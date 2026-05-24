// AuraEngine/lib/memory.ts
//
// AI Memory Layer — Phase 1.
//
// Three scopes (workspace_memory / lead_memory / campaign_memory) backed by
// the migration 20260508000000_ai_memory_layer.sql. This module exposes a
// thin, typed API for reading and writing memory plus a `buildMemoryContext`
// helper that turns recalled rows into a system-prompt fragment for Gemini.
//
// Phase 2 will add embedding-based retrieval. Until then we filter by
// workspace + kind + tags and return the most-recent / highest-confidence
// rows. This is intentionally simple: the schema reserves `embedding_meta`
// JSONB and a follow-up migration will add the pgvector column.

import { supabase } from './supabase';

export type MemoryScope = 'workspace' | 'lead' | 'campaign';

// ── Workspace resolution ────────────────────────────────────────────────────
// Mirrors the resolveWorkspaceId helper in lib/credits.ts. Kept here so memory
// callers don't need to import from credits. Cached per page lifetime via the
// _wsCache map below — workspace membership rarely changes within a session.

const _wsCache = new Map<string, string | null>();

export async function resolveWorkspaceForUser(userId: string): Promise<string | null> {
  if (_wsCache.has(userId)) return _wsCache.get(userId)!;
  const { data, error } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) {
    _wsCache.set(userId, null);
    return null;
  }
  const ws = (data?.workspace_id as string | undefined) ?? null;
  _wsCache.set(userId, ws);
  return ws;
}

/**
 * Idempotent self-service recovery: creates a workspace + owner membership
 * for the currently authenticated user if they're not yet a member of one.
 * Optional `name` sets the display name on first creation; subsequent calls
 * return the existing workspace unchanged. Clears the in-memory cache so
 * the next resolveWorkspaceForUser() call hits the DB.
 *
 * Wrapped in a 10s timeout via Promise.race so the UI never spins forever
 * if Supabase / network is unhealthy. Logs both the raw rpc result and any
 * timeout to console for in-the-browser diagnosis.
 */
export async function createMyWorkspace(
  userId: string,
  name?: string,
): Promise<{ workspaceId: string; created: boolean; name: string; leadsAdopted: number }> {
  const trimmed = name?.trim();
  console.log('[createMyWorkspace] calling rpc with', { p_name: trimmed || null });

  const rpcCall = supabase.rpc('create_my_workspace', {
    p_name: trimmed || null,
  });

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('create_my_workspace timed out after 10s')), 10_000),
  );

  const { data, error } = (await Promise.race([rpcCall, timeout])) as Awaited<typeof rpcCall>;
  console.log('[createMyWorkspace] rpc returned', { data, error });

  if (error) throw new Error(`${error.code ?? ''} ${error.message}`.trim());
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.workspace_id) throw new Error('RPC returned no workspace_id (data=' + JSON.stringify(data) + ')');
  _wsCache.delete(userId);
  return {
    workspaceId: row.workspace_id as string,
    created: row.created === true,
    name: (row.name as string) ?? 'My Workspace',
    leadsAdopted: typeof row.leads_adopted === 'number' ? row.leads_adopted : 0,
  };
}

export interface WorkspaceMemoryRow {
  id: string;
  workspace_id: string;
  kind: string;
  key: string | null;
  value: unknown;
  source: string | null;
  confidence: number;
  tags: string[];
  created_at: string;
  updated_at: string;
  expires_at: string | null;
}

export interface LeadMemoryRow {
  id: string;
  workspace_id: string;
  lead_id: string;
  kind: string;
  value: unknown;
  source: string | null;
  confidence: number;
  tags: string[];
  occurred_at: string | null;
  created_at: string;
}

export interface CampaignMemoryRow {
  id: string;
  workspace_id: string;
  campaign_kind: string;
  campaign_id: string;
  kind: string;
  value: unknown;
  metric_value: number | null;
  source: string | null;
  confidence: number;
  tags: string[];
  observed_at: string;
  created_at: string;
}

// ── Workspace memory ──

export async function recallWorkspaceMemory(opts: {
  workspaceId: string;
  kinds?: string[];
  tags?: string[];
  limit?: number;
}): Promise<WorkspaceMemoryRow[]> {
  let q = supabase
    .from('workspace_memory')
    .select('*')
    .eq('workspace_id', opts.workspaceId)
    .order('updated_at', { ascending: false })
    .limit(opts.limit ?? 25);
  if (opts.kinds?.length) q = q.in('kind', opts.kinds);
  if (opts.tags?.length) q = q.contains('tags', opts.tags);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as WorkspaceMemoryRow[];
}

export async function rememberWorkspace(opts: {
  workspaceId: string;
  kind: string;
  value: unknown;
  key?: string;
  source?: string;
  confidence?: number;
  tags?: string[];
  expiresAt?: Date;
}): Promise<void> {
  const { error } = await supabase.from('workspace_memory').insert({
    workspace_id: opts.workspaceId,
    kind: opts.kind,
    key: opts.key ?? null,
    value: opts.value,
    source: opts.source ?? 'user',
    confidence: opts.confidence ?? 0.7,
    tags: opts.tags ?? [],
    expires_at: opts.expiresAt?.toISOString() ?? null,
  });
  if (error) throw error;
}

// ── Lead memory ──

export async function recallLeadMemory(opts: {
  workspaceId: string;
  leadId: string;
  kinds?: string[];
  limit?: number;
}): Promise<LeadMemoryRow[]> {
  let q = supabase
    .from('lead_memory')
    .select('*')
    .eq('workspace_id', opts.workspaceId)
    .eq('lead_id', opts.leadId)
    .order('created_at', { ascending: false })
    .limit(opts.limit ?? 25);
  if (opts.kinds?.length) q = q.in('kind', opts.kinds);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as LeadMemoryRow[];
}

export async function rememberLead(opts: {
  workspaceId: string;
  leadId: string;
  kind: string;
  value: unknown;
  source?: string;
  confidence?: number;
  tags?: string[];
  occurredAt?: Date;
}): Promise<void> {
  const { error } = await supabase.from('lead_memory').insert({
    workspace_id: opts.workspaceId,
    lead_id: opts.leadId,
    kind: opts.kind,
    value: opts.value,
    source: opts.source ?? 'system',
    confidence: opts.confidence ?? 0.7,
    tags: opts.tags ?? [],
    occurred_at: opts.occurredAt?.toISOString() ?? null,
  });
  if (error) throw error;
}

// ── Campaign memory ──

export async function recallCampaignMemory(opts: {
  workspaceId: string;
  campaignKind?: string;
  campaignId?: string;
  kinds?: string[];
  limit?: number;
}): Promise<CampaignMemoryRow[]> {
  let q = supabase
    .from('campaign_memory')
    .select('*')
    .eq('workspace_id', opts.workspaceId)
    .order('observed_at', { ascending: false })
    .limit(opts.limit ?? 25);
  if (opts.campaignKind) q = q.eq('campaign_kind', opts.campaignKind);
  if (opts.campaignId) q = q.eq('campaign_id', opts.campaignId);
  if (opts.kinds?.length) q = q.in('kind', opts.kinds);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as CampaignMemoryRow[];
}

export async function rememberCampaign(opts: {
  workspaceId: string;
  campaignKind: string;
  campaignId: string;
  kind: string;
  value: unknown;
  metricValue?: number;
  source?: string;
  confidence?: number;
  tags?: string[];
}): Promise<void> {
  const { error } = await supabase.from('campaign_memory').insert({
    workspace_id: opts.workspaceId,
    campaign_kind: opts.campaignKind,
    campaign_id: opts.campaignId,
    kind: opts.kind,
    value: opts.value,
    metric_value: opts.metricValue ?? null,
    source: opts.source ?? 'system',
    confidence: opts.confidence ?? 0.7,
    tags: opts.tags ?? [],
  });
  if (error) throw error;
}

// ── Prompt context builder ──
//
// Pull the most relevant rows for a Gemini call and turn them into a compact
// system-prompt fragment. Caller passes the workspace + optional lead/campaign
// scope. Result is empty-string-safe to drop in unconditionally.

export async function buildMemoryContext(opts: {
  workspaceId: string;
  leadId?: string;
  campaignKind?: string;
  campaignId?: string;
  workspaceKinds?: string[];
}): Promise<string> {
  const [ws, lead, campaign] = await Promise.all([
    recallWorkspaceMemory({
      workspaceId: opts.workspaceId,
      kinds: opts.workspaceKinds,
      limit: 12,
    }).catch(() => []),
    opts.leadId
      ? recallLeadMemory({
          workspaceId: opts.workspaceId,
          leadId: opts.leadId,
          limit: 8,
        }).catch(() => [])
      : Promise.resolve([] as LeadMemoryRow[]),
    opts.campaignId && opts.campaignKind
      ? recallCampaignMemory({
          workspaceId: opts.workspaceId,
          campaignKind: opts.campaignKind,
          campaignId: opts.campaignId,
          limit: 8,
        }).catch(() => [])
      : Promise.resolve([] as CampaignMemoryRow[]),
  ]);

  const sections: string[] = [];

  if (ws.length) {
    sections.push(
      'WORKSPACE MEMORY (preferences, tone, winning patterns):\n' +
        ws
          .map((r) => `- [${r.kind}${r.key ? `:${r.key}` : ''}] ${stringify(r.value)}`)
          .join('\n'),
    );
  }
  if (lead.length) {
    sections.push(
      'LEAD MEMORY (prior interactions and signals for this lead):\n' +
        lead.map((r) => `- [${r.kind}] ${stringify(r.value)}`).join('\n'),
    );
  }
  if (campaign.length) {
    sections.push(
      'CAMPAIGN MEMORY (what has worked here before):\n' +
        campaign
          .map(
            (r) =>
              `- [${r.kind}${r.metric_value != null ? ` ${r.metric_value}` : ''}] ${stringify(r.value)}`,
          )
          .join('\n'),
    );
  }

  return sections.length ? `\n\n${sections.join('\n\n')}` : '';
}

function stringify(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
