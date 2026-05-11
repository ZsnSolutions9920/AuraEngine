// supabase/functions/goal-executor/index.ts
//
// Phase 6.2.a — Goal-plan executor.
//
//   POST /functions/v1/goal-executor
//   body: { goal_id: "<uuid>", mode?: "dry_run" }
//   Auth: Supabase user JWT (caller must be a member of the goal's workspace).
//
// Walks the active automation_plan in dependency order. For each step,
// inserts an automation_step_runs row, transitions it through running →
// succeeded/failed, and records what would-have-happened in the `output`
// JSONB.
//
// Phase 6.2.a is DRY-RUN ONLY:
//   - mode='dry_run' is the only accepted value.
//   - Every primitive returns a "would have done X" stub with no real
//     side effect (no Apollo calls, no email sends, no social posts).
//   - This lets customers validate planner output before Phase 6.2.b
//     wires live execution behind a per-workspace feature flag.
//
// Hard safety: this function never invokes another edge function, never
// writes to leads / email_messages / email_sequence_runs, never opens an
// outbound HTTP request beyond the internal Supabase calls. The only
// tables it writes are automation_step_runs and automation_goals.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders, handleCors } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const MAX_STEPS_PER_PLAN = 25; // safety cap; the planner is constrained to 3-12

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

interface Plan {
  summary: string;
  steps: PlanStep[];
  estimated_total_hours?: number;
  risks?: string[];
  assumptions?: string[];
}

function jsonResponse(b: unknown, status: number, h: Record<string, string>): Response {
  return new Response(JSON.stringify(b), { status, headers: { ...h, "Content-Type": "application/json" } });
}

// ── Dry-run primitive stubs ─────────────────────────────────────────────
//
// Each handler returns the "output" payload that gets stored on the step
// run. The shape is intentionally varied per kind so the UI can render
// distinct "what would happen" descriptions.

type StubResult = { output: Record<string, unknown>; warning?: string };

function dryRunStub(step: PlanStep): StubResult {
  const p = step.params ?? {};
  switch (step.kind) {
    case "apollo_search":
      return {
        output: {
          dry_run: true,
          summary: `Would search Apollo with filters and return up to N leads.`,
          filters: p.filters ?? p,
          simulated_lead_count: 42,
        },
      };
    case "enrich_leads":
      return {
        output: {
          dry_run: true,
          summary: `Would run AI research on leads from ${p.lead_filter ?? "upstream step"} (~2-4 hours typical wall time).`,
          simulated_enriched: 38,
          simulated_failed: 4,
        },
      };
    case "lead_score":
      return {
        output: {
          dry_run: true,
          summary: `Would score leads against your ICP. Typical result: 60% scored, 20% hot, 40% warm, 40% cold.`,
          simulated_hot: 8,
          simulated_warm: 16,
          simulated_cold: 16,
        },
      };
    case "email_sequence":
      return {
        output: {
          dry_run: true,
          summary: `Would start sequence "${p.sequence_template ?? "unknown"}" for ${p.lead_filter ?? "all hot leads"}.`,
          sequence_template: p.sequence_template,
          total_emails: p.total_emails,
          cadence_days: p.cadence_days,
        },
        warning: "Email sends are gated behind a feature flag — Phase 6.2.b will require explicit per-workspace opt-in.",
      };
    case "social_post":
      return {
        output: {
          dry_run: true,
          summary: `Would publish a ${p.channel ?? "social"} post on the topic: "${p.topic ?? ""}".`,
          channel: p.channel,
          topic: p.topic,
        },
        warning: "Social publishes are gated — Phase 6.2.b will require explicit per-workspace opt-in.",
      };
    case "team_task":
      return {
        output: {
          dry_run: true,
          summary: `Would create a team task: "${p.title ?? "(no title)"}"`,
          title: p.title,
          description: p.description,
          assigned_role: p.assigned_role,
        },
      };
    case "wait":
      return {
        output: {
          dry_run: true,
          summary: `Would wait ${p.hours ?? "?"} hours. Reason: ${p.reason ?? "(none)"}.`,
          hours: p.hours,
        },
      };
    case "checkpoint":
      return {
        output: {
          dry_run: true,
          summary: `Would evaluate metric "${p.metric ?? "?"}" against threshold ${p.comparison ?? ""} ${p.threshold ?? "?"}.`,
          metric: p.metric,
          threshold: p.threshold,
          comparison: p.comparison,
          simulated_outcome: "would_pass",
        },
      };
    default:
      return {
        output: {
          dry_run: true,
          summary: `Unknown step kind "${step.kind}" — no-op.`,
        },
        warning: `Step kind "${step.kind}" is not yet supported by the executor.`,
      };
  }
}

// ── Topological sort (dependency order) ────────────────────────────────

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
  const token = authHeader.replace(/^Bearer\s+/i, "");

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: userRes, error: authErr } = await admin.auth.getUser(token);
  if (authErr || !userRes?.user) return jsonResponse({ error: "Invalid token" }, 401, corsHeaders);
  const userId = userRes.user.id;

  const body = await req.json().catch(() => ({} as { goal_id?: string; mode?: string }));
  if (!body.goal_id || typeof body.goal_id !== "string") {
    return jsonResponse({ error: "goal_id required" }, 400, corsHeaders);
  }
  const mode = body.mode === "live" ? "live" : "dry_run";
  if (mode === "live") {
    return jsonResponse({
      error: "Live execution is not yet enabled. Phase 6.2.b will introduce a per-workspace feature flag.",
      code: "live_not_enabled",
    }, 403, corsHeaders);
  }

  // Resolve the goal + active plan.
  const { data: goal, error: goalErr } = await admin
    .from("automation_goals")
    .select("id, workspace_id, statement, status, target_value")
    .eq("id", body.goal_id)
    .maybeSingle();
  if (goalErr || !goal) return jsonResponse({ error: "Goal not found" }, 404, corsHeaders);

  // Auth: caller must be in the goal's workspace.
  const { data: membership } = await admin
    .from("workspace_members")
    .select("user_id")
    .eq("workspace_id", goal.workspace_id)
    .eq("user_id", userId)
    .maybeSingle();
  if (!membership) return jsonResponse({ error: "Forbidden" }, 403, corsHeaders);

  if (!["planned", "paused", "active", "running"].includes(goal.status)) {
    return jsonResponse({
      error: `Goal must be planned/active/paused/running to execute; current status is "${goal.status}"`,
      code: "wrong_status",
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
  if (!plan.steps || plan.steps.length === 0) {
    return jsonResponse({ error: "Plan has no steps" }, 400, corsHeaders);
  }
  if (plan.steps.length > MAX_STEPS_PER_PLAN) {
    return jsonResponse({
      error: `Plan has ${plan.steps.length} steps; executor cap is ${MAX_STEPS_PER_PLAN}`,
      code: "too_many_steps",
    }, 400, corsHeaders);
  }

  const ordered = topoSort(plan.steps);
  if ("error" in ordered) return jsonResponse({ error: ordered.error }, 400, corsHeaders);

  // Mark goal as running.
  await admin.rpc("set_goal_status", { p_goal_id: goal.id, p_status: "running" });

  const progressIncrement = goal.target_value > 0
    ? Number(goal.target_value) / ordered.length
    : 0;

  const stepRunIds: string[] = [];
  let failures = 0;

  for (const step of ordered) {
    // Insert run row in 'running' state.
    const { data: inserted, error: insErr } = await admin
      .from("automation_step_runs")
      .insert({
        plan_id:       planRow.id,
        goal_id:       goal.id,
        workspace_id:  goal.workspace_id,
        step_id:       step.id,
        step_kind:     step.kind,
        status:        "running",
        mode,
        attempt_count: 1,
        input_params:  step.params ?? {},
        started_at:    new Date().toISOString(),
      })
      .select("id")
      .single();
    if (insErr || !inserted) {
      console.error("[goal-executor] insert step run failed:", insErr?.message);
      failures++;
      continue;
    }
    stepRunIds.push(inserted.id);

    // Dry-run stub.
    const result = dryRunStub(step);

    await admin
      .from("automation_step_runs")
      .update({
        status:       "succeeded",
        output:       result.output,
        error:        result.warning ?? null,
        completed_at: new Date().toISOString(),
      })
      .eq("id", inserted.id);

    // Advance progress proportionally.
    if (progressIncrement > 0) {
      await admin.rpc("advance_goal_progress", {
        p_goal_id:   goal.id,
        p_increment: progressIncrement,
      });
    }
  }

  // Final goal status.
  const finalStatus = failures === 0 ? "completed" : "failed";
  await admin.rpc("set_goal_status", { p_goal_id: goal.id, p_status: finalStatus });

  return jsonResponse({
    goal_id:       goal.id,
    plan_id:       planRow.id,
    mode,
    steps_total:   ordered.length,
    steps_succeeded: ordered.length - failures,
    steps_failed:  failures,
    step_run_ids:  stepRunIds,
    final_status:  finalStatus,
  }, 200, corsHeaders);
});
