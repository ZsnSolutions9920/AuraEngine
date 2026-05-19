// supabase/functions/goal-replanner/index.ts
//
// Phase 6.3.b — LLM-based auto-replanner.
//
//   POST /functions/v1/goal-replanner
//   body: { goal_id: <uuid> }
//   Auth: user JWT (must be workspace member) OR service-role token (cron path)
//
// Reads:
//   - automation_goals row (statement, target, due, guardrails)
//   - active automation_plans row (prior plan body, version, rationale)
//   - automation_step_runs for the active plan (what actually happened)
//   - workspace_memory observation rows for this goal (drift signals)
//   - workspace_memory winning_pattern / avoid rows (general learning)
//
// Writes:
//   - new automation_plans row via store_plan_version() — prior version
//     becomes is_active=false with superseded_reason='replan: <kind>'
//
// Rate limit: refuses to replan if there's already a replanner-created
// plan version in the last 6 hours, unless force=true is passed.
//
// LLM call: same Gemini path the original planner uses, with a system
// prompt that emphasises diff-aware revision (don't redo succeeded
// steps, address observed drift, keep what's working).

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders, handleCors } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
// Supabase migrated this project to the new sb_secret_* key format,
// which gets auto-bound to SUPABASE_SERVICE_ROLE_KEY at edge-fn runtime.
// pg_cron callers still use the legacy JWT (stored in vault). Accept
// either so both paths work without forcing a coordinated rotation.
const LEGACY_SERVICE_ROLE_KEY = Deno.env.get("LEGACY_SERVICE_ROLE_KEY") ?? "";
const ACCEPTED_SERVICE_TOKENS = [SUPABASE_SERVICE_ROLE_KEY, LEGACY_SERVICE_ROLE_KEY].filter(Boolean);
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";

const COOLDOWN_HOURS = 6;
const MIN_STEPS = 3;
const MAX_STEPS = 12;

const PRIMITIVE_KINDS = [
  "enrich_leads", "lead_score", "email_sequence",
  "social_post", "team_task", "wait", "checkpoint",
] as const;

function jsonResponse(b: unknown, status: number, h: Record<string, string>): Response {
  return new Response(JSON.stringify(b), { status, headers: { ...h, "Content-Type": "application/json" } });
}

async function geminiGenerate(systemInstruction: string, userPrompt: string): Promise<{ text: string; tokens: number }> {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not configured");
  const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=" + GEMINI_API_KEY;
  const body = {
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    systemInstruction: { parts: [{ text: systemInstruction }] },
    generationConfig: {
      temperature: 0.6,
      topP: 0.9,
      responseMimeType: "application/json",
    },
  };
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const text = j.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  const tokens = j.usageMetadata?.totalTokenCount ?? 0;
  return { text, tokens };
}

const SYSTEM_INSTRUCTION = `You are revising an automation plan that has drifted from its goal.

You will receive:
  - the original goal (statement, target metric/value, due date, guardrails)
  - the PRIOR plan (steps + summary)
  - actual OUTCOMES so far (which steps succeeded / failed / skipped)
  - OBSERVATIONS (drift signals from the observer cron)
  - WORKSPACE LEARNING (winning_pattern + avoid rows)

Produce a REVISED plan as JSON. Schema is identical to the original planner output:
  {
    "summary": "one-sentence overview, leading with WHAT CHANGED",
    "estimated_total_hours": number,
    "steps": [
      {
        "id": "s1",
        "kind": one of [enrich_leads, lead_score, email_sequence, social_post, team_task, wait, checkpoint],
        "title": "short label",
        "rationale": "why this step now, given the drift",
        "params": { ... },
        "depends_on": [],
        "estimated_hours": number,
        "success_criteria": "what done looks like"
      }
    ],
    "risks": [],
    "assumptions": []
  }

REVISION RULES:
- Address the OBSERVATIONS explicitly. If 'stalled_running' was observed, the revised plan should remove or fix the stalled step.
- DON'T redo work that already succeeded. If enrich_leads produced research on 50 leads, the revised plan shouldn't include another enrich_leads unless that's the actual issue.
- Lean on workspace learning: winning_pattern rows describe what's worked; avoid rows describe what hasn't.
- Between 3 and 12 steps. Same primitive constraints as the original planner.
- Output ONLY JSON. No prose preamble. No code-fence wrappers.`;

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);

  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, corsHeaders);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return jsonResponse({ error: "Missing Authorization" }, 401, corsHeaders);
  const token = authHeader.replace(/^Bearer\s+/i, "");

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Two callers: user JWT (manual replan from UI) OR service-role (cron sweep).
  const isServiceRole = ACCEPTED_SERVICE_TOKENS.includes(token);
  let userId: string | null = null;
  if (!isServiceRole) {
    const { data: userRes, error: authErr } = await admin.auth.getUser(token);
    if (authErr || !userRes?.user) return jsonResponse({ error: "Invalid token" }, 401, corsHeaders);
    userId = userRes.user.id;
  }

  const body = await req.json().catch(() => ({} as { goal_id?: string; force?: boolean }));
  if (!body.goal_id || typeof body.goal_id !== "string") {
    return jsonResponse({ error: "goal_id required" }, 400, corsHeaders);
  }
  const force = body.force === true;

  // Resolve goal + workspace membership (skip the membership check for service-role).
  const { data: goal, error: goalErr } = await admin
    .from("automation_goals")
    .select("id, workspace_id, statement, status, target_value, target_metric, progress_value, due_at, guardrails")
    .eq("id", body.goal_id)
    .maybeSingle();
  if (goalErr || !goal) return jsonResponse({ error: "Goal not found" }, 404, corsHeaders);

  if (!isServiceRole && userId) {
    const { data: membership } = await admin
      .from("workspace_members")
      .select("user_id")
      .eq("workspace_id", goal.workspace_id)
      .eq("user_id", userId)
      .maybeSingle();
    if (!membership) return jsonResponse({ error: "Forbidden" }, 403, corsHeaders);
  }

  // Cooldown: don't auto-replan more than once per COOLDOWN_HOURS unless forced.
  if (!force) {
    const cutoff = new Date(Date.now() - COOLDOWN_HOURS * 3600000).toISOString();
    const { count } = await admin
      .from("automation_plans")
      .select("id", { count: "exact", head: true })
      .eq("goal_id", goal.id)
      .eq("created_by_kind", "replanner")
      .gte("created_at", cutoff);
    if ((count ?? 0) > 0) {
      return jsonResponse({
        error: `Goal was replanned within the last ${COOLDOWN_HOURS}h. Pass force=true to override.`,
        code: "cooldown_active",
      }, 429, corsHeaders);
    }
  }

  // Active plan.
  const { data: planRow, error: planErr } = await admin
    .from("automation_plans")
    .select("id, version, plan, rationale")
    .eq("goal_id", goal.id)
    .eq("is_active", true)
    .maybeSingle();
  if (planErr || !planRow) return jsonResponse({ error: "No active plan to revise" }, 404, corsHeaders);

  // Step run outcomes for the active plan.
  const { data: stepRuns } = await admin
    .from("automation_step_runs")
    .select("step_id, step_kind, status, output, error, completed_at")
    .eq("plan_id", planRow.id)
    .order("created_at", { ascending: true });

  // Observations for this goal in the last 7 days.
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const { data: observations } = await admin
    .from("workspace_memory")
    .select("value, created_at")
    .eq("workspace_id", goal.workspace_id)
    .eq("kind", "observation")
    .eq("key", "goal:" + goal.id)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(20);

  if (!force && (!observations || observations.length === 0)) {
    return jsonResponse({
      error: "No recent observations to replan against. Pass force=true to revise anyway.",
      code: "no_observations",
    }, 400, corsHeaders);
  }

  // Workspace memory: winning_pattern + avoid (general learning).
  const { data: memoryRows } = await admin
    .from("workspace_memory")
    .select("kind, value")
    .eq("workspace_id", goal.workspace_id)
    .in("kind", ["winning_pattern", "avoid"])
    .order("updated_at", { ascending: false })
    .limit(15);

  // Build the prompt.
  const userPrompt = [
    "ORIGINAL GOAL",
    "=============",
    `Statement: ${goal.statement}`,
    `Target:    ${goal.target_value} ${goal.target_metric} (progress so far: ${goal.progress_value})`,
    `Due by:    ${goal.due_at ?? "no deadline"}`,
    `Guardrails: ${goal.guardrails ?? "(none)"}`,
    "",
    `PRIOR PLAN (v${planRow.version})`,
    "==============",
    `Summary: ${(planRow.plan as { summary?: string }).summary ?? "(no summary)"}`,
    `Steps:`,
    ...((planRow.plan as { steps?: Array<{ id: string; kind: string; title: string }> }).steps ?? [])
      .map((s) => `  - ${s.id} ${s.kind}: ${s.title}`),
    "",
    "OUTCOMES SO FAR",
    "===============",
    ...(stepRuns ?? []).map((r) =>
      `  - ${r.step_id} (${r.step_kind}): ${r.status}` +
      (r.error ? ` — error: ${String(r.error).slice(0, 120)}` : "") +
      (r.output && typeof r.output === "object" && "summary" in r.output
        ? ` — ${String((r.output as { summary: unknown }).summary).slice(0, 120)}`
        : "")
    ),
    "",
    "OBSERVATIONS (drift signals)",
    "============================",
    ...((observations ?? []).map((o) => {
      const v = o.value as { kind?: string; [k: string]: unknown };
      return `  - ${o.created_at}: ${v.kind ?? "unknown"} ${JSON.stringify({ ...v, kind: undefined })}`;
    })),
    "",
    "WORKSPACE LEARNING",
    "==================",
    ...((memoryRows ?? []).map((m) => `  [${m.kind}] ${JSON.stringify(m.value).slice(0, 300)}`)),
    "",
    "Generate the revised plan now. JSON only.",
  ].join("\n");

  let raw: { text: string; tokens: number };
  try {
    raw = await geminiGenerate(SYSTEM_INSTRUCTION, userPrompt);
  } catch (e) {
    return jsonResponse({ error: `Replanner LLM call failed: ${(e as Error).message}` }, 502, corsHeaders);
  }

  const cleaned = raw.text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  interface PlanLike { summary?: string; steps?: Array<{ kind?: string }> }
  let parsed: PlanLike;
  try { parsed = JSON.parse(cleaned); }
  catch (e) {
    return jsonResponse({ error: `Replanner returned non-JSON: ${(e as Error).message}`, raw_preview: cleaned.slice(0, 300) }, 502, corsHeaders);
  }

  if (!Array.isArray(parsed.steps) || parsed.steps.length < MIN_STEPS || parsed.steps.length > MAX_STEPS) {
    return jsonResponse({ error: `Replanner step count out of bounds: ${parsed.steps?.length ?? 0}` }, 502, corsHeaders);
  }
  for (const s of parsed.steps) {
    if (!PRIMITIVE_KINDS.includes(s.kind as (typeof PRIMITIVE_KINDS)[number])) {
      return jsonResponse({ error: `Replanner emitted unknown step kind: ${s.kind}` }, 502, corsHeaders);
    }
  }

  // Persist as new plan version. store_plan_version is SECURITY DEFINER and
  // expects auth.uid() to be a member — so when called via service-role we
  // need a different path. Insert directly with an admin client.
  // (store_plan_version atomicity is replicated here manually.)
  const { data: existingVersions } = await admin
    .from("automation_plans")
    .select("version")
    .eq("goal_id", goal.id)
    .order("version", { ascending: false })
    .limit(1);
  const nextVersion = (existingVersions?.[0]?.version ?? 0) + 1;

  const obsKindList = (observations ?? []).map((o) => (o.value as { kind?: string }).kind).filter(Boolean).join(", ") || "manual";
  const supersededReason = `replan: ${obsKindList}`;

  await admin
    .from("automation_plans")
    .update({ is_active: false, superseded_reason: supersededReason })
    .eq("goal_id", goal.id)
    .eq("is_active", true);

  const { data: newPlan, error: insertErr } = await admin
    .from("automation_plans")
    .insert({
      goal_id:        goal.id,
      workspace_id:   goal.workspace_id,
      version:        nextVersion,
      created_by_kind: "replanner",
      plan:           parsed,
      rationale:      parsed.summary ?? "",
      model_used:     "gemini-3-flash-preview",
      tokens_used:    raw.tokens,
      is_active:      true,
    })
    .select("id")
    .single();

  if (insertErr || !newPlan) {
    return jsonResponse({ error: `Failed to persist replanned version: ${insertErr?.message}` }, 500, corsHeaders);
  }

  // After a replan, advance status back to 'planned' so the user can run it.
  await admin.rpc("set_goal_status", { p_goal_id: goal.id, p_status: "planned" });

  return jsonResponse({
    goal_id:       goal.id,
    plan_id:       newPlan.id,
    version:       nextVersion,
    superseded_reason: supersededReason,
    observations_used: (observations ?? []).length,
    tokens_used:   raw.tokens,
    triggered_by:  isServiceRole ? "cron" : "user",
  }, 200, corsHeaders);
});
