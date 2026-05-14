-- ============================================================================
-- 20260514100000_schema_refine_4.sql
-- ----------------------------------------------------------------------------
-- Fourth refinement pass. Two buckets, both mechanical:
--
--   1. Drop 3 dead tables that have been superseded by newer schemas.
--      All three confirmed pre-migration: zero rows, zero FK in-refs,
--      zero `.from(...)` or SQL writers in the active code paths:
--        idempotency_keys → replaced by api_idempotency (Phase 4)
--        usage_counters   → replaced by workspace_usage_counters
--                           and usage_events
--        webhooks         → replaced by webhook_endpoints +
--                           webhook_deliveries (Phase 4)
--
--   2. Defense-in-depth: revoke anon SELECT on 5 secret-bearing tables.
--      All 5 currently sit on the Supabase default "anon has table-level
--      SELECT, RLS is the only gate" pattern. That's a single-point-of
--      -failure — one bad policy and Stripe IDs / OAuth tokens / SMTP
--      passwords would leak. Revoking anon table-level SELECT makes
--      RLS the second gate, not the only gate.
--
--      Verified pre-migration:
--        - no anon-readable table's policy references any of these 5
--          (so we won't repeat the blog_posts→profiles.role gotcha
--          that bit us in commit dcb914c)
--        - no marketing/public page in the SPA queries these tables
--          (all callers are in authed portal pages or service-role
--          edge functions)
-- ============================================================================

-- ── 1. Drop dead tables ────────────────────────────────────────────────

drop table if exists public.idempotency_keys;
drop table if exists public.usage_counters;
drop table if exists public.webhooks;

-- ── 2. Anon revoke on secret-bearing tables ────────────────────────────

revoke select on public.sender_account_secrets from anon;
revoke select on public.email_provider_configs from anon;
revoke select on public.social_accounts        from anon;
revoke select on public.integrations           from anon;
revoke select on public.subscriptions          from anon;

-- Document why, so future maintainers don't restore the broad grant.
comment on table public.sender_account_secrets is
  'Per-user sender account secrets (api_key, oauth_access_token, oauth_refresh_token, smtp_pass). Anon SELECT revoked — only service-role and authenticated paths read this. RLS still enforces per-user scoping for authenticated readers.';

comment on table public.email_provider_configs is
  'Per-user email provider configs (api_key, smtp_pass, webhook_key). Anon SELECT revoked. Authenticated reads scoped by owner RLS.';

comment on table public.social_accounts is
  'Per-user connected social accounts with encrypted OAuth tokens. Anon SELECT revoked. Authenticated reads scoped by user_id RLS.';

comment on table public.integrations is
  'Per-user / per-workspace third-party integration configs (credentials jsonb). Anon SELECT revoked. Authenticated reads scoped by owner RLS.';

comment on table public.subscriptions is
  'Stripe subscription rows (stripe_customer_id, stripe_subscription_id). Anon SELECT revoked. Joined via subscription:subscriptions(*) in fetchProfile / pollForProfile — both run authenticated.';
