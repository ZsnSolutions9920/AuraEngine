-- ============================================================================
-- 20260508400000_db_refinement.sql
-- ----------------------------------------------------------------------------
-- DB schema refinement pass.
--
-- Two structural fixes, plus deprecation documentation. Everything is
-- additive and idempotent. No table or column is dropped — that requires
-- explicit alignment with product (Strategy Hub) and a Phase 3.2 cutover
-- (email_provider_configs) that hasn't shipped yet.
--
-- 1. email_messages.workspace_id          — high-leverage scope fix
-- 2. email_dlq workspace_id FK correction — point at workspaces, not profiles
-- 3. Deprecation comments on superseded entities so future engineers and
--    cleanup migrations don't have to re-derive the history:
--      - ai_prompts            (superseded by prompt_dna_registry)
--      - ai_usage_logs         (superseded by ai_credit_usage)
--      - email_provider_configs (superseded by sender_accounts; remove
--                                after Phase 3.2 send-path cutover)
--      - strategy_tasks / strategy_notes (pending product decision per
--                                         migration 20260413400000)
--      - leads.name / leads.email / leads.lastActivity
--                              (legacy duplicates; use first_name +
--                               last_name / primary_email / last_activity)
-- ============================================================================

-- ── 1. email_messages.workspace_id ─────────────────────────────────────────
--
-- Why: every workspace-scoped query against email_messages today has to join
-- through leads to get a workspace_id. Direct column + index lets RLS,
-- analytics, and the Phase 3.1 sender-health functions filter cheaply.
-- The column is nullable for now so backfill failures (rows whose lead has
-- a null workspace_id, or whose lead_id is null) don't block the migration.
-- Phase 3.2 send-path cutover will populate it on insert.

alter table public.email_messages
  add column if not exists workspace_id uuid
    references public.workspaces(id) on delete set null;

create index if not exists idx_email_messages_workspace_created
  on public.email_messages (workspace_id, created_at desc)
  where workspace_id is not null;

-- Backfill from the canonical workspace_id on leads.
update public.email_messages em
   set workspace_id = l.workspace_id
  from public.leads l
 where em.workspace_id is null
   and em.lead_id      = l.id
   and l.workspace_id is not null;

comment on column public.email_messages.workspace_id is
  'Phase 3.5 — canonical workspace scope. Backfilled from leads.workspace_id where possible. New rows should be set explicitly by send-email when Phase 3.2 cutover lands.';

-- ── 2. email_dlq workspace FK correction ───────────────────────────────────
--
-- email_dlq was created in Phase 3.1 with workspace_id referencing
-- profiles(id) to mirror sender_accounts' legacy FK. workspaces(id) is the
-- canonical target for new tables (per the post-20260305200002 convention).
-- Table is empty (Phase 3.2 webhooks haven't shipped yet) so re-pointing
-- the FK is risk-free. Done idempotently:

do $$
declare
  v_constraint_name text;
begin
  -- Find the existing FK on email_dlq.workspace_id (whatever it's named).
  select constraint_name
    into v_constraint_name
    from information_schema.table_constraints tc
    join information_schema.constraint_column_usage ccu using (constraint_name, table_schema)
   where tc.table_schema = 'public'
     and tc.table_name = 'email_dlq'
     and tc.constraint_type = 'FOREIGN KEY'
     and ccu.table_name in ('profiles', 'workspaces')
     and ccu.column_name = 'id'
   limit 1;

  if v_constraint_name is not null then
    execute format('alter table public.email_dlq drop constraint %I', v_constraint_name);
  end if;
end $$;

alter table public.email_dlq
  add constraint email_dlq_workspace_id_fkey
  foreign key (workspace_id) references public.workspaces(id) on delete cascade;

-- ── 3. Deprecation comments ────────────────────────────────────────────────
--
-- These are documentation only — they don't change any behavior. They
-- exist so the next engineer (human or AI) knows which tables are
-- canonical and which are awaiting removal.

-- ai_prompts → prompt_dna_registry
comment on table public.ai_prompts is
  'DEPRECATED — superseded by prompt_dna_registry. Was the original flat AI prompt table; the DNA registry adds versioning, variables, tone config, guardrails, and per-call analytics. Schedule for removal once no code reads from this table.';

-- ai_usage_logs → ai_credit_usage
comment on table public.ai_usage_logs is
  'DEPRECATED — superseded by ai_credit_usage. Was the original per-user token log; ai_credit_usage is workspace-scoped with idempotency keys and operation classification. Schedule for removal once no code writes to this table.';

-- email_provider_configs → sender_accounts (Phase 3.2)
comment on table public.email_provider_configs is
  'DEPRECATED — superseded by sender_accounts + sender_account_secrets. The Phase 3.2 send-path cutover (planned, not yet shipped) will retire this table. Until then, send-email/index.ts still reads from here; do not drop.';

-- strategy_tasks / strategy_notes (pending product decision)
comment on table public.strategy_tasks is
  'PENDING DECISION (per migration 20260413400000) — Strategy Hub feature was paused; this table was kept rather than dropped. Confirm with product before any code references it again or before scheduling removal.';
comment on table public.strategy_notes is
  'PENDING DECISION (per migration 20260413400000) — see strategy_tasks comment.';

-- Legacy lead columns (canonical replacements documented)
comment on column public.leads.name is
  'DEPRECATED — use first_name + last_name. Computed at app boundary by lib/queries.ts normalizeLeads().';
comment on column public.leads.email is
  'DEPRECATED — use primary_email. The emails text[] column holds all addresses; primary_email is the canonical headline.';
comment on column public.leads."lastActivity" is
  'DEPRECATED — use last_activity (timestamptz). This text-typed column is the legacy spelling.';

-- ── 4. Self-doc anchor ─────────────────────────────────────────────────────

comment on schema public is
  'Scaliyo — AI Revenue Operating System. Canonical entities: workspaces, workspace_members, leads, sender_accounts, email_messages (now with workspace_id), email_events, lead_memory, campaign_memory, workspace_memory. Deprecation comments live on individual tables/columns.';
