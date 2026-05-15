import React, { useState, useCallback, useMemo } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { Search, Filter, ChevronRight } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../../lib/supabase';
import { cacheKeys, staleTimes } from '../../../lib/cacheKeys';
import { resolveWorkspaceForUser } from '../../../lib/memory';
import type { User, Lead } from '../../../types';

interface LayoutContext {
  user: User;
}

type SortField = 'score' | 'created_at' | 'last_activity';
type StatusFilter = 'all' | 'New' | 'Contacted' | 'Qualified' | 'Converted' | 'Lost';

const STATUS_COLORS: Record<string, string> = {
  New: 'bg-blue-100 text-blue-700',
  Contacted: 'bg-amber-100 text-amber-700',
  Qualified: 'bg-indigo-100 text-indigo-700',
  Converted: 'bg-emerald-100 text-emerald-700',
  Lost: 'bg-gray-100 text-gray-500',
};

async function fetchLeads(userId: string): Promise<Lead[]> {
  const workspaceId = await resolveWorkspaceForUser(userId);
  if (!workspaceId) return [];
  const { data } = await supabase
    .from('leads')
    .select('id, first_name, last_name, company, score, status, primary_email, primary_phone, created_at, last_activity, source')
    .eq('workspace_id', workspaceId)
    .order('score', { ascending: false })
    .limit(200);
  return (data ?? []) as Lead[];
}

const MobileLeads: React.FC = () => {
  const { user } = useOutletContext<LayoutContext>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sortBy] = useState<SortField>('score');
  const [showFilters, setShowFilters] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const { data: leads = [], isLoading } = useQuery<Lead[]>({
    queryKey: [...cacheKeys.leads(user.id), 'mobile-list'],
    queryFn: () => fetchLeads(user.id),
    staleTime: staleTimes.fast,
    enabled: !!user.id,
  });

  const filtered = useMemo(() => {
    let result = leads;
    if (statusFilter !== 'all') {
      result = result.filter(l => l.status === statusFilter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(l =>
        `${l.first_name} ${l.last_name}`.toLowerCase().includes(q) ||
        l.company?.toLowerCase().includes(q) ||
        l.primary_email?.toLowerCase().includes(q)
      );
    }
    return result;
  }, [leads, statusFilter, search]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await qc.invalidateQueries({ queryKey: cacheKeys.leads(user.id) });
    setRefreshing(false);
  }, [user.id, qc]);

  return (
    <div className="flex flex-col h-full">
      {/* Search + Filter Bar */}
      <div className="px-4 pt-4 pb-2 space-y-2 bg-gray-50 sticky top-0 z-10">
        <div className="relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            placeholder="Search leads..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full pl-9 pr-10 py-2.5 bg-white border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-300"
          />
          <button
            onClick={() => setShowFilters(prev => !prev)}
            className={`absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-lg transition-colors ${
              showFilters ? 'bg-indigo-100 text-indigo-600' : 'text-gray-400'
            }`}
          >
            <Filter size={16} />
          </button>
        </div>

        {showFilters && (
          <div className="flex gap-1.5 overflow-x-auto pb-1 no-scrollbar">
            {(['all', 'New', 'Contacted', 'Qualified', 'Converted', 'Lost'] as StatusFilter[]).map(s => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={`px-3 py-1.5 rounded-full text-[11px] font-bold whitespace-nowrap transition-colors ${
                  statusFilter === s
                    ? 'bg-indigo-600 text-white'
                    : 'bg-white border border-gray-200 text-gray-600'
                }`}
              >
                {s === 'all' ? 'All' : s}
              </button>
            ))}
          </div>
        )}

        <div className="flex items-center justify-between">
          <p className="text-[10px] font-bold text-gray-400 uppercase">{filtered.length} leads</p>
          {refreshing && <div className="w-4 h-4 border-2 border-indigo-100 border-t-indigo-600 rounded-full animate-spin" />}
        </div>
      </div>

      {/* Lead List */}
      <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-2">
        {isLoading ? (
          <div className="flex justify-center py-12">
            <div className="w-7 h-7 border-3 border-indigo-100 border-t-indigo-600 rounded-full animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-sm text-gray-400">{search ? 'No matches found' : 'No leads yet'}</p>
          </div>
        ) : (
          filtered.map(lead => (
            <button
              key={lead.id}
              onClick={() => navigate(`/portal/mobile/leads/${lead.id}`)}
              className="w-full flex items-center gap-3 bg-white rounded-2xl p-3.5 border border-gray-100 shadow-sm text-left active:scale-[0.98] transition-transform"
            >
              <div className="w-10 h-10 rounded-xl bg-indigo-50 flex items-center justify-center text-indigo-600 font-bold text-sm shrink-0">
                {lead.first_name?.charAt(0) || '?'}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-bold text-gray-900 truncate">{lead.first_name} {lead.last_name}</p>
                <p className="text-[11px] text-gray-400 truncate">{lead.company || lead.primary_email}</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className={`px-1.5 py-0.5 rounded text-[9px] font-black ${STATUS_COLORS[lead.status] || 'bg-gray-100 text-gray-500'}`}>
                  {lead.status}
                </span>
                <span className={`text-xs font-black ${lead.score >= 75 ? 'text-rose-600' : lead.score >= 50 ? 'text-amber-600' : 'text-gray-400'}`}>
                  {lead.score}
                </span>
                <ChevronRight size={14} className="text-gray-300" />
              </div>
            </button>
          ))
        )}

        {/* Pull to refresh */}
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="w-full py-3 text-center text-xs font-bold text-gray-400 hover:text-gray-600 disabled:opacity-50"
        >
          {refreshing ? 'Refreshing...' : 'Tap to refresh'}
        </button>
      </div>
    </div>
  );
};

export default MobileLeads;
