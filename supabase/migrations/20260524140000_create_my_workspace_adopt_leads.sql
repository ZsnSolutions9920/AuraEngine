-- ============================================================================
-- 20260524140000_create_my_workspace_adopt_leads.sql
-- ----------------------------------------------------------------------------
-- Extends create_my_workspace to adopt the caller's existing leads into the
-- workspace it returns.
--
-- Why: many existing accounts have leads where the row's `client_id` or
-- `user_id` equals auth.uid() but workspace_id was set to a stale UUID
-- by the March 2026 backfill (workspace_id := COALESCE(client_id, user_id))
-- from a now-deleted client/workspace. After the recovery RPC created a
-- fresh workspace, those leads were invisible to all workspace-scoped
-- queries (Quick Launch, Lead Intelligence, etc.) even though the user
-- "owned" them by client_id.
--
-- Behaviour now:
--   1. If caller is already in workspace_members → return that workspace
--      AND re-parent any owned leads whose workspace_id drifted.
--   2. Else create the workspace + ownership row as before, then re-parent.
--
-- Re-parent scope: leads where client_id = auth.uid() OR user_id = auth.uid()
-- and current workspace_id != target workspace_id. Returns the number of
-- leads adopted so the UI can show it.
-- ============================================================================

drop function if exists public.create_my_workspace(text);

create or replace function public.create_my_workspace(p_name text default null)
returns table (
  workspace_id   uuid,
  created        boolean,
  name           text,
  leads_adopted  int
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_user_id     uuid := auth.uid();
  v_target      uuid;
  v_existing    uuid;
  v_existing_nm text;
  v_name        text;
  v_adopted     int := 0;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  -- Already a member? Use that workspace.
  select wm.workspace_id, ws.name
    into v_existing, v_existing_nm
    from public.workspace_members wm
    join public.workspaces ws on ws.id = wm.workspace_id
   where wm.user_id = v_user_id
   order by wm.joined_at asc
   limit 1;

  if v_existing is not null then
    v_target := v_existing;
    name     := v_existing_nm;
    created  := false;
  else
    -- Resolve name: trimmed param > auth full_name > 'My Workspace'.
    v_name := nullif(trim(coalesce(p_name, '')), '');
    if v_name is null then
      select nullif(trim(coalesce(u.raw_user_meta_data->>'full_name', '')), '')
        into v_name
        from auth.users u
       where u.id = v_user_id;
    end if;
    v_name := coalesce(v_name, 'My Workspace');

    insert into public.workspaces (id, name, owner_id)
    values (v_user_id, v_name, v_user_id)
    on conflict (id) do nothing;

    insert into public.workspace_members (workspace_id, user_id, role)
    values (v_user_id, v_user_id, 'owner')
    on conflict (workspace_id, user_id) do nothing;

    v_target := v_user_id;
    name     := v_name;
    created  := true;
  end if;

  -- Adopt owned leads whose workspace_id has drifted. Safe because the
  -- WHERE clause filters by ownership; we never touch leads belonging
  -- to a different client_id/user_id.
  with adopted as (
    update public.leads l
       set workspace_id = v_target,
           updated_at   = now()
     where (l.client_id = v_user_id or l.user_id = v_user_id)
       and (l.workspace_id is distinct from v_target)
     returning 1
  )
  select count(*)::int into v_adopted from adopted;

  workspace_id  := v_target;
  leads_adopted := v_adopted;
  return next;
end;
$$;

revoke all on function public.create_my_workspace(text) from public;
grant execute on function public.create_my_workspace(text) to authenticated;

comment on function public.create_my_workspace(text) is
  'Self-service workspace recovery + lead adoption. Creates workspace+membership for auth.uid() if missing, then re-parents the caller''s owned leads (by client_id/user_id) into that workspace. Idempotent.';
