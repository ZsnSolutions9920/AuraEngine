// AuraEngine/lib/permissions.ts
//
// Phase 4.5 — Centralised permission check.
//
// Every ad-hoc role check in the codebase (`user.role === 'admin'`,
// `user.is_super_admin === true`, `teamRole === 'Manager'`) should go
// through hasPermission() instead. This:
//
//   1. Makes it auditable — one place to look when SOC2 asks
//      "what gates access to X?"
//   2. Makes the role model swappable — when we move to Org Admin /
//      Workspace Admin / Member / Viewer, only this file changes.
//   3. Makes the answer composable across UserRole + TeamRole +
//      is_super_admin without callers wiring all three.
//
// Phase 4.5 wraps the EXISTING role model. The intent here is
// consolidation, not re-modelling — that's a future phase if/when
// enterprise deals demand the org/workspace split.

import { UserRole, type User, type TeamRole } from '../types';

// Action × Resource grammar. Both are string-literal unions so the
// TypeScript compiler catches typos at every call site.

export type Action =
  | 'read'
  | 'create'
  | 'update'
  | 'delete'
  | 'manage';   // implies all of the above

export type Resource =
  | 'lead'
  | 'campaign'
  | 'sequence'
  | 'template'
  | 'sender_account'
  | 'api_key'
  | 'webhook_endpoint'
  | 'invoice'
  | 'team_board'
  | 'team_item'
  | 'workspace_settings'
  | 'workspace_billing'
  | 'admin_console'
  | 'admin_users'
  | 'admin_audit'
  | 'support_console';

interface PermissionCtx {
  /** Which workspace this is being checked against. Optional — only
   *  matters for resources where TeamRole gates access. */
  teamRole?: TeamRole | null;
}

// ── Role helpers ─────────────────────────────────────────────────────────

const isAdmin       = (u: User | null | undefined) => u?.role === UserRole.ADMIN;
const isSuperAdmin  = (u: User | null | undefined) => !!u?.is_super_admin;
const isClient      = (u: User | null | undefined) => u?.role === UserRole.CLIENT;

const teamCanWrite = (r: TeamRole | null | undefined) =>
  r === 'Administrator' || r === 'Manager';
const teamCanManage = (r: TeamRole | null | undefined) =>
  r === 'Administrator';

// ── Main check ──────────────────────────────────────────────────────────

export function hasPermission(
  user: User | null | undefined,
  action: Action,
  resource: Resource,
  ctx: PermissionCtx = {},
): boolean {
  if (!user) return false;

  // Super admins bypass everything (support session use-case).
  if (isSuperAdmin(user)) return true;

  // Admin-only resources.
  if (resource === 'admin_console' || resource === 'admin_users' ||
      resource === 'admin_audit'   || resource === 'support_console') {
    if (resource === 'support_console') return isSuperAdmin(user);
    return isAdmin(user);
  }

  // Workspace billing — admin or owner.
  if (resource === 'workspace_billing') {
    return isAdmin(user) || isClient(user);
  }

  // Workspace settings — admin or any client (workspace owner).
  if (resource === 'workspace_settings') {
    return isAdmin(user) || isClient(user);
  }

  // Team Hub resources gate on TeamRole when present.
  if (resource === 'team_board' || resource === 'team_item') {
    if (action === 'read')   return !!ctx.teamRole;
    if (action === 'create' || action === 'update') return teamCanWrite(ctx.teamRole);
    if (action === 'delete' || action === 'manage') return teamCanManage(ctx.teamRole);
  }

  // For everything else (leads, campaigns, sequences, templates, sender
  // accounts, API keys, webhook endpoints, invoices) — any client of the
  // workspace can read/write. RLS at the DB layer enforces workspace
  // scoping; this helper is the "is this user allowed to even see the
  // form?" front-of-house check.
  return isAdmin(user) || isClient(user);
}

// ── Convenience helpers for common UI patterns ──────────────────────────

/** Returns true if the user can mint API keys. */
export const canManageApiKeys = (u: User | null | undefined) =>
  hasPermission(u, 'manage', 'api_key');

/** Returns true if the user can register outbound webhook endpoints. */
export const canManageWebhooks = (u: User | null | undefined) =>
  hasPermission(u, 'manage', 'webhook_endpoint');

/** Admin-console gate. Replaces ad-hoc `user?.role === UserRole.ADMIN`. */
export const canEnterAdmin = (u: User | null | undefined) =>
  hasPermission(u, 'read', 'admin_console');

/** Super-admin-only support console gate. */
export const canEnterSupport = (u: User | null | undefined) =>
  hasPermission(u, 'read', 'support_console');
