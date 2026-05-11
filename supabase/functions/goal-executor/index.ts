// supabase/functions/goal-executor/index.ts
//
// Phase 6.2.a (dry-run) + Phase 6.2.b (live, partial).
//
//   POST /functions/v1/goal-executor
//   body: { goal_id: <uuid>, mode?: "dry_run" | "live" }
//   Auth: Supabase user JWT (caller must be a member of the goal's workspace).
//
// Mode gating:
//   dry_run     ALWAYS allowed. All primitives return "would have done X" stubs.
//   live        Requires the workspace to have feature flag
//               `goal_executor_live = true`. Returns 403 otherwise.
//
// Live-mode primitives implemented THIS SESSION (6.2.b):
//   apollo_search   real Apollo API call via existing apollo-search edge fn
//                   (consumes the workspace's Apollo credits)
//   checkpoint      reads the named workspace metric, compares to threshold
//
// Live-mode primitives that remain stubbed in 6.2.b (with explicit reason):
//   wait            scheduling deferred to Phase 6.2.c (cron worker)
//   enrich_leads    Gemini integration deferred to 6.2.c
//   lead_score      Gemini integration deferred to 6.2.c
//   team_task       team_hub board-mapping deferred to 6.2.c
//
// Live-mode primitives gated UNCONDITIONALLY (require their own flags):
//   email_sequence  needs goal_executor_send_email flag (6.2.d)
//   social_post     needs goal_executor_send_social flag (6.2.d)

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders, handleCors } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const MAX_STEPS_PER_PLAN = 25;
const LIVE_MODE_FLAG       = "goal_executor_live";
const SEND_EMAIL_FLAG      = "goal_executor_send_email";
const SEND_SOCIAL_FLAG     = "goal_executor_send_social";
const GEMINI_API_KEY       = Deno.env.get("GEMINI_API_KEY") ?? "";
const INLINE_WAIT_MAX_MS   = 30_000;             // waits ≤ 30s sleep inline; longer waits persist + cron resumes
const ENRICH_MAX_LEADS     = 20;
const SCORE_MAX_LEADS      = 50;

interface PlanStep {
  id: string;
  kind: string;
  title: string;
  rationale: string;
  params: Record<string, unknown>;
  depends_on: string[];
  estimated_hours?: number;
  success_criteria?: string;
}
interface Plan { summary: string; steps: PlanStep[]; }

type Mode = "dry_run" | "live";
type StepStatus = "succeeded" | "failed" | "skipped";
interface StepResult {
  status: StepStatus;
  output: Record<string, unknown>;
  error?: string;
}

function jsonResponse(b: unknown, status: number, h: Record<string, string>): Response {
  return new Response(JSON.stringify(b), { status, headers: { ...h, "Content-Type": "application/json" } });
}

// ── Dry-run stubs (unchanged from 6.2.a) ───────────────────────────────

function dryRunStub(step: PlanStep): StepResult {
  const p = step.params ?? {};
  switch (step.kind) {
    case "apollo_search":
      return { status: "succeeded", output: { dry_run: true, summary: `Would search Apollo with filters and return up to N leads.`, filters: p.filters ?? p, simulated_lead_count: 42 } };
    case "enrich_leads":
      return { status: "succeeded", output: { dry_run: true, summary: `Would run AI research on leads from ${p.lead_filter ?? "upstream step"} (~2-4 hours typical wall time).`, simulated_enriched: 38, simulated_failed: 4 } };
    case "lead_score":
      return { status: "succeeded", output: { dry_run: true, summary: `Would score leads against your ICP. Typical result: 60% scored, 20% hot, 40% warm, 40% cold.`, simulated_hot: 8, simulated_warm: 16, simulated_cold: 16 } };
    case "email_sequence":
      return { status: "succeeded", output: { dry_run: true, summary: `Would start sequence "${p.sequence_template ?? "unknown"}" for ${p.lead_filter ?? "all hot leads"}.`, sequence_template: p.sequence_template, total_emails: p.total_emails, cadence_days: p.cadence_days }, error: "Email sends are gated — Phase 6.2.d will require explicit per-workspace opt-in." };
    case "social_post":
      return { status: "succeeded", output: { dry_run: true, summary: `Would publish a ${p.channel ?? "social"} post on the topic: "${p.topic ?? ""}".`, channel: p.channel, topic: p.topic }, error: "Social publishes are gated — Phase 6.2.d will require explicit per-workspace opt-in." };
    case "team_task":
      return { status: "succeeded", output: { dry_run: true, summary: `Would create a team task: "${p.title ?? "(no title)"}"`, title: p.title, description: p.description, assigned_role: p.assigned_role } };
    case "wait":
      return { status: "succeeded", output: { dry_run: true, summary: `Would wait ${p.hours ?? "?"} hours. Reason: ${p.reason ?? "(none)"}.`, hours: p.hours } };
    case "checkpoint":
      return { status: "succeeded", output: { dry_run: true, summary: `Would evaluate metric "${p.metric ?? "?"}" against threshold ${p.comparison ?? ""} ${p.threshold ?? "?"}.`, metric: p.metric, threshold: p.threshold, comparison: p.comparison, simulated_outcome: "would_pass" } };
    default:
      return { status: "succeeded", output: { dry_run: true, summary: `Unknown step kind "${step.kind}" — no-op.` }, error: `Step kind "${step.kind}" is not yet supported by the executor.` };
  }
}

// ── Live-mode handlers ─────────────────────────────────────────────────
//
// Each returns the same StepResult shape. Live handlers can be partial —
// for any primitive not yet implemented in live mode, we fall through to
// a "deferred to 6.2.c" stub with status='skipped' so the goal status
// later reflects the partial execution.

async function liveApolloSearch(
  admin: ReturnType<typeof createClient>,
  userToken: string,
  step: PlanStep,
): Promise<StepResult> {
  const params = (step.params?.filters as Record<string, unknown>) ?? step.params ?? {};
  try {
    // Invoke the existing apollo-search edge fn with the user's JWT so it
    // attributes the search + log row to the right user.
    const url = `${SUPABASE_URL}/functions/v1/apollo-search`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        Authorization:   `Bearer ${userToken}`,
      },
      body: JSON.stringify({
        person_titles:        params.person_titles        ?? params.titles        ?? [],
        q_keywords:           params.q_keywords           ?? params.keywords      ?? "",
        person_locations:     params.person_locations     ?? params.locations     ?? [],
        organization_locations: params.organization_locations ?? [],
        employee_ranges:      params.employee_ranges      ?? params.company_sizes ?? [],
        person_seniorities:   params.person_seniorities   ?? [],
        person_departments:   params.person_departments   ?? [],
        per_page:             Number(params.per_page ?? params.limit ?? 25),
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { status: "failed", output: { live: true }, error: `apollo-search HTTP ${res.status}: ${text.slice(0, 200)}` };
    }
    const data = await res.json();
    return {
      status: "succeeded",
      output: {
        live: true,
        summary: `Apollo returned ${data.pagination?.total_entries ?? 0} matching prospects (showing top ${data.people?.length ?? 0}).`,
        total_entries: data.pagination?.total_entries ?? 0,
        results_returned: data.people?.length ?? 0,
        search_log_id: data.search_log_id ?? null,
        // First 5 only — we don't want huge JSONB payloads in step_runs.
        sample: (data.people ?? []).slice(0, 5).map((p: Record<string, unknown>) => ({
          name:    p.name,
          title:   p.title,
          company: (p.organization as Record<string, unknown>)?.name,
        })),
      },
    };
  } catch (e) {
    return { status: "failed", output: { live: true }, error: `apollo-search threw: ${(e as Error).message}` };
  }
}

// ── Gemini call (server-side, uses GEMINI_API_KEY directly) ─────────────

async function geminiGenerate(prompt: string, systemInstruction: string, opts?: { responseMimeType?: string }): Promise<{ text: string; tokens: number }> {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not configured");
  const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=" + GEMINI_API_KEY;
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    systemInstruction: { parts: [{ text: systemInstruction }] },
    generationConfig: {
      temperature: 0.5,
      topP: 0.9,
      ...(opts?.responseMimeType ? { responseMimeType: opts.responseMimeType } : {}),
    },
  };
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const text = j.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  const tokens = j.usageMetadata?.totalTokenCount ?? 0;
  return { text, tokens };
}

// ── Live: enrich_leads ─────────────────────────────────────────────────
//
// Picks up to ENRICH_MAX_LEADS workspace leads with empty insights, calls
// Gemini per lead, writes back insights. Caps to avoid runaway costs.

async function liveEnrichLeads(
  admin: ReturnType<typeof createClient>,
  workspaceId: string,
  step: PlanStep,
): Promise<StepResult> {
  try {
    const { data: leads, error } = await admin
      .from("leads")
      .select("id, first_name, last_name, primary_email, company, title, linkedin_url, insights, workspace_id")
      .eq("workspace_id", workspaceId)
      .or("insights.is.null,insights.eq.")
      .limit(ENRICH_MAX_LEADS);
    if (error) return { status: "failed", output: { live: true }, error: `lead fetch failed: ${error.message}` };
    if (!leads || leads.length === 0) {
      return { status: "succeeded", output: { live: true, summary: "No leads needed enrichment.", enriched: 0 } };
    }

    let enriched = 0;
    let failed = 0;
    for (const l of leads) {
      const prompt = `Research this B2B prospect and produce a 2-3 sentence insight on their likely pain points and the best opening hook for outreach. Return plain text, no preamble.\n\nName: ${l.first_name ?? ""} ${l.last_name ?? ""}\nTitle: ${l.title ?? "unknown"}\nCompany: ${l.company ?? "unknown"}\nEmail: ${l.primary_email ?? "(none)"}\nLinkedIn: ${l.linkedin_url ?? "(none)"}`;
      try {
        const { text } = await geminiGenerate(prompt, "You are a B2B sales researcher producing terse, useful prospect insights.");
        await admin.from("leads").update({ insights: text.slice(0, 1000), updated_at: new Date().toISOString() }).eq("id", l.id);
        enriched++;
      } catch (e) {
        console.warn(`[enrich] lead ${l.id} failed:`, (e as Error).message);
        failed++;
      }
    }

    return {
      status: failed === leads.length ? "failed" : "succeeded",
      output: {
        live: true,
        summary: `Enriched ${enriched} of ${leads.length} leads (${failed} failed). Insights written to leads.insights.`,
        enriched, failed, total: leads.length,
      },
      error: failed > 0 ? `${failed} lead(s) failed enrichment — see edge fn logs.` : undefined,
    };
  } catch (e) {
    return { status: "failed", output: { live: true }, error: `enrich_leads threw: ${(e as Error).message}` };
  }
}

// ── Live: lead_score ───────────────────────────────────────────────────

async function liveLeadScore(
  admin: ReturnType<typeof createClient>,
  workspaceId: string,
  step: PlanStep,
): Promise<StepResult> {
  try {
    const { data: leads, error } = await admin
      .from("leads")
      .select("id, first_name, last_name, company, title, industry, insights, score")
      .eq("workspace_id", workspaceId)
      .or("score.is.null,score.eq.0")
      .limit(SCORE_MAX_LEADS);
    if (error) return { status: "failed", output: { live: true }, error: `lead fetch failed: ${error.message}` };
    if (!leads || leads.length === 0) {
      return { status: "succeeded", output: { live: true, summary: "No leads needed scoring.", scored: 0 } };
    }

    let scored = 0; let failed = 0;
    let hot = 0; let warm = 0; let cold = 0;
    for (const l of leads) {
      const prompt = `Score this B2B prospect 0-100 for ICP fit. Output JSON ONLY: {"score": int, "tier": "hot"|"warm"|"cold", "reason": "one sentence"}.\n\nProspect: ${l.first_name} ${l.last_name}, ${l.title} at ${l.company} (${l.industry ?? "unknown industry"}).\nInsights: ${l.insights ?? "(none)"}`;
      try {
        const { text } = await geminiGenerate(prompt, "You are a B2B ICP scorer. Output strict JSON only.", { responseMimeType: "application/json" });
        const cleaned = text.replace(/^```(?:json)?\s*/, "").replace(/```\s*$/, "").trim();
        const parsed = JSON.parse(cleaned) as { score: number; tier: string };
        const s = Math.max(0, Math.min(100, Math.round(Number(parsed.score) || 0)));
        await admin.from("leads").update({ score: s, updated_at: new Date().toISOString() }).eq("id", l.id);
        scored++;
        if (parsed.tier === "hot") hot++;
        else if (parsed.tier === "warm") warm++;
        else cold++;
      } catch (e) {
        console.warn(`[score] lead ${l.id} failed:`, (e as Error).message);
        failed++;
      }
    }

    return {
      status: failed === leads.length ? "failed" : "succeeded",
      output: {
        live: true,
        summary: `Scored ${scored} of ${leads.length} leads. Hot: ${hot}, Warm: ${warm}, Cold: ${cold}.`,
        scored, failed, hot, warm, cold, total: leads.length,
      },
      error: failed > 0 ? `${failed} lead(s) failed scoring.` : undefined,
    };
  } catch (e) {
    return { status: "failed", output: { live: true }, error: `lead_score threw: ${(e as Error).message}` };
  }
}

// ── Live: team_task ────────────────────────────────────────────────────
//
// Auto-creates a workspace-scoped "AI Goals" board on first call. Inserts
// a card into the "To Do" list of that board.

async function liveTeamTask(
  admin: ReturnType<typeof createClient>,
  userId: string,
  workspaceId: string,
  step: PlanStep,
): Promise<StepResult> {
  const p = step.params ?? {};
  const title = String(p.title ?? step.title ?? "Untitled task");
  const description = (p.description as string) ?? null;

  try {
    // Find or create the "AI Goals" board for this workspace.
    let boardId: string | null = null;
    {
      const { data: existing } = await admin
        .from("teamhub_boards")
        .select("id")
        .eq("workspace_id", workspaceId)
        .eq("name", "AI Goals")
        .maybeSingle();
      if (existing?.id) {
        boardId = existing.id as string;
      } else {
        const { data: created, error: cerr } = await admin
          .from("teamhub_boards")
          .insert({ workspace_id: workspaceId, name: "AI Goals", created_by: userId })
          .select("id")
          .single();
        if (cerr || !created) {
          return { status: "skipped", output: { live: true, summary: `Couldn't auto-create AI Goals board: ${cerr?.message ?? "unknown"}.` }, error: cerr?.message };
        }
        boardId = created.id as string;
      }
    }

    // Find or create the "To Do" list on this board.
    let listId: string | null = null;
    {
      const { data: existing } = await admin
        .from("teamhub_lists")
        .select("id")
        .eq("board_id", boardId)
        .eq("name", "To Do")
        .maybeSingle();
      if (existing?.id) {
        listId = existing.id as string;
      } else {
        const { data: created, error: cerr } = await admin
          .from("teamhub_lists")
          .insert({ board_id: boardId, name: "To Do", position: 0 })
          .select("id")
          .single();
        if (cerr || !created) {
          return { status: "skipped", output: { live: true, summary: `Couldn't create To Do list: ${cerr?.message ?? "unknown"}.` }, error: cerr?.message };
        }
        listId = created.id as string;
      }
    }

    const { data: card, error: cardErr } = await admin
      .from("teamhub_cards")
      .insert({
        board_id:    boardId,
        list_id:     listId,
        title,
        description: description ?? `Created by goal executor — ${step.rationale ?? ""}`,
        created_by:  userId,
      })
      .select("id")
      .single();

    if (cardErr || !card) {
      return { status: "failed", output: { live: true }, error: `team_task insert failed: ${cardErr?.message}` };
    }

    return {
      status: "succeeded",
      output: {
        live: true,
        summary: `Created team task "${title}" on the AI Goals board.`,
        card_id: card.id,
        board_id: boardId,
        list_id: listId,
      },
    };
  } catch (e) {
    return { status: "failed", output: { live: true }, error: `team_task threw: ${(e as Error).message}` };
  }
}

// ── Live: wait ────────────────────────────────────────────────────────
//
// Two regimes:
//   ≤ 30s wait: inline sleep, succeed immediately.
//   > 30s wait: persist not_before, mark goal paused, return 'paused'
//               sentinel so the executor exits early without processing
//               downstream steps. The pg_cron worker (every 5 min) will
//               re-invoke the executor in resume mode when not_before <= now().

interface PausedSentinel { paused: true; not_before: string; }
async function liveWait(step: PlanStep): Promise<StepResult | PausedSentinel> {
  const hours = Number(step.params?.hours ?? 0);
  const reason = String(step.params?.reason ?? "");
  const ms = Math.max(0, hours * 3_600_000);

  if (ms <= INLINE_WAIT_MAX_MS) {
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
    return {
      status: "succeeded",
      output: { live: true, summary: `Waited ${hours}h inline (≤30s) — resumed.`, hours, reason },
    };
  }

  const notBefore = new Date(Date.now() + ms).toISOString();
  return { paused: true, not_before: notBefore };
}

// ── Live: gated email_sequence / social_post ──────────────────────────

async function liveGatedStub(
  admin: ReturnType<typeof createClient>,
  workspaceId: string,
  step: PlanStep,
  flagKey: string,
  phaseLabel: string,
): Promise<StepResult> {
  const { data: flagOn } = await admin.rpc("workspace_has_flag", {
    p_workspace_id: workspaceId,
    p_flag_key:     flagKey,
  });
  if (!flagOn) {
    return {
      status: "skipped",
      output: {
        live: true,
        gated: true,
        summary: `"${step.kind}" requires workspace flag "${flagKey}" — not enabled. Skipped.`,
        flag_key: flagKey,
      },
      error: `"${step.kind}" is gated behind the ${flagKey} workspace flag (${phaseLabel}). Enable it explicitly before this primitive will execute.`,
    };
  }

  // Flag is on, but actual send wiring is the responsibility of a future
  // ship — for now, log clearly that we *would* fire and ack the flag.
  return {
    status: "skipped",
    output: {
      live: true,
      gated: false,
      summary: `Flag "${flagKey}" is enabled but the send wiring is not yet implemented. Would have invoked: ${step.kind} with the planner's params.`,
      params: step.params ?? {},
    },
    error: `Flag enabled but send wiring not yet shipped (${phaseLabel}).`,
  };
}

async function liveCheckpoint(
  admin: ReturnType<typeof createClient>,
  workspaceId: string,
  goalTargetMetric: string,
  step: PlanStep,
): Promise<StepResult> {
  const p = step.params ?? {};
  const metric = String(p.metric ?? goalTargetMetric);
  const threshold = Number(p.threshold ?? 0);
  const comparison = String(p.comparison ?? "gte");

  // Map well-known metrics to SQL queries.
  let observed: number | null = null;
  let queryNote = "";
  try {
    if (metric === "leads_total" || metric === "leads") {
      const { count } = await admin.from("leads").select("id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId);
      observed = count ?? 0;
      queryNote = "leads (workspace, all-time)";
    } else if (metric === "leads_new_30d") {
      const since = new Date(Date.now() - 30 * 86400000).toISOString();
      const { count } = await admin.from("leads").select("id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId).gte("created_at", since);
      observed = count ?? 0;
      queryNote = "leads created in last 30 days";
    } else if (metric === "qualified_leads") {
      const { count } = await admin.from("leads").select("id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId).eq("status", "Qualified");
      observed = count ?? 0;
      queryNote = "leads with status=Qualified";
    } else if (metric === "emails_sent_in_range" || metric === "email_sent") {
      const { count } = await admin.from("email_messages").select("id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId);
      observed = count ?? 0;
      queryNote = "email_messages (workspace, all-time)";
    } else if (metric === "active_sequences") {
      const { count } = await admin.from("email_sequence_runs").select("id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId).eq("status", "processing");
      observed = count ?? 0;
      queryNote = "email_sequence_runs status=processing";
    } else {
      return {
        status: "skipped",
        output: { live: true, summary: `Checkpoint metric "${metric}" is not in the live-mode metric catalogue yet.` },
        error: `Unsupported metric "${metric}" — supported: leads_total, leads_new_30d, qualified_leads, emails_sent_in_range, active_sequences.`,
      };
    }
  } catch (e) {
    return { status: "failed", output: { live: true }, error: `checkpoint query failed: ${(e as Error).message}` };
  }

  const passed = comparison === "gte" ? (observed ?? 0) >= threshold
               : comparison === "lte" ? (observed ?? 0) <= threshold
               : comparison === "eq"  ? (observed ?? 0) === threshold
               : false;

  return {
    status: "succeeded",
    output: {
      live: true,
      summary: `Checkpoint: ${queryNote} = ${observed} (target ${comparison} ${threshold}) → ${passed ? "PASS" : "MISS"}.`,
      metric,
      observed,
      threshold,
      comparison,
      passed,
    },
    // We record an error message on a checkpoint miss so the UI surfaces
    // it, but the step itself stays 'succeeded' — checkpoint *evaluation*
    // succeeded; whether the metric passed is a separate signal.
    error: passed ? undefined : `Checkpoint missed: ${observed} ${comparison} ${threshold} = false`,
  };
}

async function executeStepLive(
  admin: ReturnType<typeof createClient>,
  userToken: string,
  userId: string,
  workspaceId: string,
  goalTargetMetric: string,
  step: PlanStep,
): Promise<StepResult | PausedSentinel> {
  switch (step.kind) {
    case "apollo_search":  return await liveApolloSearch(admin, userToken, step);
    case "checkpoint":     return await liveCheckpoint(admin, workspaceId, goalTargetMetric, step);
    case "enrich_leads":   return await liveEnrichLeads(admin, workspaceId, step);
    case "lead_score":     return await liveLeadScore(admin, workspaceId, step);
    case "team_task":      return await liveTeamTask(admin, userId, workspaceId, step);
    case "wait":           return await liveWait(step);
    case "email_sequence": return await liveGatedStub(admin, workspaceId, step, SEND_EMAIL_FLAG, "Phase 6.2.d");
    case "social_post":    return await liveGatedStub(admin, workspaceId, step, SEND_SOCIAL_FLAG, "Phase 6.2.d");
    default: return {
      status: "skipped",
      output: { live: true, summary: `Unknown step kind "${step.kind}" — no-op.` },
      error: `Step kind "${step.kind}" is not supported by the executor.`,
    };
  }
}

// ── Topo sort ──────────────────────────────────────────────────────────

function topoSort(steps: PlanStep[]): PlanStep[] | { error: string } {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const s of steps) {
    indeg.set(s.id, (s.depends_on ?? []).length);
    for (const d of s.depends_on ?? []) {
      if (!byId.has(d)) return { error: `step ${s.id} depends on unknown step ${d}` };
      adj.set(d, [...(adj.get(d) ?? []), s.id]);
    }
  }
  const queue = steps.filter((s) => (indeg.get(s.id) ?? 0) === 0).map((s) => s.id);
  const ordered: PlanStep[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    ordered.push(byId.get(id)!);
    for (const nxt of adj.get(id) ?? []) {
      indeg.set(nxt, (indeg.get(nxt) ?? 1) - 1);
      if ((indeg.get(nxt) ?? 0) === 0) queue.push(nxt);
    }
  }
  if (ordered.length !== steps.length) return { error: "plan has dependency cycle" };
  return ordered;
}

// ── Handler ────────────────────────────────────────────────────────────

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);

  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, corsHeaders);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return jsonResponse({ error: "Missing Authorization" }, 401, corsHeaders);
  const userToken = authHeader.replace(/^Bearer\s+/i, "");

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: userRes, error: authErr } = await admin.auth.getUser(userToken);
  if (authErr || !userRes?.user) return jsonResponse({ error: "Invalid token" }, 401, corsHeaders);
  const userId = userRes.user.id;

  const body = await req.json().catch(() => ({} as { goal_id?: string; mode?: string; resume?: boolean }));
  if (!body.goal_id || typeof body.goal_id !== "string") {
    return jsonResponse({ error: "goal_id required" }, 400, corsHeaders);
  }
  const mode: Mode = body.mode === "live" ? "live" : "dry_run";
  const resume: boolean = body.resume === true;

  const { data: goal, error: goalErr } = await admin
    .from("automation_goals")
    .select("id, workspace_id, statement, status, target_value, target_metric")
    .eq("id", body.goal_id)
    .maybeSingle();
  if (goalErr || !goal) return jsonResponse({ error: "Goal not found" }, 404, corsHeaders);

  const { data: membership } = await admin
    .from("workspace_members")
    .select("user_id")
    .eq("workspace_id", goal.workspace_id)
    .eq("user_id", userId)
    .maybeSingle();
  if (!membership) return jsonResponse({ error: "Forbidden" }, 403, corsHeaders);

  // Live-mode requires explicit workspace flag.
  if (mode === "live") {
    const { data: flagOn } = await admin.rpc("workspace_has_flag", {
      p_workspace_id: goal.workspace_id,
      p_flag_key:     LIVE_MODE_FLAG,
    });
    if (!flagOn) {
      return jsonResponse({
        error: "Live execution requires the goal_executor_live workspace flag to be enabled.",
        code:  "live_not_enabled",
        flag_key: LIVE_MODE_FLAG,
      }, 403, corsHeaders);
    }
  }

  if (!["planned", "active", "paused", "running", "completed", "failed"].includes(goal.status)) {
    return jsonResponse({
      error: `Goal must be planned/active/paused/running/completed/failed to execute; current status is "${goal.status}"`,
      code:  "wrong_status",
    }, 409, corsHeaders);
  }

  const { data: planRow, error: planErr } = await admin
    .from("automation_plans")
    .select("id, plan")
    .eq("goal_id", goal.id)
    .eq("is_active", true)
    .maybeSingle();
  if (planErr || !planRow) return jsonResponse({ error: "No active plan for this goal" }, 404, corsHeaders);

  const plan = planRow.plan as Plan;
  if (!plan.steps || plan.steps.length === 0) return jsonResponse({ error: "Plan has no steps" }, 400, corsHeaders);
  if (plan.steps.length > MAX_STEPS_PER_PLAN) return jsonResponse({ error: `Plan has ${plan.steps.length} steps; cap is ${MAX_STEPS_PER_PLAN}`, code: "too_many_steps" }, 400, corsHeaders);

  const ordered = topoSort(plan.steps);
  if ("error" in ordered) return jsonResponse({ error: ordered.error }, 400, corsHeaders);

  // In resume mode (called by cron), pick up where we left off.
  // Find step IDs that already have a terminal status_run row and skip them.
  let alreadyDoneStepIds = new Set<string>();
  if (resume) {
    const { data: existing } = await admin
      .from("automation_step_runs")
      .select("step_id, status")
      .eq("plan_id", planRow.id)
      .in("status", ["succeeded", "skipped", "failed"]);
    alreadyDoneStepIds = new Set((existing ?? []).map((r) => r.step_id as string));
  }

  await admin.rpc("set_goal_status", { p_goal_id: goal.id, p_status: "running" });

  const progressIncrement = goal.target_value > 0
    ? Number(goal.target_value) / ordered.length
    : 0;

  const stepRunIds: string[] = [];
  let failures = 0;
  let skipped = 0;
  let pausedAt: { step_id: string; not_before: string } | null = null;

  for (const step of ordered) {
    if (alreadyDoneStepIds.has(step.id)) continue;

    // Insert or claim the step_run row. In resume mode, there may already
    // be a 'pending' row for this step (the cron worker's claim transitioned
    // it to 'running'); reuse it.
    let stepRunId: string;
    if (resume) {
      const { data: existing } = await admin
        .from("automation_step_runs")
        .select("id")
        .eq("plan_id", planRow.id)
        .eq("step_id", step.id)
        .order("attempt_count", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (existing?.id) {
        stepRunId = existing.id;
        await admin.from("automation_step_runs").update({ status: "running", started_at: new Date().toISOString() }).eq("id", stepRunId);
      } else {
        const { data: inserted, error: insErr } = await admin
          .from("automation_step_runs")
          .insert({
            plan_id: planRow.id, goal_id: goal.id, workspace_id: goal.workspace_id,
            step_id: step.id, step_kind: step.kind, status: "running", mode,
            attempt_count: 1, input_params: step.params ?? {}, started_at: new Date().toISOString(),
          })
          .select("id").single();
        if (insErr || !inserted) { failures++; continue; }
        stepRunId = inserted.id;
      }
    } else {
      const { data: inserted, error: insErr } = await admin
        .from("automation_step_runs")
        .insert({
          plan_id: planRow.id, goal_id: goal.id, workspace_id: goal.workspace_id,
          step_id: step.id, step_kind: step.kind, status: "running", mode,
          attempt_count: 1, input_params: step.params ?? {}, started_at: new Date().toISOString(),
        })
        .select("id").single();
      if (insErr || !inserted) { failures++; continue; }
      stepRunId = inserted.id;
    }
    stepRunIds.push(stepRunId);

    let result: StepResult | PausedSentinel;
    if (mode === "live") {
      result = await executeStepLive(admin, userToken, userId, goal.workspace_id, goal.target_metric, step);
    } else {
      result = dryRunStub(step);
    }

    // Paused sentinel from liveWait: persist not_before and stop the loop.
    if ("paused" in result && result.paused) {
      await admin.from("automation_step_runs").update({
        status: "pending", not_before: result.not_before, started_at: null,
        output: { live: true, paused: true, summary: `Paused — will resume at ${result.not_before}.`, not_before: result.not_before },
      }).eq("id", stepRunId);
      pausedAt = { step_id: step.id, not_before: result.not_before };
      break;
    }

    if (result.status === "failed") failures++;
    if (result.status === "skipped") skipped++;

    await admin
      .from("automation_step_runs")
      .update({
        status:       result.status,
        output:       result.output,
        error:        result.error ?? null,
        completed_at: new Date().toISOString(),
      })
      .eq("id", stepRunId);

    if (progressIncrement > 0 && result.status === "succeeded") {
      await admin.rpc("advance_goal_progress", {
        p_goal_id:   goal.id,
        p_increment: progressIncrement,
      });
    }
  }

  let finalStatus: string;
  if (pausedAt) {
    finalStatus = "paused";
  } else {
    finalStatus = failures === 0 ? "completed" : "failed";
  }
  await admin.rpc("set_goal_status", { p_goal_id: goal.id, p_status: finalStatus });

  return jsonResponse({
    goal_id:       goal.id,
    plan_id:       planRow.id,
    mode,
    resume,
    paused_at:     pausedAt,
    steps_total:   ordered.length,
    steps_succeeded: stepRunIds.length - failures - skipped - (pausedAt ? 1 : 0),
    steps_skipped: skipped,
    steps_failed:  failures,
    step_run_ids:  stepRunIds,
    final_status:  finalStatus,
  }, 200, corsHeaders);
});
