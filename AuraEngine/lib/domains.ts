// AuraEngine/lib/domains.ts
//
// Phase 4.6.b — workspace vanity domain management.

import { supabase } from './supabase';

export interface WorkspaceDomain {
  id: string;
  workspace_id: string;
  domain: string;
  verification_token: string;
  status: 'pending' | 'verified' | 'failed' | 'expired';
  is_primary: boolean;
  verified_at: string | null;
  last_check_at: string | null;
  last_check_error: string | null;
  provisioned_at: string | null;
  cert_expires_at: string | null;
  last_provision_at: string | null;
  last_provision_error: string | null;
  created_at: string;
}

export async function listWorkspaceDomains(workspaceId: string): Promise<WorkspaceDomain[]> {
  const { data, error } = await supabase
    .from('workspace_domains')
    .select('*')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as WorkspaceDomain[];
}

export async function addWorkspaceDomain(
  workspaceId: string,
  domain: string,
): Promise<WorkspaceDomain> {
  const { data, error } = await supabase.rpc('add_workspace_domain', {
    p_workspace_id: workspaceId,
    p_domain:       domain,
  });
  if (error) throw error;
  return data as WorkspaceDomain;
}

export async function deleteWorkspaceDomain(id: string): Promise<void> {
  const { error } = await supabase.from('workspace_domains').delete().eq('id', id);
  if (error) throw error;
}

/**
 * Invokes the verify-domain edge function. Returns the verification result.
 * Caller refetches the domain list afterwards to see the updated status.
 */
export async function verifyDomain(domainId: string): Promise<{
  verified: boolean;
  method?: 'txt' | 'cname';
  error?: string;
  expected_txt?:   { name: string; value: string };
  expected_cname?: { name: string; value: string };
}> {
  const { data, error } = await supabase.functions.invoke('verify-domain', {
    body: { domain_id: domainId },
  });
  if (error) throw new Error(error.message ?? 'verify-domain failed');
  return data;
}

/**
 * Domain status as a single derived label, useful for UI badges.
 */
export function domainStatusLabel(d: WorkspaceDomain): {
  label: string; tone: 'slate' | 'amber' | 'emerald' | 'rose' | 'indigo';
} {
  if (d.last_provision_error && !d.provisioned_at) return { label: 'Provision failed', tone: 'rose' };
  if (d.provisioned_at) return { label: 'Live', tone: 'emerald' };
  if (d.status === 'verified') return { label: 'Issuing cert…', tone: 'indigo' };
  if (d.status === 'failed') return { label: 'Verify failed', tone: 'rose' };
  if (d.status === 'expired') return { label: 'Expired', tone: 'amber' };
  return { label: 'Awaiting DNS', tone: 'slate' };
}
