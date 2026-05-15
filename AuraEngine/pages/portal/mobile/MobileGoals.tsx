// AuraEngine/pages/portal/mobile/MobileGoals.tsx
//
// Mobile read-only view of the Phase 6 goals system. Lists goals with
// status, progress, and any observer drift chips. Tap a card to peek at
// the active plan summary + step count. Creating, planning, and running
// goals is intentionally NOT exposed here — those flows need richer
// surface area than a phone screen supports — so we link out to the
// desktop /portal/goals at the top.

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Target, Clock, AlertCircle, Activity, ChevronDown, ChevronRight,
  ExternalLink, Loader2, Wand2,
} from 'lucide-react';
import { resolveWorkspaceForUser } from '../../../lib/memory';
import {
  listGoals, getActivePlan, getGoalObservationCounts,
  OBSERVATION_LABELS,
  type AutomationGoal, type AutomationPlanRow, type GoalObservationCount,
} from '../../../lib/goals';
import type { User } from '../../../types';

interface LayoutContext { user: User }

const STATUS_TONE: Record<string, string> = {
  draft:      'bg-slate-100 text-slate-600',
  planning:   'bg-indigo-100 text-indigo-700',
  planned:    'bg-emerald-100 text-emerald-700',
  active:     'bg-emerald-100 text-emerald-700',
  running:    'bg-indigo-100 text-indigo-700',
  paused:     'bg-amber-100 text-amber-700',
  completed:  'bg-emerald-100 text-emerald-700',
  cancelled:  'bg-slate-100 text-slate-500',
  failed:     'bg-rose-100 text-rose-700',
};

const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft', planning: 'Planning…', planned: 'Planned', active: 'Active',
  running: 'Running…', paused: 'Paused', completed: 'Done', cancelled: 'Cancelled', failed: 'Failed',
};

const MobileGoals: React.FC = () => {
  const { user } = useOutletContext<LayoutContext>();

  const { data: workspaceId = null } = useQuery<string | null>({
    queryKey: ['mobile-goals-workspace', user.id],
    queryFn: () => resolveWorkspaceForUser(user.id),
    staleTime: 5 * 60_000,
  });

  const [goals, setGoals] = useState<AutomationGoal[]>([]);
  const [counts, setCounts] = useState<Record<string, GoalObservationCount>>({});
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    try {
      const [list, c] = await Promise.all([
        listGoals(workspaceId),
        getGoalObservationCounts(workspaceId).catch(() => ({} as Record<string, GoalObservationCount>)),
      ]);
      setGoals(list);
      setCounts(c);
    } finally { setLoading(false); }
  }, [workspaceId]);

  useEffect(() => { refresh(); }, [refresh]);

  // Auto-refresh while anything is mid-flight
  useEffect(() => {
    if (!goals.some((g) => g.status === 'planning' || g.status === 'running')) return;
    const id = setInterval(refresh, 4000);
    return () => clearInterval(id);
  }, [goals, refresh]);

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 pt-4 pb-2 bg-gray-50 sticky top-0 z-10 space-y-2">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-black text-gray-900 tracking-tight flex items-center gap-1.5">
              <Target size={16} className="text-indigo-500" /> Goals
            </h1>
            <p className="text-[10px] text-gray-400 font-medium mt-0.5">
              {goals.length} goal{goals.length === 1 ? '' : 's'} · auto-refreshes while running
            </p>
          </div>
          <a
            href="/portal/goals"
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-white border border-slate-200 text-[11px] font-bold text-slate-700 active:scale-95 transition-transform"
          >
            Manage <ExternalLink size={11} />
          </a>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-2">
        {loading ? (
          <div className="flex justify-center py-12">
            <Loader2 size={20} className="animate-spin text-indigo-400" />
          </div>
        ) : goals.length === 0 ? (
          <div className="text-center py-12 px-4">
            <Target size={28} className="mx-auto text-slate-300" />
            <p className="text-sm text-gray-500 mt-2 font-semibold">No goals yet</p>
            <p className="text-xs text-gray-400 mt-1 max-w-[16rem] mx-auto">
              Create your first sales goal on desktop. Try <em>"Book 10 SaaS demos by August 1"</em>.
            </p>
            <a
              href="/portal/goals"
              className="inline-flex items-center gap-1.5 mt-4 px-3 py-2 bg-slate-900 text-white text-xs font-bold rounded-xl active:scale-95"
            >
              Open Goals on desktop <ExternalLink size={11} />
            </a>
          </div>
        ) : (
          goals.map((g) => (
            <GoalCard
              key={g.id}
              goal={g}
              count={counts[g.id]}
              expanded={expanded === g.id}
              onToggle={() => setExpanded(expanded === g.id ? null : g.id)}
            />
          ))
        )}
      </div>
    </div>
  );
};

const GoalCard: React.FC<{
  goal: AutomationGoal;
  count?: GoalObservationCount;
  expanded: boolean;
  onToggle: () => void;
}> = ({ goal: g, count, expanded, onToggle }) => {
  const pct = g.target_value > 0
    ? Math.min(100, Math.round((g.progress_value / g.target_value) * 100))
    : 0;
  const driftBadge = count && count.latest_kind
    ? (OBSERVATION_LABELS[count.latest_kind] ?? { label: count.latest_kind, tone: 'amber' })
    : null;

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full p-3.5 text-left active:bg-slate-50 transition-colors"
      >
        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-gray-900 leading-snug">{g.statement}</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <span className={`px-1.5 py-0.5 rounded text-[9px] font-black uppercase ${STATUS_TONE[g.status]}`}>
                {g.status === 'planning' || g.status === 'running' ? (
                  <Loader2 size={8} className="inline animate-spin mr-0.5" />
                ) : null}
                {STATUS_LABEL[g.status]}
              </span>
              <span className="text-[11px] text-gray-500 font-mono">
                {g.progress_value}/{g.target_value} {g.target_metric}
              </span>
              {g.due_at && (
                <span className="text-[10px] text-gray-400 inline-flex items-center gap-0.5">
                  <Clock size={9} /> {new Date(g.due_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                </span>
              )}
              {g.guardrails && (
                <span className="text-[10px] text-amber-600 inline-flex items-center gap-0.5">
                  <AlertCircle size={9} /> guardrails
                </span>
              )}
            </div>

            {driftBadge && (
              <div className={`mt-1.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-${driftBadge.tone}-50 text-${driftBadge.tone}-700 border border-${driftBadge.tone}-200`}>
                <Activity size={9} /> {driftBadge.label}
                {count && count.observation_count > 1 && (
                  <span className="opacity-70">·{count.observation_count}</span>
                )}
              </div>
            )}

            <div className="mt-2 h-1.5 rounded-full bg-slate-100 overflow-hidden">
              <div
                className={`h-full transition-all ${
                  g.status === 'failed' ? 'bg-rose-500'
                  : g.status === 'paused' ? 'bg-amber-500'
                  : 'bg-emerald-500'
                }`}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
          <div className="text-slate-300 shrink-0 mt-0.5">
            {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </div>
        </div>
      </button>

      {expanded && <GoalPlanPeek goalId={g.id} />}
    </div>
  );
};

const GoalPlanPeek: React.FC<{ goalId: string }> = ({ goalId }) => {
  const { data: plan, isLoading } = useQuery<AutomationPlanRow | null>({
    queryKey: ['mobile-plan', goalId],
    queryFn: () => getActivePlan(goalId),
    staleTime: 30_000,
  });

  if (isLoading) {
    return (
      <div className="border-t border-slate-100 px-3.5 py-3 text-[11px] text-slate-400">
        Loading plan…
      </div>
    );
  }
  if (!plan) {
    return (
      <div className="border-t border-slate-100 px-3.5 py-3 text-[11px] text-slate-500 italic">
        No active plan. Generate one on desktop.
      </div>
    );
  }

  const steps = plan.plan.steps ?? [];
  const isReplanned = plan.created_by_kind === 'replanner';

  return (
    <div className="border-t border-slate-100 px-3.5 py-3 space-y-2 bg-slate-50/40">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-[9px] font-black text-slate-500 uppercase tracking-wide">
            Plan v{plan.version}{isReplanned ? ' · revised' : ''}
          </p>
          <p className="text-[11px] text-slate-700 italic mt-0.5">"{plan.plan.summary}"</p>
        </div>
        {isReplanned && <Wand2 size={11} className="text-indigo-500 shrink-0 mt-1" />}
      </div>

      <ol className="space-y-1">
        {steps.map((s, i) => (
          <li key={s.id} className="flex items-start gap-1.5 text-[11px]">
            <span className="w-4 h-4 rounded bg-slate-200 text-slate-600 text-[9px] font-black flex items-center justify-center shrink-0 mt-0.5">
              {i + 1}
            </span>
            <div className="flex-1 min-w-0">
              <span className="font-semibold text-slate-800">{s.title}</span>
              <span className="text-slate-400 ml-1">· {s.kind}</span>
            </div>
          </li>
        ))}
      </ol>

      <a
        href={`/portal/goals`}
        className="block text-center w-full mt-2 py-2 rounded-lg bg-slate-900 text-white text-[11px] font-bold active:scale-95 transition-transform"
      >
        Open full plan on desktop
      </a>
    </div>
  );
};

export default MobileGoals;
