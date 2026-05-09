// AuraEngine/pages/portal/ApiKeysPage.tsx
//
// Phase 4.1 — API key management UI.
//
//   - List existing keys (label, prefix, scopes, last_used, expiry, revoke)
//   - Mint a new key: choose label, scopes, optional expiry
//   - Show the plaintext exactly once after mint; user must copy it now.
//
// Plaintext is never re-fetchable — the migration only stores the hash.

import React, { useEffect, useState, useCallback } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Key, Plus, Trash2, Check, Clipboard, AlertTriangle, ShieldCheck } from 'lucide-react';
import type { User } from '../../types';
import { supabase } from '../../lib/supabase';
import {
  listApiKeys, createApiKey, revokeApiKey, SCOPES, type ApiKeyRow, type ApiScope,
} from '../../lib/apiKeys';

interface LayoutContext { user: User }

const ApiKeysPage: React.FC = () => {
  const { user } = useOutletContext<LayoutContext>();

  // Resolve workspace id (matches resolveWorkspaceForUser pattern in lib/memory.ts).
  const { data: workspaceId } = useQuery<string | null>({
    queryKey: ['api-keys-workspace', user.id],
    queryFn: async () => {
      const { data } = await supabase
        .from('workspace_members')
        .select('workspace_id')
        .eq('user_id', user.id)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();
      return (data?.workspace_id as string | undefined) ?? null;
    },
    staleTime: 5 * 60_000,
  });

  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [justCreatedToken, setJustCreatedToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    try {
      setKeys(await listApiKeys(workspaceId));
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { refresh(); }, [refresh]);

  const handleRevoke = async (id: string, label: string) => {
    if (!confirm(`Revoke "${label}"? This cannot be undone — apps using this key will stop working immediately.`)) return;
    await revokeApiKey(id);
    refresh();
  };

  const activeKeys = keys.filter((k) => !k.revoked_at);
  const revokedKeys = keys.filter((k) => k.revoked_at);

  return (
    <div className="px-6 py-8 max-w-5xl mx-auto space-y-6">
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
            <Key size={20} className="text-indigo-500" />
            API Keys
          </h1>
          <p className="text-slate-600 mt-2 max-w-xl">
            Personal access tokens for the public REST API. Use these to read leads, build
            integrations, or automate workflows from your own tools.
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          disabled={!workspaceId}
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-slate-900 text-white text-sm font-semibold hover:bg-slate-800 transition disabled:opacity-50"
        >
          <Plus size={16} /> New API key
        </button>
      </header>

      {/* Documentation hint */}
      <div className="p-4 rounded-xl border border-slate-200 bg-slate-50 text-sm text-slate-700">
        <p className="font-semibold flex items-center gap-1.5 mb-1">
          <ShieldCheck size={14} className="text-emerald-500" />
          How to authenticate
        </p>
        <pre className="text-xs bg-white border border-slate-200 rounded-lg p-2 mt-1 overflow-x-auto"><code>{`curl https://utvydxqiqedaaxmmpfpf.functions.supabase.co/v1-leads \\
  -H "Authorization: Bearer scal_..."`}</code></pre>
        <p className="text-xs text-slate-500 mt-2">
          Endpoints: <code className="font-mono">v1-leads</code>, <code className="font-mono">v1-sequences</code>, <code className="font-mono">v1-campaigns</code>, <code className="font-mono">v1-analytics</code>.
          Rate limit: 60 req/min/key.
          {' '}<a href="https://github.com/ZsnSolutions9920/AuraEngine/blob/main/docs/api/openapi.yaml" target="_blank" rel="noopener noreferrer" className="text-indigo-600 hover:underline">OpenAPI 3.1 spec ↗</a>
        </p>
      </div>

      {/* Active keys */}
      <section>
        <h2 className="text-sm font-bold text-slate-500 uppercase tracking-wide mb-3">
          Active ({activeKeys.length})
        </h2>
        {loading ? (
          <div className="h-24 rounded-2xl bg-slate-100 animate-pulse" />
        ) : activeKeys.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-200 p-8 text-center text-sm text-slate-500">
            No API keys yet. Create one to start using the public API.
          </div>
        ) : (
          <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs font-semibold text-slate-500 uppercase tracking-wide">
                <tr>
                  <th className="px-4 py-2.5 text-left">Label</th>
                  <th className="px-4 py-2.5 text-left">Prefix</th>
                  <th className="px-4 py-2.5 text-left">Scopes</th>
                  <th className="px-4 py-2.5 text-left">Last used</th>
                  <th className="px-4 py-2.5 text-left">Expires</th>
                  <th className="px-4 py-2.5"></th>
                </tr>
              </thead>
              <tbody>
                {activeKeys.map((k) => (
                  <tr key={k.id} className="border-t border-slate-100">
                    <td className="px-4 py-3 font-medium text-slate-900">{k.label}</td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-600">{k.key_prefix}…</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {k.scopes.map((s) => (
                          <span key={s} className="px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 text-[10px] font-semibold">{s}</span>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500">
                      {k.last_used_at ? new Date(k.last_used_at).toLocaleString() : 'never'}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500">
                      {k.expires_at ? new Date(k.expires_at).toLocaleDateString() : 'never'}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => handleRevoke(k.id, k.label)}
                        className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition"
                        title="Revoke"
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Revoked keys (collapsed display) */}
      {revokedKeys.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-slate-500 font-semibold">
            Revoked ({revokedKeys.length})
          </summary>
          <div className="mt-2 rounded-2xl border border-slate-200 bg-slate-50 overflow-hidden">
            <table className="w-full text-sm">
              <tbody>
                {revokedKeys.map((k) => (
                  <tr key={k.id} className="border-t border-slate-100 first:border-t-0">
                    <td className="px-4 py-2.5 text-slate-500">{k.label}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-slate-400">{k.key_prefix}…</td>
                    <td className="px-4 py-2.5 text-xs text-slate-400">
                      revoked {k.revoked_at ? new Date(k.revoked_at).toLocaleString() : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {/* Create modal */}
      {showCreate && workspaceId && (
        <CreateKeyModal
          workspaceId={workspaceId}
          onClose={() => setShowCreate(false)}
          onCreated={(plaintext) => {
            setShowCreate(false);
            setJustCreatedToken(plaintext);
            refresh();
          }}
        />
      )}

      {/* "Copy this now" modal — only shown once per fresh mint */}
      {justCreatedToken && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50" onClick={() => setJustCreatedToken(null)} />
          <div className="relative bg-white rounded-2xl shadow-2xl max-w-lg w-full p-6 space-y-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="text-amber-500 shrink-0" size={22} />
              <div>
                <h3 className="text-lg font-bold text-slate-900">Save this key now</h3>
                <p className="text-sm text-slate-600 mt-1">
                  This is the only time the full key is visible. After you close this dialog,
                  only the prefix will be shown — there's no way to recover the full token.
                </p>
              </div>
            </div>
            <pre className="bg-slate-900 text-emerald-300 rounded-xl p-3 font-mono text-xs break-all whitespace-pre-wrap">{justCreatedToken}</pre>
            <div className="flex items-center gap-2">
              <button
                onClick={async () => {
                  await navigator.clipboard.writeText(justCreatedToken);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }}
                className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-slate-900 text-white text-sm font-semibold hover:bg-slate-800"
              >
                {copied ? <><Check size={14} /> Copied</> : <><Clipboard size={14} /> Copy</>}
              </button>
              <button
                onClick={() => setJustCreatedToken(null)}
                className="px-4 py-2.5 rounded-xl border border-slate-200 text-sm font-semibold hover:bg-slate-50"
              >
                I've saved it
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ── Create-key modal ─────────────────────────────────────────────────────

const CreateKeyModal: React.FC<{
  workspaceId: string;
  onClose: () => void;
  onCreated: (plaintext: string) => void;
}> = ({ workspaceId, onClose, onCreated }) => {
  const [label, setLabel] = useState('');
  const [scopes, setScopes] = useState<ApiScope[]>(['leads.read']);
  const [expiry, setExpiry] = useState<string>(''); // ISO date string or ''
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleScope = (s: ApiScope) => {
    setScopes((prev) => prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]);
  };

  const handleCreate = async () => {
    if (!label.trim()) { setError('Label is required'); return; }
    if (scopes.length === 0) { setError('Pick at least one scope'); return; }
    setCreating(true);
    setError(null);
    try {
      const { plaintext } = await createApiKey({
        workspaceId,
        label: label.trim(),
        scopes,
        expiresAt: expiry ? new Date(expiry) : null,
      });
      onCreated(plaintext);
    } catch (e) {
      setError((e as Error).message || 'Failed to create key');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[9998] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl max-w-md w-full p-6 space-y-4">
        <h3 className="text-lg font-bold text-slate-900">New API key</h3>

        <div>
          <label className="block text-xs font-bold text-slate-500 uppercase tracking-wide mb-1">Label</label>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Production webhook"
            className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-indigo-500"
            autoFocus
          />
        </div>

        <div>
          <label className="block text-xs font-bold text-slate-500 uppercase tracking-wide mb-1">Scopes</label>
          <div className="space-y-1.5">
            {SCOPES.map((s) => (
              <label key={s} className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={scopes.includes(s)}
                  onChange={() => toggleScope(s)}
                  className="rounded"
                />
                <span className="font-mono text-slate-700">{s}</span>
              </label>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-xs font-bold text-slate-500 uppercase tracking-wide mb-1">Expires (optional)</label>
          <input
            type="date"
            value={expiry}
            onChange={(e) => setExpiry(e.target.value)}
            className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-indigo-500"
          />
          <p className="text-xs text-slate-400 mt-1">Leave blank to never expire.</p>
        </div>

        {error && <div className="text-sm text-rose-600 bg-rose-50 border border-rose-200 rounded-lg p-2">{error}</div>}

        <div className="flex items-center gap-2 pt-2">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2.5 rounded-xl border border-slate-200 text-sm font-semibold hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={creating}
            className="flex-1 px-4 py-2.5 rounded-xl bg-slate-900 text-white text-sm font-semibold hover:bg-slate-800 disabled:opacity-50"
          >
            {creating ? 'Creating…' : 'Create key'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ApiKeysPage;
