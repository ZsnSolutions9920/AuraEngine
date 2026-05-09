import React, { useState, useEffect, Suspense, lazy, useCallback } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { UserRole, User } from './types';
import ErrorBoundary from './components/ErrorBoundary';
import { GuideProvider } from './components/guide/GuideProvider';
import { SupportProvider } from './components/support/SupportProvider';
import { SupportBanner } from './components/support/SupportBanner';
import { UIModeProvider } from './components/ui-mode';
import { useIdlePrefetch } from './hooks/useIdlePrefetch';
import { useAuthMachine } from './hooks/useAuthMachine';
import { AuthGate } from './components/auth/AuthGate';
import { useIsMobile } from './hooks/useIsMobile';
import { canEnterAdmin, canEnterSupport } from './lib/permissions';
import { loadBranding, applyBrandingToDocument } from './lib/branding';

// Dev perf panel — lazy-loaded, tree-shaken in production
const PerfPanel = lazy(() => import('./components/dev/PerfPanel'));

// Layouts — direct imports so the app shell never suspends
import MarketingLayout from './components/layout/MarketingLayout';
import AdminLayout from './components/layout/AdminLayout';
import ClientLayout from './components/layout/ClientLayout';

// ─── Lazy-loaded pages ───

// Marketing
const LandingPage = lazy(() => import('./pages/marketing/LandingPage'));
const FeaturesPage = lazy(() => import('./pages/marketing/FeaturesPage'));
const PricingPage = lazy(() => import('./pages/marketing/PricingPage'));
const AboutPage = lazy(() => import('./pages/marketing/AboutPage'));
const ContactPage = lazy(() => import('./pages/marketing/ContactPage'));
const BlogPage = lazy(() => import('./pages/marketing/BlogPage'));
const BlogPostPage = lazy(() => import('./pages/marketing/BlogPostPage'));
const TrialSignupPage = lazy(() => import('./pages/marketing/TrialSignupPage'));

// Auth
const AuthPage = lazy(() => import('./pages/portal/AuthPage'));
const VoiceAgentLauncher = lazy(() => import('./components/voice/VoiceAgentLauncher'));
const ResetPasswordPage = lazy(() => import('./pages/portal/ResetPasswordPage'));
const ConfirmEmailPage = lazy(() => import('./pages/portal/ConfirmEmailPage'));

// Onboarding
const OnboardingPage = lazy(() => import('./pages/portal/OnboardingPage'));

// Client Portal
const ClientDashboard = lazy(() => import('./pages/portal/ClientDashboard'));
const MissionControl = lazy(() => import('./pages/portal/MissionControl'));
const LeadManagement = lazy(() => import('./pages/portal/LeadManagement'));
const LeadProfile = lazy(() => import('./pages/portal/LeadProfile'));
const ContentGen = lazy(() => import('./pages/portal/ContentGen'));
const BlogDrafts = lazy(() => import('./pages/portal/BlogDrafts'));
const AnalyticsPage = lazy(() => import('./pages/portal/AnalyticsPage'));
const AutomationPage = lazy(() => import('./pages/portal/AutomationPage'));
const BillingPage = lazy(() => import('./pages/portal/BillingPage'));
const HelpCenterPage = lazy(() => import('./pages/portal/HelpCenterPage'));
const UserManualPage = lazy(() => import('./pages/portal/UserManualPage'));
const ProfilePage = lazy(() => import('./pages/portal/ProfilePage'));
const LeadIntelligence = lazy(() => import('./pages/portal/LeadIntelligence'));
const AICommandCenter = lazy(() => import('./pages/portal/AICommandCenter'));
const ContentStudio = lazy(() => import('./pages/portal/ContentStudio'));
// Mobile portal
import MobileAppShell from './components/layout/MobileAppShell';
const MobileHome = lazy(() => import('./pages/portal/mobile/MobileHome'));
const MobileLeads = lazy(() => import('./pages/portal/mobile/MobileLeads'));
const MobileLeadDetail = lazy(() => import('./pages/portal/mobile/MobileLeadDetail'));
const MobileCampaigns = lazy(() => import('./pages/portal/mobile/MobileCampaigns'));
const MobileActivity = lazy(() => import('./pages/portal/mobile/MobileActivity'));
const MobileMore = lazy(() => import('./pages/portal/mobile/MobileMore'));
const ModelTraining = lazy(() => import('./pages/portal/ModelTraining'));
const IntegrationHub = lazy(() => import('./pages/portal/IntegrationHub'));
const ApolloSearchPage = lazy(() => import('./pages/portal/ApolloSearchPage'));
const InvoicesPage = lazy(() => import('./pages/portal/InvoicesPage'));
const SocialScheduler = lazy(() => import('./pages/portal/SocialScheduler'));
const TeamHubBoards = lazy(() => import('./pages/portal/team-hub/TeamHubPage'));
const SenderAccountsPage = lazy(() => import('./pages/portal/SenderAccountsPage'));
const ApiKeysPage = lazy(() => import('./pages/portal/ApiKeysPage'));

// Admin
const AdminDashboard = lazy(() => import('./pages/admin/AdminDashboard'));
const SupportConsole = lazy(() => import('./pages/support/SupportConsole'));
const UserManagement = lazy(() => import('./pages/admin/UserManagement'));
const SystemHealth = lazy(() => import('./pages/admin/SystemHealth'));
const LeadsManagement = lazy(() => import('./pages/admin/LeadsManagement'));
const AdminSettings = lazy(() => import('./pages/admin/AdminSettings'));
const AIOperations = lazy(() => import('./pages/admin/AIOperations'));
const DnaRegistryPage = lazy(() => import('./pages/admin/prompt-lab/DnaRegistryPage'));
const DnaEditorPage = lazy(() => import('./pages/admin/prompt-lab/DnaEditorPage'));
const AuditLogs = lazy(() => import('./pages/admin/AuditLogs'));
const BlogManager = lazy(() => import('./pages/admin/BlogManager'));
const PricingManagement = lazy(() => import('./pages/admin/PricingManagement'));
const AdminOpsCenter = lazy(() => import('./pages/admin/AdminOpsCenter'));
const AdminCommandCenter = lazy(() => import('./pages/admin/CommandCenter/AdminCommandCenterPage'));
const AdminConsolePage = lazy(() => import('./pages/admin/console/AdminConsolePage'));

// ─── Route guard components ───
// These isolate useLocation / useIsMobile so App never re-renders on navigation.

/** Redirects to /auth with the current location in state. Only mounts for unauthenticated users. */
function AuthRedirect() {
  const location = useLocation();
  return <Navigate to="/auth" state={{ from: location }} />;
}

/** Portal entry guard — checks onboarding + mobile + pending plan selection, then renders ClientLayout. */
function PortalGuard({ user, onLogout, refreshProfile }: { user: User; onLogout: () => void; refreshProfile: () => Promise<void> }) {
  const isMobile = useIsMobile();
  const location = useLocation();

  if (!user.businessProfile?.companyName && !localStorage.getItem('scaliyo_onboarding_complete')) {
    return <Navigate to="/onboarding" replace />;
  }

  // If user selected a plan from pricing page, redirect to billing with that plan
  const storedPlan = localStorage.getItem('scaliyo_selected_plan');
  if (storedPlan && !location.pathname.includes('/billing')) {
    // Don't remove yet — BillingPage will clear it after opening checkout
    return <Navigate to={`/portal/billing?plan=${storedPlan}`} replace />;
  }

  if (isMobile) {
    return <Navigate to="/portal/mobile" replace />;
  }
  return <ClientLayout user={user} onLogout={onLogout} refreshProfile={refreshProfile} />;
}

/** Mobile portal entry guard — checks onboarding, then renders MobileAppShell. */
function MobilePortalGuard({ user, onLogout, refreshProfile }: { user: User; onLogout: () => void; refreshProfile: () => Promise<void> }) {
  if (!user.businessProfile?.companyName && !localStorage.getItem('scaliyo_onboarding_complete')) {
    return <Navigate to="/onboarding" replace />;
  }
  return <MobileAppShell user={user} onLogout={onLogout} refreshProfile={refreshProfile} />;
}

/** Runs idle prefetching in isolation — its useLocation() doesn't cause App to re-render. */
function IdlePrefetcher() {
  useIdlePrefetch();
  return null;
}

const PageFallback = () => {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setShow(true), 150);
    return () => clearTimeout(id);
  }, []);
  if (!show) return null;
  return (
    <div className="animate-fadeIn px-6 py-10 max-w-4xl mx-auto space-y-6">
      <div className="h-8 w-48 bg-slate-200 rounded-lg animate-pulse" />
      <div className="space-y-3">
        <div className="h-4 w-full bg-slate-100 rounded animate-pulse" />
        <div className="h-4 w-5/6 bg-slate-100 rounded animate-pulse" />
        <div className="h-4 w-2/3 bg-slate-100 rounded animate-pulse" />
      </div>
      <div className="grid grid-cols-3 gap-4">
        <div className="h-24 bg-slate-100 rounded-xl animate-pulse" />
        <div className="h-24 bg-slate-100 rounded-xl animate-pulse" />
        <div className="h-24 bg-slate-100 rounded-xl animate-pulse" />
      </div>
    </div>
  );
};

const App: React.FC = () => {
  const { state, retry, logout, setUser, refreshProfile } = useAuthMachine();
  const { user } = state;
  const [showLogoutModal, setShowLogoutModal] = useState(false);
  const qc = useQueryClient();

  // Phase 4.6.a — apply per-workspace branding once we have a user.
  // Best-effort; failure leaves platform defaults in place.
  useEffect(() => {
    if (!user?.id) {
      applyBrandingToDocument(null);
      return;
    }
    let cancelled = false;
    loadBranding(user.id).then((b) => {
      if (!cancelled) applyBrandingToDocument(b);
    }).catch(() => { /* keep defaults */ });
    return () => { cancelled = true; };
  }, [user?.id]);

  // ErrorBoundary reset: invalidate caches + re-bootstrap auth
  const handleErrorReset = useCallback(() => {
    retry();
  }, [retry]);

  const handleLogout = useCallback(() => {
    setShowLogoutModal(true);
  }, []);

  const confirmLogout = useCallback(async () => {
    setShowLogoutModal(false);
    await logout();
  }, [logout]);

  return (
    <AuthGate phase={state.phase} error={state.error} onRetry={retry}>
    <UIModeProvider userId={user?.id}>
    <SupportProvider user={user}>
    <ErrorBoundary queryClient={qc} onReset={handleErrorReset}>
      <GuideProvider>
      <SupportBanner />
      <IdlePrefetcher />
      {/* Logout Confirmation Modal */}
      {showLogoutModal && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setShowLogoutModal(false)} />
          <div className="relative bg-white rounded-3xl shadow-2xl p-8 max-w-sm w-full mx-4 animate-in fade-in zoom-in-95 duration-200">
            <div className="flex flex-col items-center text-center space-y-4">
              <div className="w-14 h-14 bg-red-50 rounded-2xl flex items-center justify-center">
                <svg className="w-7 h-7 text-red-500" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9" />
                </svg>
              </div>
              <div>
                <h3 className="text-lg font-bold text-slate-900">Sign Out?</h3>
                <p className="text-sm text-slate-500 mt-1">Are you sure you want to sign out of your account?</p>
              </div>
              <div className="flex items-center gap-3 w-full pt-2">
                <button
                  onClick={() => setShowLogoutModal(false)}
                  className="flex-1 px-5 py-3 rounded-2xl border border-slate-200 text-sm font-bold text-slate-600 hover:bg-slate-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmLogout}
                  className="flex-1 px-5 py-3 rounded-2xl bg-red-500 text-white text-sm font-bold hover:bg-red-600 transition-colors shadow-lg shadow-red-100"
                >
                  Sign Out
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

        <Routes>
          {/* Marketing — has its own full-page Suspense since there's no persistent shell */}
          <Route element={<MarketingLayout />}>
            <Route path="/" element={<Suspense fallback={<PageFallback />}><LandingPage /></Suspense>} />
            <Route path="/features" element={<Suspense fallback={<PageFallback />}><FeaturesPage /></Suspense>} />
            <Route path="/pricing" element={<Suspense fallback={<PageFallback />}><PricingPage /></Suspense>} />
            <Route path="/blog" element={<Suspense fallback={<PageFallback />}><BlogPage /></Suspense>} />
            <Route path="/blog/:slug" element={<Suspense fallback={<PageFallback />}><BlogPostPage /></Suspense>} />
            <Route path="/about" element={<Suspense fallback={<PageFallback />}><AboutPage /></Suspense>} />
            <Route path="/contact" element={<Suspense fallback={<PageFallback />}><ContactPage /></Suspense>} />
          </Route>

          <Route path="/signup" element={<Suspense fallback={<PageFallback />}><TrialSignupPage /></Suspense>} />
          <Route path="/auth" element={<Suspense fallback={null}><AuthPage user={user} onLogin={(u) => setUser(u)} /><VoiceAgentLauncher agentId={import.meta.env.VITE_ELEVENLABS_AUTH_AGENT_ID} /></Suspense>} />
          <Route path="/reset-password" element={<Suspense fallback={<PageFallback />}><ResetPasswordPage /></Suspense>} />
          <Route path="/auth/confirm" element={<Suspense fallback={<PageFallback />}><ConfirmEmailPage /></Suspense>} />

          <Route
            path="/onboarding"
            element={
              user?.role === UserRole.CLIENT ?
              <Suspense fallback={<PageFallback />}><OnboardingPage user={user!} refreshProfile={refreshProfile} /></Suspense> :
              <AuthRedirect />
            }
          />

          {/* Mobile portal — layout has ErrorBoundary + Suspense around Outlet */}
          <Route
            path="/portal/mobile"
            element={
              user?.role === UserRole.CLIENT ?
              <MobilePortalGuard user={user!} onLogout={handleLogout} refreshProfile={refreshProfile} /> :
              <AuthRedirect />
            }
          >
            <Route index element={<MobileHome />} />
            <Route path="leads" element={<MobileLeads />} />
            <Route path="leads/:leadId" element={<MobileLeadDetail />} />
            <Route path="campaigns" element={<MobileCampaigns />} />
            <Route path="activity" element={<MobileActivity />} />
            <Route path="more" element={<MobileMore />} />
          </Route>

          {/* Desktop portal — layout has ErrorBoundary + Suspense around Outlet */}
          <Route
            path="/portal"
            element={
              user?.role === UserRole.CLIENT ?
              <PortalGuard user={user!} onLogout={handleLogout} refreshProfile={refreshProfile} /> :
              <AuthRedirect />
            }
          >
            <Route index element={<MissionControl />} />
            <Route path="dashboard" element={<ClientDashboard user={user!} />} />
            {/* Legacy alias — old links to /portal/mission still resolve. */}
            <Route path="mission" element={<Navigate to="/portal" replace />} />
            <Route path="leads" element={<LeadManagement />} />
            <Route path="leads/apollo" element={<ApolloSearchPage />} />
            <Route path="leads/:leadId" element={<LeadProfile />} />
            <Route path="content" element={<ContentGen />} />
            <Route path="strategy" element={<Navigate to="/portal/team-hub" replace />} />
            <Route path="blog" element={<BlogDrafts />} />
            <Route path="analytics" element={<AnalyticsPage />} />
            <Route path="automation" element={<AutomationPage />} />
            <Route path="billing" element={<BillingPage />} />
            <Route path="help" element={<HelpCenterPage />} />
            <Route path="manual" element={<UserManualPage />} />
            <Route path="settings" element={<ProfilePage />} />
            <Route path="intelligence" element={<LeadIntelligence />} />
            <Route path="ai" element={<AICommandCenter />} />
            <Route path="content-studio" element={<ContentStudio />} />
            <Route path="model-training" element={<ModelTraining />} />
            <Route path="integrations" element={<IntegrationHub />} />
            <Route path="invoices" element={<InvoicesPage />} />
            <Route path="social-scheduler" element={<SocialScheduler />} />
            <Route path="team-hub" element={<TeamHubBoards />} />
            <Route path="sender-accounts" element={<SenderAccountsPage />} />
            <Route path="api-keys" element={<ApiKeysPage />} />
          </Route>

          {/* Admin — layout has ErrorBoundary + Suspense around Outlet */}
          <Route
            path="/admin"
            element={
              canEnterAdmin(user) ?
              <AdminLayout user={user!} onLogout={handleLogout} /> :
              <AuthRedirect />
            }
          >
            <Route index element={<AdminDashboard />} />
            <Route path="users" element={<UserManagement />} />
            <Route path="ai" element={<AIOperations />} />
            <Route path="prompts" element={<DnaRegistryPage />} />
            <Route path="prompts/:id" element={<DnaEditorPage />} />
            <Route path="leads" element={<LeadsManagement />} />
            <Route path="blog" element={<BlogManager />} />
            <Route path="health" element={<SystemHealth />} />
            <Route path="audit" element={<AuditLogs />} />
            <Route path="settings" element={<AdminSettings />} />
            <Route path="pricing" element={<PricingManagement />} />
            <Route path="console" element={<AdminConsolePage />} />
            <Route path="ops" element={<AdminOpsCenter />} />
            <Route path="command" element={<AdminCommandCenter />} />
            {canEnterSupport(user) && (
              <Route path="support" element={<SupportConsole />} />
            )}
          </Route>

          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
    </GuideProvider>
    </ErrorBoundary>
    {import.meta.env.DEV && (
      <Suspense fallback={null}><PerfPanel /></Suspense>
    )}
    </SupportProvider>
    </UIModeProvider>
    </AuthGate>
  );
};

export default App;
