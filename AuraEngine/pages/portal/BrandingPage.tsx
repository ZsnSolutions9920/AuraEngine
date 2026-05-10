// AuraEngine/pages/portal/BrandingPage.tsx
//
// Phase 4.6.a (UI) — workspace branding settings.
//
// Logo upload (reuses uploadBase64Image), color pickers for
// primary / accent / background, product name + support email text
// inputs, live preview area showing the colors applied. Save = upsert
// into workspace_branding, then refresh the App-level branding effect
// by reloading.

import React, { useEffect, useState, useRef } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Palette, Upload, Save, Loader2, Image as ImageIcon, Trash2, ExternalLink,
  Globe, ShieldCheck, AlertTriangle, Plus, RefreshCw, Copy, Check,
} from 'lucide-react';
import type { User } from '../../types';
import { supabase } from '../../lib/supabase';
import {
  loadBranding, upsertBranding, applyBrandingToDocument,
  type WorkspaceBranding,
} from '../../lib/branding';
import { uploadBase64Image } from '../../lib/imageUpload';
import {
  listWorkspaceDomains, addWorkspaceDomain, deleteWorkspaceDomain, verifyDomain,
  domainStatusLabel, type WorkspaceDomain,
} from '../../lib/domains';

interface LayoutContext { user: User }

const HEX_RE = /^#[0-9A-Fa-f]{6}$/;

interface FormState {
  logo_url:        string;
  favicon_url:     string;
  email_logo_url:  string;
  primary_color:   string;
  accent_color:    string;
  background_color: string;
  product_name:    string;
  support_email:   string;
}

const EMPTY: FormState = {
  logo_url: '', favicon_url: '', email_logo_url: '',
  primary_color: '', accent_color: '', background_color: '',
  product_name: '', support_email: '',
};

function fromBranding(b: WorkspaceBranding | null): FormState {
  if (!b) return EMPTY;
  return {
    logo_url:         b.logo_url        ?? '',
    favicon_url:      b.favicon_url     ?? '',
    email_logo_url:   b.email_logo_url  ?? '',
    primary_color:    b.primary_color   ?? '',
    accent_color:     b.accent_color    ?? '',
    background_color: b.background_color?? '',
    product_name:     b.product_name    ?? '',
    support_email:    b.support_email   ?? '',
  };
}

const BrandingPage: React.FC = () => {
  const { user } = useOutletContext<LayoutContext>();

  const { data: workspaceId = null } = useQuery<string | null>({
    queryKey: ['branding-workspace', user.id],
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

  const [form, setForm] = useState<FormState>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Load existing branding row.
  useEffect(() => {
    let cancelled = false;
    if (!user.id) return;
    setLoading(true);
    loadBranding(user.id)
      .then((b) => { if (!cancelled) setForm(fromBranding(b)); })
      .catch(() => { /* keep empty form */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [user.id]);

  const update = (k: keyof FormState, v: string) => setForm((s) => ({ ...s, [k]: v }));

  const handleFile = async (file: File | null) => {
    if (!file) return;
    setUploadingLogo(true);
    setError(null);
    try {
      const reader = new FileReader();
      const dataUri: string = await new Promise((resolve, reject) => {
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error('File read failed'));
        reader.readAsDataURL(file);
      });
      const url = await uploadBase64Image(dataUri);
      update('logo_url', url);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploadingLogo(false);
    }
  };

  const handleSave = async () => {
    if (!workspaceId) return;
    setError(null);
    setSuccess(false);
    // Validate hex colors.
    for (const k of ['primary_color', 'accent_color', 'background_color'] as const) {
      const v = form[k];
      if (v && !HEX_RE.test(v)) { setError(`${k} must be a 6-digit hex like #6366f1`); return; }
    }
    setSaving(true);
    try {
      const saved = await upsertBranding(workspaceId, {
        logo_url:         form.logo_url        || null,
        favicon_url:      form.favicon_url     || null,
        email_logo_url:   form.email_logo_url  || null,
        primary_color:    form.primary_color   || null,
        accent_color:     form.accent_color    || null,
        background_color: form.background_color|| null,
        product_name:     form.product_name    || null,
        support_email:    form.support_email   || null,
      });
      // Apply immediately so the user sees the change without reloading.
      applyBrandingToDocument(saved);
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const previewBg = form.background_color || '#f8fafc';
  const previewPrimary = form.primary_color || '#6366f1';
  const previewAccent = form.accent_color || '#f59e0b';

  return (
    <div className="px-6 py-8 max-w-5xl mx-auto space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
          <Palette size={20} className="text-indigo-500" />
          Branding
        </h1>
        <p className="text-slate-600 mt-2 max-w-xl">
          Customise how your workspace looks. Logo, colors, product name. Vanity-domain
          mapping (your-app.acme.com) is a separate setup — coming next.
        </p>
      </header>

      {/* Custom domain — Phase 4.6.b */}
      {workspaceId && <DomainsSection workspaceId={workspaceId} />}

      {loading ? (
        <div className="h-96 rounded-2xl bg-slate-100 animate-pulse" />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Form */}
          <div className="space-y-5">
            {/* Logo */}
            <section className="rounded-2xl border border-slate-200 bg-white p-5 space-y-3">
              <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wide">Header logo</h2>
              {form.logo_url ? (
                <div className="flex items-center gap-3">
                  <img src={form.logo_url} alt="logo" className="h-10 max-w-[160px] object-contain" />
                  <button
                    onClick={() => update('logo_url', '')}
                    className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50"
                    title="Remove"
                  ><Trash2 size={14} /></button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  disabled={uploadingLogo}
                  className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl border-2 border-dashed border-slate-200 text-sm text-slate-500 hover:border-indigo-300 hover:text-indigo-600"
                >
                  {uploadingLogo
                    ? <><Loader2 size={14} className="animate-spin" /> Uploading…</>
                    : <><Upload size={14} /> Upload logo (PNG/SVG/WebP)</>}
                </button>
              )}
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/svg+xml,image/webp,image/jpeg"
                className="hidden"
                onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
              />
              <p className="text-[10px] text-slate-400">Recommended: 32–40px tall, transparent background.</p>
            </section>

            {/* URLs */}
            <section className="rounded-2xl border border-slate-200 bg-white p-5 space-y-3">
              <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wide">Image URLs</h2>
              <Field label="Favicon URL" value={form.favicon_url} onChange={(v) => update('favicon_url', v)} placeholder="https://cdn.example.com/favicon.png" />
              <Field label="Email logo URL" value={form.email_logo_url} onChange={(v) => update('email_logo_url', v)} placeholder="Used in outgoing email footers" />
            </section>

            {/* Colors */}
            <section className="rounded-2xl border border-slate-200 bg-white p-5 space-y-3">
              <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wide">Colors</h2>
              <ColorField label="Primary"    value={form.primary_color}    onChange={(v) => update('primary_color', v)} />
              <ColorField label="Accent"     value={form.accent_color}     onChange={(v) => update('accent_color', v)} />
              <ColorField label="Background" value={form.background_color} onChange={(v) => update('background_color', v)} />
            </section>

            {/* Copy */}
            <section className="rounded-2xl border border-slate-200 bg-white p-5 space-y-3">
              <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wide">Copy</h2>
              <Field label="Product name" value={form.product_name} onChange={(v) => update('product_name', v)} placeholder="Powers in-product references (e.g. browser tab title)" />
              <Field label="Support email" value={form.support_email} onChange={(v) => update('support_email', v)} placeholder="Shown in error states + email footers" />
            </section>

            {error && <div className="text-sm text-rose-600 bg-rose-50 border border-rose-200 rounded-xl p-3">{error}</div>}
            {success && <div className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl p-3">Saved.</div>}

            <button
              onClick={handleSave}
              disabled={saving || !workspaceId}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-slate-900 text-white text-sm font-semibold hover:bg-slate-800 disabled:opacity-50"
            >
              {saving ? <><Loader2 size={14} className="animate-spin" /> Saving…</> : <><Save size={14} /> Save branding</>}
            </button>
          </div>

          {/* Live preview */}
          <div className="rounded-2xl border border-slate-200 bg-white p-5 sticky top-6 self-start">
            <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wide mb-3">Live preview</h2>
            <div
              className="rounded-xl p-5 border border-slate-100 space-y-3"
              style={{ background: previewBg }}
            >
              <div className="flex items-center gap-2">
                {form.logo_url
                  ? <img src={form.logo_url} alt="logo" className="h-8" />
                  : <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: previewPrimary, color: 'white' }}>
                      <ImageIcon size={14} />
                    </div>}
                <span className="text-sm font-bold text-slate-900">{form.product_name || 'Scaliyo'}</span>
              </div>
              <button
                type="button"
                className="px-3 py-1.5 rounded-lg text-xs font-bold text-white"
                style={{ background: previewPrimary }}
                onClick={(e) => e.preventDefault()}
              >
                Primary action
              </button>
              <button
                type="button"
                className="ml-2 px-3 py-1.5 rounded-lg text-xs font-bold text-white"
                style={{ background: previewAccent }}
                onClick={(e) => e.preventDefault()}
              >
                Accent action
              </button>
              <div className="text-[11px] text-slate-500 mt-2">
                {form.support_email ? <>Need help? <a href={`mailto:${form.support_email}`} style={{ color: previewPrimary }}>{form.support_email}</a></> : 'No support email set.'}
              </div>
            </div>
            <p className="text-[10px] text-slate-400 mt-3 inline-flex items-center gap-1">
              <ExternalLink size={10} /> Changes apply globally on save.
            </p>
          </div>
        </div>
      )}
    </div>
  );
};

// ── Tiny field components ───────────────────────────────────────────────

const Field: React.FC<{
  label: string; value: string; onChange: (v: string) => void; placeholder?: string;
}> = ({ label, value, onChange, placeholder }) => (
  <div>
    <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wide mb-1">{label}</label>
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-indigo-500"
    />
  </div>
);

const ColorField: React.FC<{
  label: string; value: string; onChange: (v: string) => void;
}> = ({ label, value, onChange }) => (
  <div>
    <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wide mb-1">{label}</label>
    <div className="flex items-center gap-2">
      <input
        type="color"
        value={value || '#6366f1'}
        onChange={(e) => onChange(e.target.value)}
        className="w-10 h-9 rounded-lg border border-slate-200 cursor-pointer"
      />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="#6366f1 (leave blank for default)"
        className="flex-1 px-3 py-2 rounded-xl border border-slate-200 text-sm font-mono focus:outline-none focus:border-indigo-500"
      />
      {value && (
        <button onClick={() => onChange('')} className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50" title="Clear">
          <Trash2 size={14} />
        </button>
      )}
    </div>
  </div>
);

// ── Custom-domain section ───────────────────────────────────────────────

const DomainsSection: React.FC<{ workspaceId: string }> = ({ workspaceId }) => {
  const [domains, setDomains] = useState<WorkspaceDomain[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [verifying, setVerifying] = useState<string | null>(null);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);
  const [verifyResult, setVerifyResult] = useState<Record<string, string>>({});

  const refresh = async () => {
    setLoading(true);
    try { setDomains(await listWorkspaceDomains(workspaceId)); }
    finally { setLoading(false); }
  };

  useEffect(() => { refresh(); }, [workspaceId]);

  const handleVerify = async (id: string) => {
    setVerifying(id);
    setVerifyResult((s) => ({ ...s, [id]: '' }));
    try {
      const r = await verifyDomain(id);
      setVerifyResult((s) => ({
        ...s,
        [id]: r.verified ? `Verified via ${r.method?.toUpperCase()}` : (r.error ?? 'Not yet'),
      }));
      await refresh();
    } catch (e) {
      setVerifyResult((s) => ({ ...s, [id]: (e as Error).message }));
    } finally {
      setVerifying(null);
    }
  };

  const handleDelete = async (d: WorkspaceDomain) => {
    if (!confirm(`Remove ${d.domain}? Traffic to this domain will stop working.`)) return;
    await deleteWorkspaceDomain(d.id);
    refresh();
  };

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wide flex items-center gap-2">
            <Globe size={14} className="text-indigo-500" /> Custom domain
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            Map a domain you control (e.g. <code className="font-mono">app.yourcompany.com</code>) to your Scaliyo workspace.
          </p>
        </div>
        <button
          onClick={() => setShowAdd(true)}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800"
        >
          <Plus size={12} /> Add domain
        </button>
      </div>

      {loading ? (
        <div className="h-12 bg-slate-100 rounded-xl animate-pulse" />
      ) : domains.length === 0 ? (
        <p className="text-xs text-slate-400 italic">No custom domains yet.</p>
      ) : (
        <div className="space-y-2">
          {domains.map((d) => {
            const status = domainStatusLabel(d);
            const txtName = `_scaliyo-verify.${d.domain}`;
            return (
              <div key={d.id} className="rounded-xl border border-slate-200 p-3 space-y-2">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-mono text-sm font-medium truncate">{d.domain}</span>
                    <span className={`px-2 py-0.5 rounded-full bg-${status.tone}-50 text-${status.tone}-700 text-[10px] font-bold`}>
                      {status.label}
                    </span>
                    {d.cert_expires_at && (
                      <span className="text-[10px] text-slate-400 inline-flex items-center gap-1">
                        <ShieldCheck size={10} /> renews {new Date(d.cert_expires_at).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    {d.status !== 'verified' && (
                      <button
                        onClick={() => handleVerify(d.id)}
                        disabled={verifying === d.id}
                        className="px-2 py-1 rounded-lg bg-indigo-50 text-indigo-700 text-xs font-semibold hover:bg-indigo-100 disabled:opacity-50 inline-flex items-center gap-1"
                      >
                        {verifying === d.id ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                        Verify
                      </button>
                    )}
                    <button
                      onClick={() => handleDelete(d)}
                      className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50"
                      title="Remove"
                    ><Trash2 size={12} /></button>
                  </div>
                </div>

                {verifyResult[d.id] && (
                  <div className={`text-[11px] px-2 py-1 rounded ${
                    verifyResult[d.id].startsWith('Verified') ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-800'
                  }`}>
                    {verifyResult[d.id]}
                  </div>
                )}

                {/* DNS instructions: only show until verified */}
                {d.status !== 'verified' && (
                  <div className="bg-slate-50 rounded-lg p-3 space-y-2 text-xs">
                    <p className="font-semibold text-slate-700 inline-flex items-center gap-1">
                      <AlertTriangle size={11} className="text-amber-500" /> Add ONE of these DNS records, then click Verify
                    </p>
                    <div className="font-mono text-[11px] grid gap-1">
                      <DnsRow
                        label="TXT"
                        host={txtName}
                        value={d.verification_token}
                        copied={copiedToken === d.id ? 'value' : null}
                        onCopy={(what) => {
                          navigator.clipboard.writeText(what === 'host' ? txtName : d.verification_token);
                          setCopiedToken(d.id);
                          setTimeout(() => setCopiedToken(null), 2000);
                        }}
                      />
                      <p className="text-[10px] text-slate-400">— or —</p>
                      <DnsRow
                        label="CNAME"
                        host={d.domain}
                        value="app.scaliyo.com"
                        copied={null}
                        onCopy={(what) => {
                          navigator.clipboard.writeText(what === 'host' ? d.domain : 'app.scaliyo.com');
                        }}
                      />
                    </div>
                  </div>
                )}

                {d.last_provision_error && !d.provisioned_at && (
                  <div className="text-[11px] bg-rose-50 text-rose-700 px-2 py-1 rounded">
                    Provision error: {d.last_provision_error}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {showAdd && (
        <AddDomainModal
          workspaceId={workspaceId}
          onClose={() => setShowAdd(false)}
          onAdded={() => { setShowAdd(false); refresh(); }}
        />
      )}
    </section>
  );
};

const DnsRow: React.FC<{
  label: string; host: string; value: string;
  copied: 'host' | 'value' | null;
  onCopy: (which: 'host' | 'value') => void;
}> = ({ label, host, value, copied, onCopy }) => (
  <div className="flex items-center gap-2">
    <span className="px-1.5 py-0.5 rounded bg-slate-200 text-slate-700 text-[10px] font-bold w-12 text-center">{label}</span>
    <button onClick={() => onCopy('host')} className="text-slate-700 hover:text-indigo-600 truncate flex-1 text-left">
      {host}
    </button>
    <span className="text-slate-400">→</span>
    <button onClick={() => onCopy('value')} className="text-slate-700 hover:text-indigo-600 truncate flex-1 text-left">
      {value}
    </button>
    <span className="text-slate-400 shrink-0">
      {copied ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
    </span>
  </div>
);

const AddDomainModal: React.FC<{
  workspaceId: string; onClose: () => void; onAdded: () => void;
}> = ({ workspaceId, onClose, onAdded }) => {
  const [domain, setDomain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handleAdd = async () => {
    setError(null);
    if (!domain.trim()) { setError('Domain is required'); return; }
    setBusy(true);
    try {
      await addWorkspaceDomain(workspaceId, domain.trim().toLowerCase());
      onAdded();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="fixed inset-0 z-[9998] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl max-w-md w-full p-6 space-y-4">
        <h3 className="text-lg font-bold text-slate-900">Add custom domain</h3>
        <div>
          <label className="block text-xs font-bold text-slate-500 uppercase tracking-wide mb-1">Domain</label>
          <input
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="app.yourcompany.com"
            className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm font-mono focus:outline-none focus:border-indigo-500"
            autoFocus
          />
          <p className="text-xs text-slate-400 mt-1">After adding, you'll be shown DNS records to add at your domain registrar. The cert is issued automatically once DNS is verified.</p>
        </div>
        {error && <div className="text-sm text-rose-600 bg-rose-50 border border-rose-200 rounded-lg p-2">{error}</div>}
        <div className="flex items-center gap-2 pt-2">
          <button onClick={onClose} className="flex-1 px-4 py-2.5 rounded-xl border border-slate-200 text-sm font-semibold hover:bg-slate-50">Cancel</button>
          <button onClick={handleAdd} disabled={busy} className="flex-1 px-4 py-2.5 rounded-xl bg-slate-900 text-white text-sm font-semibold hover:bg-slate-800 disabled:opacity-50">
            {busy ? 'Adding…' : 'Add domain'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default BrandingPage;
