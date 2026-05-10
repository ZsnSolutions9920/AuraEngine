-- ============================================================================
-- 20260510400000_workspace_domain_provisioning.sql
-- ----------------------------------------------------------------------------
-- Phase 4.6.b — track TLS provisioning state on workspace_domains.
--
-- Lifecycle:
--   pending     — row created, DNS not verified yet
--   verified    — DNS check passed (TXT or CNAME)
--   provisioned — VPS poller has issued cert + dropped Nginx server block
--                 and reloaded; the vanity domain now serves traffic
--   failed      — verification failed (DNS proof not present)
--
-- We add provisioned_at + cert_expires_at + last_provision_error so the
-- VPS-side poller can update the row after each certbot run, and the
-- `/portal/branding` UI can surface "live", "renewing", or "stuck" state.
-- ============================================================================

alter table public.workspace_domains
  add column if not exists provisioned_at        timestamptz,
  add column if not exists cert_expires_at       timestamptz,
  add column if not exists last_provision_at     timestamptz,
  add column if not exists last_provision_error  text;

create index if not exists idx_workspace_domains_provision_queue
  on public.workspace_domains (status, provisioned_at)
  where status = 'verified' and provisioned_at is null;

-- ── mark_domain_provisioned / mark_domain_provision_failed ────────────────

create or replace function public.mark_domain_provisioned(
  p_domain_id        uuid,
  p_cert_expires_at  timestamptz
) returns void
language sql
security definer
set search_path = public
as $$
  update public.workspace_domains
     set provisioned_at        = coalesce(provisioned_at, now()),
         last_provision_at     = now(),
         last_provision_error  = null,
         cert_expires_at       = p_cert_expires_at
   where id = p_domain_id;
$$;

revoke all on function public.mark_domain_provisioned(uuid, timestamptz) from public;
grant execute on function public.mark_domain_provisioned(uuid, timestamptz) to service_role;

create or replace function public.mark_domain_provision_failed(
  p_domain_id uuid,
  p_error     text
) returns void
language sql
security definer
set search_path = public
as $$
  update public.workspace_domains
     set last_provision_at     = now(),
         last_provision_error  = p_error
   where id = p_domain_id;
$$;

revoke all on function public.mark_domain_provision_failed(uuid, text) from public;
grant execute on function public.mark_domain_provision_failed(uuid, text) to service_role;
