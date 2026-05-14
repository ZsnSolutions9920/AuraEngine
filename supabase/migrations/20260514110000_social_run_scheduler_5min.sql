-- ============================================================================
-- 20260514110000_social_run_scheduler_5min.sql
-- ----------------------------------------------------------------------------
-- Drop social-run-scheduler cron frequency from every minute to every
-- 5 minutes. Cuts pg_net invocations by 80%. Worst-case latency on a
-- scheduled social post grows from "up to 1 min" to "up to 5 min" —
-- acceptable for the product (no minute-precision UX is exposed).
--
-- Command body preserved verbatim from cron.job.
-- ============================================================================

do $$ begin
  perform cron.unschedule('social-run-scheduler');
exception when others then null;
end $$;

select cron.schedule(
  'social-run-scheduler',
  '*/5 * * * *',
  $sql$
  SELECT net.http_post(
    url := current_setting('app.settings.supabase_url') || '/functions/v1/social-run-scheduler',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key')
    ),
    body := '{"source":"cron"}'::jsonb
  );
  $sql$
);
