// AuraEngine/pages/portal/QuickLaunchPage.tsx
//
// Single-page "import + generate + launch" demo flow. The page lands with
// sample leads + a pre-rendered sample sequence so anyone (a prospect,
// a teammate, you) can SEE the value before touching a thing — then
// swap the audience in, edit the offer, regenerate, launch.
//
// Three sections, all visible on one page, progressively enabled:
//   1. Audience    — sample / existing leads / paste emails / CSV import
//   2. Offer       — one-line goal + tone + cadence + length
//   3. Sequence    — preview AI emails, regenerate, launch
//
// For the sample-data path we skip the network round-trip entirely:
// the preview shows a hand-written 3-step demo so the page renders
// instantly. The "Launch sequence" button is gated to real leads.
// Real leads → generateEmailSequence (Gemini) → start-email-sequence-run.

import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { useOutletContext, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Rocket, Users, Upload, Clipboard, Sparkles, Loader2, Mail, Send,
  RefreshCw, Check, Info, AlertCircle, ArrowRight, Zap,
} from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { resolveWorkspaceForUser, createMyWorkspace } from '../../lib/memory';
import {
  generateEmailSequence, parseEmailSequenceResponse,
} from '../../lib/gemini';
import { ToneType, type User, type EmailSequenceConfig, type Lead } from '../../types';

// Local sequence-step shape — matches the start-email-sequence-run edge
// fn payload (stepIndex + delayDays). Distinct from the global EmailStep
// type which uses string delays for the ContentGen wizard.
interface SequenceStep {
  stepIndex: number;
  delayDays: number;
  subject: string;
  body: string;
}
import ImportLeadsWizard from '../../components/portal/ImportLeadsWizard';

interface LayoutContext { user: User }

type AudienceMode = 'sample' | 'existing' | 'paste' | 'import';

const SAMPLE_LEADS: Lead[] = [
  {
    id: 'sample-1', client_id: '', first_name: 'Maya', last_name: 'Reyes',
    primary_email: 'maya@northwind-saas.io', primary_phone: '', company: 'Northwind SaaS',
    score: 86, status: 'New', last_activity: '', insights: 'Recently raised Series A; growing GTM team', title: 'VP of Growth',
    industry: 'B2B SaaS',
  },
  {
    id: 'sample-2', client_id: '', first_name: 'Daniel', last_name: 'Okafor',
    primary_email: 'daniel.o@apexpilot.co', primary_phone: '', company: 'Apex Pilot',
    score: 72, status: 'New', last_activity: '', insights: 'Posted on LinkedIn about scaling outbound; pain around personalization', title: 'Head of Sales',
    industry: 'Fintech',
  },
  {
    id: 'sample-3', client_id: '', first_name: 'Priya', last_name: 'Shah',
    primary_email: 'priya@lattice-ai.dev', primary_phone: '', company: 'Lattice AI',
    score: 91, status: 'New', last_activity: '', insights: 'Currently uses Outreach; evaluating consolidation', title: 'CRO',
    industry: 'AI Tools',
  },
];

const SAMPLE_STEPS: SequenceStep[] = [
  {
    stepIndex: 1, delayDays: 0,
    subject: 'Quick thought, {{first_name}}',
    body: `Hi {{first_name}},\n\nNoticed {{company}} is scaling its outbound — congrats on the recent traction.\n\nMost growth teams hit the same wall: personalization at scale either eats hours or feels generic. We built Scaliyo to fix that — AI that reads each lead's signal and writes the sequence around it.\n\nWorth a 15-min look next week?\n\nAly`,
  },
  {
    stepIndex: 2, delayDays: 2,
    subject: 'Quick example for {{company}}',
    body: `Hi {{first_name}},\n\nFollowing up — wanted to show you the kind of personalization we'd produce for {{company}}.\n\nThe AI reads your lead's LinkedIn + funding stage + recent posts and writes the opener around it. No templates, no manual research per lead.\n\nIf you'd like to see a sample output for 10 of your real prospects, I can send it tomorrow.`,
  },
  {
    stepIndex: 3, delayDays: 4,
    subject: 'Last note',
    body: `Hi {{first_name}},\n\nLast note from me — I won't keep pinging.\n\nIf scaling outbound personalization is on the roadmap for {{company}} in the next quarter, here's a 90-sec walkthrough: scaliyo.com/demo.\n\nIf not the right time, totally fine — happy to reconnect later.\n\nAly`,
  },
];

const QuickLaunchPage: React.FC = () => {
  const { user } = useOutletContext<LayoutContext>();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const { data: workspaceId = null, refetch: refetchWorkspace } = useQuery<string | null>({
    queryKey: ['quick-launch-workspace', user.id],
    queryFn: () => resolveWorkspaceForUser(user.id),
    staleTime: 5 * 60_000,
  });

  // ─── Workspace recovery (for accounts that pre-date the signup trigger) ─
  const [wsName, setWsName] = useState('');
  const [creatingWs, setCreatingWs] = useState(false);
  const [createWsError, setCreateWsError] = useState<string | null>(null);
  const [createdWs, setCreatedWs] = useState<{ name: string; leadsAdopted: number } | null>(null);
  const handleCreateWorkspace = useCallback(async (e?: React.FormEvent) => {
    e?.preventDefault();
    setCreatingWs(true); setCreateWsError(null); setCreatedWs(null);
    try {
      const result = await createMyWorkspace(user.id, wsName);
      // Don't await refetch — if it hangs, the success card still renders.
      refetchWorkspace().catch((err) => console.warn('[quick-launch] refetchWorkspace failed:', err));
      qc.invalidateQueries({ queryKey: ['quick-launch-leads'] });
      setCreatedWs({ name: result.name, leadsAdopted: result.leadsAdopted });
    } catch (err) {
      console.error('[quick-launch] create workspace failed:', err);
      setCreateWsError((err as Error).message ?? String(err));
    } finally {
      setCreatingWs(false);
    }
  }, [user.id, wsName, refetchWorkspace, qc]);

  // ─── Audience state ─────────────────────────────────────────────────
  const [mode, setMode] = useState<AudienceMode>('sample');
  const [pasteText, setPasteText] = useState('');
  const [pasteLeads, setPasteLeads] = useState<Lead[]>([]);
  const [importOpen, setImportOpen] = useState(false);

  const { data: existingLeads = [], refetch: refetchExisting, isLoading: existingLoading } = useQuery<Lead[]>({
    queryKey: ['quick-launch-leads', workspaceId],
    queryFn: async () => {
      if (!workspaceId) return [];
      // Don't pre-filter by email — surface everything we have, then warn
      // at launch time if any rows are missing an address. Pre-filtering
      // was making the section render empty when leads existed but
      // hadn't been enriched yet.
      const { data, error } = await supabase
        .from('leads')
        .select('id, first_name, last_name, primary_email, primary_phone, company, score, status, insights, title, industry')
        .eq('workspace_id', workspaceId)
        .order('score', { ascending: false, nullsFirst: false })
        .limit(50);
      if (error) console.warn('[quick-launch] leads query failed:', error.message);
      return ((data ?? []) as unknown[]).map((d) => ({
        ...(d as Record<string, unknown>),
        client_id: '', last_activity: '',
      })) as Lead[];
    },
    enabled: !!workspaceId,
    staleTime: 60_000,
  });

  const existingEmailable = existingLeads.filter((l) => /\S+@\S+\.\S+/.test(l.primary_email ?? ''));

  const activeLeads: Lead[] = useMemo(() => {
    if (mode === 'sample') return SAMPLE_LEADS;
    if (mode === 'paste') return pasteLeads;
    if (mode === 'existing') return existingEmailable;
    return [];
  }, [mode, pasteLeads, existingEmailable]);

  const isSampleMode = mode === 'sample';

  // ─── Offer state ────────────────────────────────────────────────────
  const [offer, setOffer] = useState('Show how AI-personalized outbound books more meetings.');
  const [goal, setGoal] = useState<EmailSequenceConfig['goal']>('book_meeting');
  const [tone, setTone] = useState<ToneType>(ToneType.PROFESSIONAL);
  const [cadence, setCadence] = useState<EmailSequenceConfig['cadence']>('every_2_days');
  const [sequenceLength, setSequenceLength] = useState(3);

  // ─── Sequence state ────────────────────────────────────────────────
  const [steps, setSteps] = useState<SequenceStep[]>(SAMPLE_STEPS);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);

  // ─── Launch state ──────────────────────────────────────────────────
  const [launching, setLaunching] = useState(false);
  const [launchResult, setLaunchResult] = useState<{ runId: string; total: number } | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);

  // When the user swaps off the sample, blank out the canned preview so
  // the next "Generate" button click feels intentional.
  useEffect(() => {
    if (mode !== 'sample' && steps === SAMPLE_STEPS) {
      setSteps([]);
    }
  }, [mode, steps]);

  const handleParsePaste = useCallback(() => {
    const rows = pasteText.split('\n').map((l) => l.trim()).filter(Boolean);
    const parsed: Lead[] = rows.slice(0, 100).map((row, i) => {
      // Accept "email", "email, name", or "email, name, company"
      const parts = row.split(/[,\t]/).map((p) => p.trim()).filter(Boolean);
      const email = parts[0] ?? '';
      const name = parts[1] ?? email.split('@')[0];
      const company = parts[2] ?? '';
      const [first, ...rest] = name.split(' ');
      return {
        id: `paste-${i}`, client_id: '',
        first_name: first ?? '', last_name: rest.join(' '),
        primary_email: email, primary_phone: '', company,
        score: 50, status: 'New' as const, last_activity: '', insights: '',
      };
    }).filter((l) => /\S+@\S+\.\S+/.test(l.primary_email));
    setPasteLeads(parsed);
  }, [pasteText]);

  const handleGenerate = useCallback(async () => {
    setGenerating(true); setGenError(null);
    try {
      const config: EmailSequenceConfig = {
        audienceLeadIds: activeLeads.map((l) => l.id),
        goal, sequenceLength, cadence, tone,
      };
      // Promote the offer into a synthetic insights line so Gemini grounds on it.
      const enrichedLeads = activeLeads.map((l) => ({
        ...l,
        insights: [l.insights, `Sender's offer: ${offer}`].filter(Boolean).join(' — '),
      }));
      const ai = await generateEmailSequence(
        enrichedLeads, config, user.businessProfile ?? undefined, user.id,
      );
      const parsed = parseEmailSequenceResponse(ai.text ?? '', config);
      if (parsed.length === 0) throw new Error('AI returned no steps — try rephrasing the offer.');
      // Adapt the global EmailStep (string delay) → local SequenceStep (numeric).
      const cadenceDays = ({ daily: 1, every_2_days: 2, every_3_days: 3, weekly: 7 } as const)[cadence];
      const adapted: SequenceStep[] = parsed.map((p, i) => ({
        stepIndex: p.stepNumber ?? i + 1,
        delayDays: i === 0 ? 0 : cadenceDays * i,
        subject: p.subject,
        body: p.body,
      }));
      setSteps(adapted);
    } catch (e) {
      setGenError((e as Error).message);
    } finally {
      setGenerating(false);
    }
  }, [activeLeads, goal, sequenceLength, cadence, tone, offer, user]);

  const handleLaunch = useCallback(async () => {
    if (isSampleMode) return;
    if (activeLeads.length === 0 || steps.length === 0) return;
    setLaunching(true); setLaunchError(null);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error('No auth session — please refresh and try again.');
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/start-email-sequence-run`;
      const payload = {
        leads: activeLeads.map((l) => ({
          id: l.id,
          email: l.primary_email,
          name: [l.first_name, l.last_name].filter(Boolean).join(' '),
          company: l.company,
          score: l.score, status: l.status, insights: l.insights,
          industry: l.industry, title: l.title,
        })),
        steps: steps.map((s) => ({
          stepIndex: s.stepIndex,
          delayDays: s.delayDays,
          subject: s.subject,
          body: s.body,
        })),
        config: {
          tone: tone.toString(),
          goal: offer,
          cadence,
          sendMode: 'auto',
        },
      };
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = await res.json() as { run_id: string; items_total: number };
      setLaunchResult({ runId: data.run_id, total: data.items_total });
    } catch (e) {
      setLaunchError((e as Error).message);
    } finally {
      setLaunching(false);
    }
  }, [activeLeads, steps, tone, offer, cadence, isSampleMode]);

  // ───────────────────────────────────────────────────────────────────
  return (
    <div className="px-6 py-8 max-w-4xl mx-auto space-y-6">
      <header className="space-y-1.5">
        <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
          <Rocket size={20} className="text-indigo-500" /> Quick Launch
        </h1>
        <p className="text-sm text-slate-600 max-w-xl">
          Three steps to a live outreach sequence: pick an audience, describe the offer, launch.
          The sample below shows you the shape — swap your own leads in and click <span className="font-semibold">Launch</span>.
        </p>
      </header>

      {/* ── STEP 1 — Audience ─────────────────────────────────────── */}
      <SectionCard step={1} title="Audience" subtitle={
        mode === 'sample' ? '3 sample leads loaded — swap them in for real'
        : `${activeLeads.length} lead${activeLeads.length === 1 ? '' : 's'} selected`
      }>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <ModeButton active={mode === 'sample'} onClick={() => setMode('sample')} icon={Sparkles} label="Sample" hint="See how it works" />
          <ModeButton active={mode === 'existing'} onClick={() => setMode('existing')} icon={Users} label="Existing" hint={
            existingLoading ? 'Loading…'
            : existingEmailable.length === 0 ? 'None available'
            : `${existingEmailable.length} emailable`
          } />
          <ModeButton active={mode === 'paste'} onClick={() => setMode('paste')} icon={Clipboard} label="Paste" hint="Emails or CSV rows" />
          <ModeButton active={mode === 'import'} onClick={() => { setMode('import'); setImportOpen(true); }} icon={Upload} label="Import CSV" hint="Full importer" />
        </div>

        {mode === 'existing' && !existingLoading && (
          workspaceId === null ? (
            <div className="mt-4 flex items-start gap-2 text-xs bg-amber-50 border border-amber-200 text-amber-800 rounded-lg p-3">
              <AlertCircle size={14} className="mt-0.5 shrink-0" />
              <div className="flex-1">
                <p className="font-semibold">No workspace found for your account</p>
                <p className="mt-0.5">Name your workspace and we'll set it up — leads, sequences, and team activity all live inside it.</p>
                <form onSubmit={handleCreateWorkspace} className="mt-2 flex flex-col sm:flex-row sm:items-center gap-2">
                  <input
                    type="text"
                    value={wsName}
                    onChange={(e) => setWsName(e.target.value)}
                    placeholder={user.businessProfile?.companyName ?? "e.g. Acme Outbound"}
                    disabled={creatingWs}
                    maxLength={80}
                    className="flex-1 px-2.5 py-1.5 rounded-lg border border-amber-300 bg-white text-slate-900 text-xs placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-amber-400 disabled:opacity-60"
                  />
                  <button
                    type="submit"
                    disabled={creatingWs}
                    className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-600 text-white text-xs font-bold hover:bg-amber-700 disabled:opacity-60"
                  >
                    {creatingWs ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />}
                    {creatingWs ? 'Creating…' : 'Create workspace'}
                  </button>
                </form>
                <p className="mt-1.5 text-[10px] text-amber-700/70">
                  Leave blank to use {user.businessProfile?.companyName ? `"${user.businessProfile.companyName}"` : '"My Workspace"'}. You can change it later. Or skip this and use <span className="font-semibold">Paste</span> / <span className="font-semibold">Import CSV</span>.
                </p>
                {createWsError && (
                  <p className="mt-1.5 text-[11px] text-red-700">Couldn't create workspace: {createWsError}</p>
                )}
              </div>
            </div>
          ) : createdWs ? (
            <div className="mt-4 flex items-start gap-2 text-xs bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-lg p-3">
              <Check size={14} className="mt-0.5 shrink-0" />
              <div className="flex-1">
                <p className="font-semibold">Workspace "{createdWs.name}" is ready</p>
                <p className="mt-0.5">
                  {createdWs.leadsAdopted > 0
                    ? <>Adopted <span className="font-semibold">{createdWs.leadsAdopted} lead{createdWs.leadsAdopted === 1 ? '' : 's'}</span> you already owned into this workspace. Click <span className="font-semibold">Existing</span> again to load them, or jump to <button onClick={() => navigate('/portal/leads')} className="underline font-semibold">Leads</button>.</>
                    : <>It's empty for now — add leads via <span className="font-semibold">Import CSV</span> or <span className="font-semibold">Paste</span>, or jump to <button onClick={() => navigate('/portal/leads')} className="underline font-semibold">Leads</button> to build it out.</>}
                </p>
              </div>
            </div>
          ) : existingEmailable.length === 0 ? (
            <div className="mt-4 flex items-start gap-2 text-xs bg-slate-50 border border-slate-200 text-slate-700 rounded-lg p-3">
              <Info size={14} className="mt-0.5 shrink-0 text-slate-500" />
              <div className="flex-1">
                <p className="font-semibold">
                  {existingLeads.length === 0
                    ? 'No leads in this workspace yet'
                    : `${existingLeads.length} lead${existingLeads.length === 1 ? '' : 's'} in workspace, but none have an email address`}
                </p>
                <p className="mt-0.5">
                  {existingLeads.length === 0
                    ? 'If you imported leads on this account before, they may be tied to an older workspace. Click below to re-link any you own.'
                    : 'Add emails to your existing leads or use Paste / Import to launch a campaign now.'}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => handleCreateWorkspace()}
                    disabled={creatingWs}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-700 text-white text-[11px] font-bold hover:bg-slate-800 disabled:opacity-60"
                  >
                    {creatingWs ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                    {creatingWs ? 'Linking…' : 'Re-link my leads'}
                  </button>
                  <span className="text-[10px] text-slate-400 font-mono">workspace: {workspaceId.slice(0, 8)}…</span>
                </div>
                {createdWs && createdWs.leadsAdopted > 0 && (
                  <p className="mt-1.5 text-[11px] text-emerald-700">Adopted {createdWs.leadsAdopted} lead{createdWs.leadsAdopted === 1 ? '' : 's'}. Click <span className="font-semibold">Existing</span> again to load them.</p>
                )}
                {createdWs && createdWs.leadsAdopted === 0 && (
                  <p className="mt-1.5 text-[11px] text-slate-500">No drifted leads found for your account. Use Paste / Import CSV.</p>
                )}
                {createWsError && (
                  <p className="mt-1.5 text-[11px] text-red-700">Couldn't re-link: {createWsError}</p>
                )}
              </div>
            </div>
          ) : null
        )}

        {mode === 'paste' && (
          <div className="mt-4 space-y-2">
            <textarea
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              placeholder={`maya@northwind.io, Maya Reyes, Northwind SaaS\ndaniel@apex.co, Daniel Okafor, Apex Pilot\n…or one email per line`}
              rows={5}
              className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm font-mono focus:outline-none focus:border-indigo-500 resize-none"
            />
            <div className="flex items-center justify-between">
              <p className="text-[11px] text-slate-500">
                Accepts <code>email</code>, <code>email, name</code>, or <code>email, name, company</code>. Max 100.
              </p>
              <button
                onClick={handleParsePaste}
                className="px-3 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-bold hover:bg-slate-800"
              >
                Parse → {pasteLeads.length || 0} valid
              </button>
            </div>
          </div>
        )}

        {/* Lead preview — only renders when there's something */}
        {activeLeads.length > 0 && (
          <div className="mt-4 space-y-1.5">
            <p className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">Preview ({activeLeads.length})</p>
            <div className="space-y-1 max-h-48 overflow-y-auto rounded-xl border border-slate-100 bg-slate-50/40 p-2">
              {activeLeads.slice(0, 6).map((l) => (
                <div key={l.id} className="flex items-center justify-between text-xs px-2 py-1 rounded-md bg-white border border-slate-100">
                  <span className="font-semibold text-slate-700">{l.first_name} {l.last_name}</span>
                  <span className="text-slate-400 truncate ml-2">{l.primary_email}</span>
                  {l.company && <span className="text-slate-400 ml-2 truncate hidden md:inline">· {l.company}</span>}
                </div>
              ))}
              {activeLeads.length > 6 && (
                <p className="text-[11px] text-slate-400 italic text-center pt-1">…and {activeLeads.length - 6} more</p>
              )}
            </div>
          </div>
        )}
      </SectionCard>

      {/* ── STEP 2 — Offer ────────────────────────────────────────── */}
      <SectionCard step={2} title="Your offer" subtitle="One sentence the AI uses to ground every email">
        <textarea
          value={offer}
          onChange={(e) => setOffer(e.target.value)}
          placeholder="e.g. Show how AI-personalized outbound books 30% more meetings."
          rows={2}
          className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-indigo-500 resize-none"
        />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">
          <Field label="Goal">
            <select value={goal} onChange={(e) => setGoal(e.target.value as EmailSequenceConfig['goal'])} className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs bg-white focus:outline-none focus:border-indigo-500">
              <option value="book_meeting">Book a meeting</option>
              <option value="product_demo">Product demo</option>
              <option value="nurture">Nurture</option>
              <option value="re_engage">Re-engage</option>
              <option value="upsell">Upsell</option>
            </select>
          </Field>
          <Field label="Tone">
            <select value={tone} onChange={(e) => setTone(e.target.value as ToneType)} className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs bg-white focus:outline-none focus:border-indigo-500">
              {Object.values(ToneType).map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="Cadence">
            <select value={cadence} onChange={(e) => setCadence(e.target.value as EmailSequenceConfig['cadence'])} className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs bg-white focus:outline-none focus:border-indigo-500">
              <option value="daily">Daily</option>
              <option value="every_2_days">Every 2 days</option>
              <option value="every_3_days">Every 3 days</option>
              <option value="weekly">Weekly</option>
            </select>
          </Field>
          <Field label="Length">
            <select value={sequenceLength} onChange={(e) => setSequenceLength(Number(e.target.value))} className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs bg-white focus:outline-none focus:border-indigo-500">
              {[1,2,3,4,5].map((n) => <option key={n} value={n}>{n} email{n > 1 ? 's' : ''}</option>)}
            </select>
          </Field>
        </div>

        <div className="mt-4 flex items-center justify-between">
          <p className="text-[11px] text-slate-500 max-w-md">
            {isSampleMode
              ? 'The preview below is a hand-written demo — click Generate to call the AI on the sample leads.'
              : 'Click Generate to produce a personalized sequence from your audience + offer.'}
          </p>
          <button
            onClick={handleGenerate}
            disabled={generating || activeLeads.length === 0 || !offer.trim()}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-indigo-600 text-white text-sm font-bold hover:bg-indigo-700 disabled:opacity-50 transition"
          >
            {generating ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
            {generating ? 'Generating…' : steps.length > 0 ? 'Regenerate' : 'Generate sequence'}
          </button>
        </div>

        {genError && (
          <div className="mt-3 flex items-start gap-2 text-xs bg-rose-50 border border-rose-200 text-rose-700 rounded-lg p-2">
            <AlertCircle size={13} className="mt-0.5 shrink-0" /> {genError}
          </div>
        )}
      </SectionCard>

      {/* ── STEP 3 — Sequence ─────────────────────────────────────── */}
      <SectionCard step={3} title="Review & launch" subtitle={
        steps.length === 0 ? 'Generate above to see the sequence'
        : `${steps.length}-step sequence · ${activeLeads.length} recipient${activeLeads.length === 1 ? '' : 's'}`
      }>
        {steps.length === 0 ? (
          <div className="text-center py-10 text-sm text-slate-400">
            <Mail size={28} className="mx-auto text-slate-300" />
            <p className="mt-2">Pick an audience and click Generate</p>
          </div>
        ) : (
          <div className="space-y-3">
            {steps.map((s, i) => (
              <div key={i} className="rounded-xl border border-slate-200 p-4 bg-white">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="w-6 h-6 rounded-lg bg-indigo-50 text-indigo-700 text-[11px] font-black flex items-center justify-center">{i + 1}</span>
                    <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">
                      {s.delayDays === 0 ? 'Send immediately' : `+${s.delayDays} day${s.delayDays === 1 ? '' : 's'}`}
                    </span>
                  </div>
                </div>
                <p className="text-sm font-bold text-slate-900">{s.subject}</p>
                <pre className="mt-2 text-xs text-slate-700 whitespace-pre-wrap font-sans leading-relaxed">{s.body}</pre>
              </div>
            ))}

            {launchResult ? (
              <div className="flex items-center gap-3 bg-emerald-50 border border-emerald-200 text-emerald-900 rounded-xl p-4">
                <Check size={18} className="shrink-0" />
                <div className="flex-1">
                  <p className="text-sm font-bold">Sequence launched</p>
                  <p className="text-xs">{launchResult.total} email{launchResult.total === 1 ? '' : 's'} scheduled across {activeLeads.length} recipient{activeLeads.length === 1 ? '' : 's'}.</p>
                </div>
                <button onClick={() => navigate('/portal/content')} className="text-xs font-bold underline">View campaigns</button>
              </div>
            ) : (
              <div className="flex items-center justify-between pt-2">
                <div className="text-[11px] text-slate-500 max-w-sm">
                  {isSampleMode ? (
                    <span className="inline-flex items-start gap-1">
                      <Info size={12} className="mt-0.5 shrink-0 text-amber-600" />
                      <span>This is sample data — switch to <span className="font-semibold">Existing</span>, <span className="font-semibold">Paste</span>, or <span className="font-semibold">Import</span> above to send for real.</span>
                    </span>
                  ) : (
                    <span>Launching will create a real sequence run and schedule the first send.</span>
                  )}
                </div>
                <button
                  onClick={handleLaunch}
                  disabled={isSampleMode || launching || activeLeads.length === 0 || steps.length === 0}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-slate-900 text-white text-sm font-bold hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed transition"
                >
                  {launching ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                  {launching ? 'Launching…' : 'Launch sequence'}
                </button>
              </div>
            )}

            {launchError && (
              <div className="flex items-start gap-2 text-xs bg-rose-50 border border-rose-200 text-rose-700 rounded-lg p-2">
                <AlertCircle size={13} className="mt-0.5 shrink-0" /> {launchError}
              </div>
            )}
          </div>
        )}
      </SectionCard>

      <ImportLeadsWizard
        isOpen={importOpen}
        onClose={() => { setImportOpen(false); if (existingLeads.length === 0) setMode('sample'); else setMode('existing'); }}
        userId={user.id}
        planName={user.plan ?? 'Free'}
        onImportComplete={() => { setMode('existing'); refetchExisting(); setImportOpen(false); }}
      />
    </div>
  );
};

// ─── helpers ──────────────────────────────────────────────────────────

const SectionCard: React.FC<{ step: number; title: string; subtitle?: string; children: React.ReactNode }> = ({ step, title, subtitle, children }) => (
  <section className="rounded-2xl border border-slate-200 bg-white p-5">
    <header className="flex items-center gap-3 mb-4">
      <span className="w-7 h-7 rounded-lg bg-indigo-100 text-indigo-700 text-sm font-black flex items-center justify-center">{step}</span>
      <div className="flex-1">
        <h2 className="text-base font-bold text-slate-900">{title}</h2>
        {subtitle && <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>}
      </div>
    </header>
    {children}
  </section>
);

const ModeButton: React.FC<{ active: boolean; onClick: () => void; icon: React.FC<{ size?: number; className?: string }>; label: string; hint: string }> = ({ active, onClick, icon: Icon, label, hint }) => (
  <button
    onClick={onClick}
    className={`flex flex-col items-start gap-1 p-3 rounded-xl text-left transition ${
      active
        ? 'bg-indigo-50 border-2 border-indigo-400'
        : 'bg-white border-2 border-slate-100 hover:border-slate-300'
    }`}
  >
    <Icon size={16} className={active ? 'text-indigo-600' : 'text-slate-500'} />
    <span className={`text-sm font-bold ${active ? 'text-indigo-900' : 'text-slate-700'}`}>{label}</span>
    <span className="text-[10px] text-slate-400 leading-tight">{hint}</span>
  </button>
);

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div>
    <label className="block text-[10px] font-black text-slate-500 uppercase tracking-wider mb-1">{label}</label>
    {children}
  </div>
);

export default QuickLaunchPage;
