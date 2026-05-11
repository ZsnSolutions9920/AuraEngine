-- ============================================================================
-- 20260511400000_phase_6_2_c.sql
-- ----------------------------------------------------------------------------
-- Phase 6.2.c + 6.4 — schema for the remaining safe primitives, the wait-
-- resumption cron, and the memory feedback loop.
--
-- Pieces:
--   1. automation_step_runs.not_before   — when can a paused step resume?
--   2. claim_resumable_goal_step_runs()  — atomic claim for cron worker
--   3. fan_out_resumable_goals()         — pg_cron sweeper that hits the
--                                          goal-executor edge fn via pg_net
--   4. log_goal_outcome_to_memory()      — TRIGGER on automation_goals
--                                          status transitions → workspace_memory
--   5. goal_executor_send_email/social   — feature flags pre-created as
--                                          disabled (for forward compat)
-- ============================================================================

-- ── 1. not_before column on step_runs ───────────────────────────────────

alter table public.automation_step_runs
  add column if not exists not_before timestamptz;

create index if not exists idx_automation_step_runs_resumable
  on public.automation_step_runs (not_before)
  where status = 'pending' and not_before is not null;

-- ── 2. claim_resumable_goal_step_runs ───────────────────────────────────
--
-- Atomic claim. Returns goal_ids whose paused wait steps are due. Sets
-- the affected step_runs to status='running' so concurrent invocations
-- don't double-fire.

create or replace function public.claim_resumable_goal_step_runs(p_limit int default 20)
returns table (goal_id uuid)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with claimed as (
    update public.automation_step_runs
       set status = 'running',
           started_at = now()
     where id in (
       select id
         from public.automation_step_runs
        where status = 'pending'
          and not_before is not null
          and not_before <= now()
        order by not_before asc
        for update skip locked
        limit p_limit
     )
    returning goal_id
  )
  select distinct c.goal_id from claimed c;
end;
$$;

revoke all on function public.claim_resumable_goal_step_runs(int) from public;
grant execute on function public.claim_resumable_goal_step_runs(int) to service_role;

-- ── 3. cron worker stub ─────────────────────────────────────────────────
--
-- Hourly sweep that finds any goal with a resumable wait and POSTs to the
-- goal-executor edge fn (via pg_net, using the vault-stored service-role
-- token). Edge fn handles the actual resumption logic.

create or replace function public.cron_resume_paused_goals()
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_token  text;
  v_goal   record;
  v_url    text := 'https://utvydxqiqedaaxmmpfpf.functions.supabase.co/goal-executor';
begin
  select decrypted_secret into v_token
  from vault.decrypted_secrets
  where name = 'webhook_dispatcher_service_key'  -- reused — same service-role token
  limit 1;

  if v_token is null then
    raise warning 'webhook_dispatcher_service_key vault secret missing — cron_resume_paused_goals skipping';
    return;
  end if;

  -- claim_resumable_goal_step_runs transitions paused → running so
  -- subsequent invocations don't repeat the work. The edge fn does the
  -- actual primitive execution on the freshly-claimed step.
  for v_goal in
    select goal_id from public.claim_resumable_goal_step_runs(20)
  loop
    perform net.http_post(
      url     := v_url,
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || v_token
      ),
      body    := jsonb_build_object(
        'goal_id', v_goal.goal_id,
        'mode',    'live',
        'resume',  true
      ),
      timeout_milliseconds := 60000
    );
  end loop;
end;
$$;

revoke all on function public.cron_resume_paused_goals() from public;
grant execute on function public.cron_resume_paused_goals() to service_role;

do $$ begin
  perform cron.unschedule('resume-paused-goals');
exception when others then null;
end $$;

select cron.schedule(
  'resume-paused-goals',
  '*/5 * * * *',   -- every 5 min — good enough resolution for waits measured in hours
  $$select public.cron_resume_paused_goals();$$
);

-- ── 4. Goal outcome → workspace_memory feedback loop (Phase 6.4) ────────
--
-- Fires when automation_goals.status transitions into a terminal state.
-- Writes a row to workspace_memory with kind='winning_pattern' on
-- completed (success) or kind='avoid' on failed/cancelled.

create or replace function public.log_goal_outcome_to_memory()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_active_plan jsonb;
  v_step_summary jsonb;
  v_memory_kind text;
begin
  -- Only fire on transitions to terminal states.
  if new.status not in ('completed','failed','cancelled') then return new; end if;
  if old.status is not distinct from new.status then return new; end if;
  if old.status in ('completed','failed','cancelled') then return new; end if;

  v_memory_kind := case
    when new.status = 'completed' then 'winning_pattern'
    else 'avoid'
  end;

  -- Get the active plan's body for memory context.
  select plan into v_active_plan
    from public.automation_plans
   where goal_id = new.id and is_active = true
   limit 1;

  -- Get the step run aggregate counts.
  select jsonb_build_object(
    'succeeded', count(*) filter (where status = 'succeeded'),
    'failed',    count(*) filter (where status = 'failed'),
    'skipped',   count(*) filter (where status = 'skipped'),
    'total',     count(*)
  ) into v_step_summary
  from public.automation_step_runs
  where goal_id = new.id;

  insert into public.workspace_memory (
    workspace_id, kind, key, value, source, confidence, tags
  )
  values (
    new.workspace_id,
    v_memory_kind,
    'goal:' || new.id::text,
    jsonb_build_object(
      'goal_statement',       new.statement,
      'goal_target_metric',   new.target_metric,
      'goal_target_value',    new.target_value,
      'goal_progress',        new.progress_value,
      'goal_status',          new.status,
      'plan_summary',         coalesce(v_active_plan->>'summary', ''),
      'plan_step_count',      coalesce(jsonb_array_length(v_active_plan->'steps'), 0),
      'step_run_summary',     v_step_summary,
      'completed_at',         coalesce(new.completed_at, now())
    ),
    'goal_outcome',
    case
      when (v_step_summary->>'total')::int >= 5  then 0.85
      when (v_step_summary->>'total')::int >= 3  then 0.70
      else 0.55
    end,
    array['goal','automation', new.target_metric, v_memory_kind]
  );

  return new;
exception when others then
  raise warning 'log_goal_outcome_to_memory failed for %: % %', new.id, sqlstate, sqlerrm;
  return new;
end;
$$;

drop trigger if exists trg_log_goal_outcome on public.automation_goals;
create trigger trg_log_goal_outcome
  after update on public.automation_goals
  for each row execute function public.log_goal_outcome_to_memory();

comment on function public.log_goal_outcome_to_memory is
  'Phase 6.4 — on goal status → completed/failed/cancelled, write a workspace_memory row (winning_pattern or avoid) so future generateGoalPlan() runs see this outcome.';

-- ── 5. Email + social feature flag rows (Phase 6.2.d pre-provisioning) ──
--
-- Pre-create the disabled flag rows so the UI can render the toggles
-- without first having to UPSERT. Phase 6.2.d will wire the actual send
-- gating.

-- (No insert needed — workspace_has_flag defaults to false for missing
-- rows. The flag_keys are declared here as canonical constants:
--   goal_executor_send_email
--   goal_executor_send_social
-- via the comment below for grep-ability.)
comment on table public.workspace_feature_flags is
  'Phase 6.2.b — per-workspace feature flag toggles. Known flag_keys: goal_executor_live, goal_executor_send_email, goal_executor_send_social. Missing rows default to disabled.';
