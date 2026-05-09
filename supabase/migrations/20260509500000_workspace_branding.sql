-- ============================================================================
-- 20260509500000_workspace_branding.sql
-- ----------------------------------------------------------------------------
-- Phase 4.6.a — White-label theme tokens.
--
-- Per-workspace branding overrides. The SPA reads this row at boot and
-- injects it as CSS variables on the document root. Empty/null fields
-- fall back to the platform defaults; this is purely override.
--
-- Vanity domain (4.6.b) lives in a separate migration so the heavier
-- TLS/Nginx work doesn't gate the simple theme story.
-- ============================================================================

create table if not exists public.workspace_branding (
  workspace_id    uuid primary key references public.workspaces(id) on delete cascade,
  -- Logos
  logo_url        text,                -- header logo (recommended 32px tall)
  favicon_url     text,                -- defaults to platform favicon
  email_logo_url  text,                -- inlined into outgoing email templates
  -- Color tokens (hex)
  primary_color   text check (primary_color   is null or primary_color   ~ '^#[0-9A-Fa-f]{6}$'),
  accent_color    text check (accent_color    is null or accent_color    ~ '^#[0-9A-Fa-f]{6}$'),
  background_color text check (background_color is null or background_color ~ '^#[0-9A-Fa-f]{6}$'),
  -- Copy
  product_name    text,                -- "Powered by Acme" replaces "Scaliyo" in headers/footers
  support_email   text,                -- shown in error states + email footers
  updated_by      uuid references auth.users(id) on delete set null,
  updated_at      timestamptz not null default now()
);

alter table public.workspace_branding enable row level security;

create policy workspace_branding_select on public.workspace_branding
  for select using (
    workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid())
  );

create policy workspace_branding_upsert on public.workspace_branding
  for insert with check (
    workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid())
  );

create policy workspace_branding_update on public.workspace_branding
  for update using (
    workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid())
  );

create or replace function public.touch_workspace_branding()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end;
$$;

drop trigger if exists trg_workspace_branding_touch on public.workspace_branding;
create trigger trg_workspace_branding_touch
  before update on public.workspace_branding
  for each row execute function public.touch_workspace_branding();

comment on table public.workspace_branding is
  'Phase 4.6.a — per-workspace theme overrides. SPA reads this row at boot and injects as CSS variables. Vanity domain (4.6.b) is separate.';
