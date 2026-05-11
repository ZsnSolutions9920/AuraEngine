// AuraEngine/pages/portal/GoalsPage.tsx
//
// Phase 6.1 — Goal-based AI automation UI.
// List goals, create new ones, view their AI-generated plan + version
// history. No execution yet — that's Phase 6.2.

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Target, Plus, Trash2, Sparkles, Loader2, AlertCircle, CheckCircle,
  Clock, TrendingUp, ChevronDown, ChevronRight, RefreshCw, Play, XCircle,
} from 'lucide-react';
import type { User } from '../../types';
import { supabase } from '../../lib/supabase';
import {
  listGoals, createGoal, deleteGoal, getActivePlan, listPlanVersions,
  planAndStoreFromGoal,
  listStepRunsForPlan, runPlanPreview,
  type AutomationGoal, type AutomationPlanRow, type PlanStep,
  type AutomationStepRun,
} from '../../lib/goals';

interface LayoutContext { user: User }

// Canonical metric options surfaced in the form. Free-text accepted too.
const METRIC_PRESETS = [
  'meetings_booked',
  'qualified_leads',
  'replies',
  'demos',
  'pipeline_value',
  'new_logos',
  'reactivated_leads',
];

const STATUS_TONE: Record<string, string> = {
  draft:      'slate',
  planning:   'indigo',
  planned:    'emerald',
  active:     'emerald',
  running:    'indigo',
  paused:     'amber',
  completed:  'emerald',
  cancelled:  'slate',
  failed:     'rose',
};

const STATUS_LABEL: Record<string, string> = {
  draft:      'Draft',
  planning:   'AI Planning…',
  planned:    'Planned',
  active:     'Active',
  running:    'Running…',
  paused:     'Paused',
  completed:  'Completed',
  cancelled:  'Cancelled',
  failed:     'Failed',
};

const GoalsPage: React.FC = () => {
  const { user } = useOutletContext<LayoutContext>();

  const { data: workspaceId = null } = useQuery<string | null>({
    queryKey: ['goals-workspace', user.id],
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

  const [goals, setGoals] = useState<AutomationGoal[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [planning, setPlanning] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    try { setGoals(await listGoals(workspaceId)); }
    finally { setLoading(false); }
  }, [workspaceId]);

  useEffect(() => { refresh(); }, [refresh]);

  // Auto-refresh while any goal is in 'planning' state.
  useEffect(() => {
    if (!goals.some((g) => g.status === 'planning')) return;
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, [goals, refresh]);

  const handlePlan = async (g: AutomationGoal) => {
    setPlanning(g.id);
    try {
      await planAndStoreFromGoal({ goal: g, userId: user.id, businessProfile: user.businessProfile ?? null });
      await refresh();
      setExpanded(g.id);
    } catch (e) {
      alert(`Planner failed: ${(e as Error).message}`);
    } finally {
      setPlanning(null);
    }
  };

  const handleDelete = async (g: AutomationGoal) => {
    if (!confirm(`Delete "${g.statement}"? All plan versions will be removed.`)) return;
    await deleteGoal(g.id);
    refresh();
  };

  const handleRunPreview = async (g: AutomationGoal) => {
    try {
      const result = await runPlanPreview(g.id);
      await refresh();
      setExpanded(g.id);
      const msg = result.steps_failed === 0
        ? `Preview complete · ${result.steps_succeeded} of ${result.steps_total} steps simulated.`
        : `Preview finished with ${result.steps_failed} failed step(s).`;
      // Soft surface; the per-step output is already visible in the panel.
      console.log('[goals]', msg);
    } catch (e) {
      alert(`Preview failed: ${(e as Error).message}`);
    }
  };

  return (
    <div className="px-6 py-8 max-w-5xl mx-auto space-y-6">
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
            <Target size={20} className="text-indigo-500" />
            Goals
          </h1>
          <p className="text-slate-600 mt-2 max-w-xl">
            State a sales outcome and let the AI plan how to get there.
            Plans use your workspace's memory of what's worked before.
          </p>
          <p className="text-xs text-slate-500 mt-1 max-w-xl inline-flex items-center gap-1.5">
            <span className="inline-block px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 text-[10px] font-bold uppercase tracking-wide">Preview</span>
            Plans are generated and reviewable today; you run the steps manually. Automated execution is coming.
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          disabled={!workspaceId}
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-slate-900 text-white text-sm font-semibold hover:bg-slate-800 disabled:opacity-50"
        >
          <Plus size={16} /> New goal
        </button>
      </header>

      {loading ? (
        <div className="h-24 rounded-2xl bg-slate-100 animate-pulse" />
      ) : goals.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-200 p-10 text-center">
          <Target size={32} className="mx-auto text-slate-300" />
          <p className="text-sm text-slate-600 mt-3 max-w-md mx-auto">
            No goals yet. Try something concrete: <em>"Book 10 SaaS demos by August 1"</em> or
            <em> "Reactivate 50 dormant leads this month"</em>.
          </p>
          <button
            onClick={() => setShowCreate(true)}
            disabled={!workspaceId}
            className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-slate-900 text-white text-sm font-semibold hover:bg-slate-800 disabled:opacity-50"
          >
            <Plus size={14} /> Create your first goal
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {goals.map((g) => (
            <GoalCard
              key={g.id}
              goal={g}
              expanded={expanded === g.id}
              planning={planning === g.id}
              onExpand={() => setExpanded(expanded === g.id ? null : g.id)}
              onPlan={() => handlePlan(g)}
              onRunPreview={() => handleRunPreview(g)}
              onDelete={() => handleDelete(g)}
            />
          ))}
        </div>
      )}

      {showCreate && workspaceId && (
        <CreateGoalModal
          workspaceId={workspaceId}
          onClose={() => setShowCreate(false)}
          onCreated={(g) => {
            setShowCreate(false);
            refresh();
            // Auto-plan on creation.
            handlePlan(g);
          }}
        />
      )}
    </div>
  );
};

// ── Goal card with collapsible plan view ────────────────────────────────

const GoalCard: React.FC<{
  goal: AutomationGoal;
  expanded: boolean;
  planning: boolean;
  onExpand: () => void;
  onPlan: () => void;
  onRunPreview: () => void;
  onDelete: () => void;
}> = ({ goal: g, expanded, planning, onExpand, onPlan, onRunPreview, onDelete }) => {
  const [previewing, setPreviewing] = useState(false);
  const tone = STATUS_TONE[g.status];
  const pct = g.target_value > 0
    ? Math.min(100, Math.round((g.progress_value / g.target_value) * 100))
    : 0;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white">
      <div className="p-5 flex items-start gap-3">
        <button onClick={onExpand} className="mt-1 text-slate-400 hover:text-slate-700">
          {expanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
        </button>

        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <p className="font-semibold text-slate-900">{g.statement}</p>
            <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold bg-${tone}-50 text-${tone}-700 shrink-0`}>
              {g.status === 'planning' && <Loader2 size={10} className="inline animate-spin mr-1" />}
              {STATUS_LABEL[g.status]}
            </span>
          </div>

          <div className="mt-2 flex flex-wrap gap-3 items-center text-xs text-slate-500">
            <span className="font-mono">{g.progress_value}/{g.target_value} {g.target_metric}</span>
            {g.due_at && (
              <span className="inline-flex items-center gap-1">
                <Clock size={11} /> due {new Date(g.due_at).toLocaleDateString()}
              </span>
            )}
            {g.guardrails && (
              <span className="inline-flex items-center gap-1 text-amber-600">
                <AlertCircle size={11} /> guardrails
              </span>
            )}
          </div>

          <div className="mt-2 h-1.5 rounded-full bg-slate-100 overflow-hidden">
            <div className={`h-full bg-${tone}-500`} style={{ width: `${pct}%` }} />
          </div>
        </div>

        <div className="flex items-center gap-1">
          {(g.status === 'draft' || g.status === 'planned' || g.status === 'completed' || g.status === 'failed') && (
            <button
              onClick={onPlan}
              disabled={planning}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-indigo-50 text-indigo-700 text-xs font-semibold hover:bg-indigo-100 disabled:opacity-50"
              title="Generate a fresh plan"
            >
              {planning ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
              {g.status === 'draft' ? 'Plan' : 'Replan'}
            </button>
          )}
          {(g.status === 'planned' || g.status === 'completed' || g.status === 'failed') && (
            <button
              onClick={async () => { setPreviewing(true); try { await onRunPreview(); } finally { setPreviewing(false); } }}
              disabled={previewing}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-emerald-50 text-emerald-700 text-xs font-semibold hover:bg-emerald-100 disabled:opacity-50"
              title="Simulate execution end-to-end (no real side effects)"
            >
              {previewing ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />}
              Run preview
            </button>
          )}
          <button
            onClick={onDelete}
            className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50"
            title="Delete"
          ><Trash2 size={14} /></button>
        </div>
      </div>

      {expanded && <PlanPanel goalId={g.id} />}
    </div>
  );
};

// ── Plan rendering ──────────────────────────────────────────────────────

const PlanPanel: React.FC<{ goalId: string }> = ({ goalId }) => {
  const { data: plan, isLoading } = useQuery<AutomationPlanRow | null>({
    queryKey: ['active-plan', goalId],
    queryFn: () => getActivePlan(goalId),
    staleTime: 10_000,
  });
  const { data: versions = [] } = useQuery<AutomationPlanRow[]>({
    queryKey: ['plan-versions', goalId],
    queryFn: () => listPlanVersions(goalId),
    staleTime: 10_000,
  });
  // Step run state for the currently-active plan
  const { data: stepRuns = [] } = useQuery<AutomationStepRun[]>({
    queryKey: ['step-runs', plan?.id],
    queryFn: () => plan ? listStepRunsForPlan(plan.id) : Promise.resolve([]),
    enabled: !!plan?.id,
    staleTime: 5_000,
  });
  // Index by step_id for fast lookup inside StepRow
  const runsByStep = useMemo(() => {
    const m: Record<string, AutomationStepRun> = {};
    for (const r of stepRuns) {
      // Keep latest attempt
      if (!m[r.step_id] || r.attempt_count > m[r.step_id].attempt_count) m[r.step_id] = r;
    }
    return m;
  }, [stepRuns]);

  if (isLoading) return <div className="border-t border-slate-100 p-5 text-xs text-slate-400">Loading plan…</div>;
  if (!plan) return (
    <div className="border-t border-slate-100 p-5 text-xs text-slate-400 italic">
      No plan yet. Click "Plan" to generate one.
    </div>
  );

  return (
    <div className="border-t border-slate-100 p-5 space-y-4 bg-slate-50/40">
      <header className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <p className="text-xs font-bold text-slate-500 uppercase tracking-wide">
            Plan v{plan.version} · {plan.created_by_kind}
          </p>
          <p className="text-sm text-slate-900 mt-1 italic">"{plan.plan.summary}"</p>
        </div>
        <div className="text-[10px] text-slate-400 text-right">
          <p>{new Date(plan.created_at).toLocaleString()}</p>
          {plan.tokens_used != null && <p>{plan.tokens_used} tokens · {plan.model_used}</p>}
          {plan.plan.estimated_total_hours != null && (
            <p>{plan.plan.estimated_total_hours}h estimated</p>
          )}
        </div>
      </header>

      <ol className="space-y-2">
        {plan.plan.steps.map((s, i) => (
          <StepRow key={s.id} step={s} index={i} run={runsByStep[s.id]} />
        ))}
      </ol>

      {plan.plan.risks?.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer font-semibold text-amber-700">
            ⚠ {plan.plan.risks.length} risk{plan.plan.risks.length === 1 ? '' : 's'}
          </summary>
          <ul className="mt-1 ml-4 list-disc space-y-1 text-slate-600">
            {plan.plan.risks.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </details>
      )}

      {plan.plan.assumptions?.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer font-semibold text-slate-600">
            Assumptions
          </summary>
          <ul className="mt-1 ml-4 list-disc space-y-1 text-slate-600">
            {plan.plan.assumptions.map((a, i) => <li key={i}>{a}</li>)}
          </ul>
        </details>
      )}

      {versions.length > 1 && (
        <details className="text-xs">
          <summary className="cursor-pointer font-semibold text-slate-600">
            Plan history ({versions.length} versions)
          </summary>
          <ul className="mt-1 ml-4 space-y-1 text-slate-500">
            {versions.map((v) => (
              <li key={v.id} className={v.is_active ? 'font-semibold text-emerald-700' : ''}>
                v{v.version} {v.is_active ? '(active)' : `— ${v.superseded_reason ?? 'superseded'}`} ·{' '}
                {new Date(v.created_at).toLocaleString()}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
};

const KIND_BADGE: Record<string, { tone: string; label: string }> = {
  apollo_search:   { tone: 'indigo',  label: 'Apollo' },
  enrich_leads:    { tone: 'violet',  label: 'AI Enrich' },
  lead_score:      { tone: 'violet',  label: 'Score' },
  email_sequence:  { tone: 'emerald', label: 'Sequence' },
  social_post:     { tone: 'sky',     label: 'Social' },
  team_task:       { tone: 'amber',   label: 'Task' },
  wait:            { tone: 'slate',   label: 'Wait' },
  checkpoint:      { tone: 'rose',    label: 'Checkpoint' },
};

const RUN_TONE: Record<AutomationStepRun['status'], string> = {
  pending:   'slate',
  running:   'indigo',
  succeeded: 'emerald',
  failed:    'rose',
  skipped:   'slate',
};

const StepRow: React.FC<{
  step: PlanStep; index: number; run?: AutomationStepRun;
}> = ({ step: s, index, run }) => {
  const badge = KIND_BADGE[s.kind] ?? { tone: 'slate', label: s.kind };
  const runTone = run ? RUN_TONE[run.status] : null;
  return (
    <li className="rounded-xl border border-slate-200 bg-white p-3">
      <div className="flex items-start gap-3">
        <span className="w-6 h-6 rounded-lg bg-slate-100 text-slate-600 text-xs font-bold flex items-center justify-center shrink-0">
          {index + 1}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold bg-${badge.tone}-50 text-${badge.tone}-700`}>
              {badge.label}
            </span>
            <span className="text-sm font-semibold text-slate-900">{s.title}</span>
            {run && (
              <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-${runTone}-50 text-${runTone}-700`}>
                {run.status === 'running'   && <Loader2  size={9} className="animate-spin" />}
                {run.status === 'succeeded' && <CheckCircle size={9} />}
                {run.status === 'failed'    && <XCircle size={9} />}
                {run.status}{run.mode === 'dry_run' ? ' · preview' : ''}
              </span>
            )}
            {s.estimated_hours != null && (
              <span className="text-[10px] text-slate-400">~{s.estimated_hours}h</span>
            )}
            {s.depends_on.length > 0 && (
              <span className="text-[10px] text-slate-400">after: {s.depends_on.join(', ')}</span>
            )}
          </div>
          <p className="text-xs text-slate-600 mt-1">{s.rationale}</p>
          {s.success_criteria && (
            <p className="text-[11px] text-slate-500 mt-1 inline-flex items-center gap-1">
              <CheckCircle size={11} className="text-emerald-500" />
              {s.success_criteria}
            </p>
          )}
          {run?.output?.summary && (
            <p className="mt-2 text-[11px] bg-slate-50 border border-slate-100 rounded p-2 text-slate-700">
              <span className="font-semibold">{run.mode === 'dry_run' ? 'Preview:' : 'Result:'}</span>{' '}
              {String(run.output.summary)}
            </p>
          )}
          {run?.error && (
            <p className="mt-1 text-[11px] text-amber-700 inline-flex items-center gap-1">
              <AlertCircle size={11} /> {run.error}
            </p>
          )}
        </div>
      </div>
    </li>
  );
};

// ── Create-goal modal ──────────────────────────────────────────────────

const CreateGoalModal: React.FC<{
  workspaceId: string;
  onClose: () => void;
  onCreated: (g: AutomationGoal) => void;
}> = ({ workspaceId, onClose, onCreated }) => {
  const [statement, setStatement] = useState('');
  const [targetMetric, setTargetMetric] = useState(METRIC_PRESETS[0]);
  const [targetValue, setTargetValue] = useState('10');
  const [dueAt, setDueAt] = useState('');
  const [guardrails, setGuardrails] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
    setError(null);
    if (!statement.trim()) { setError('Statement is required'); return; }
    const n = Number(targetValue);
    if (!Number.isFinite(n) || n <= 0) { setError('Target value must be > 0'); return; }
    setBusy(true);
    try {
      const g = await createGoal({
        workspaceId,
        statement: statement.trim(),
        targetMetric: targetMetric.trim() || 'goal_units',
        targetValue: n,
        dueAt: dueAt ? new Date(dueAt) : null,
        guardrails: guardrails.trim() || undefined,
      });
      onCreated(g);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[9998] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl max-w-lg w-full p-6 space-y-4 max-h-[90vh] overflow-y-auto">
        <h3 className="text-lg font-bold text-slate-900">New goal</h3>
        <p className="text-xs text-slate-500">After creation, the AI generates a plan automatically.</p>

        <div>
          <label className="block text-xs font-bold text-slate-500 uppercase tracking-wide mb-1">Goal statement</label>
          <textarea
            value={statement}
            onChange={(e) => setStatement(e.target.value)}
            placeholder='e.g. "Book 10 SaaS demos with fintech founders by end of August"'
            rows={2}
            className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-indigo-500 resize-none"
            autoFocus
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-bold text-slate-500 uppercase tracking-wide mb-1">Metric</label>
            <input
              value={targetMetric}
              onChange={(e) => setTargetMetric(e.target.value)}
              list="metric-presets"
              className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm font-mono focus:outline-none focus:border-indigo-500"
            />
            <datalist id="metric-presets">
              {METRIC_PRESETS.map((m) => <option key={m} value={m} />)}
            </datalist>
          </div>
          <div>
            <label className="block text-xs font-bold text-slate-500 uppercase tracking-wide mb-1">Target</label>
            <input
              type="number"
              value={targetValue}
              onChange={(e) => setTargetValue(e.target.value)}
              min="1"
              className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-indigo-500"
            />
          </div>
        </div>

        <div>
          <label className="block text-xs font-bold text-slate-500 uppercase tracking-wide mb-1">Due date (optional)</label>
          <input
            type="date"
            value={dueAt}
            onChange={(e) => setDueAt(e.target.value)}
            className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-indigo-500"
          />
        </div>

        <div>
          <label className="block text-xs font-bold text-slate-500 uppercase tracking-wide mb-1">Guardrails (optional)</label>
          <textarea
            value={guardrails}
            onChange={(e) => setGuardrails(e.target.value)}
            placeholder='e.g. "Only US prospects. Avoid anyone we emailed in Q1."'
            rows={2}
            className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-indigo-500 resize-none"
          />
        </div>

        {error && <div className="text-sm text-rose-600 bg-rose-50 border border-rose-200 rounded-lg p-2">{error}</div>}

        <div className="flex items-center gap-2 pt-2">
          <button onClick={onClose} className="flex-1 px-4 py-2.5 rounded-xl border border-slate-200 text-sm font-semibold hover:bg-slate-50">Cancel</button>
          <button
            onClick={handleCreate}
            disabled={busy}
            className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-slate-900 text-white text-sm font-semibold hover:bg-slate-800 disabled:opacity-50"
          >
            {busy ? <><Loader2 size={14} className="animate-spin" /> Creating…</> : <><Sparkles size={14} /> Create & plan</>}
          </button>
        </div>
      </div>
    </div>
  );
};

export default GoalsPage;
