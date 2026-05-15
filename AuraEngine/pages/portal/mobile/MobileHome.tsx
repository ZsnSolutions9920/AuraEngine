import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import {
  ArrowRight, TrendingUp, Users, Mail, Zap, Flame, Sparkles,
  Target, BarChart3, Upload, FileText, ChevronRight, RefreshCw,
  CreditCard, Send, Eye, MousePointer, Bell, Brain,
} from 'lucide-react';
import { useRealtimeJobs } from '../../../hooks/useRealtimeJobs';
import { supabase } from '../../../lib/supabase';
import { normalizeLeads } from '../../../lib/queries';
import { resolvePlanName, TIER_LIMITS } from '../../../lib/credits';
import { generateProgrammaticInsights } from '../../../lib/insights';
import { fetchOwnerEmailPerformance } from '../../../lib/emailTracking';
import { resolveWorkspaceForUser } from '../../../lib/memory';
import type { User, Lead, AIInsight, DashboardQuickStats } from '../../../types';
import type { Job } from '../../../lib/jobs';

interface LayoutContext {
  user: User;
  refreshProfile: () => Promise<void>;
}

function jobStatusColor(status: Job['status']): string {
  switch (status) {
    case 'succeeded': return 'bg-emerald-100 text-emerald-700';
    case 'failed': return 'bg-red-100 text-red-700';
    case 'running': return 'bg-blue-100 text-blue-700';
    case 'queued': return 'bg-amber-100 text-amber-700';
    default: return 'bg-gray-100 text-gray-600';
  }
}

function leadStatusColor(status: string): string {
  switch (status) {
    case 'New': return 'bg-blue-100 text-blue-700';
    case 'Contacted': return 'bg-amber-100 text-amber-700';
    case 'Qualified': return 'bg-indigo-100 text-indigo-700';
    case 'Converted': return 'bg-emerald-100 text-emerald-700';
    case 'Lost': return 'bg-gray-100 text-gray-500';
    default: return 'bg-gray-100 text-gray-500';
  }
}

const MobileHome: React.FC = () => {
  const { user, refreshProfile } = useOutletContext<LayoutContext>();
  const navigate = useNavigate();
  const { jobs, connectionStatus } = useRealtimeJobs({ workspaceId: user.id, limit: 5 });

  const [leads, setLeads] = useState<Lead[]>([]);
  const [loadingLeads, setLoadingLeads] = useState(true);
  const [stats, setStats] = useState<DashboardQuickStats>({
    leadsToday: 0, hotLeads: 0, contentCreated: 0, avgAiScore: 0,
    predictedConversions: 0, recommendations: 0, leadsYesterday: 0, hotLeadsYesterday: 0,
  });
  const [statsLoading, setStatsLoading] = useState(true);
  const [socialStats, setSocialStats] = useState({ scheduled: 0, published: 0 });
  const [emailStats, setEmailStats] = useState<{ sent: number; opened: number; clicks: number } | null>(null);
  const [insights, setInsights] = useState<AIInsight[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [prospectPageSize, setProspectPageSize] = useState(10);

  const currentPlan = resolvePlanName(user.subscription?.plan_name || user.plan || 'Free');
  const creditsTotal = user.credits_total || (TIER_LIMITS[currentPlan]?.credits ?? TIER_LIMITS.Free.credits);
  const creditsUsed = user.credits_used || 0;
  const creditsRemaining = creditsTotal - creditsUsed;

  const conversionRate = leads.length > 0
    ? Math.round((leads.filter(l => l.status === 'Qualified').length / leads.length) * 100)
    : 0;

  // ─── Fetch all data ───
  const fetchLeads = useCallback(async () => {
    setLoadingLeads(true);
    const workspaceId = await resolveWorkspaceForUser(user.id);
    if (!workspaceId) { setLoadingLeads(false); return; }
    const { data } = await supabase
      .from('leads')
      .select('*')
      .eq('workspace_id', workspaceId)
      .order('score', { ascending: false })
      .order('updated_at', { ascending: false });
    if (data) {
      const normalized = normalizeLeads(data);
      setLeads(normalized);
      setInsights(generateProgrammaticInsights(normalized));
    }
    setLoadingLeads(false);
  }, [user.id]);

  const fetchQuickStats = useCallback(async () => {
    setStatsLoading(true);
    try {
      const workspaceId = await resolveWorkspaceForUser(user.id);
      if (!workspaceId) { setStatsLoading(false); return; }
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const yesterdayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).toISOString();

      const [{ data: allLeads }, { count: leadsToday }, { count: leadsYesterday }, { count: contentCreated }] = await Promise.all([
        supabase.from('leads').select('*').eq('workspace_id', workspaceId),
        supabase.from('leads').select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId).gte('created_at', todayStart),
        supabase.from('leads').select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId).gte('created_at', yesterdayStart).lt('created_at', todayStart),
        supabase.from('ai_usage_logs').select('id', { count: 'exact', head: true }).eq('user_id', user.id),
      ]);

      const lds = normalizeLeads(allLeads || []);
      const hotLeads = lds.filter(l => l.score > 80).length;
      const hotLeadsYesterdayCount = lds.filter(l => l.created_at && new Date(l.created_at) < new Date(todayStart) && l.score > 80).length;
      const avgScore = lds.length > 0 ? Math.round(lds.reduce((a, b) => a + b.score, 0) / lds.length) : 0;
      const programmaticInsights = generateProgrammaticInsights(lds);

      setStats({
        leadsToday: leadsToday || 0,
        hotLeads,
        contentCreated: contentCreated || 0,
        avgAiScore: avgScore,
        predictedConversions: Math.round(hotLeads * 0.35),
        recommendations: programmaticInsights.length,
        leadsYesterday: leadsYesterday || 0,
        hotLeadsYesterday: hotLeadsYesterdayCount,
      });
    } catch (err) {
      console.warn('[MobileHome] stats fetch error:', err);
    } finally {
      setStatsLoading(false);
    }
  }, [user.id]);

  const fetchSocialStats = useCallback(async () => {
    try {
      const { data } = await supabase
        .from('social_posts')
        .select('status')
        .eq('user_id', user.id)
        .in('status', ['scheduled', 'completed', 'published']);
      const posts = data || [];
      setSocialStats({
        scheduled: posts.filter(p => p.status === 'scheduled').length,
        published: posts.filter(p => p.status === 'completed' || p.status === 'published').length,
      });
    } catch { /* silent */ }
  }, [user.id]);

  const fetchEmailStats = useCallback(async () => {
    try {
      const entries = await fetchOwnerEmailPerformance();
      const thirtyDaysAgo = Date.now() - 30 * 86400000;
      const recent = entries.filter(e => new Date(e.sentAt).getTime() >= thirtyDaysAgo);
      setEmailStats({
        sent: recent.length,
        opened: recent.reduce((s, e) => s + e.opens, 0),
        clicks: recent.reduce((s, e) => s + e.clicks, 0),
      });
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    fetchLeads();
    fetchQuickStats();
    fetchSocialStats();
    fetchEmailStats();
  }, [fetchLeads, fetchQuickStats, fetchSocialStats, fetchEmailStats]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([fetchLeads(), fetchQuickStats(), fetchSocialStats(), fetchEmailStats()]);
    setRefreshing(false);
  }, [fetchLeads, fetchQuickStats, fetchSocialStats, fetchEmailStats]);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const firstName = user.name?.split(' ')[0] || 'there';

  // Trend helpers
  const leadsTrend = stats.leadsYesterday !== undefined && stats.leadsYesterday > 0
    ? stats.leadsToday - stats.leadsYesterday : null;
  const hotTrend = stats.hotLeadsYesterday !== undefined
    ? stats.hotLeads - stats.hotLeadsYesterday : null;

  return (
    <div className="space-y-5 pb-6 animate-in fade-in duration-500">
      {/* Refresh indicator */}
      {refreshing && (
        <div className="flex justify-center py-2">
          <div className="w-5 h-5 border-2 border-indigo-100 border-t-indigo-600 rounded-full animate-spin" />
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════ */}
      {/*  HERO BANNER                                           */}
      {/* ═══════════════════════════════════════════════════════ */}
      <div className="mx-4 bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 rounded-2xl p-5 text-white relative overflow-hidden">
        <div className="absolute top-0 right-0 w-40 h-40 bg-indigo-500/10 rounded-full blur-3xl -translate-y-1/2 translate-x-1/4" />
        <div className="absolute bottom-0 left-0 w-24 h-24 bg-purple-500/10 rounded-full blur-2xl translate-y-1/2 -translate-x-1/4" />

        <div className="relative">
          <div className="flex items-center gap-2.5 mb-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-500/20 flex items-center justify-center text-base font-black text-indigo-300">
              {user.name?.charAt(0) || 'U'}
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight">{greeting}, {firstName}</h1>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="px-2 py-0.5 bg-indigo-500/20 rounded-md text-[8px] font-bold text-indigo-300 uppercase tracking-widest">
                  {currentPlan} Plan
                </span>
                <span className="text-[10px] text-slate-400">
                  {new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                </span>
              </div>
            </div>
          </div>

          {/* Hero Key Metrics */}
          <div className="flex items-center gap-2 mt-3">
            <div className="flex-1 px-3 py-2.5 bg-white/5 border border-white/10 rounded-xl text-center">
              <div className="flex items-center justify-center gap-1 mb-1">
                <Target size={10} className="text-blue-300" />
                <span className="text-[8px] font-bold text-blue-300 uppercase tracking-widest">Leads</span>
              </div>
              {statsLoading ? (
                <div className="h-5 w-8 bg-white/10 animate-pulse rounded mx-auto" />
              ) : (
                <p className="text-lg font-bold">{leads.length}</p>
              )}
            </div>
            <div className="flex-1 px-3 py-2.5 bg-white/5 border border-white/10 rounded-xl text-center">
              <div className="flex items-center justify-center gap-1 mb-1">
                <BarChart3 size={10} className="text-emerald-300" />
                <span className="text-[8px] font-bold text-emerald-300 uppercase tracking-widest">Conv.</span>
              </div>
              {statsLoading ? (
                <div className="h-5 w-8 bg-white/10 animate-pulse rounded mx-auto" />
              ) : (
                <p className="text-lg font-bold">{conversionRate}%</p>
              )}
            </div>
            <div className="flex-1 px-3 py-2.5 bg-white/5 border border-white/10 rounded-xl text-center">
              <div className="flex items-center justify-center gap-1 mb-1">
                <CreditCard size={10} className="text-amber-300" />
                <span className="text-[8px] font-bold text-amber-300 uppercase tracking-widest">Credits</span>
              </div>
              <p className="text-lg font-bold">{creditsRemaining.toLocaleString()}</p>
            </div>
          </div>
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════ */}
      {/*  QUICK ACTIONS                                         */}
      {/* ═══════════════════════════════════════════════════════ */}
      <div className="px-4">
        <div className="flex gap-2 overflow-x-auto no-scrollbar pb-1">
          <button onClick={() => navigate('/portal/leads')} className="flex items-center gap-1.5 px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs font-semibold text-slate-700 whitespace-nowrap shadow-sm active:scale-95 transition-transform">
            <Upload size={14} />
            <span>Import Leads</span>
          </button>
          <button onClick={() => navigate('/portal/content')} className="flex items-center gap-1.5 px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs font-semibold text-slate-700 whitespace-nowrap shadow-sm active:scale-95 transition-transform">
            <Sparkles size={14} />
            <span>Generate Content</span>
          </button>
          <button onClick={() => navigate('/portal/analytics')} className="flex items-center gap-1.5 px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs font-semibold text-slate-700 whitespace-nowrap shadow-sm active:scale-95 transition-transform">
            <FileText size={14} />
            <span>Run Report</span>
          </button>
          <button onClick={() => navigate('/portal/leads')} className="px-4 py-2 bg-indigo-600 text-white rounded-xl text-xs font-bold whitespace-nowrap shadow-lg shadow-indigo-100 active:scale-95 transition-transform">
            + Add Lead
          </button>
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════ */}
      {/*  QUICK STATS GRID (mirrors QuickStatsRow)              */}
      {/* ═══════════════════════════════════════════════════════ */}
      <div className="px-4">
        <div className="grid grid-cols-2 gap-2.5">
          {/* Leads Today */}
          <div className="bg-white p-3 rounded-2xl border border-slate-200 shadow-sm">
            <div className="flex items-center justify-between mb-1.5">
              <div className="p-1.5 bg-indigo-50 text-indigo-600 rounded-lg"><Target size={14} /></div>
              {!statsLoading && leadsTrend !== null && (
                <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${leadsTrend >= 0 ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-600'}`}>
                  {leadsTrend >= 0 ? '+' : ''}{leadsTrend} today
                </span>
              )}
            </div>
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">Leads Today</p>
            {statsLoading ? <div className="h-6 w-12 bg-slate-100 animate-pulse rounded mt-0.5" /> : <p className="text-xl font-bold text-slate-900">{stats.leadsToday}</p>}
          </div>

          {/* Hot Leads */}
          <div className="bg-white p-3 rounded-2xl border border-slate-200 shadow-sm">
            <div className="flex items-center justify-between mb-1.5">
              <div className="p-1.5 bg-rose-50 text-rose-600 rounded-lg"><Flame size={14} /></div>
              {!statsLoading && hotTrend !== null && (
                <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${hotTrend >= 0 ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-600'}`}>
                  {hotTrend >= 0 ? '+' : ''}{hotTrend} vs yday
                </span>
              )}
            </div>
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">Hot Leads</p>
            {statsLoading ? <div className="h-6 w-16 bg-slate-100 animate-pulse rounded mt-0.5" /> : <p className="text-xl font-bold text-slate-900">{stats.hotLeads} Active</p>}
          </div>

          {/* Content Created */}
          <div className="bg-white p-3 rounded-2xl border border-slate-200 shadow-sm">
            <div className="p-1.5 bg-violet-50 text-violet-600 rounded-lg w-fit mb-1.5"><Sparkles size={14} /></div>
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">Content Created</p>
            {statsLoading ? <div className="h-6 w-10 bg-slate-100 animate-pulse rounded mt-0.5" /> : <p className="text-xl font-bold text-slate-900">{stats.contentCreated}</p>}
          </div>

          {/* Avg AI Score */}
          <div className="bg-white p-3 rounded-2xl border border-slate-200 shadow-sm">
            <div className="p-1.5 bg-amber-50 text-amber-600 rounded-lg w-fit mb-1.5"><Zap size={14} /></div>
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">Avg AI Score</p>
            {statsLoading ? <div className="h-6 w-10 bg-slate-100 animate-pulse rounded mt-0.5" /> : <p className="text-xl font-bold text-slate-900">{stats.avgAiScore}%</p>}
          </div>

          {/* Social Posts */}
          <div className="bg-white p-3 rounded-2xl border border-slate-200 shadow-sm">
            <div className="flex items-center justify-between mb-1.5">
              <div className="p-1.5 bg-sky-50 text-sky-600 rounded-lg"><Send size={14} /></div>
              {socialStats.scheduled > 0 && (
                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-600">{socialStats.scheduled} queued</span>
              )}
            </div>
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">Social Posts</p>
            <p className="text-xl font-bold text-slate-900">{socialStats.published} sent</p>
          </div>

          {/* Email Performance */}
          <div className="bg-white p-3 rounded-2xl border border-slate-200 shadow-sm">
            <div className="p-1.5 bg-indigo-50 text-indigo-600 rounded-lg w-fit mb-1.5"><Mail size={14} /></div>
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">Email (30d)</p>
            {emailStats ? (
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-sm font-bold text-slate-900">{emailStats.sent}</span>
                <div className="flex items-center gap-1 text-[9px] text-slate-400">
                  <Eye size={9} />{emailStats.opened}
                  <MousePointer size={9} className="ml-1" />{emailStats.clicks}
                </div>
              </div>
            ) : (
              <div className="h-6 w-16 bg-slate-100 animate-pulse rounded mt-0.5" />
            )}
          </div>
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════ */}
      {/*  AI INSIGHTS                                           */}
      {/* ═══════════════════════════════════════════════════════ */}
      {insights.length > 0 && (
        <div className="px-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="p-4 border-b border-slate-100 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="p-1.5 bg-indigo-50 text-indigo-600 rounded-lg"><Brain size={14} /></div>
                <h3 className="text-sm font-bold text-slate-800">AI Insights</h3>
                <span className="px-1.5 py-0.5 bg-indigo-50 text-indigo-600 rounded text-[9px] font-bold">{insights.length}</span>
              </div>
            </div>
            <div className="divide-y divide-slate-50">
              {insights.slice(0, 4).map(insight => (
                <div key={insight.id} className="px-4 py-3 flex items-start gap-3">
                  <div className={`p-1.5 rounded-lg shrink-0 mt-0.5 ${
                    insight.category === 'score' ? 'bg-indigo-50 text-indigo-600' :
                    insight.category === 'timing' ? 'bg-blue-50 text-blue-600' :
                    insight.category === 'conversion' ? 'bg-emerald-50 text-emerald-600' :
                    insight.category === 'engagement' ? 'bg-orange-50 text-orange-600' :
                    'bg-purple-50 text-purple-600'
                  }`}>
                    <Sparkles size={12} />
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs font-bold text-slate-800">{insight.title}</p>
                    <p className="text-[11px] text-slate-500 mt-0.5 leading-relaxed line-clamp-2">{insight.description}</p>
                    {insight.confidence > 0 && (
                      <div className="flex items-center gap-1.5 mt-1.5">
                        <div className="w-12 h-1 bg-slate-100 rounded-full overflow-hidden">
                          <div className="h-full bg-indigo-400 rounded-full" style={{ width: `${insight.confidence}%` }} />
                        </div>
                        <span className="text-[9px] font-bold text-slate-400">{insight.confidence}%</span>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════ */}
      {/*  PRIORITY PROSPECT LIST                                */}
      {/* ═══════════════════════════════════════════════════════ */}
      <div className="px-4">
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="p-4 border-b border-slate-100 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-bold text-slate-800">Priority Prospects</h3>
              {leads.length > prospectPageSize && (
                <span className="text-[9px] text-slate-400">
                  {prospectPageSize} of {leads.length}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {loadingLeads && <span className="text-[10px] text-indigo-600 animate-pulse font-bold">Syncing...</span>}
              <select
                value={prospectPageSize}
                onChange={e => setProspectPageSize(Number(e.target.value))}
                className="text-[10px] font-bold text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-1.5 py-0.5 focus:outline-none"
              >
                <option value={10}>10</option>
                <option value={25}>25</option>
                <option value={50}>50</option>
              </select>
              {leads.length > prospectPageSize && (
                <button onClick={() => navigate('/portal/mobile/leads')} className="text-[10px] font-bold text-indigo-600 flex items-center gap-0.5">
                  All <ArrowRight size={10} />
                </button>
              )}
            </div>
          </div>

          {leads.length === 0 && !loadingLeads ? (
            <div className="px-4 py-10 text-center">
              <p className="text-sm text-slate-400">No leads found. Start by adding your first prospect.</p>
            </div>
          ) : (
            <div className="divide-y divide-slate-50">
              {leads.slice(0, prospectPageSize).map(lead => (
                <button
                  key={lead.id}
                  onClick={() => navigate(`/portal/mobile/leads/${lead.id}`)}
                  className="w-full flex items-center gap-3 px-4 py-3 text-left active:bg-slate-50 transition-colors"
                >
                  <div className="w-9 h-9 rounded-xl bg-slate-100 flex items-center justify-center font-bold text-[11px] text-slate-500 shrink-0">
                    {(lead.first_name?.charAt(0) || '') + (lead.last_name?.charAt(0) || '') || '?'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-bold text-slate-900 truncate">{lead.first_name} {lead.last_name}</p>
                    <p className="text-[10px] text-slate-400 truncate">{lead.company} {lead.primary_email ? `· ${lead.primary_email}` : ''}</p>
                  </div>
                  {/* Aura Score */}
                  <div className="flex flex-col items-center gap-0.5 shrink-0 w-12">
                    <div className="w-full bg-slate-100 h-1 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${lead.score > 80 ? 'bg-indigo-500' : lead.score > 50 ? 'bg-orange-400' : 'bg-red-400'}`}
                        style={{ width: `${lead.score}%` }}
                      />
                    </div>
                    <span className="text-[9px] font-black text-slate-700">{lead.score}%</span>
                  </div>
                  {/* Status */}
                  <span className={`px-1.5 py-0.5 rounded text-[8px] font-black uppercase tracking-wider shrink-0 ${leadStatusColor(lead.status)}`}>
                    {lead.status}
                  </span>
                  <ChevronRight size={12} className="text-slate-300 shrink-0" />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════ */}
      {/*  LIVE ACTIVITY FEED                                    */}
      {/* ═══════════════════════════════════════════════════════ */}
      <div className="px-4">
        <div className="flex items-center justify-between mb-2.5">
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-black text-slate-900 uppercase tracking-wider">Recent Activity</h3>
            <div className={`w-1.5 h-1.5 rounded-full ${
              connectionStatus === 'connected' ? 'bg-emerald-500' : connectionStatus === 'error' ? 'bg-red-500' : 'bg-amber-500'
            }`} />
          </div>
          <button onClick={() => navigate('/portal/mobile/activity')} className="text-[10px] font-bold text-indigo-600 flex items-center gap-0.5">
            View all <ArrowRight size={10} />
          </button>
        </div>
        {jobs.length === 0 ? (
          <div className="bg-white rounded-2xl p-6 border border-slate-200 text-center">
            <p className="text-xs text-slate-400">No recent activity</p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {jobs.slice(0, 5).map(job => (
              <div key={job.id} className="bg-white rounded-xl p-3 border border-slate-100 shadow-sm flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-slate-800 truncate">{job.type?.replace(/_/g, ' ') || 'Job'}</p>
                  {job.created_at && (
                    <p className="text-[9px] text-slate-400">
                      {new Date(job.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </p>
                  )}
                </div>
                <span className={`px-1.5 py-0.5 rounded text-[9px] font-black shrink-0 ${jobStatusColor(job.status)}`}>
                  {job.status}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Refresh button */}
      <div className="px-4">
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="w-full flex items-center justify-center gap-2 py-3 text-xs font-bold text-slate-400 hover:text-slate-600 transition-colors disabled:opacity-50"
        >
          <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
          {refreshing ? 'Refreshing...' : 'Tap to refresh'}
        </button>
      </div>
    </div>
  );
};

export default MobileHome;
