-- ============================================================================
-- 20260524130000_create_my_workspace_with_name.sql
-- ----------------------------------------------------------------------------
-- Adds an optional `p_name` parameter to create_my_workspace so callers can
-- choose the workspace's display name at creation time. Behaviour:
--   - p_name is trimmed; empty/null falls back to full_name from auth
--     metadata, then 'My Workspace'.
--   - If the user is already a workspace member, the existing workspace is
--     returned unchanged. The name is NOT renamed retroactively.
--   - Function is still SECURITY DEFINER and grant-scoped to authenticated.
-- ============================================================================

drop function if exists public.create_my_workspace();

create or replace function public.create_my_workspace(p_name text default null)
returns table (
  workspace_id uuid,
  created      boolean,
  name         text
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_user_id uuid := auth.uid();
  v_existing uuid;
  v_existing_name text;
  v_name text;
begin
  if v_user_id is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  -- Already a member? Return that and bail (no rename).
  select wm.workspace_id, ws.name
    into v_existing, v_existing_name
    from public.workspace_members wm
    join public.workspaces ws on ws.id = wm.workspace_id
   where wm.user_id = v_user_id
   order by wm.joined_at asc
   limit 1;

  if v_existing is not null then
    workspace_id := v_existing;
    created      := false;
    name         := v_existing_name;
    return next;
    return;
  end if;

  -- Resolve the name: trimmed param > auth full_name > 'My Workspace'.
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

  workspace_id := v_user_id;
  created      := true;
  name         := v_name;
  return next;
end;
$$;

revoke all on function public.create_my_workspace(text) from public;
grant execute on function public.create_my_workspace(text) to authenticated;

comment on function public.create_my_workspace(text) is
  'Self-service: idempotently creates a workspace + owner membership for auth.uid(). Optional p_name sets the display name on first creation; subsequent calls return the existing workspace unchanged.';
