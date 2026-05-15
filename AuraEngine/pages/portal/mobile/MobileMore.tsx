import React from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import {
  PieChart, MessageSquare, Zap, Plug, Settings,
  CreditCard, HelpCircle, BookOpen, LogOut, ChevronRight,
  Send, LayoutGrid, SlidersHorizontal, Target,
} from 'lucide-react';
import type { User } from '../../../types';
import { TIER_LIMITS, resolvePlanName } from '../../../lib/credits';

interface LayoutContext {
  user: User;
  onLogout: () => void;
}

interface MenuItem {
  label: string;
  icon: React.FC<{ size?: number; className?: string }>;
  path: string;
  color: string;
}

const MENU_SECTIONS: { title: string; items: MenuItem[] }[] = [
  {
    title: 'Tools',
    items: [
      { label: 'Goals', icon: Target, path: '/portal/mobile/goals', color: 'indigo' },
      { label: 'Reports', icon: PieChart, path: '/portal/analytics', color: 'indigo' },
      { label: 'AI Assistant', icon: MessageSquare, path: '/portal/ai', color: 'violet' },
      { label: 'Tasks', icon: Zap, path: '/portal/strategy', color: 'amber' },
      { label: 'Board View', icon: LayoutGrid, path: '/portal/team-hub', color: 'emerald' },
      { label: 'Social', icon: Send, path: '/portal/social-scheduler', color: 'rose' },
    ],
  },
  {
    title: 'Workspace',
    items: [
      { label: 'Integrations', icon: Plug, path: '/portal/integrations', color: 'blue' },
      { label: 'AI Settings', icon: SlidersHorizontal, path: '/portal/model-training', color: 'slate' },
    ],
  },
  {
    title: 'Account',
    items: [
      { label: 'Subscription', icon: CreditCard, path: '/portal/billing', color: 'emerald' },
      { label: 'Settings', icon: Settings, path: '/portal/settings', color: 'gray' },
      { label: 'User Manual', icon: BookOpen, path: '/portal/manual', color: 'indigo' },
      { label: 'Help Center', icon: HelpCircle, path: '/portal/help', color: 'blue' },
    ],
  },
];

const MobileMore: React.FC = () => {
  const { user, onLogout } = useOutletContext<LayoutContext>();
  const navigate = useNavigate();

  const currentPlan = resolvePlanName(user.subscription?.plan_name || user.plan || 'Free');
  const creditsTotal = user.credits_total || (TIER_LIMITS[currentPlan]?.credits ?? TIER_LIMITS.Free.credits);
  const creditsUsed = user.credits_used || 0;
  const creditsLeft = creditsTotal - creditsUsed;
  const usagePercent = Math.min(Math.round((creditsUsed / creditsTotal) * 100), 100);

  return (
    <div className="px-4 py-5 space-y-5 pb-8">
      {/* User Card */}
      <div className="bg-white rounded-2xl p-4 border border-gray-100 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-2xl bg-indigo-50 flex items-center justify-center text-indigo-600 font-black text-lg">
            {user.name?.charAt(0) || 'U'}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-gray-900 truncate">{user.name || 'User'}</p>
            <p className="text-[11px] text-gray-400 truncate">{user.email}</p>
          </div>
        </div>

        {/* Credits Bar */}
        <div className="mt-4 bg-gray-50 rounded-xl p-3">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[10px] font-black text-gray-400 uppercase">AI Credits</span>
            <span className="text-[10px] font-bold text-gray-500">{creditsLeft.toLocaleString()} left</span>
          </div>
          <div className="w-full h-1.5 bg-gray-200 rounded-full overflow-hidden">
            <div
              className="h-full bg-indigo-500 rounded-full transition-all duration-500"
              style={{ width: `${usagePercent}%` }}
            />
          </div>
          <p className="text-[10px] text-gray-400 mt-1">{currentPlan} plan</p>
        </div>
      </div>

      {/* Menu Sections */}
      {MENU_SECTIONS.map(section => (
        <div key={section.title}>
          <p className="text-[10px] font-black text-gray-400 uppercase tracking-wider mb-2 px-1">{section.title}</p>
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm divide-y divide-gray-50">
            {section.items.map(item => (
              <button
                key={item.label}
                onClick={() => navigate(item.path)}
                className="w-full flex items-center gap-3 px-4 py-3.5 text-left active:bg-gray-50 transition-colors"
              >
                <div className={`w-8 h-8 rounded-lg bg-${item.color}-50 flex items-center justify-center`}>
                  <item.icon size={16} className={`text-${item.color}-600`} />
                </div>
                <span className="text-sm font-semibold text-gray-700 flex-1">{item.label}</span>
                <ChevronRight size={14} className="text-gray-300" />
              </button>
            ))}
          </div>
        </div>
      ))}

      {/* Sign Out */}
      <button
        onClick={onLogout}
        className="w-full flex items-center gap-3 bg-white rounded-2xl px-4 py-3.5 border border-gray-100 shadow-sm text-left active:bg-red-50 transition-colors"
      >
        <div className="w-8 h-8 rounded-lg bg-red-50 flex items-center justify-center">
          <LogOut size={16} className="text-red-500" />
        </div>
        <span className="text-sm font-semibold text-red-600">Sign Out</span>
      </button>
    </div>
  );
};

export default MobileMore;
