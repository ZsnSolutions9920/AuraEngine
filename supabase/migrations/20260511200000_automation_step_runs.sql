-- ============================================================================
-- 20260511200000_automation_step_runs.sql
-- ----------------------------------------------------------------------------
-- Phase 6.2.a — Per-step execution state for goal-driven automation.
--
-- One row per (plan_id × step_id). When the goal-executor edge function
-- walks a plan, it inserts a row per step, transitions it through
-- pending → running → succeeded|failed|skipped, and records the output
-- (for dry-run mode: a "would have done X" payload; for live mode (6.2.b):
-- the actual primitive's response).
--
-- Critical: ONLY service_role can insert/update. End users can only SELECT
-- step runs in their workspace. This is so an attacker can't fabricate
-- "this step succeeded" claims that bypass the actual executor.
-- ============================================================================

create table if not exists public.automation_step_runs (
  id              uuid primary key default gen_random_uuid(),
  plan_id         uuid not null references public.automation_plans(id) on delete cascade,
  goal_id         uuid not null references public.automation_goals(id) on delete cascade,
  workspace_id    uuid not null references public.workspaces(id) on delete cascade,
  step_id         text not null,                                       -- e.g. "s1" (matches plan.steps[].id)
  step_kind       text not null,                                       -- e.g. "apollo_search" — denormalised for fast queries
  status          text not null default 'pending'
                  check (status in ('pending','running','succeeded','failed','skipped')),
  mode            text not null default 'dry_run'
                  check (mode in ('dry_run','live')),
  attempt_count   int not null default 0,
  input_params    jsonb,                                                -- snapshot of the step.params at run time
  output          jsonb,                                                -- primitive response (or dry-run simulation)
  error           text,
  started_at      timestamptz,
  completed_at    timestamptz,
  created_at      timestamptz not null default now(),
  -- One row per (plan_id, step_id, attempt_count) so retries don't
  -- collide. Most queries filter on the latest attempt.
  unique (plan_id, step_id, attempt_count)
);

create index if not exists idx_automation_step_runs_plan
  on public.automation_step_runs (plan_id, step_id, attempt_count desc);
create index if not exists idx_automation_step_runs_goal_status
  on public.automation_step_runs (goal_id, status);
create index if not exists idx_automation_step_runs_workspace_recent
  on public.automation_step_runs (workspace_id, created_at desc);

alter table public.automation_step_runs enable row level security;

create policy automation_step_runs_select on public.automation_step_runs
  for select using (
    workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid())
  );

-- NO insert/update/delete policies — service-role only. The executor
-- edge function is the only writer.

comment on table public.automation_step_runs is
  'Phase 6.2.a — per-step execution state. Service-role-only writes; the goal-executor edge function is the sole writer. mode=dry_run means the step was simulated (no real side effects); mode=live (Phase 6.2.b) means the primitive was actually invoked.';

-- ── advance_goal_progress(goal_id, increment) ─────────────────────────────
--
-- Tiny helper for the executor to bump progress_value atomically.
-- Caps at target_value to avoid drift past 100%.

create or replace function public.advance_goal_progress(
  p_goal_id   uuid,
  p_increment numeric
) returns void
language sql
security definer
set search_path = public
as $$
  update public.automation_goals
     set progress_value = least(target_value, progress_value + p_increment)
   where id = p_goal_id;
$$;

revoke all on function public.advance_goal_progress(uuid, numeric) from public;
grant execute on function public.advance_goal_progress(uuid, numeric) to service_role;

-- ── set_goal_status(goal_id, status) ──────────────────────────────────────

create or replace function public.set_goal_status(
  p_goal_id uuid,
  p_status  text
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_status not in ('draft','planning','planned','active','running','paused','completed','cancelled','failed') then
    raise exception 'invalid status: %', p_status;
  end if;
  update public.automation_goals
     set status = p_status,
         completed_at = case when p_status = 'completed' then now() else completed_at end
   where id = p_goal_id;
end;
$$;

revoke all on function public.set_goal_status(uuid, text) from public;
grant execute on function public.set_goal_status(uuid, text) to service_role;

-- ── automation_goals.status check expansion ───────────────────────────────
-- Add 'running' to the allowed values (added in Phase 6.2 — wasn't in 6.1).

alter table public.automation_goals
  drop constraint if exists automation_goals_status_check;

alter table public.automation_goals
  add constraint automation_goals_status_check
  check (status in ('draft','planning','planned','active','running','paused','completed','cancelled','failed'));
