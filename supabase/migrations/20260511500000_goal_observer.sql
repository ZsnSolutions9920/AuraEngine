-- ============================================================================
-- 20260511500000_goal_observer.sql
-- ----------------------------------------------------------------------------
-- Phase 6.3 — Goal Observer (skeleton).
--
-- Hourly cron that scans active/running/paused goals and detects drift:
--   - Goal past its due_at with progress < target
--   - Plan-version older than 7 days with no terminal step completions in 24h
--   - Goal that's been 'paused' for > 12h (cron wait should have unstuck it)
--
-- For each observation, writes a workspace_memory row with kind='observation'
-- so the next replan call sees the context. (The full LLM-replanner loop
-- lives in Phase 6.3.b — for now, observations show up in /portal/goals as
-- inline warnings on goal cards.)
-- ============================================================================

create or replace function public.cron_observe_goal_drift()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_goal      record;
  v_obs       jsonb;
  v_reason    text;
begin
  for v_goal in
    select g.id, g.workspace_id, g.statement, g.status, g.target_value, g.progress_value, g.due_at, g.updated_at
      from public.automation_goals g
     where g.status in ('active','running','paused')
  loop
    v_obs := null;

    -- (a) past due with progress < target
    if v_goal.due_at is not null and v_goal.due_at < now() and v_goal.progress_value < v_goal.target_value then
      v_reason := 'past_due_with_unmet_target';
      v_obs := jsonb_build_object(
        'kind', v_reason,
        'goal_id', v_goal.id,
        'progress', v_goal.progress_value,
        'target', v_goal.target_value,
        'due_at', v_goal.due_at,
        'observed_at', now()
      );
    end if;

    -- (b) paused for > 12h
    if v_obs is null and v_goal.status = 'paused' and v_goal.updated_at < now() - interval '12 hours' then
      v_reason := 'paused_too_long';
      v_obs := jsonb_build_object(
        'kind', v_reason,
        'goal_id', v_goal.id,
        'paused_since', v_goal.updated_at,
        'observed_at', now()
      );
    end if;

    -- (c) running without recent step progress
    if v_obs is null and v_goal.status = 'running' then
      if not exists (
        select 1 from public.automation_step_runs
        where goal_id = v_goal.id
          and completed_at > now() - interval '6 hours'
      ) then
        v_reason := 'stalled_running';
        v_obs := jsonb_build_object(
          'kind', v_reason,
          'goal_id', v_goal.id,
          'observed_at', now()
        );
      end if;
    end if;

    if v_obs is null then continue; end if;

    -- De-dup: don't write the same observation kind for the same goal
    -- if one was written in the last 24h.
    if exists (
      select 1 from public.workspace_memory wm
      where wm.workspace_id = v_goal.workspace_id
        and wm.kind = 'observation'
        and wm.key = 'goal:' || v_goal.id::text
        and wm.value->>'kind' = v_reason
        and wm.created_at > now() - interval '24 hours'
    ) then
      continue;
    end if;

    insert into public.workspace_memory (
      workspace_id, kind, key, value, source, confidence, tags
    ) values (
      v_goal.workspace_id,
      'observation',
      'goal:' || v_goal.id::text,
      v_obs,
      'goal_observer',
      0.80,
      array['goal','observation', v_reason]
    );
  end loop;
exception when others then
  raise warning 'cron_observe_goal_drift failed: % %', sqlstate, sqlerrm;
end;
$$;

revoke all on function public.cron_observe_goal_drift() from public;
grant execute on function public.cron_observe_goal_drift() to service_role;

do $$ begin
  perform cron.unschedule('observe-goal-drift');
exception when others then null;
end $$;

select cron.schedule(
  'observe-goal-drift',
  '37 * * * *',  -- hourly; offset from other cron jobs
  $$select public.cron_observe_goal_drift();$$
);

comment on function public.cron_observe_goal_drift is
  'Phase 6.3 — hourly observer. Scans active/running/paused goals and writes workspace_memory rows for drift signals (past due, stalled, paused too long). Phase 6.3.b will wire an LLM replanner that consumes these.';
