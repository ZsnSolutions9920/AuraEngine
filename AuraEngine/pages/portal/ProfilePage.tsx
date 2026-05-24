import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useOutletContext, useSearchParams } from 'react-router-dom';
import { User, NotificationPreferences, DashboardPreferences, ApiKey, BusinessProfile, BusinessAnalysisResult, BusinessAnalysisField, BusinessService, BusinessPricingTier } from '../../types';
import {
  ShieldIcon, BellIcon, KeyIcon, LayoutIcon, CogIcon, CopyIcon, PlusIcon, XIcon, CheckIcon, EyeIcon, LockIcon,
  TrendUpIcon, TrendDownIcon, KeyboardIcon, ActivityIcon, BrainIcon, LayersIcon, UsersIcon,
  ClockIcon, AlertTriangleIcon, DownloadIcon, SparklesIcon, DocumentIcon, TargetIcon, BriefcaseIcon,
  GlobeIcon, LinkedInIcon, TwitterIcon, InstagramIcon, FacebookIcon, BoltIcon, RefreshIcon, ChevronDownIcon,
  PhoneIcon, MailIcon, MapPinIcon, UploadIcon, TagIcon
} from '../../components/Icons';
import { supabase } from '../../lib/supabase';
import StageColorSettings from '../../components/leads/StageColorSettings';
import { consumeCredits } from '../../lib/credits';
import { analyzeBusinessFromWeb, generateFollowUpQuestions } from '../../lib/gemini';
import { PageHeader } from '../../components/layout/PageHeader';
import { AdvancedOnly, useUIMode } from '../../components/ui-mode';
import { BRAND } from '../../lib/brand';

/** Safely extract a string from any value (handles {value,confidence} objects, nulls, etc.) */
const safeStr = (v: unknown): string => {
  if (typeof v === 'string') return v;
  if (v != null && typeof v === 'object' && 'value' in (v as any)) {
    const inner = (v as any).value;
    return typeof inner === 'string' ? inner : String(inner ?? '');
  }
  return v != null ? String(v) : '';
};

/** Safely clean a profile object for DB storage */
const cleanProfileForSave = (profile: Record<string, unknown>): Record<string, unknown> => {
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(profile)) {
    if (v == null) continue;
    if (k === 'socialLinks' && typeof v === 'object' && !Array.isArray(v)) {
      const filteredSocials: Record<string, string> = {};
      for (const [sk, sv] of Object.entries(v as Record<string, unknown>)) {
        const s = safeStr(sv);
        if (s) filteredSocials[sk] = s;
      }
      if (Object.keys(filteredSocials).length > 0) cleaned[k] = filteredSocials;
    } else if (Array.isArray(v)) {
      if (v.length > 0) cleaned[k] = v;
    } else if (typeof v === 'string') {
      if (v.trim()) cleaned[k] = v.trim();
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      cleaned[k] = v;
    } else if (typeof v === 'object') {
      const s = safeStr(v);
      if (s) cleaned[k] = s;
    }
  }
  return cleaned;
};

const PREFS_STORAGE_KEY = 'scaliyo_dashboard_prefs';
const NOTIF_STORAGE_KEY = 'scaliyo_notification_prefs';
const APIKEYS_STORAGE_KEY = 'scaliyo_api_keys';

type SettingsTab = 'profile' | 'business_profile' | 'notifications' | 'preferences' | 'api_keys' | 'security' | 'pipeline_colors';

const ProfilePage: React.FC = () => {
  const { user, refreshProfile } = useOutletContext<{ user: User; refreshProfile: () => Promise<void> }>();
  const { isAdvanced: isAdvancedMode } = useUIMode();
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState<SettingsTab>(() => {
    const tab = searchParams.get('tab');
    if (tab && ['profile','business_profile','notifications','preferences','api_keys','security','pipeline_colors'].includes(tab)) {
      return tab as SettingsTab;
    }
    return 'profile';
  });

  // Profile
  const [name, setName] = useState(user?.name || '');
  const [isUpdating, setIsUpdating] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // Notifications
  const [notifications, setNotifications] = useState<NotificationPreferences>(() => {
    try {
      const stored = localStorage.getItem(NOTIF_STORAGE_KEY);
      return stored ? JSON.parse(stored) : {
        emailAlerts: true, leadScoreAlerts: true, weeklyDigest: true,
        contentReady: true, teamMentions: false, systemUpdates: true
      };
    } catch { return { emailAlerts: true, leadScoreAlerts: true, weeklyDigest: true, contentReady: true, teamMentions: false, systemUpdates: true }; }
  });

  // Preferences
  const [preferences, setPreferences] = useState<DashboardPreferences>(() => {
    try {
      const stored = localStorage.getItem(PREFS_STORAGE_KEY);
      return stored ? JSON.parse(stored) : {
        defaultView: 'grid', itemsPerPage: 25, showQuickStats: true,
        showAiInsights: true, showActivityFeed: true, theme: 'light', autoContactedOnSend: false
      };
    } catch { return { defaultView: 'grid', itemsPerPage: 25, showQuickStats: true, showAiInsights: true, showActivityFeed: true, theme: 'light', autoContactedOnSend: false }; }
  });

  // API Keys
  const [apiKeys, setApiKeys] = useState<ApiKey[]>(() => {
    try {
      const stored = localStorage.getItem(APIKEYS_STORAGE_KEY);
      return stored ? JSON.parse(stored) : [];
    } catch { return []; }
  });
  const [newKeyName, setNewKeyName] = useState('');
  const [showKeyId, setShowKeyId] = useState<string | null>(null);

  // Security
  const [twoFactorEnabled, setTwoFactorEnabled] = useState(false);
  const [showQRCode, setShowQRCode] = useState(false);

  // Business Profile — sanitize on load to unwrap any { value, confidence } objects from DB
  const [businessProfile, setBusinessProfile] = useState<BusinessProfile>(() => {
    const raw = user?.businessProfile || {};
    const sanitized: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (v == null) continue;
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || Array.isArray(v)) {
        sanitized[k] = v;
      } else if (typeof v === 'object') {
        // Unwrap { value, confidence } objects into plain values
        const obj = v as Record<string, unknown>;
        if ('value' in obj && obj.value != null) {
          sanitized[k] = obj.value;
        } else if (k === 'socialLinks') {
          // Sanitize social links — ensure all values are strings
          const links: Record<string, string> = {};
          for (const [sk, sv] of Object.entries(obj)) {
            if (typeof sv === 'string') links[sk] = sv;
            else if (sv && typeof sv === 'object' && 'value' in (sv as any)) links[sk] = String((sv as any).value || '');
          }
          sanitized[k] = links;
        } else {
          sanitized[k] = v;
        }
      }
    }
    return sanitized as BusinessProfile;
  });
  const [isSavingBusiness, setIsSavingBusiness] = useState(false);

  // Business Profile Wizard
  type WizardPhase = 'input' | 'analyzing' | 'results' | 'questions' | 'manual';
  type AnalysisStage = 'searching' | 'reading' | 'extracting' | 'structuring' | 'complete';
  const [wizardPhase, setWizardPhase] = useState<WizardPhase>(() => {
    // If profile already has data, show results view; otherwise start with input
    const hasData = user?.businessProfile && Object.values(user.businessProfile).some(v => v);
    return hasData ? 'manual' : 'input';
  });
  const [analysisStage, setAnalysisStage] = useState<AnalysisStage>('searching');
  const [analysisProgress, setAnalysisProgress] = useState(0);
  const [analysisElapsed, setAnalysisElapsed] = useState(0);
  const [analysisStartedAt, setAnalysisStartedAt] = useState<number | null>(null);
  const [analysisCancelled, setAnalysisCancelled] = useState(false);
  const analysisCancelledRef = useRef(false);
  const [websiteUrl, setWebsiteUrl] = useState(user?.businessProfile?.companyWebsite || '');
  const [socialUrls, setSocialUrls] = useState({ linkedin: '', twitter: '', instagram: '', facebook: '' });
  const [showSocialInputs, setShowSocialInputs] = useState(false);
  const [analysisResult, setAnalysisResult] = useState<BusinessAnalysisResult | null>(null);
  const [analysisError, setAnalysisError] = useState('');
  const [followUpQuestions, setFollowUpQuestions] = useState<{ field: string; question: string; placeholder: string }[]>([]);
  const [currentQuestionIdx, setCurrentQuestionIdx] = useState(0);
  const [questionAnswer, setQuestionAnswer] = useState('');
  const [urlError, setUrlError] = useState('');
  const [businessDescription, setBusinessDescription] = useState(user?.businessProfile?.businessDescription || '');
  const stageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Background enrichment state — lets us save first and scrape after
  type EnrichmentStatus = 'idle' | 'running' | 'complete' | 'failed';
  const [enrichmentStatus, setEnrichmentStatus] = useState<EnrichmentStatus>('idle');
  const [enrichmentStartedAt, setEnrichmentStartedAt] = useState<number | null>(null);
  const [enrichmentElapsed, setEnrichmentElapsed] = useState(0);
  const [enrichmentFieldsAdded, setEnrichmentFieldsAdded] = useState(0);
  const [enrichmentError, setEnrichmentError] = useState('');
  const businessProfileRef = useRef<BusinessProfile>(businessProfile);
  useEffect(() => { businessProfileRef.current = businessProfile; }, [businessProfile]);

  // Live tick for the elapsed-time counter while enrichment runs
  useEffect(() => {
    if (enrichmentStatus !== 'running' || enrichmentStartedAt == null) return;
    const id = setInterval(() => {
      setEnrichmentElapsed(Math.floor((Date.now() - enrichmentStartedAt) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [enrichmentStatus, enrichmentStartedAt]);

  // Logo upload
  const [logoUrl, setLogoUrl] = useState<string | null>(user?.businessProfile?.logoUrl || null);
  const [uploadingLogo, setUploadingLogo] = useState(false);

  // Structured services & pricing
  const [servicesList, setServicesList] = useState<BusinessService[]>(user?.businessProfile?.services || []);
  const [pricingTiers, setPricingTiers] = useState<BusinessPricingTier[]>(user?.businessProfile?.pricingTiers || []);

  // Deep insights collapsible
  const [showDeepInsights, setShowDeepInsights] = useState(false);

  // ─── Logo Upload Handlers ───
  const logoInputRef = useRef<HTMLInputElement>(null);

  const handleLogoUpload = async (file: File) => {
    if (file.size > 5 * 1024 * 1024) {
      setError('Logo file must be under 5MB');
      return;
    }
    const ext = file.name.split('.').pop()?.toLowerCase();
    if (!['png','jpg','jpeg','svg','webp'].includes(ext || '')) {
      setError('Accepted formats: PNG, JPG, SVG, WebP');
      return;
    }
    setUploadingLogo(true);
    setError('');
    try {
      const path = `logos/${user.id}/${Date.now()}.${ext}`;
      const { error: uploadErr } = await supabase.storage.from('image-gen-assets').upload(path, file, { upsert: true });
      if (uploadErr) throw new Error(uploadErr.message || 'Upload failed. Make sure the image-gen-assets bucket exists.');
      const { data: urlData } = supabase.storage.from('image-gen-assets').getPublicUrl(path);
      const publicUrl = urlData?.publicUrl || '';
      setLogoUrl(publicUrl);
      // Update local state and auto-save to DB
      const updatedProfile = { ...businessProfile, logoUrl: publicUrl, logoAssetId: path };
      setBusinessProfile(updatedProfile);
      const cleaned = cleanProfileForSave(updatedProfile as Record<string, unknown>);
      await supabase.from('profiles').update({ businessProfile: cleaned }).eq('id', user.id);
      if (refreshProfile) await refreshProfile();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Logo upload failed');
    } finally {
      setUploadingLogo(false);
    }
  };

  const handleLogoRemove = async () => {
    setLogoUrl(null);
    const next = { ...businessProfile };
    delete next.logoUrl;
    delete next.logoAssetId;
    setBusinessProfile(next);
    // Auto-save to DB
    try {
      const cleaned = cleanProfileForSave(next as Record<string, unknown>);
      await supabase.from('profiles').update({ businessProfile: Object.keys(cleaned).length > 0 ? cleaned : null }).eq('id', user.id);
      if (refreshProfile) await refreshProfile();
    } catch { /* silent */ }
  };

  // ─── Structured Services Sync ───
  const updateServicesList = (updated: BusinessService[]) => {
    setServicesList(updated);
    const summary = updated.map(s => s.name).filter(Boolean).join(', ');
    setBusinessProfile(p => ({ ...p, productsServices: summary || p.productsServices, services: updated }));
  };

  // ─── Structured Pricing Tiers Sync ───
  const updatePricingTiers = (updated: BusinessPricingTier[]) => {
    setPricingTiers(updated);
    const summary = updated.map(t => `${t.name}${t.price ? ' ' + t.price : ''}`).filter(s => s.trim()).join(', ');
    setBusinessProfile(p => ({ ...p, pricingModel: summary || p.pricingModel, pricingTiers: updated }));
  };

  const allTabs = [
    { id: 'profile' as SettingsTab, label: 'Profile', icon: <CogIcon className="w-4 h-4" /> },
    { id: 'business_profile' as SettingsTab, label: 'Business Profile', icon: <BriefcaseIcon className="w-4 h-4" /> },
    { id: 'notifications' as SettingsTab, label: 'Notifications', icon: <BellIcon className="w-4 h-4" /> },
    { id: 'preferences' as SettingsTab, label: 'Preferences', icon: <LayoutIcon className="w-4 h-4" /> },
    { id: 'api_keys' as SettingsTab, label: 'API Keys', icon: <KeyIcon className="w-4 h-4" /> },
    { id: 'security' as SettingsTab, label: 'Security', icon: <LockIcon className="w-4 h-4" /> },
    { id: 'pipeline_colors' as SettingsTab, label: 'Pipeline Colors', icon: <TagIcon className="w-4 h-4" /> },
  ];
  const simplifiedTabIds: SettingsTab[] = ['profile', 'notifications', 'preferences', 'security'];
  const tabs = isAdvancedMode ? allTabs : allTabs.filter(t => simplifiedTabIds.includes(t.id));

  // Profile handlers
  const handleUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsUpdating(true);
    setError('');
    setSuccess(false);
    try {
      const { error: updateError } = await supabase.from('profiles').update({ name }).eq('id', user.id);
      if (updateError) throw updateError;
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to update configuration.');
    } finally {
      setIsUpdating(false);
    }
  };

  const handleDeleteAccount = async () => {
    setIsDeleting(true);
    await new Promise(resolve => setTimeout(resolve, 2000));
    await supabase.auth.signOut();
    window.location.href = '/';
  };

  // Business Profile handler
  const handleBusinessProfileUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSavingBusiness(true);
    setError('');
    setSuccess(false);
    try {
      const cleaned = cleanProfileForSave(businessProfile as Record<string, unknown>);
      const { error: updateError } = await supabase
        .from('profiles')
        .update({ businessProfile: Object.keys(cleaned).length > 0 ? cleaned : null })
        .eq('id', user.id);
      if (updateError) throw updateError;
      if (refreshProfile) await refreshProfile();
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save business profile.');
    } finally {
      setIsSavingBusiness(false);
    }
  };

  // Wizard: validate URL
  const validateUrl = (url: string): boolean => {
    if (!url.trim()) return false;
    try {
      const u = new URL(url.startsWith('http') ? url : `https://${url}`);
      return !!u.hostname.includes('.');
    } catch {
      return false;
    }
  };

  // Save whatever the user typed in the wizard input phase (URL/description/socials) to DB.
  // Returns the merged profile so the caller can chain enrichment onto the same object.
  const persistWizardInput = async (fullUrl: string | null): Promise<BusinessProfile> => {
    const next: BusinessProfile = { ...businessProfile };
    if (fullUrl) next.companyWebsite = fullUrl;
    if (businessDescription.trim()) next.businessDescription = businessDescription.trim();
    const enteredSocials = Object.entries(socialUrls).filter(([_, v]) => safeStr(v).trim().length > 0);
    if (enteredSocials.length > 0) {
      next.socialLinks = { ...(next.socialLinks || {}), ...Object.fromEntries(enteredSocials) };
    }
    setBusinessProfile(next);
    try {
      const cleaned = cleanProfileForSave(next as Record<string, unknown>);
      const { error: updateErr } = await supabase
        .from('profiles')
        .update({ businessProfile: Object.keys(cleaned).length > 0 ? cleaned : null })
        .eq('id', user.id);
      if (updateErr) throw updateErr;
      if (refreshProfile) await refreshProfile();
    } catch (err) {
      // Non-fatal — the user has the data on screen and can re-save from the manual form.
      console.warn('Initial profile save failed:', err);
    }
    return next;
  };

  // Runs analyzeBusinessFromWeb in the background and merges the result without
  // overwriting any field the user has already filled in.
  const startEnrichment = async (fullUrl: string, socials: typeof socialUrls) => {
    setEnrichmentStatus('running');
    setEnrichmentStartedAt(Date.now());
    setEnrichmentElapsed(0);
    setEnrichmentError('');
    setEnrichmentFieldsAdded(0);
    try {
      const creditResult = await consumeCredits(supabase, 'business_analysis');
      if (!creditResult.success) throw new Error(creditResult.message || 'Insufficient credits.');
      const result = await analyzeBusinessFromWeb(fullUrl, socials);
      if (!result.analysis) throw new Error('Could not analyze the website. Edit your fields manually or try a different URL.');

      // Merge into whatever the user has now. Two rules:
      //   - Empty fields:  fill with anything the AI returned (any confidence).
      //   - Filled fields: ONLY overwrite when the AI confidence is high
      //                    (>=70). Low-confidence AI guesses are ignored so
      //                    re-analyze never silently clobbers curated copy.
      // Previously every filled field was preserved unconditionally, which
      // made re-analyze look like a no-op (user saw the same old profile).
      const HIGH_CONFIDENCE = 70;
      const current = businessProfileRef.current;
      const populated: BusinessProfile = { ...current };
      let fieldsAdded = 0;
      let fieldsUpdated = 0;
      const isEmpty = (v: unknown) => v == null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && v.length === 0);
      const mergeField = <K extends keyof BusinessProfile>(
        field: K,
        value: BusinessProfile[K] | undefined,
        confidence: number,
      ) => {
        if (value == null || value === '') return;
        const currentlyEmpty = isEmpty((populated as any)[field]);
        if (currentlyEmpty) {
          (populated as any)[field] = value;
          fieldsAdded++;
        } else if (confidence >= HIGH_CONFIDENCE && (populated as any)[field] !== value) {
          (populated as any)[field] = value;
          fieldsUpdated++;
        }
      };

      const stringFields = [
        'companyName', 'industry', 'productsServices', 'targetAudience', 'valueProp',
        'pricingModel', 'salesApproach', 'companyStory', 'foundedYear', 'teamSize',
        'teamHighlights', 'testimonialsThemes', 'competitiveAdvantage', 'contentTone', 'keyClients',
      ] as const;
      stringFields.forEach(f => {
        const deep = (result.analysis as any)[f];
        if (deep?.value) mergeField(f as any, deep.value, deep.confidence ?? 0);
      });

      const servicesDeep = (result.analysis as any).services;
      if (servicesDeep?.value?.length) {
        const conf = servicesDeep.confidence ?? 0;
        if (isEmpty(populated.services)) {
          populated.services = servicesDeep.value;
          setServicesList(servicesDeep.value);
          fieldsAdded++;
        } else if (conf >= HIGH_CONFIDENCE) {
          populated.services = servicesDeep.value;
          setServicesList(servicesDeep.value);
          fieldsUpdated++;
        }
      }
      const pricingDeep = (result.analysis as any).pricingTiers;
      if (pricingDeep?.value?.length) {
        const conf = pricingDeep.confidence ?? 0;
        if (isEmpty(populated.pricingTiers)) {
          populated.pricingTiers = pricingDeep.value;
          setPricingTiers(pricingDeep.value);
          fieldsAdded++;
        } else if (conf >= HIGH_CONFIDENCE) {
          populated.pricingTiers = pricingDeep.value;
          setPricingTiers(pricingDeep.value);
          fieldsUpdated++;
        }
      }
      const uspDeep = (result.analysis as any).uniqueSellingPoints;
      if (uspDeep?.value?.length) {
        const conf = uspDeep.confidence ?? 0;
        if (isEmpty(populated.uniqueSellingPoints)) {
          populated.uniqueSellingPoints = uspDeep.value;
          fieldsAdded++;
        } else if (conf >= HIGH_CONFIDENCE) {
          populated.uniqueSellingPoints = uspDeep.value;
          fieldsUpdated++;
        }
      }
      if (result.analysis.phone?.value && (result.analysis.phone.confidence || 0) > 0) mergeField('phone', result.analysis.phone.value, result.analysis.phone.confidence ?? 0);
      if (result.analysis.businessEmail?.value && (result.analysis.businessEmail.confidence || 0) > 0) mergeField('businessEmail', result.analysis.businessEmail.value, result.analysis.businessEmail.confidence ?? 0);
      if (result.analysis.address?.value && (result.analysis.address.confidence || 0) > 0) mergeField('address', result.analysis.address.value, result.analysis.address.confidence ?? 0);

      if (result.analysis.socialLinks) {
        const discovered = result.analysis.socialLinks;
        const existing = populated.socialLinks || {};
        const merged: Record<string, string> = { ...existing };
        (['linkedin', 'twitter', 'instagram', 'facebook'] as const).forEach(k => {
          if (discovered[k] && !merged[k]) {
            merged[k] = discovered[k]!;
            fieldsAdded++;
          }
        });
        populated.socialLinks = merged;
        setSocialUrls(prev => ({
          linkedin: discovered.linkedin || prev.linkedin,
          twitter: discovered.twitter || prev.twitter,
          instagram: discovered.instagram || prev.instagram,
          facebook: discovered.facebook || prev.facebook,
        }));
      }

      setBusinessProfile(populated);
      setAnalysisResult(result.analysis);

      const cleaned = cleanProfileForSave(populated as Record<string, unknown>);
      await supabase
        .from('profiles')
        .update({ businessProfile: Object.keys(cleaned).length > 0 ? cleaned : null })
        .eq('id', user.id);
      if (refreshProfile) await refreshProfile();

      setEnrichmentFieldsAdded(fieldsAdded + fieldsUpdated);
      setEnrichmentStatus('complete');
      // Auto-dismiss the success banner after a short read window
      setTimeout(() => {
        setEnrichmentStatus(prev => (prev === 'complete' ? 'idle' : prev));
      }, 8000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Enrichment failed';
      setEnrichmentError(msg);
      setEnrichmentStatus('failed');
      // Re-throw so callers that want to drive the wizard flow can react.
      throw err instanceof Error ? err : new Error(msg);
    }
  };

  // Wizard submit: save user input immediately, land on the manual form, then enrich in background.
  const handleAnalyze = async () => {
    // Description-only flow: persist description, skip enrichment
    if (!websiteUrl.trim() && businessDescription.trim()) {
      await persistWizardInput(null);
      setWizardPhase('manual');
      return;
    }
    if (!validateUrl(websiteUrl)) {
      setUrlError('Please enter a valid website URL');
      return;
    }
    setUrlError('');
    setAnalysisError('');
    setAnalysisCancelled(false);
    analysisCancelledRef.current = false;
    const fullUrl = websiteUrl.startsWith('http') ? websiteUrl : `https://${websiteUrl}`;

    // Immediate feedback: flip to the analyzing screen so the click never
    // feels dead. The progress + stages tick during the wait.
    setAnalysisStage('searching');
    setAnalysisProgress(8);
    setAnalysisStartedAt(Date.now());
    setAnalysisElapsed(0);
    setWizardPhase('analyzing');

    // Best-effort persistence — don't block the visible transition behind
    // a Supabase round-trip.
    void persistWizardInput(fullUrl);

    // Optimistic progress + elapsed-time tickers. Real progress signals
    // from grounding chunks would be ideal; for now this proves the click
    // did something and surfaces elapsed time prominently.
    const stageOrder: AnalysisStage[] = ['searching', 'reading', 'extracting', 'structuring'];
    const progressTicker = setInterval(() => {
      setAnalysisProgress((p) => Math.min(92, p + 2));
      setAnalysisStage((s) => {
        const i = stageOrder.indexOf(s);
        return i < stageOrder.length - 1 ? stageOrder[i + 1] : s;
      });
    }, 1500);
    const elapsedTicker = setInterval(() => {
      setAnalysisElapsed((e) => e + 1);
    }, 1000);

    try {
      await startEnrichment(fullUrl, socialUrls);
      if (analysisCancelledRef.current) return;
      setAnalysisProgress(100);
      setAnalysisStage('complete');
      setTimeout(() => setWizardPhase('manual'), 500);
    } catch (err) {
      if (analysisCancelledRef.current) return;
      setAnalysisError((err as Error).message ?? 'Analysis failed.');
    } finally {
      clearInterval(progressTicker);
      clearInterval(elapsedTicker);
    }
  };

  const handleCancelAnalysis = useCallback(() => {
    setAnalysisCancelled(true);
    analysisCancelledRef.current = true;
    setEnrichmentStatus('idle');
    setWizardPhase('manual');
  }, []);

  // ─── Clear & start over ────────────────────────────────────────────
  // Wipes the saved business profile from DB + local state, then drops the
  // user on the wizard input phase to enter a fresh URL. Costs 2 credits.
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [clearingProfile, setClearingProfile] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);
  const handleClearAndStartOver = useCallback(async () => {
    setShowClearConfirm(false);
    setClearingProfile(true); setClearError(null);
    try {
      const creditResult = await consumeCredits(supabase, 'clear_business_profile');
      if (!creditResult.success) throw new Error(creditResult.message || 'Could not deduct credits.');

      const { error: updateError } = await supabase
        .from('profiles')
        .update({ businessProfile: null })
        .eq('id', user.id);
      if (updateError) throw new Error(`Failed to clear profile: ${updateError.message}`);

      // Reset every piece of in-memory state that mirrors the profile.
      setBusinessProfile({} as BusinessProfile);
      setServicesList([]);
      setPricingTiers([]);
      setWebsiteUrl('');
      setSocialUrls({ linkedin: '', twitter: '', instagram: '', facebook: '' });
      setBusinessDescription('');
      setAnalysisResult(null);
      setAnalysisError('');
      setEnrichmentStatus('idle');
      setEnrichmentError('');
      setEnrichmentFieldsAdded(0);
      if (refreshProfile) await refreshProfile();
      setWizardPhase('input');
    } catch (err) {
      setClearError((err as Error).message ?? 'Failed to clear profile.');
    } finally {
      setClearingProfile(false);
    }
  }, [user.id, refreshProfile]);

  // Wizard: save profile (reused for all phases)
  const handleWizardSave = async () => {
    setIsSavingBusiness(true);
    setError('');
    setSuccess(false);
    try {
      // Merge discovered social URLs into profile
      const mergedProfile = { ...businessProfile };
      const hasSocials = Object.values(socialUrls).some(v => safeStr(v).length > 0);
      if (hasSocials) {
        mergedProfile.socialLinks = {
          ...(mergedProfile.socialLinks || {}),
          ...Object.fromEntries(Object.entries(socialUrls).filter(([_, v]) => safeStr(v).length > 0))
        };
      }

      const cleaned = cleanProfileForSave(mergedProfile as Record<string, unknown>);
      const { error: updateError } = await supabase
        .from('profiles')
        .update({ businessProfile: Object.keys(cleaned).length > 0 ? cleaned : null })
        .eq('id', user.id);
      if (updateError) throw updateError;
      if (refreshProfile) await refreshProfile();
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save business profile.');
    } finally {
      setIsSavingBusiness(false);
    }
  };

  // Wizard: handle follow-up answer
  const handleFollowUpAnswer = (answer: string) => {
    if (answer.trim() && followUpQuestions[currentQuestionIdx]) {
      const { field } = followUpQuestions[currentQuestionIdx];
      setBusinessProfile(p => ({ ...p, [field]: answer.trim() }));
    }
    if (currentQuestionIdx < followUpQuestions.length - 1) {
      setCurrentQuestionIdx(idx => idx + 1);
      setQuestionAnswer('');
    } else {
      handleWizardSave();
    }
  };

  // Notification handlers
  const toggleNotification = (key: keyof NotificationPreferences) => {
    const updated = { ...notifications, [key]: !notifications[key] };
    setNotifications(updated);
    try { localStorage.setItem(NOTIF_STORAGE_KEY, JSON.stringify(updated)); } catch {}
  };

  // Preferences handlers
  const updatePreference = <K extends keyof DashboardPreferences>(key: K, value: DashboardPreferences[K]) => {
    const updated = { ...preferences, [key]: value };
    setPreferences(updated);
    try { localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(updated)); } catch {}
  };

  // API Key handlers
  const generateApiKey = () => {
    if (!newKeyName.trim()) return;
    const key: ApiKey = {
      id: Date.now().toString(),
      name: newKeyName.trim(),
      key: `af_${Array.from({ length: 32 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('')}`,
      createdAt: new Date().toISOString(),
      status: 'active'
    };
    const updated = [...apiKeys, key];
    setApiKeys(updated);
    try { localStorage.setItem(APIKEYS_STORAGE_KEY, JSON.stringify(updated)); } catch {}
    setNewKeyName('');
    setShowKeyId(key.id);
  };

  const revokeApiKey = (id: string) => {
    const updated = apiKeys.map(k => k.id === id ? { ...k, status: 'revoked' as const } : k);
    setApiKeys(updated);
    try { localStorage.setItem(APIKEYS_STORAGE_KEY, JSON.stringify(updated)); } catch {}
  };

  const copyKey = (key: string) => {
    navigator.clipboard.writeText(key);
  };

  // ─── New Enhancement State ───
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showAccountHealth, setShowAccountHealth] = useState(false);
  const [showSessionActivity, setShowSessionActivity] = useState(false);
  const [showDataExport, setShowDataExport] = useState(false);
  const [showUsageAnalytics, setShowUsageAnalytics] = useState(false);
  const [showPrivacyAudit, setShowPrivacyAudit] = useState(false);
  const [showQuotaTracker, setShowQuotaTracker] = useState(false);

  // ─── KPI Stats ───
  const kpiStats = useMemo(() => {
    const activeKeyCount = apiKeys.filter(k => k.status === 'active').length;
    const enabledNotifs = Object.values(notifications).filter(Boolean).length;
    const totalNotifs = Object.keys(notifications).length;

    return [
      { label: 'Account Status', value: 'Active', sub: user?.role === 'ADMIN' ? 'Administrator' : 'Client Node', trend: 'up' as const, color: 'emerald' },
      { label: 'API Keys', value: activeKeyCount.toString(), sub: `${apiKeys.length} total generated`, trend: activeKeyCount > 0 ? 'up' as const : 'down' as const, color: 'indigo' },
      { label: 'Notifications', value: `${enabledNotifs}/${totalNotifs}`, sub: 'Channels active', trend: enabledNotifs > 3 ? 'up' as const : 'down' as const, color: 'violet' },
      { label: 'Security Score', value: twoFactorEnabled ? '95%' : '60%', sub: twoFactorEnabled ? '2FA enabled' : '2FA disabled', trend: twoFactorEnabled ? 'up' as const : 'down' as const, color: twoFactorEnabled ? 'emerald' : 'amber' },
      { label: 'Theme', value: preferences.theme === 'light' ? 'Light' : preferences.theme === 'dark' ? 'Dark' : 'System', sub: `${preferences.defaultView} view`, trend: 'up' as const, color: 'slate' },
      { label: 'Session Age', value: 'Active', sub: new Date().toLocaleDateString(), trend: 'up' as const, color: 'rose' },
    ];
  }, [apiKeys, notifications, twoFactorEnabled, preferences, user]);

  // ─── Account Health Data ───
  const accountHealth = useMemo(() => {
    const checks = [
      { label: 'Profile Complete', passed: !!name.trim(), weight: 15 },
      { label: 'Email Verified', passed: true, weight: 20 },
      { label: '2FA Enabled', passed: twoFactorEnabled, weight: 25 },
      { label: 'API Key Generated', passed: apiKeys.some(k => k.status === 'active'), weight: 10 },
      { label: 'Notifications Configured', passed: Object.values(notifications).some(Boolean), weight: 10 },
      { label: 'Dashboard Customized', passed: preferences.theme !== 'light' || preferences.defaultView !== 'grid', weight: 5 },
      { label: 'Lead Score Alerts', passed: notifications.leadScoreAlerts, weight: 10 },
      { label: 'Weekly Digest Active', passed: notifications.weeklyDigest, weight: 5 },
    ];
    const score = checks.reduce((s, c) => s + (c.passed ? c.weight : 0), 0);
    return { checks, score };
  }, [name, twoFactorEnabled, apiKeys, notifications, preferences]);

  // ─── Session Activity Mock ───
  const sessionActivity = useMemo(() => [
    { time: 'Just now', action: 'Viewed Account Architecture', type: 'navigation' },
    { time: '2 min ago', action: 'Updated notification preferences', type: 'settings' },
    { time: '5 min ago', action: 'Viewed Lead Management', type: 'navigation' },
    { time: '12 min ago', action: 'Generated AI content', type: 'ai' },
    { time: '18 min ago', action: 'Exported analytics report', type: 'export' },
    { time: '25 min ago', action: 'Updated lead score for TechCorp', type: 'leads' },
    { time: '32 min ago', action: 'Logged in via password', type: 'auth' },
    { time: '1 hour ago', action: 'Previous session ended', type: 'auth' },
  ], []);

  const SESSION_TYPE_STYLES: Record<string, { bg: string; text: string }> = {
    navigation: { bg: 'bg-indigo-50', text: 'text-indigo-600' },
    settings: { bg: 'bg-violet-50', text: 'text-violet-600' },
    ai: { bg: 'bg-emerald-50', text: 'text-emerald-600' },
    export: { bg: 'bg-amber-50', text: 'text-amber-600' },
    leads: { bg: 'bg-rose-50', text: 'text-rose-600' },
    auth: { bg: 'bg-slate-100', text: 'text-slate-600' },
  };

  // ─── Data Export Options ───
  const exportOptions = useMemo(() => [
    { id: 'profile', label: 'Profile Data', desc: 'Name, email, role, preferences', icon: <UsersIcon className="w-4 h-4" />, size: '~2 KB' },
    { id: 'leads', label: 'All Leads', desc: 'Complete lead database with scores', icon: <TargetIcon className="w-4 h-4" />, size: '~500 KB' },
    { id: 'content', label: 'Generated Content', desc: 'All AI-generated content history', icon: <DocumentIcon className="w-4 h-4" />, size: '~1.2 MB' },
    { id: 'analytics', label: 'Analytics Data', desc: 'Performance metrics and reports', icon: <ActivityIcon className="w-4 h-4" />, size: '~800 KB' },
    { id: 'audit', label: 'Audit Logs', desc: 'Complete activity history', icon: <ClockIcon className="w-4 h-4" />, size: '~300 KB' },
    { id: 'api', label: 'API Usage Logs', desc: 'Request history and rate limits', icon: <KeyIcon className="w-4 h-4" />, size: '~150 KB' },
  ], []);

  // ─── Usage Analytics ───
  const usageAnalytics = useMemo(() => {
    const weeklyLogins = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(); d.setDate(d.getDate() - (6 - i));
      return { day: d.toLocaleDateString('en-US', { weekday: 'short' }), logins: Math.floor(Math.random() * 3) + 1, actions: Math.floor(Math.random() * 40) + 10 };
    });

    const featureUsage = [
      { feature: 'Lead Management', sessions: 42, pct: 35, avgDuration: '12m' },
      { feature: 'Content Studio', sessions: 28, pct: 23, avgDuration: '18m' },
      { feature: 'Analytics', sessions: 22, pct: 18, avgDuration: '8m' },
      { feature: 'Automation', sessions: 15, pct: 13, avgDuration: '15m' },
      { feature: 'Settings', sessions: 8, pct: 7, avgDuration: '3m' },
      { feature: 'Other', sessions: 5, pct: 4, avgDuration: '5m' },
    ];

    const totalSessions = featureUsage.reduce((s, f) => s + f.sessions, 0);
    const totalActions = weeklyLogins.reduce((s, d) => s + d.actions, 0);
    const avgSessionDuration = '11m';
    const peakHour = '10 AM';

    return { weeklyLogins, featureUsage, totalSessions, totalActions, avgSessionDuration, peakHour };
  }, []);

  // ─── Privacy & Compliance Audit ───
  const privacyAudit = useMemo(() => {
    const checks = [
      { label: 'Data Encryption', status: 'pass' as const, detail: 'AES-256 at rest, TLS 1.3 in transit' },
      { label: 'GDPR Compliance', status: 'pass' as const, detail: 'Data processing agreement active' },
      { label: 'Data Retention Policy', status: 'pass' as const, detail: '12-month retention, auto-purge enabled' },
      { label: 'Access Logging', status: 'pass' as const, detail: 'Full audit trail enabled' },
      { label: 'Third-Party Sharing', status: notifications.teamMentions ? 'warn' as const : 'pass' as const, detail: notifications.teamMentions ? 'Team mentions may expose data' : 'No third-party sharing' },
      { label: 'Cookie Consent', status: 'pass' as const, detail: 'Essential cookies only' },
      { label: 'Password Policy', status: twoFactorEnabled ? 'pass' as const : 'warn' as const, detail: twoFactorEnabled ? 'Strong: password + 2FA' : 'Moderate: password only' },
      { label: 'Session Timeout', status: 'pass' as const, detail: '30-minute inactivity timeout' },
    ];

    const passCount = checks.filter(c => c.status === 'pass').length;
    const complianceScore = Math.round((passCount / checks.length) * 100);
    const lastAudit = '2024-01-15';

    return { checks, passCount, total: checks.length, complianceScore, lastAudit };
  }, [twoFactorEnabled, notifications]);

  // ─── Quota & Limits Tracker ───
  const quotaTracker = useMemo(() => {
    const activeKeyCount = apiKeys.filter(k => k.status === 'active').length;
    const quotas = [
      { resource: 'API Calls', used: 2847, limit: 10000, unit: 'calls/mo', color: 'indigo' },
      { resource: 'AI Credits', used: 156, limit: 500, unit: 'credits/mo', color: 'violet' },
      { resource: 'Storage', used: 2.4, limit: 10, unit: 'GB', color: 'emerald' },
      { resource: 'Team Members', used: 3, limit: 10, unit: 'seats', color: 'amber' },
      { resource: 'Active API Keys', used: activeKeyCount, limit: 5, unit: 'keys', color: 'rose' },
      { resource: 'Webhooks', used: 2, limit: 20, unit: 'endpoints', color: 'cyan' },
    ];

    const overallUsage = Math.round(quotas.reduce((s, q) => s + (q.used / q.limit) * 100, 0) / quotas.length);
    const nearLimit = quotas.filter(q => (q.used / q.limit) > 0.8);

    return { quotas, overallUsage, nearLimit };
  }, [apiKeys]);

  // ─── Clean tab query param from URL ───
  useEffect(() => {
    if (searchParams.has('tab')) {
      searchParams.delete('tab');
      setSearchParams(searchParams, { replace: true });
    }
  }, []);

  // ─── Keyboard Shortcuts ───
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable;
      if (isInput) return;

      const overlayOpen = showShortcuts || showAccountHealth || showSessionActivity || showDataExport || showUsageAnalytics || showPrivacyAudit || showQuotaTracker || isDeleteModalOpen;

      if (e.key === 'Escape') {
        if (showShortcuts) setShowShortcuts(false);
        if (showAccountHealth) setShowAccountHealth(false);
        if (showSessionActivity) setShowSessionActivity(false);
        if (showDataExport) setShowDataExport(false);
        if (showUsageAnalytics) setShowUsageAnalytics(false);
        if (showPrivacyAudit) setShowPrivacyAudit(false);
        if (showQuotaTracker) setShowQuotaTracker(false);
        return;
      }

      if (overlayOpen) return;

      switch (e.key) {
        case '1': e.preventDefault(); setActiveTab('profile'); break;
        case '2': e.preventDefault(); setActiveTab('business_profile'); break;
        case '3': e.preventDefault(); setActiveTab('notifications'); break;
        case '4': e.preventDefault(); setActiveTab('preferences'); break;
        case '5': e.preventDefault(); setActiveTab('api_keys'); break;
        case '6': e.preventDefault(); setActiveTab('security'); break;
        case 'h': case 'H': e.preventDefault(); setShowAccountHealth(true); break;
        case 'a': case 'A': e.preventDefault(); setShowSessionActivity(true); break;
        case 'e': case 'E': e.preventDefault(); setShowDataExport(true); break;
        case 'u': case 'U': e.preventDefault(); setShowUsageAnalytics(true); break;
        case 'p': case 'P': e.preventDefault(); setShowPrivacyAudit(true); break;
        case 'q': case 'Q': e.preventDefault(); setShowQuotaTracker(true); break;
        case '?': e.preventDefault(); setShowShortcuts(true); break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showShortcuts, showAccountHealth, showSessionActivity, showDataExport, showUsageAnalytics, showPrivacyAudit, showQuotaTracker, isDeleteModalOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const notificationItems = [
    { key: 'emailAlerts' as const, label: 'Email Alerts', desc: 'Receive email notifications for important events' },
    { key: 'leadScoreAlerts' as const, label: 'Lead Score Changes', desc: 'Notify when a lead score changes significantly' },
    { key: 'weeklyDigest' as const, label: 'Weekly Digest', desc: 'Summary of activity sent every Monday' },
    { key: 'contentReady' as const, label: 'Content Ready', desc: 'Alert when AI content generation completes' },
    { key: 'teamMentions' as const, label: 'Team Mentions', desc: 'Notify when a team member mentions you' },
    { key: 'systemUpdates' as const, label: 'System Updates', desc: 'Platform updates and maintenance notices' },
  ];

  return (
    <div className="max-w-6xl mx-auto px-4 space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500 pb-20">
      {/* Header */}
      <PageHeader
        title="Settings"
        description="Manage your profile, preferences, security, and API access"
        advancedActions={
          <>
            <button onClick={() => setShowAccountHealth(true)} className="flex items-center space-x-1.5 px-3 py-2 bg-emerald-50 text-emerald-700 rounded-xl text-xs font-bold hover:bg-emerald-100 transition-all">
              <ShieldIcon className="w-3.5 h-3.5" />
              <span>Health</span>
            </button>
            <button onClick={() => setShowSessionActivity(true)} className="flex items-center space-x-1.5 px-3 py-2 bg-indigo-50 text-indigo-700 rounded-xl text-xs font-bold hover:bg-indigo-100 transition-all">
              <ActivityIcon className="w-3.5 h-3.5" />
              <span>Activity</span>
            </button>
            <button onClick={() => setShowDataExport(true)} className="flex items-center space-x-1.5 px-3 py-2 bg-violet-50 text-violet-700 rounded-xl text-xs font-bold hover:bg-violet-100 transition-all">
              <DownloadIcon className="w-3.5 h-3.5" />
              <span>Export</span>
            </button>
            <button onClick={() => setShowUsageAnalytics(s => !s)} className={`flex items-center space-x-1.5 px-3 py-2 rounded-xl text-xs font-bold transition-all ${showUsageAnalytics ? 'bg-cyan-600 text-white shadow-lg shadow-cyan-200' : 'bg-cyan-50 text-cyan-700 hover:bg-cyan-100'}`}>
              <TrendUpIcon className="w-3.5 h-3.5" />
              <span>Usage</span>
            </button>
            <button onClick={() => setShowPrivacyAudit(s => !s)} className={`flex items-center space-x-1.5 px-3 py-2 rounded-xl text-xs font-bold transition-all ${showPrivacyAudit ? 'bg-rose-600 text-white shadow-lg shadow-rose-200' : 'bg-rose-50 text-rose-700 hover:bg-rose-100'}`}>
              <LockIcon className="w-3.5 h-3.5" />
              <span>Privacy</span>
            </button>
            <button onClick={() => setShowQuotaTracker(s => !s)} className={`flex items-center space-x-1.5 px-3 py-2 rounded-xl text-xs font-bold transition-all ${showQuotaTracker ? 'bg-amber-600 text-white shadow-lg shadow-amber-200' : 'bg-amber-50 text-amber-700 hover:bg-amber-100'}`}>
              <LayersIcon className="w-3.5 h-3.5" />
              <span>Quotas</span>
            </button>
            <button onClick={() => setShowShortcuts(true)} className="flex items-center space-x-1.5 px-3 py-2 bg-slate-100 text-slate-600 rounded-xl text-xs font-bold hover:bg-slate-200 transition-all">
              <KeyboardIcon className="w-3.5 h-3.5" />
              <span>?</span>
            </button>
          </>
        }
      />

      {/* ─── KPI Stats Banner ─── */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        {kpiStats.map((stat, idx) => (
          <div key={idx} className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4 hover:shadow-md transition-shadow">
            <div className="flex items-center justify-between mb-2">
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider">{stat.label}</p>
              {stat.trend === 'up' ? (
                <TrendUpIcon className="w-3.5 h-3.5 text-emerald-500" />
              ) : (
                <TrendDownIcon className="w-3.5 h-3.5 text-red-400" />
              )}
            </div>
            <p className="text-2xl font-black text-slate-900">{stat.value}</p>
            <p className="text-[11px] text-slate-500 mt-0.5">{stat.sub}</p>
          </div>
        ))}
      </div>

      {/* Tab Navigation */}
      <div className="flex bg-white border border-slate-200 rounded-2xl p-1.5 shadow-sm overflow-x-auto">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center space-x-2 px-5 py-3 rounded-xl text-xs font-bold transition-all whitespace-nowrap ${
              activeTab === tab.id
                ? 'bg-slate-900 text-white shadow-lg'
                : 'text-slate-500 hover:text-slate-900 hover:bg-slate-50'
            }`}
          >
            {tab.icon}
            <span>{tab.label}</span>
          </button>
        ))}
      </div>

      {/* Profile Tab */}
      {activeTab === 'profile' && (
        <div className="space-y-8 animate-in fade-in duration-300">
          <div className="bg-white rounded-[2.5rem] border border-slate-200 shadow-sm overflow-hidden">
            <div className="p-10 border-b border-slate-100 flex items-center space-x-8 bg-slate-50/50">
              <div className="w-24 h-24 rounded-[2rem] bg-indigo-600 flex items-center justify-center text-4xl text-white font-black shadow-2xl shadow-indigo-200 group relative cursor-pointer overflow-hidden border-4 border-white uppercase">
                <span className="relative z-10">{name?.charAt(0) || user?.email?.charAt(0)?.toUpperCase() || 'U'}</span>
                <div className="absolute inset-0 bg-black/20 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                  <span className="text-[10px] font-black text-white uppercase tracking-widest">Update</span>
                </div>
              </div>
              <div>
                <h3 className="text-2xl font-black text-slate-900 font-heading tracking-tight truncate max-w-[280px]">{name || 'Unnamed User'}</h3>
                <p className="text-slate-500 text-sm font-medium uppercase tracking-widest text-[10px] mt-1">{user?.role === 'ADMIN' ? 'Platform Administrator' : 'Client Access Node'}</p>
                <div className="mt-3 flex items-center space-x-2">
                  <span className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse"></span>
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em]">Verified Instance</span>
                </div>
              </div>
            </div>

            <form onSubmit={handleUpdate} className="p-10 space-y-8">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                <div className="space-y-3">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">Display Name</label>
                  <input type="text" required value={name} onChange={(e) => setName(e.target.value)}
                    className="w-full px-5 py-4 rounded-2xl border border-slate-200 focus:ring-4 focus:ring-indigo-100 focus:border-indigo-500 outline-none transition-all font-bold text-slate-800" />
                </div>
                <div className="space-y-3">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">Login Identifier</label>
                  <input type="email" disabled value={user?.email || ''}
                    className="w-full px-5 py-4 rounded-2xl border border-slate-100 bg-slate-50 text-slate-400 font-bold cursor-not-allowed outline-none" />
                </div>
              </div>

              <div className="pt-8 border-t border-slate-50 flex items-center justify-between">
                <div className="flex-grow">
                  {success && (
                    <span className="text-emerald-600 text-xs font-black uppercase tracking-widest flex items-center space-x-2 animate-in slide-in-from-left-2 duration-300">
                      <div className="w-5 h-5 bg-emerald-100 rounded-lg flex items-center justify-center text-[10px]">
                        <CheckIcon className="w-3 h-3" />
                      </div>
                      <span>Database Synced</span>
                    </span>
                  )}
                  {error && <span className="text-red-600 text-xs font-black uppercase tracking-widest truncate max-w-[300px]">Error: {error}</span>}
                </div>
                <button type="submit" disabled={isUpdating}
                  className={`px-10 py-4 font-bold rounded-2xl shadow-2xl transition-all active:scale-95 ${isUpdating ? 'bg-slate-100 text-slate-400' : 'bg-indigo-600 text-white hover:bg-indigo-700 shadow-indigo-100 hover:scale-[1.02]'}`}>
                  {isUpdating ? 'Synchronizing...' : 'Save Configuration'}
                </button>
              </div>
            </form>
          </div>

          <AdvancedOnly>
          <div className="p-10 bg-white rounded-[2.5rem] border border-red-100 shadow-sm flex flex-col sm:flex-row items-center justify-between gap-8 border-l-8 border-l-red-500">
            <div>
              <h4 className="text-slate-900 font-black font-heading text-lg">Decommission Account</h4>
              <p className="text-slate-500 text-sm mt-1 max-w-sm font-medium">Permanently purge prospect intelligence, custom AI models, and credit history.</p>
            </div>
            <button onClick={() => setIsDeleteModalOpen(true)}
              className="whitespace-nowrap px-8 py-4 bg-red-50 text-red-600 border border-red-100 rounded-2xl font-black uppercase tracking-widest text-[10px] hover:bg-red-600 hover:text-white transition-all transform active:scale-95 shadow-sm">
              Destroy Instance
            </button>
          </div>
          </AdvancedOnly>
        </div>
      )}

      {/* Notifications Tab */}
      {activeTab === 'notifications' && (
        <div className="bg-white rounded-[2.5rem] border border-slate-200 shadow-sm overflow-hidden animate-in fade-in duration-300">
          <div className="p-8 border-b border-slate-100">
            <h3 className="text-lg font-bold text-slate-900 font-heading">Notification Preferences</h3>
            <p className="text-sm text-slate-500 mt-1">Control which alerts and digests you receive.</p>
          </div>
          <div className="divide-y divide-slate-100">
            {notificationItems.map(item => (
              <div key={item.key} className="px-8 py-6 flex items-center justify-between hover:bg-slate-50/50 transition-colors">
                <div>
                  <p className="text-sm font-bold text-slate-800">{item.label}</p>
                  <p className="text-xs text-slate-400 mt-0.5">{item.desc}</p>
                </div>
                <button
                  onClick={() => toggleNotification(item.key)}
                  className={`relative w-12 h-7 rounded-full transition-colors ${notifications[item.key] ? 'bg-indigo-600' : 'bg-slate-200'}`}
                >
                  <div className={`absolute top-1 w-5 h-5 bg-white rounded-full shadow-sm transition-transform ${notifications[item.key] ? 'left-6' : 'left-1'}`} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Preferences Tab */}
      {activeTab === 'preferences' && (
        <div className="space-y-6 animate-in fade-in duration-300">
          <div className="bg-white rounded-3xl border border-slate-200 shadow-sm p-8 space-y-6">
            <h3 className="text-lg font-bold text-slate-900 font-heading">Dashboard Layout</h3>

            <div className="space-y-4">
              <div>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Default View</p>
                <div className="flex space-x-3">
                  {(['grid', 'list'] as const).map(v => (
                    <button key={v} onClick={() => updatePreference('defaultView', v)}
                      className={`px-6 py-3 rounded-xl text-xs font-bold border transition-all capitalize ${preferences.defaultView === v ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-600 border-slate-200 hover:border-indigo-200'}`}>
                      {v} View
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Items Per Page</p>
                <div className="flex space-x-3">
                  {[10, 25, 50, 100].map(n => (
                    <button key={n} onClick={() => updatePreference('itemsPerPage', n)}
                      className={`px-5 py-3 rounded-xl text-xs font-bold border transition-all ${preferences.itemsPerPage === n ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-600 border-slate-200 hover:border-indigo-200'}`}>
                      {n}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Theme</p>
                <div className="flex space-x-3">
                  {(['light', 'dark', 'system'] as const).map(t => (
                    <button key={t} onClick={() => updatePreference('theme', t)}
                      className={`px-6 py-3 rounded-xl text-xs font-bold border transition-all capitalize ${preferences.theme === t ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-600 border-slate-200 hover:border-indigo-200'}`}>
                      {t}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-3xl border border-slate-200 shadow-sm p-8 space-y-4">
            <h3 className="text-lg font-bold text-slate-900 font-heading">Dashboard Widgets</h3>
            {([
              { key: 'showQuickStats' as const, label: 'Quick Stats Row', desc: 'Show 6-card stats at top of dashboard' },
              { key: 'showAiInsights' as const, label: 'AI Insights Panel', desc: 'Display AI-generated recommendations' },
              { key: 'showActivityFeed' as const, label: 'Activity Feed', desc: 'Show live activity feed on dashboard' },
              { key: 'autoContactedOnSend' as const, label: 'Auto-mark Contacted on Email Send', desc: 'Automatically move New leads to Contacted when you send them an email' },
            ]).map(item => (
              <div key={item.key} className="flex items-center justify-between py-4 border-b border-slate-50 last:border-0">
                <div>
                  <p className="text-sm font-bold text-slate-800">{item.label}</p>
                  <p className="text-xs text-slate-400 mt-0.5">{item.desc}</p>
                </div>
                <button
                  onClick={() => updatePreference(item.key, !preferences[item.key])}
                  className={`relative w-12 h-7 rounded-full transition-colors ${preferences[item.key] ? 'bg-indigo-600' : 'bg-slate-200'}`}
                >
                  <div className={`absolute top-1 w-5 h-5 bg-white rounded-full shadow-sm transition-transform ${preferences[item.key] ? 'left-6' : 'left-1'}`} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* API Keys Tab */}
      {activeTab === 'api_keys' && (
        <div className="space-y-6 animate-in fade-in duration-300">
          <div className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="p-8 border-b border-slate-100 flex items-center justify-between">
              <div>
                <h3 className="text-lg font-bold text-slate-900 font-heading">API Access Keys</h3>
                <p className="text-sm text-slate-500 mt-1">Generate keys for programmatic access to the Scaliyo API.</p>
              </div>
            </div>

            <div className="p-6 border-b border-slate-100 bg-slate-50/50">
              <div className="flex items-center space-x-3">
                <input
                  type="text"
                  value={newKeyName}
                  onChange={e => setNewKeyName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && generateApiKey()}
                  placeholder="Key name (e.g. 'Production App')..."
                  className="flex-grow px-4 py-3 bg-white border border-slate-200 rounded-xl text-sm font-medium outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100 transition-all"
                />
                <button
                  onClick={generateApiKey}
                  disabled={!newKeyName.trim()}
                  className={`px-6 py-3 rounded-xl text-xs font-bold flex items-center space-x-2 transition-all ${newKeyName.trim() ? 'bg-indigo-600 text-white hover:bg-indigo-700' : 'bg-slate-100 text-slate-300 cursor-not-allowed'}`}
                >
                  <PlusIcon className="w-4 h-4" />
                  <span>Generate Key</span>
                </button>
              </div>
            </div>

            <div className="divide-y divide-slate-100">
              {apiKeys.length > 0 ? apiKeys.map(k => (
                <div key={k.id} className="px-8 py-5 flex items-center justify-between group hover:bg-slate-50/50 transition-colors">
                  <div className="flex items-center space-x-4 flex-grow min-w-0">
                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${k.status === 'active' ? 'bg-indigo-50 text-indigo-600' : 'bg-red-50 text-red-400'}`}>
                      <KeyIcon className="w-5 h-5" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center space-x-2">
                        <p className="text-sm font-bold text-slate-800">{k.name}</p>
                        <span className={`text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full ${k.status === 'active' ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-500'}`}>
                          {k.status}
                        </span>
                      </div>
                      <div className="flex items-center space-x-3 mt-1">
                        <p className="text-xs text-slate-400 font-mono truncate max-w-[300px]">
                          {showKeyId === k.id ? k.key : `${k.key.slice(0, 8)}${'•'.repeat(24)}`}
                        </p>
                        <button onClick={() => setShowKeyId(showKeyId === k.id ? null : k.id)} className="text-slate-300 hover:text-indigo-600 transition-colors">
                          <EyeIcon className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center space-x-2">
                    <button onClick={() => copyKey(k.key)} className="p-2 text-slate-300 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors">
                      <CopyIcon className="w-4 h-4" />
                    </button>
                    {k.status === 'active' && (
                      <button onClick={() => revokeApiKey(k.id)} className="px-3 py-1.5 text-[10px] font-bold text-red-500 bg-red-50 rounded-lg hover:bg-red-100 transition-colors">
                        Revoke
                      </button>
                    )}
                  </div>
                </div>
              )) : (
                <div className="px-8 py-16 text-center">
                  <KeyIcon className="w-10 h-10 text-slate-200 mx-auto mb-3" />
                  <p className="text-sm text-slate-400 italic">No API keys generated yet.</p>
                </div>
              )}
            </div>
          </div>

          <div className="p-6 bg-amber-50/50 rounded-2xl border border-amber-100">
            <p className="text-xs font-bold text-amber-700">Security Notice: API keys grant full access to your account. Store them securely and never expose them in client-side code.</p>
          </div>
        </div>
      )}

      {/* Security Tab */}
      {/* Business Profile Tab */}
      {activeTab === 'business_profile' && (
        <div className="space-y-6 animate-in fade-in duration-300">

          {/* ─── Background enrichment status banner ─── */}
          {enrichmentStatus !== 'idle' && (
            <div className={`rounded-2xl p-4 flex items-center justify-between border shadow-sm ${
              enrichmentStatus === 'running' ? 'bg-indigo-50 border-indigo-200' :
              enrichmentStatus === 'complete' ? 'bg-emerald-50 border-emerald-200' :
              'bg-red-50 border-red-200'
            }`}>
              <div className="flex items-center space-x-3 min-w-0">
                {enrichmentStatus === 'running' && (
                  <>
                    <div className="w-9 h-9 bg-indigo-100 rounded-xl flex items-center justify-center animate-pulse shrink-0">
                      <SparklesIcon className="w-4 h-4 text-indigo-600" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-bold text-indigo-900">AI is researching your business&hellip;</p>
                      <p className="text-xs text-indigo-600 mt-0.5 truncate">
                        Scanning website & socials. Fill fields below &mdash; we won't overwrite your edits.
                      </p>
                    </div>
                  </>
                )}
                {enrichmentStatus === 'complete' && (
                  <>
                    <div className="w-9 h-9 bg-emerald-100 rounded-xl flex items-center justify-center shrink-0">
                      <CheckIcon className="w-4 h-4 text-emerald-600" />
                    </div>
                    <div>
                      <p className="text-sm font-bold text-emerald-900">Enrichment complete</p>
                      <p className="text-xs text-emerald-600 mt-0.5">
                        {enrichmentFieldsAdded === 0
                          ? 'No new fields found — your profile was already up to date.'
                          : `${enrichmentFieldsAdded} field${enrichmentFieldsAdded === 1 ? '' : 's'} filled in automatically.`}
                      </p>
                    </div>
                  </>
                )}
                {enrichmentStatus === 'failed' && (
                  <>
                    <div className="w-9 h-9 bg-red-100 rounded-xl flex items-center justify-center shrink-0">
                      <AlertTriangleIcon className="w-4 h-4 text-red-600" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-bold text-red-900">Enrichment failed</p>
                      <p className="text-xs text-red-600 mt-0.5 truncate">{enrichmentError}</p>
                    </div>
                  </>
                )}
              </div>
              <div className="flex items-center space-x-3 shrink-0 ml-4">
                {enrichmentStatus === 'running' && (
                  <span className="text-sm font-mono font-bold text-indigo-700 tabular-nums">
                    {Math.floor(enrichmentElapsed / 60)}:{String(enrichmentElapsed % 60).padStart(2, '0')}
                  </span>
                )}
                {enrichmentStatus === 'failed' && businessProfile.companyWebsite && (
                  <button
                    type="button"
                    onClick={() => startEnrichment(businessProfile.companyWebsite!, socialUrls)}
                    className="px-3 py-1.5 rounded-lg bg-red-600 text-white text-xs font-bold hover:bg-red-700 transition-colors"
                  >
                    Retry
                  </button>
                )}
                {(enrichmentStatus === 'complete' || enrichmentStatus === 'failed') && (
                  <button
                    type="button"
                    onClick={() => setEnrichmentStatus('idle')}
                    className="text-slate-400 hover:text-slate-600 p-1"
                    aria-label="Dismiss"
                  >
                    <XIcon className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
          )}

          {/* ═══ Phase 1: URL Input ═══ */}
          {wizardPhase === 'input' && (
            <div className="space-y-6">
              <div className="bg-gradient-to-br from-indigo-600 via-violet-600 to-purple-700 rounded-[2.5rem] p-10 text-white shadow-2xl shadow-indigo-200 relative overflow-hidden">
                <div className="absolute top-0 right-0 w-64 h-64 bg-white/5 rounded-full -translate-y-1/2 translate-x-1/2" />
                <div className="absolute bottom-0 left-0 w-48 h-48 bg-white/5 rounded-full translate-y-1/2 -translate-x-1/2" />
                <div className="relative">
                  <div className="flex items-center space-x-3 mb-4">
                    <div className="w-10 h-10 bg-white/20 rounded-2xl flex items-center justify-center backdrop-blur-sm">
                      <SparklesIcon className="w-5 h-5" />
                    </div>
                    <h3 className="text-2xl font-black font-heading tracking-tight">Let AI Discover Your Business</h3>
                  </div>
                  <p className="text-indigo-100 text-sm max-w-lg leading-relaxed">
                    Enter your website URL and we'll use AI to analyze your online presence, extract business intelligence, and auto-fill your profile in seconds.
                  </p>
                </div>
              </div>

              <div className="bg-white rounded-3xl border border-slate-200 shadow-sm p-8 space-y-6">
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">Website URL</label>
                  <div className="relative">
                    <div className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400">
                      <GlobeIcon className="w-5 h-5" />
                    </div>
                    <input
                      type="text"
                      value={websiteUrl}
                      onChange={e => { setWebsiteUrl(e.target.value); setUrlError(''); }}
                      placeholder="https://yourcompany.com"
                      className={`w-full pl-12 pr-5 py-4 rounded-2xl border ${urlError ? 'border-red-300 focus:ring-red-100 focus:border-red-500' : 'border-slate-200 focus:ring-indigo-100 focus:border-indigo-500'} focus:ring-4 outline-none transition-all font-bold text-slate-800 text-lg`}
                    />
                  </div>
                  {urlError && <p className="text-xs font-bold text-red-500 mt-1">{urlError}</p>}
                </div>

                {/* "Or" Divider */}
                <div className="flex items-center gap-4">
                  <div className="flex-1 h-px bg-slate-200" />
                  <span className="text-xs font-bold text-slate-400">&mdash; or &mdash;</span>
                  <div className="flex-1 h-px bg-slate-200" />
                </div>

                {/* Tell Us About Your Business */}
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">Tell Us About Your Business</label>
                  <p className="text-xs text-slate-500 leading-relaxed">Don't have a website? No problem &mdash; describe what you do, who you serve, and what makes you different.</p>
                  <textarea
                    value={businessDescription}
                    onChange={e => setBusinessDescription(e.target.value)}
                    placeholder="e.g. I run a digital marketing agency helping small restaurants and cafes grow online. We offer monthly packages including content creation, posting schedules, and analytics. Our clients are local business owners who want more customers but don't have time to manage social media themselves."
                    rows={4}
                    className="w-full px-5 py-4 rounded-2xl border border-slate-200 focus:ring-4 focus:ring-indigo-100 focus:border-indigo-500 outline-none transition-all font-bold text-slate-800 resize-none"
                  />
                </div>

                {/* Expandable Social Handles */}
                <div>
                  <button
                    type="button"
                    onClick={() => setShowSocialInputs(!showSocialInputs)}
                    className="flex items-center space-x-2 text-xs font-bold text-slate-500 hover:text-indigo-600 transition-colors"
                  >
                    <ChevronDownIcon className={`w-4 h-4 transition-transform ${showSocialInputs ? 'rotate-180' : ''}`} />
                    <span>Add social media profiles (optional)</span>
                  </button>

                  {showSocialInputs && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4 animate-in fade-in slide-in-from-top-2 duration-300">
                      {[
                        { key: 'linkedin' as const, icon: <LinkedInIcon className="w-4 h-4" />, placeholder: 'https://linkedin.com/company/...' },
                        { key: 'twitter' as const, icon: <TwitterIcon className="w-4 h-4" />, placeholder: 'https://twitter.com/...' },
                        { key: 'instagram' as const, icon: <InstagramIcon className="w-4 h-4" />, placeholder: 'https://instagram.com/...' },
                        { key: 'facebook' as const, icon: <FacebookIcon className="w-4 h-4" />, placeholder: 'https://facebook.com/...' },
                      ].map(s => (
                        <div key={s.key} className="relative">
                          <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400">{s.icon}</div>
                          <input
                            type="text"
                            value={socialUrls[s.key]}
                            onChange={e => setSocialUrls(p => ({ ...p, [s.key]: e.target.value }))}
                            placeholder={s.placeholder}
                            className="w-full pl-10 pr-4 py-3 rounded-xl border border-slate-200 focus:ring-4 focus:ring-indigo-100 focus:border-indigo-500 outline-none transition-all text-sm font-medium text-slate-800"
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="flex items-center justify-between pt-4 border-t border-slate-100">
                  <button
                    type="button"
                    onClick={() => setWizardPhase('manual')}
                    className="text-xs font-bold text-slate-400 hover:text-indigo-600 transition-colors"
                  >
                    Skip to manual entry
                  </button>
                  <button
                    type="button"
                    onClick={handleAnalyze}
                    disabled={!websiteUrl.trim() && !businessDescription.trim()}
                    className={`flex items-center space-x-2 px-8 py-4 rounded-2xl font-bold text-sm shadow-2xl transition-all active:scale-95 ${
                      websiteUrl.trim() || businessDescription.trim()
                        ? 'bg-indigo-600 text-white hover:bg-indigo-700 shadow-indigo-100 hover:scale-[1.02]'
                        : 'bg-slate-100 text-slate-300 cursor-not-allowed shadow-none'
                    }`}
                  >
                    <SparklesIcon className="w-4 h-4" />
                    <span>Analyze My Business</span>
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ═══ Phase 2: AI Analysis Loading ═══ */}
          {wizardPhase === 'analyzing' && (
            <div className="bg-white rounded-[2.5rem] border border-slate-200 shadow-sm p-10 space-y-8">
              <div className="text-center">
                <div className="relative inline-flex items-center justify-center w-20 h-20 mb-6">
                  <div className="absolute inset-0 bg-indigo-100 rounded-[2rem] animate-pulse" />
                  <div className="relative z-10 animate-spin [animation-duration:3s]">
                    <SparklesIcon className="w-8 h-8 text-indigo-600" />
                  </div>
                  <div className="absolute -bottom-1 -right-1 w-7 h-7 bg-violet-100 rounded-xl flex items-center justify-center animate-bounce">
                    <BoltIcon className="w-4 h-4 text-violet-600" />
                  </div>
                </div>
                <h3 className="text-xl font-black text-slate-900 font-heading">Analyzing Your Business</h3>
                <p className="text-sm text-slate-500 mt-2">Our AI is researching your company online...</p>
                <p className="text-xs font-mono font-bold text-indigo-600 mt-3 tabular-nums">
                  {Math.floor(analysisElapsed / 60)}:{String(analysisElapsed % 60).padStart(2, '0')} elapsed
                  {analysisElapsed > 30 && analysisElapsed <= 60 && <span className="text-slate-400 font-normal ml-2">· this is taking a bit longer than usual</span>}
                  {analysisElapsed > 60 && <span className="text-amber-600 font-normal ml-2">· still working — the model can take up to 60s per attempt</span>}
                </p>
              </div>

              {/* Progress Bar */}
              <div className="space-y-3">
                <div className="h-3 bg-slate-100 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-indigo-500 to-violet-500 rounded-full transition-all duration-1000 ease-out"
                    style={{ width: `${analysisProgress}%` }}
                  />
                </div>
                <p className="text-xs font-bold text-slate-400 text-center">{analysisProgress}% complete</p>
              </div>

              {/* Cancel button — always available while analyzing */}
              {!analysisError && (
                <div className="flex justify-center">
                  <button
                    type="button"
                    onClick={handleCancelAnalysis}
                    className="px-4 py-2 rounded-xl text-xs font-bold text-slate-500 hover:text-red-600 hover:bg-red-50 transition-colors"
                  >
                    Cancel and skip to manual entry
                  </button>
                </div>
              )}

              {/* Stage Checklist */}
              <div className="space-y-3">
                {([
                  { stage: 'searching' as const, label: 'Searching the web...' },
                  { stage: 'reading' as const, label: 'Analyzing website & socials...' },
                  { stage: 'extracting' as const, label: 'Extracting business intelligence...' },
                  { stage: 'structuring' as const, label: 'Building your profile...' },
                ] as const).map((item, idx) => {
                  const stageOrder: AnalysisStage[] = ['searching', 'reading', 'extracting', 'structuring', 'complete'];
                  const currentIdx = stageOrder.indexOf(analysisStage);
                  const itemIdx = stageOrder.indexOf(item.stage);
                  const isDone = currentIdx > itemIdx;
                  const isActive = currentIdx === itemIdx;

                  return (
                    <div key={item.stage} className={`flex items-center space-x-3 p-3 rounded-xl transition-all ${isActive ? 'bg-indigo-50' : isDone ? 'bg-emerald-50' : 'bg-slate-50'}`}>
                      {isDone ? (
                        <div className="w-6 h-6 bg-emerald-100 rounded-lg flex items-center justify-center">
                          <CheckIcon className="w-3.5 h-3.5 text-emerald-600" />
                        </div>
                      ) : isActive ? (
                        <div className="w-6 h-6 bg-indigo-100 rounded-lg flex items-center justify-center">
                          <div className="w-2.5 h-2.5 bg-indigo-600 rounded-full animate-pulse" />
                        </div>
                      ) : (
                        <div className="w-6 h-6 bg-slate-100 rounded-lg flex items-center justify-center">
                          <span className="text-[10px] font-black text-slate-400">{idx + 1}</span>
                        </div>
                      )}
                      <span className={`text-sm font-bold ${isDone ? 'text-emerald-700' : isActive ? 'text-indigo-700' : 'text-slate-400'}`}>
                        {item.label}
                      </span>
                    </div>
                  );
                })}
              </div>

              {analysisError && (
                <div className="p-4 bg-red-50 rounded-2xl border border-red-100 space-y-2">
                  <p className="text-xs font-bold text-red-700">{analysisError}</p>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => { setAnalysisError(''); setWizardPhase('input'); }}
                      className="px-3 py-1.5 rounded-lg bg-red-600 text-white text-[11px] font-bold hover:bg-red-700"
                    >
                      Try again
                    </button>
                    <button
                      type="button"
                      onClick={() => { setAnalysisError(''); setWizardPhase('manual'); }}
                      className="px-3 py-1.5 rounded-lg bg-white border border-slate-200 text-slate-700 text-[11px] font-bold hover:bg-slate-50"
                    >
                      Skip to manual entry
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ═══ Phase 3: Auto-Populated Results ═══ */}
          {wizardPhase === 'results' && analysisResult && (
            <div className="space-y-6">
              <div className="bg-white rounded-3xl border border-slate-200 shadow-sm p-8">
                <div className="flex items-center space-x-3 mb-2">
                  <div className="w-8 h-8 bg-emerald-100 rounded-xl flex items-center justify-center">
                    <CheckIcon className="w-4 h-4 text-emerald-600" />
                  </div>
                  <h3 className="text-lg font-black text-slate-900 font-heading">Here's What We Found</h3>
                </div>
                <p className="text-sm text-slate-500 ml-11">Review and edit any fields below. Confidence scores show how certain the AI is about each field.</p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {([
                  { key: 'companyName' as const, label: 'Company Name', icon: <BriefcaseIcon className="w-4 h-4" />, type: 'input' },
                  { key: 'industry' as const, label: 'Industry', icon: <LayersIcon className="w-4 h-4" />, type: 'input' },
                  { key: 'productsServices' as const, label: 'Products & Services', icon: <TargetIcon className="w-4 h-4" />, type: 'textarea' },
                  { key: 'targetAudience' as const, label: 'Target Audience', icon: <UsersIcon className="w-4 h-4" />, type: 'textarea' },
                  { key: 'valueProp' as const, label: 'Value Proposition', icon: <SparklesIcon className="w-4 h-4" />, type: 'textarea' },
                  { key: 'pricingModel' as const, label: 'Pricing Model', icon: <DocumentIcon className="w-4 h-4" />, type: 'input' },
                  { key: 'salesApproach' as const, label: 'Sales Approach', icon: <BoltIcon className="w-4 h-4" />, type: 'input' },
                  { key: 'phone' as const, label: 'Phone', icon: <PhoneIcon className="w-4 h-4" />, type: 'input' },
                  { key: 'businessEmail' as const, label: 'Email', icon: <MailIcon className="w-4 h-4" />, type: 'input' },
                  { key: 'address' as const, label: 'Address', icon: <MapPinIcon className="w-4 h-4" />, type: 'input' },
                ]).map(field => {
                  const confidence = (analysisResult as unknown as Record<string, BusinessAnalysisField | undefined>)[field.key]?.confidence || 0;
                  const confidenceColor = confidence >= 80 ? 'emerald' : confidence >= 50 ? 'amber' : 'rose';
                  const confidenceLabel = confidence >= 80 ? 'High confidence' : confidence >= 50 ? 'Medium' : 'Low — please review';

                  return (
                    <div key={field.key} className={`bg-white rounded-2xl border shadow-sm p-5 space-y-3 ${
                      field.type === 'textarea' ? 'md:col-span-2' : ''
                    } ${confidence < 50 ? 'border-rose-200' : 'border-slate-200'}`}>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center space-x-2">
                          <div className={`w-7 h-7 rounded-lg flex items-center justify-center bg-${confidenceColor}-50 text-${confidenceColor}-600`}>
                            {field.icon}
                          </div>
                          <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{field.label}</span>
                        </div>
                        <div className={`flex items-center space-x-1 px-2 py-1 rounded-full bg-${confidenceColor}-50`}>
                          {confidence >= 80 ? (
                            <CheckIcon className={`w-3 h-3 text-${confidenceColor}-600`} />
                          ) : confidence < 50 ? (
                            <AlertTriangleIcon className={`w-3 h-3 text-${confidenceColor}-600`} />
                          ) : null}
                          <span className={`text-[9px] font-black text-${confidenceColor}-600`}>{confidenceLabel}</span>
                        </div>
                      </div>
                      {field.type === 'textarea' ? (
                        <textarea
                          value={businessProfile[field.key] || ''}
                          onChange={e => setBusinessProfile(p => ({ ...p, [field.key]: e.target.value }))}
                          rows={3}
                          className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-4 focus:ring-indigo-100 focus:border-indigo-500 outline-none transition-all font-medium text-slate-800 text-sm resize-none"
                        />
                      ) : (
                        <input
                          type="text"
                          value={businessProfile[field.key] || ''}
                          onChange={e => setBusinessProfile(p => ({ ...p, [field.key]: e.target.value }))}
                          className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-4 focus:ring-indigo-100 focus:border-indigo-500 outline-none transition-all font-medium text-slate-800 text-sm"
                        />
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Logo Upload — Results Phase */}
              <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 space-y-3">
                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Company Logo</span>
                {logoUrl ? (
                  <div className="flex items-center space-x-4">
                    <img src={logoUrl} alt="Logo" loading="lazy" className="w-16 h-16 object-contain rounded-xl border border-slate-200 bg-slate-50" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-bold text-slate-700 truncate">{logoUrl.split('/').pop()}</p>
                    </div>
                    <button type="button" onClick={() => logoInputRef.current?.click()} className="px-3 py-1.5 text-xs font-bold text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors">Change</button>
                    <button type="button" onClick={handleLogoRemove} className="px-3 py-1.5 text-xs font-bold text-rose-600 hover:bg-rose-50 rounded-lg transition-colors">Remove</button>
                  </div>
                ) : (
                  <button type="button" onClick={() => logoInputRef.current?.click()} className="relative w-full border-2 border-dashed border-slate-300 rounded-xl py-6 flex flex-col items-center space-y-2 hover:border-indigo-400 hover:bg-indigo-50/50 transition-all cursor-pointer">
                    {uploadingLogo && <div className="absolute inset-0 bg-white/80 rounded-xl flex items-center justify-center z-10"><div className="w-5 h-5 border-2 border-indigo-300 border-t-indigo-600 rounded-full animate-spin" /></div>}
                    <UploadIcon className="w-6 h-6 text-slate-400" />
                    <span className="text-xs font-bold text-slate-500">Upload your company logo</span>
                    <span className="text-[10px] text-slate-400">PNG, JPG, SVG, or WebP (max 5MB)</span>
                  </button>
                )}
                <input ref={logoInputRef} type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) handleLogoUpload(f); e.target.value = ''; }} />
              </div>

              {/* Structured Services — Results Phase */}
              {servicesList.length > 0 && (
                <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Services Detected</span>
                    {analysisResult?.services && (
                      <span className={`text-[9px] font-black px-2 py-0.5 rounded-full ${(analysisResult.services.confidence || 0) >= 80 ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'}`}>
                        {(analysisResult.services.confidence || 0) >= 80 ? 'High confidence' : 'Medium'}
                      </span>
                    )}
                  </div>
                  <div className="space-y-2">
                    {servicesList.map((svc, idx) => (
                      <div key={svc.id} className="flex items-start space-x-3 bg-slate-50 rounded-xl p-3">
                        <div className="flex-1 min-w-0 space-y-1">
                          <input type="text" value={svc.name} onChange={e => { const u = [...servicesList]; u[idx] = { ...u[idx], name: e.target.value }; updateServicesList(u); }}
                            className="w-full text-sm font-bold text-slate-800 bg-transparent border-none outline-none" placeholder="Service name" />
                          <input type="text" value={svc.description || ''} onChange={e => { const u = [...servicesList]; u[idx] = { ...u[idx], description: e.target.value }; updateServicesList(u); }}
                            className="w-full text-xs text-slate-500 bg-transparent border-none outline-none" placeholder="Description (optional)" />
                        </div>
                        <button type="button" onClick={() => updateServicesList(servicesList.filter((_, i) => i !== idx))} className="p-1 text-slate-400 hover:text-rose-500 transition-colors"><XIcon className="w-3.5 h-3.5" /></button>
                      </div>
                    ))}
                  </div>
                  <button type="button" onClick={() => updateServicesList([...servicesList, { id: crypto.randomUUID(), name: '' }])}
                    className="text-xs font-bold text-indigo-600 hover:text-indigo-700 transition-colors">+ Add Service</button>
                </div>
              )}

              {/* Structured Pricing Tiers — Results Phase */}
              {pricingTiers.length > 0 && (
                <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Pricing Tiers Detected</span>
                    {analysisResult?.pricingTiers && (
                      <span className={`text-[9px] font-black px-2 py-0.5 rounded-full ${(analysisResult.pricingTiers.confidence || 0) >= 80 ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'}`}>
                        {(analysisResult.pricingTiers.confidence || 0) >= 80 ? 'High confidence' : 'Medium'}
                      </span>
                    )}
                  </div>
                  <div className="space-y-3">
                    {pricingTiers.map((tier, idx) => (
                      <div key={tier.id} className="bg-slate-50 rounded-xl p-4 space-y-2">
                        <div className="flex items-center space-x-2">
                          <input type="text" value={tier.name} onChange={e => { const u = [...pricingTiers]; u[idx] = { ...u[idx], name: e.target.value }; updatePricingTiers(u); }}
                            className="flex-1 text-sm font-bold text-slate-800 bg-white rounded-lg px-3 py-2 border border-slate-200 outline-none focus:ring-2 focus:ring-indigo-100" placeholder="Tier name" />
                          <input type="text" value={tier.price || ''} onChange={e => { const u = [...pricingTiers]; u[idx] = { ...u[idx], price: e.target.value }; updatePricingTiers(u); }}
                            className="w-32 text-sm font-bold text-slate-800 bg-white rounded-lg px-3 py-2 border border-slate-200 outline-none focus:ring-2 focus:ring-indigo-100" placeholder="$XX/mo" />
                          <button type="button" onClick={() => updatePricingTiers(pricingTiers.filter((_, i) => i !== idx))} className="p-1.5 text-slate-400 hover:text-rose-500 transition-colors"><XIcon className="w-3.5 h-3.5" /></button>
                        </div>
                        <input type="text" value={tier.description || ''} onChange={e => { const u = [...pricingTiers]; u[idx] = { ...u[idx], description: e.target.value }; updatePricingTiers(u); }}
                          className="w-full text-xs text-slate-600 bg-white rounded-lg px-3 py-2 border border-slate-200 outline-none focus:ring-2 focus:ring-indigo-100" placeholder="Description (optional)" />
                        {tier.features && tier.features.length > 0 && (
                          <div className="space-y-1 pl-1">
                            {tier.features.map((feat, fi) => (
                              <div key={fi} className="flex items-center space-x-2">
                                <span className="text-[10px] text-slate-400">-</span>
                                <input type="text" value={feat} onChange={e => { const u = [...pricingTiers]; const feats = [...(u[idx].features || [])]; feats[fi] = e.target.value; u[idx] = { ...u[idx], features: feats }; updatePricingTiers(u); }}
                                  className="flex-1 text-xs text-slate-600 bg-transparent border-none outline-none" />
                                <button type="button" onClick={() => { const u = [...pricingTiers]; const feats = [...(u[idx].features || [])]; feats.splice(fi, 1); u[idx] = { ...u[idx], features: feats }; updatePricingTiers(u); }}
                                  className="text-slate-300 hover:text-rose-500 transition-colors"><XIcon className="w-3 h-3" /></button>
                              </div>
                            ))}
                          </div>
                        )}
                        <button type="button" onClick={() => { const u = [...pricingTiers]; u[idx] = { ...u[idx], features: [...(u[idx].features || []), ''] }; updatePricingTiers(u); }}
                          className="text-[10px] font-bold text-indigo-500 hover:text-indigo-600 transition-colors">+ Add Feature</button>
                      </div>
                    ))}
                  </div>
                  <button type="button" onClick={() => updatePricingTiers([...pricingTiers, { id: crypto.randomUUID(), name: '', price: '' }])}
                    className="text-xs font-bold text-indigo-600 hover:text-indigo-700 transition-colors">+ Add Pricing Tier</button>
                </div>
              )}

              {/* Deep Insights — Results Phase */}
              {(() => {
                const deepFields = [
                  { key: 'companyStory', label: 'Company Story' },
                  { key: 'foundedYear', label: 'Founded Year' },
                  { key: 'teamSize', label: 'Team Size' },
                  { key: 'teamHighlights', label: 'Team Highlights' },
                  { key: 'keyClients', label: 'Key Clients' },
                  { key: 'competitiveAdvantage', label: 'Competitive Advantage' },
                  { key: 'contentTone', label: 'Brand Tone' },
                  { key: 'testimonialsThemes', label: 'Testimonial Themes' },
                ];
                const hasDeep = deepFields.some(f => (businessProfile as any)[f.key]) || (businessProfile.uniqueSellingPoints?.length ?? 0) > 0;
                if (!hasDeep) return null;
                return (
                  <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                    <button type="button" onClick={() => setShowDeepInsights(!showDeepInsights)}
                      className="w-full flex items-center justify-between p-5 hover:bg-slate-50 transition-colors">
                      <div className="flex items-center space-x-2">
                        <BrainIcon className="w-4 h-4 text-violet-500" />
                        <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Deep Insights</span>
                      </div>
                      <ChevronDownIcon className={`w-4 h-4 text-slate-400 transition-transform ${showDeepInsights ? 'rotate-180' : ''}`} />
                    </button>
                    {showDeepInsights && (
                      <div className="px-5 pb-5 space-y-3">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          {deepFields.map(f => {
                            const val = (businessProfile as any)[f.key];
                            if (!val) return null;
                            const conf = (analysisResult as any)?.[f.key]?.confidence || 0;
                            const cColor = conf >= 80 ? 'emerald' : conf >= 50 ? 'amber' : 'rose';
                            return (
                              <div key={f.key} className="bg-slate-50 rounded-xl p-3 space-y-1">
                                <div className="flex items-center justify-between">
                                  <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{f.label}</span>
                                  {conf > 0 && <span className={`text-[8px] font-black px-1.5 py-0.5 rounded-full bg-${cColor}-50 text-${cColor}-600`}>{conf}%</span>}
                                </div>
                                <p className="text-xs text-slate-700 leading-relaxed">{val}</p>
                              </div>
                            );
                          })}
                        </div>
                        {(businessProfile.uniqueSellingPoints?.length ?? 0) > 0 && (
                          <div className="bg-slate-50 rounded-xl p-3 space-y-2">
                            <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Unique Selling Points</span>
                            <div className="flex flex-wrap gap-1.5">
                              {businessProfile.uniqueSellingPoints!.map((usp, i) => (
                                <span key={i} className="px-2.5 py-1 bg-violet-100 text-violet-700 rounded-full text-[10px] font-bold">{usp}</span>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Results Actions */}
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-3">
                  <button
                    type="button"
                    onClick={() => { setWizardPhase('input'); setAnalysisResult(null); }}
                    className="flex items-center space-x-1.5 px-4 py-2.5 rounded-xl text-xs font-bold text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 transition-all"
                  >
                    <RefreshIcon className="w-3.5 h-3.5" />
                    <span>Re-analyze</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setWizardPhase('manual')}
                    className="text-xs font-bold text-slate-400 hover:text-indigo-600 transition-colors px-3 py-2.5"
                  >
                    Switch to manual entry
                  </button>
                </div>
                <div className="flex items-center space-x-3">
                  {success && (
                    <span className="text-emerald-600 text-xs font-black uppercase tracking-widest flex items-center space-x-2 animate-in slide-in-from-left-2 duration-300">
                      <CheckIcon className="w-3 h-3" />
                      <span>Saved</span>
                    </span>
                  )}
                  {error && <span className="text-red-600 text-xs font-bold truncate max-w-[200px]">{error}</span>}
                  <button
                    type="button"
                    onClick={() => {
                      if (followUpQuestions.length > 0) {
                        setCurrentQuestionIdx(0);
                        setQuestionAnswer('');
                        setWizardPhase('questions');
                      } else {
                        handleWizardSave();
                      }
                    }}
                    disabled={isSavingBusiness}
                    className={`px-8 py-4 font-bold rounded-2xl shadow-2xl transition-all active:scale-95 ${
                      isSavingBusiness ? 'bg-slate-100 text-slate-400' : 'bg-indigo-600 text-white hover:bg-indigo-700 shadow-indigo-100 hover:scale-[1.02]'
                    }`}
                  >
                    {isSavingBusiness ? 'Saving...' : followUpQuestions.length > 0 ? 'Continue' : 'Save Business Profile'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ═══ Phase 4: AI Follow-Up Questions ═══ */}
          {wizardPhase === 'questions' && followUpQuestions.length > 0 && (
            <div className="space-y-6">
              <div className="bg-white rounded-[2.5rem] border border-slate-200 shadow-sm p-10 space-y-8">
                <div className="text-center">
                  <div className="inline-flex items-center space-x-2 px-4 py-2 bg-violet-50 rounded-full mb-4">
                    <span className="text-[10px] font-black text-violet-600 uppercase tracking-widest">
                      Question {currentQuestionIdx + 1} of {followUpQuestions.length}
                    </span>
                  </div>
                  <div className="flex items-center justify-center space-x-3 mb-4">
                    <div className="w-10 h-10 bg-violet-100 rounded-2xl flex items-center justify-center">
                      <BrainIcon className="w-5 h-5 text-violet-600" />
                    </div>
                  </div>
                  <h3 className="text-xl font-black text-slate-900 font-heading max-w-lg mx-auto">
                    {followUpQuestions[currentQuestionIdx]?.question}
                  </h3>
                  <p className="text-xs text-slate-400 mt-2 font-bold uppercase tracking-widest">
                    Maps to: {followUpQuestions[currentQuestionIdx]?.field}
                  </p>
                </div>

                <textarea
                  value={questionAnswer}
                  onChange={e => setQuestionAnswer(e.target.value)}
                  placeholder={followUpQuestions[currentQuestionIdx]?.placeholder || 'Type your answer...'}
                  rows={4}
                  className="w-full px-5 py-4 rounded-2xl border border-slate-200 focus:ring-4 focus:ring-violet-100 focus:border-violet-500 outline-none transition-all font-medium text-slate-800 text-sm resize-none"
                  autoFocus
                />

                {/* Progress dots */}
                <div className="flex items-center justify-center space-x-2">
                  {followUpQuestions.map((_, idx) => (
                    <div key={idx} className={`w-2 h-2 rounded-full transition-all ${
                      idx === currentQuestionIdx ? 'w-6 bg-violet-600' : idx < currentQuestionIdx ? 'bg-emerald-400' : 'bg-slate-200'
                    }`} />
                  ))}
                </div>

                <div className="flex items-center justify-between pt-4 border-t border-slate-100">
                  <button
                    type="button"
                    onClick={() => {
                      // Skip this question
                      if (currentQuestionIdx < followUpQuestions.length - 1) {
                        setCurrentQuestionIdx(idx => idx + 1);
                        setQuestionAnswer('');
                      } else {
                        handleWizardSave();
                      }
                    }}
                    className="text-xs font-bold text-slate-400 hover:text-slate-600 transition-colors px-4 py-2"
                  >
                    Skip
                  </button>
                  <button
                    type="button"
                    onClick={() => handleFollowUpAnswer(questionAnswer)}
                    disabled={isSavingBusiness}
                    className={`flex items-center space-x-2 px-8 py-4 rounded-2xl font-bold text-sm shadow-2xl transition-all active:scale-95 ${
                      isSavingBusiness ? 'bg-slate-100 text-slate-400' : 'bg-violet-600 text-white hover:bg-violet-700 shadow-violet-100 hover:scale-[1.02]'
                    }`}
                  >
                    <span>{currentQuestionIdx < followUpQuestions.length - 1 ? 'Next' : 'Save Profile'}</span>
                    {currentQuestionIdx < followUpQuestions.length - 1 && <span>&rarr;</span>}
                  </button>
                </div>
              </div>

              {success && (
                <div className="flex items-center justify-center space-x-2 text-emerald-600 text-xs font-black uppercase tracking-widest animate-in fade-in duration-300">
                  <CheckIcon className="w-4 h-4" />
                  <span>Business Profile Saved Successfully</span>
                </div>
              )}
              {error && (
                <p className="text-center text-red-600 text-xs font-bold">{error}</p>
              )}
            </div>
          )}

          {/* ═══ Manual Fallback: Existing Static Form ═══ */}
          {wizardPhase === 'manual' && (
            <div className="space-y-6">
              {/* AI setup banner */}
              <div className="flex flex-wrap items-center justify-between gap-3 p-4 bg-indigo-50 rounded-2xl border border-indigo-100">
                <div className="flex items-center space-x-3 min-w-0">
                  <SparklesIcon className="w-5 h-5 text-indigo-600 shrink-0" />
                  <p className="text-xs font-bold text-indigo-700">Want AI to fill this out for you? Try the AI-powered setup instead.</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => setWizardPhase('input')}
                    className="px-4 py-2 bg-indigo-600 text-white rounded-xl text-xs font-bold hover:bg-indigo-700 transition-colors whitespace-nowrap"
                  >
                    Try AI Setup
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowClearConfirm(true)}
                    disabled={clearingProfile}
                    title="Wipe all saved fields and re-analyze fresh — 2 credits"
                    className="px-3 py-2 bg-white border border-red-200 text-red-700 rounded-xl text-xs font-bold hover:bg-red-50 transition-colors whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {clearingProfile ? 'Clearing…' : 'Clear & start over · 2 cr'}
                  </button>
                </div>
              </div>
              {clearError && (
                <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-xl text-xs text-red-700">
                  <AlertTriangleIcon className="w-4 h-4 mt-0.5 shrink-0" />
                  <span>{clearError}</span>
                </div>
              )}

              {/* Clear & start over confirmation modal */}
              {showClearConfirm && (
                <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
                  <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setShowClearConfirm(false)} />
                  <div className="relative bg-white rounded-3xl shadow-2xl max-w-md w-full overflow-hidden animate-in fade-in zoom-in-95 duration-200">
                    <div className="px-6 py-5 bg-gradient-to-br from-rose-50 to-amber-50 border-b border-slate-100">
                      <div className="flex items-center gap-3">
                        <div className="w-11 h-11 rounded-2xl bg-rose-100 flex items-center justify-center">
                          <RefreshIcon className="w-5 h-5 text-rose-600" />
                        </div>
                        <div className="min-w-0">
                          <h3 className="font-black text-slate-900 font-heading">Clear & start over</h3>
                          <p className="text-xs text-slate-500 mt-0.5">Wipe this profile so AI can re-analyze fresh.</p>
                        </div>
                      </div>
                    </div>
                    <div className="px-6 py-5 space-y-4">
                      <ul className="space-y-2 text-sm text-slate-700">
                        <li className="flex items-start gap-2">
                          <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-rose-400 shrink-0" />
                          <span>Removes every saved field — company name, services, pricing, social links, all of it.</span>
                        </li>
                        <li className="flex items-start gap-2">
                          <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-rose-400 shrink-0" />
                          <span>Charges <span className="font-bold">2 AI credits</span>.</span>
                        </li>
                        <li className="flex items-start gap-2">
                          <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
                          <span>Drops you on the AI setup screen so you can paste a new URL and re-analyze immediately.</span>
                        </li>
                      </ul>
                      <p className="text-[11px] text-slate-400">You can't undo this. The new analysis starts on a blank slate.</p>
                    </div>
                    <div className="px-6 py-4 bg-slate-50 border-t border-slate-100 flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setShowClearConfirm(false)}
                        className="px-4 py-2 rounded-xl bg-white border border-slate-200 text-slate-700 text-sm font-bold hover:bg-slate-50"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={handleClearAndStartOver}
                        className="px-4 py-2 rounded-xl bg-rose-600 text-white text-sm font-bold hover:bg-rose-700 shadow-sm"
                      >
                        Clear & re-analyze · 2 cr
                      </button>
                    </div>
                  </div>
                </div>
              )}

              <form onSubmit={handleBusinessProfileUpdate} className="space-y-6">
                {/* Logo Upload — Manual Phase */}
                <div className="bg-white rounded-3xl border border-slate-200 shadow-sm p-8 space-y-4">
                  <div>
                    <h3 className="text-lg font-bold text-slate-900 font-heading">Company Logo</h3>
                    <p className="text-sm text-slate-500 mt-1">Upload your logo for branding in generated images.</p>
                  </div>
                  {logoUrl ? (
                    <div className="flex items-center space-x-4">
                      <img src={logoUrl} alt="Logo" loading="lazy" className="w-16 h-16 object-contain rounded-xl border border-slate-200 bg-slate-50" />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-bold text-slate-700 truncate">{logoUrl.split('/').pop()}</p>
                      </div>
                      <button type="button" onClick={() => logoInputRef.current?.click()} className="px-3 py-1.5 text-xs font-bold text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors">Change</button>
                      <button type="button" onClick={handleLogoRemove} className="px-3 py-1.5 text-xs font-bold text-rose-600 hover:bg-rose-50 rounded-lg transition-colors">Remove</button>
                    </div>
                  ) : (
                    <button type="button" onClick={() => logoInputRef.current?.click()} className="relative w-full border-2 border-dashed border-slate-300 rounded-xl py-6 flex flex-col items-center space-y-2 hover:border-indigo-400 hover:bg-indigo-50/50 transition-all cursor-pointer">
                      {uploadingLogo && <div className="absolute inset-0 bg-white/80 rounded-xl flex items-center justify-center z-10"><div className="w-5 h-5 border-2 border-indigo-300 border-t-indigo-600 rounded-full animate-spin" /></div>}
                      <UploadIcon className="w-6 h-6 text-slate-400" />
                      <span className="text-xs font-bold text-slate-500">Upload your company logo</span>
                      <span className="text-[10px] text-slate-400">PNG, JPG, SVG, or WebP (max 5MB)</span>
                    </button>
                  )}
                  <input ref={logoInputRef} type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) handleLogoUpload(f); e.target.value = ''; }} />
                </div>

                {/* Company Info */}
                <div className="bg-white rounded-3xl border border-slate-200 shadow-sm p-8 space-y-6">
                  <div>
                    <h3 className="text-lg font-bold text-slate-900 font-heading">Company Information</h3>
                    <p className="text-sm text-slate-500 mt-1">Tell the AI about your business so all generated content is personalized.</p>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="space-y-2">
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">Company Name</label>
                      <input type="text" value={businessProfile.companyName || ''} onChange={e => setBusinessProfile(p => ({ ...p, companyName: e.target.value }))}
                        placeholder="e.g. Acme Corp"
                        className="w-full px-5 py-4 rounded-2xl border border-slate-200 focus:ring-4 focus:ring-indigo-100 focus:border-indigo-500 outline-none transition-all font-bold text-slate-800" />
                    </div>
                    <div className="space-y-2">
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">Industry</label>
                      <input type="text" value={businessProfile.industry || ''} onChange={e => setBusinessProfile(p => ({ ...p, industry: e.target.value }))}
                        placeholder="e.g. B2B SaaS, Healthcare, Fintech"
                        className="w-full px-5 py-4 rounded-2xl border border-slate-200 focus:ring-4 focus:ring-indigo-100 focus:border-indigo-500 outline-none transition-all font-bold text-slate-800" />
                    </div>
                    <div className="md:col-span-2 space-y-2">
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">Company Website</label>
                      <input type="text" value={businessProfile.companyWebsite || ''} onChange={e => setBusinessProfile(p => ({ ...p, companyWebsite: e.target.value }))}
                        placeholder="e.g. https://acmecorp.com"
                        className="w-full px-5 py-4 rounded-2xl border border-slate-200 focus:ring-4 focus:ring-indigo-100 focus:border-indigo-500 outline-none transition-all font-bold text-slate-800" />
                    </div>
                  </div>
                </div>

                {/* Contact & Online Presence */}
                <div className="bg-white rounded-3xl border border-slate-200 shadow-sm p-8 space-y-6">
                  <div>
                    <h3 className="text-lg font-bold text-slate-900 font-heading">Contact & Online Presence</h3>
                    <p className="text-sm text-slate-500 mt-1">This info appears in the footer of emails and content you create.</p>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="space-y-2">
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">Phone</label>
                      <input type="text" value={businessProfile.phone || ''} onChange={e => setBusinessProfile(p => ({ ...p, phone: e.target.value }))}
                        placeholder="e.g. +1 (555) 123-4567"
                        className="w-full px-5 py-4 rounded-2xl border border-slate-200 focus:ring-4 focus:ring-indigo-100 focus:border-indigo-500 outline-none transition-all font-bold text-slate-800" />
                    </div>
                    <div className="space-y-2">
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">Business Email</label>
                      <input type="text" value={businessProfile.businessEmail || ''} onChange={e => setBusinessProfile(p => ({ ...p, businessEmail: e.target.value }))}
                        placeholder="e.g. hello@yourcompany.com"
                        className="w-full px-5 py-4 rounded-2xl border border-slate-200 focus:ring-4 focus:ring-indigo-100 focus:border-indigo-500 outline-none transition-all font-bold text-slate-800" />
                    </div>
                    <div className="md:col-span-2 space-y-2">
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">Address</label>
                      <input type="text" value={businessProfile.address || ''} onChange={e => setBusinessProfile(p => ({ ...p, address: e.target.value }))}
                        placeholder="e.g. 123 Main St, Suite 200, San Francisco, CA 94105"
                        className="w-full px-5 py-4 rounded-2xl border border-slate-200 focus:ring-4 focus:ring-indigo-100 focus:border-indigo-500 outline-none transition-all font-bold text-slate-800" />
                    </div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {[
                      { key: 'linkedin' as const, icon: <LinkedInIcon className="w-4 h-4" />, label: 'LinkedIn', placeholder: 'https://linkedin.com/company/...' },
                      { key: 'twitter' as const, icon: <TwitterIcon className="w-4 h-4" />, label: 'Twitter / X', placeholder: 'https://x.com/...' },
                      { key: 'instagram' as const, icon: <InstagramIcon className="w-4 h-4" />, label: 'Instagram', placeholder: 'https://instagram.com/...' },
                      { key: 'facebook' as const, icon: <FacebookIcon className="w-4 h-4" />, label: 'Facebook', placeholder: 'https://facebook.com/...' },
                    ].map(s => (
                      <div key={s.key} className="space-y-2">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-1.5">{s.icon} {s.label}</label>
                        <input type="text" value={businessProfile.socialLinks?.[s.key] || ''} onChange={e => setBusinessProfile(p => ({ ...p, socialLinks: { ...(p.socialLinks || {}), [s.key]: e.target.value } }))}
                          placeholder={s.placeholder}
                          className="w-full px-5 py-4 rounded-2xl border border-slate-200 focus:ring-4 focus:ring-indigo-100 focus:border-indigo-500 outline-none transition-all font-bold text-slate-800" />
                      </div>
                    ))}
                  </div>
                </div>

                {/* Products & Value Prop */}
                <div className="bg-white rounded-3xl border border-slate-200 shadow-sm p-8 space-y-6">
                  <div>
                    <h3 className="text-lg font-bold text-slate-900 font-heading">Products & Services</h3>
                    <p className="text-sm text-slate-500 mt-1">What does your company sell or offer?</p>
                  </div>
                  <div className="space-y-6">
                    <div className="space-y-2">
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">About Your Business</label>
                      <textarea value={businessProfile.businessDescription || ''} onChange={e => setBusinessProfile(p => ({ ...p, businessDescription: e.target.value }))}
                        placeholder="e.g. I run a digital marketing agency helping small restaurants and cafes grow online. We offer monthly packages including content creation, posting schedules, and analytics. Our clients are local business owners who want more customers but don't have time to manage social media themselves."
                        rows={4}
                        className="w-full px-5 py-4 rounded-2xl border border-slate-200 focus:ring-4 focus:ring-indigo-100 focus:border-indigo-500 outline-none transition-all font-bold text-slate-800 resize-none" />
                    </div>
                    <div className="space-y-2">
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">What You Sell (Summary)</label>
                      <textarea value={businessProfile.productsServices || ''} onChange={e => setBusinessProfile(p => ({ ...p, productsServices: e.target.value }))}
                        placeholder="Describe your main products or services..."
                        rows={3}
                        className="w-full px-5 py-4 rounded-2xl border border-slate-200 focus:ring-4 focus:ring-indigo-100 focus:border-indigo-500 outline-none transition-all font-bold text-slate-800 resize-none" />
                    </div>
                    {/* Expandable Services List */}
                    <div className="space-y-3">
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">Individual Services</label>
                      {servicesList.map((svc, idx) => (
                        <div key={svc.id} className="bg-slate-50 rounded-xl p-4 space-y-2">
                          <div className="flex items-center space-x-2">
                            <input type="text" value={svc.name} onChange={e => { const u = [...servicesList]; u[idx] = { ...u[idx], name: e.target.value }; updateServicesList(u); }}
                              placeholder="Service name"
                              className="flex-1 px-4 py-3 rounded-xl border border-slate-200 focus:ring-4 focus:ring-indigo-100 focus:border-indigo-500 outline-none transition-all font-bold text-slate-800 text-sm" />
                            <button type="button" onClick={() => updateServicesList(servicesList.filter((_, i) => i !== idx))} className="p-2 text-slate-400 hover:text-rose-500 transition-colors"><XIcon className="w-4 h-4" /></button>
                          </div>
                          <textarea value={svc.description || ''} onChange={e => { const u = [...servicesList]; u[idx] = { ...u[idx], description: e.target.value }; updateServicesList(u); }}
                            placeholder="Description (optional)"
                            rows={2}
                            className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-4 focus:ring-indigo-100 focus:border-indigo-500 outline-none transition-all text-slate-700 text-sm resize-none" />
                        </div>
                      ))}
                      <button type="button" onClick={() => updateServicesList([...servicesList, { id: crypto.randomUUID(), name: '' }])}
                        className="text-xs font-bold text-indigo-600 hover:text-indigo-700 transition-colors">+ Add Service</button>
                    </div>
                    <div className="space-y-2">
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">Value Proposition</label>
                      <textarea value={businessProfile.valueProp || ''} onChange={e => setBusinessProfile(p => ({ ...p, valueProp: e.target.value }))}
                        placeholder="What makes your offering unique? Why should prospects choose you?"
                        rows={3}
                        className="w-full px-5 py-4 rounded-2xl border border-slate-200 focus:ring-4 focus:ring-indigo-100 focus:border-indigo-500 outline-none transition-all font-bold text-slate-800 resize-none" />
                    </div>
                  </div>
                </div>

                {/* Target Market */}
                <div className="bg-white rounded-3xl border border-slate-200 shadow-sm p-8 space-y-6">
                  <div>
                    <h3 className="text-lg font-bold text-slate-900 font-heading">Target Market</h3>
                    <p className="text-sm text-slate-500 mt-1">Who is your ideal customer?</p>
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">Ideal Customer Profile</label>
                    <textarea value={businessProfile.targetAudience || ''} onChange={e => setBusinessProfile(p => ({ ...p, targetAudience: e.target.value }))}
                      placeholder="Describe your ideal customer — role, company size, industry, pain points..."
                      rows={3}
                      className="w-full px-5 py-4 rounded-2xl border border-slate-200 focus:ring-4 focus:ring-indigo-100 focus:border-indigo-500 outline-none transition-all font-bold text-slate-800 resize-none" />
                  </div>
                </div>

                {/* Sales Strategy */}
                <div className="bg-white rounded-3xl border border-slate-200 shadow-sm p-8 space-y-6">
                  <div>
                    <h3 className="text-lg font-bold text-slate-900 font-heading">Sales Strategy</h3>
                    <p className="text-sm text-slate-500 mt-1">How do you sell and price your offering?</p>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="space-y-2">
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">Pricing Model (Summary)</label>
                      <input type="text" value={businessProfile.pricingModel || ''} onChange={e => setBusinessProfile(p => ({ ...p, pricingModel: e.target.value }))}
                        placeholder="e.g. Subscription, Per-seat, Usage-based"
                        className="w-full px-5 py-4 rounded-2xl border border-slate-200 focus:ring-4 focus:ring-indigo-100 focus:border-indigo-500 outline-none transition-all font-bold text-slate-800" />
                    </div>
                    <div className="space-y-2">
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">Sales Approach</label>
                      <input type="text" value={businessProfile.salesApproach || ''} onChange={e => setBusinessProfile(p => ({ ...p, salesApproach: e.target.value }))}
                        placeholder="e.g. Product-led, Enterprise sales, Freemium"
                        className="w-full px-5 py-4 rounded-2xl border border-slate-200 focus:ring-4 focus:ring-indigo-100 focus:border-indigo-500 outline-none transition-all font-bold text-slate-800" />
                    </div>
                  </div>
                  {/* Expandable Pricing Tiers */}
                  <div className="space-y-3">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">Pricing Tiers</label>
                    {pricingTiers.map((tier, idx) => (
                      <div key={tier.id} className="bg-slate-50 rounded-xl p-4 space-y-2">
                        <div className="flex items-center space-x-2">
                          <input type="text" value={tier.name} onChange={e => { const u = [...pricingTiers]; u[idx] = { ...u[idx], name: e.target.value }; updatePricingTiers(u); }}
                            placeholder="Tier name (e.g. Starter)"
                            className="flex-1 px-4 py-3 rounded-xl border border-slate-200 focus:ring-4 focus:ring-indigo-100 focus:border-indigo-500 outline-none transition-all font-bold text-slate-800 text-sm" />
                          <input type="text" value={tier.price || ''} onChange={e => { const u = [...pricingTiers]; u[idx] = { ...u[idx], price: e.target.value }; updatePricingTiers(u); }}
                            placeholder="$XX/mo"
                            className="w-32 px-4 py-3 rounded-xl border border-slate-200 focus:ring-4 focus:ring-indigo-100 focus:border-indigo-500 outline-none transition-all font-bold text-slate-800 text-sm" />
                          <button type="button" onClick={() => updatePricingTiers(pricingTiers.filter((_, i) => i !== idx))} className="p-2 text-slate-400 hover:text-rose-500 transition-colors"><XIcon className="w-4 h-4" /></button>
                        </div>
                        <textarea value={tier.description || ''} onChange={e => { const u = [...pricingTiers]; u[idx] = { ...u[idx], description: e.target.value }; updatePricingTiers(u); }}
                          placeholder="Description (optional)" rows={2}
                          className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-4 focus:ring-indigo-100 focus:border-indigo-500 outline-none transition-all text-slate-700 text-sm resize-none" />
                        {(tier.features || []).map((feat, fi) => (
                          <div key={fi} className="flex items-center space-x-2 pl-2">
                            <span className="text-slate-400 text-xs">-</span>
                            <input type="text" value={feat} onChange={e => { const u = [...pricingTiers]; const feats = [...(u[idx].features || [])]; feats[fi] = e.target.value; u[idx] = { ...u[idx], features: feats }; updatePricingTiers(u); }}
                              placeholder="Feature"
                              className="flex-1 px-3 py-2 rounded-lg border border-slate-200 focus:ring-2 focus:ring-indigo-100 outline-none text-sm text-slate-700" />
                            <button type="button" onClick={() => { const u = [...pricingTiers]; const feats = [...(u[idx].features || [])]; feats.splice(fi, 1); u[idx] = { ...u[idx], features: feats }; updatePricingTiers(u); }}
                              className="text-slate-300 hover:text-rose-500 transition-colors"><XIcon className="w-3.5 h-3.5" /></button>
                          </div>
                        ))}
                        <button type="button" onClick={() => { const u = [...pricingTiers]; u[idx] = { ...u[idx], features: [...(u[idx].features || []), ''] }; updatePricingTiers(u); }}
                          className="text-[10px] font-bold text-indigo-500 hover:text-indigo-600 transition-colors pl-2">+ Add Feature</button>
                      </div>
                    ))}
                    <button type="button" onClick={() => updatePricingTiers([...pricingTiers, { id: crypto.randomUUID(), name: '', price: '' }])}
                      className="text-xs font-bold text-indigo-600 hover:text-indigo-700 transition-colors">+ Add Pricing Tier</button>
                  </div>
                </div>

                {/* Save Button */}
                <div className="flex items-center justify-between">
                  <div className="flex-grow">
                    {success && (
                      <span className="text-emerald-600 text-xs font-black uppercase tracking-widest flex items-center space-x-2 animate-in slide-in-from-left-2 duration-300">
                        <div className="w-5 h-5 bg-emerald-100 rounded-lg flex items-center justify-center text-[10px]">
                          <CheckIcon className="w-3 h-3" />
                        </div>
                        <span>Business Profile Saved</span>
                      </span>
                    )}
                    {error && <span className="text-red-600 text-xs font-black uppercase tracking-widest truncate max-w-[300px]">Error: {error}</span>}
                  </div>
                  <button type="submit" disabled={isSavingBusiness}
                    className={`px-10 py-4 font-bold rounded-2xl shadow-2xl transition-all active:scale-95 ${isSavingBusiness ? 'bg-slate-100 text-slate-400' : 'bg-indigo-600 text-white hover:bg-indigo-700 shadow-indigo-100 hover:scale-[1.02]'}`}>
                    {isSavingBusiness ? 'Saving...' : 'Save Business Profile'}
                  </button>
                </div>
              </form>
            </div>
          )}

        </div>
      )}

      {activeTab === 'security' && (
        <div className="space-y-6 animate-in fade-in duration-300">
          <div className="bg-white rounded-3xl border border-slate-200 shadow-sm p-8 space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-bold text-slate-900 font-heading">Two-Factor Authentication</h3>
                <p className="text-sm text-slate-500 mt-1">Add an extra layer of security to your account.</p>
              </div>
              <button
                onClick={() => { setTwoFactorEnabled(!twoFactorEnabled); setShowQRCode(!twoFactorEnabled); }}
                className={`relative w-14 h-8 rounded-full transition-colors ${twoFactorEnabled ? 'bg-indigo-600' : 'bg-slate-200'}`}
              >
                <div className={`absolute top-1.5 w-5 h-5 bg-white rounded-full shadow-sm transition-transform ${twoFactorEnabled ? 'left-7' : 'left-1.5'}`} />
              </button>
            </div>

            {showQRCode && twoFactorEnabled && (
              <div className="p-6 bg-indigo-50 rounded-2xl border border-indigo-100 animate-in fade-in duration-300">
                <div className="flex items-start space-x-6">
                  <div className="w-32 h-32 bg-white rounded-2xl border border-indigo-200 flex items-center justify-center shadow-sm">
                    <div className="w-24 h-24 bg-slate-100 rounded-xl flex items-center justify-center">
                      <div className="grid grid-cols-5 gap-0.5">
                        {Array.from({ length: 25 }).map((_, i) => (
                          <div key={i} className={`w-3.5 h-3.5 rounded-sm ${Math.random() > 0.4 ? 'bg-slate-800' : 'bg-white'}`} />
                        ))}
                      </div>
                    </div>
                  </div>
                  <div className="space-y-3">
                    <p className="text-sm font-bold text-indigo-800">Scan QR Code</p>
                    <p className="text-xs text-indigo-600 leading-relaxed">Open your authenticator app (Google Authenticator, Authy) and scan this QR code to enable 2FA.</p>
                    <div className="flex items-center space-x-2">
                      <code className="px-3 py-2 bg-white rounded-lg text-xs font-mono text-slate-600 border border-indigo-100">AURA-2FA-XXXX-XXXX</code>
                      <button className="p-2 text-indigo-600 hover:bg-white rounded-lg transition-colors">
                        <CopyIcon className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {!twoFactorEnabled && (
              <div className="p-5 bg-amber-50 rounded-2xl border border-amber-100">
                <p className="text-xs font-bold text-amber-700">2FA is currently disabled. Enable it for enhanced account security.</p>
              </div>
            )}
          </div>

          <div className="bg-white rounded-3xl border border-slate-200 shadow-sm p-8 space-y-6">
            <h3 className="text-lg font-bold text-slate-900 font-heading">Active Sessions</h3>
            <div className="space-y-3">
              <div className="flex items-center justify-between p-4 bg-emerald-50 border border-emerald-100 rounded-2xl">
                <div className="flex items-center space-x-4">
                  <div className="w-10 h-10 bg-emerald-100 text-emerald-600 rounded-xl flex items-center justify-center">
                    <ShieldIcon className="w-5 h-5" />
                  </div>
                  <div>
                    <p className="text-sm font-bold text-slate-800">Current Session</p>
                    <p className="text-xs text-slate-400 mt-0.5">Browser &middot; {new Date().toLocaleDateString()}</p>
                  </div>
                </div>
                <span className="text-[9px] font-black uppercase tracking-widest bg-emerald-600 text-white px-3 py-1 rounded-full">Active</span>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-3xl border border-slate-200 shadow-sm p-8 space-y-4">
            <h3 className="text-lg font-bold text-slate-900 font-heading">Password</h3>
            <p className="text-sm text-slate-500">Change your password via Supabase authentication.</p>
            <button
              onClick={async () => {
                await supabase.auth.resetPasswordForEmail(user.email);
                setSuccess(true);
                setTimeout(() => setSuccess(false), 3000);
              }}
              className="px-6 py-3 bg-slate-900 text-white rounded-xl text-xs font-bold hover:bg-indigo-600 transition-colors"
            >
              Send Password Reset Email
            </button>
            {success && <p className="text-xs font-bold text-emerald-600">Reset email sent!</p>}
          </div>
        </div>
      )}

      {activeTab === 'pipeline_colors' && <StageColorSettings user={user} />}

      {/* Build stamp */}
      <div className="mt-8 text-center">
        <p className="text-[10px] text-slate-300 font-mono">
          {BRAND.version} &middot; build {BRAND.buildSha} &middot; {BRAND.buildTime ? new Date(BRAND.buildTime).toLocaleDateString() : ''}
        </p>
      </div>

      {/* Delete Modal */}
      {isDeleteModalOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center px-4">
          <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-md" onClick={() => !isDeleting && setIsDeleteModalOpen(false)}></div>
          <div className="relative bg-white w-full max-w-md rounded-[3rem] shadow-3xl overflow-hidden animate-in zoom-in-95 duration-300 p-12 text-center">
            <div className="w-20 h-20 bg-red-50 text-red-600 rounded-[2rem] flex items-center justify-center mx-auto mb-8 shadow-xl shadow-red-50">
              <ShieldIcon className="w-10 h-10" />
            </div>
            <h3 className="text-2xl font-black text-slate-900 font-heading mb-3">Terminate Node?</h3>
            <p className="text-slate-500 text-sm leading-relaxed mb-10 font-medium">
              You are about to permanently wipe all data. This process is irreversible and all connected AI assets will be lost.
            </p>
            <div className="space-y-4">
              <button onClick={handleDeleteAccount} disabled={isDeleting}
                className={`w-full py-5 rounded-2xl font-bold text-lg transition-all flex items-center justify-center space-x-2 ${isDeleting ? 'bg-slate-100 text-slate-400 cursor-not-allowed' : 'bg-red-600 text-white hover:bg-red-700 shadow-2xl shadow-red-100'}`}>
                {isDeleting ? <div className="w-6 h-6 border-2 border-slate-300 border-t-red-600 rounded-full animate-spin"></div> : <span>Destroy Everything</span>}
              </button>
              <button onClick={() => setIsDeleteModalOpen(false)} disabled={isDeleting}
                className="w-full py-4 bg-white text-slate-500 rounded-2xl font-bold hover:bg-slate-50 transition-all border border-slate-100">
                Abort
              </button>
            </div>
          </div>
        </div>
      )}

      <AdvancedOnly>
      {/* ═══════════════════════════════════════════════════════════ */}
      {/* ─── Account Health Dashboard Sidebar ─── */}
      {/* ═══════════════════════════════════════════════════════════ */}
      {showAccountHealth && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div className="absolute inset-0 bg-black/20 backdrop-blur-sm" onClick={() => setShowAccountHealth(false)} />
          <div className="relative w-full max-w-md bg-white shadow-2xl border-l border-slate-200 overflow-y-auto animate-slide-in-right">
            <div className="sticky top-0 bg-white border-b border-slate-100 px-6 py-4 flex items-center justify-between z-10">
              <div className="flex items-center space-x-3">
                <div className="w-8 h-8 rounded-lg bg-emerald-100 text-emerald-600 flex items-center justify-center">
                  <ShieldIcon className="w-4 h-4" />
                </div>
                <div>
                  <h2 className="text-sm font-black text-slate-900">Account Health</h2>
                  <p className="text-[10px] text-slate-400">Security & completeness score</p>
                </div>
              </div>
              <button onClick={() => setShowAccountHealth(false)} className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100"><XIcon className="w-4 h-4" /></button>
            </div>

            <div className="p-6 space-y-6">
              {/* Health Score Gauge */}
              <div className="text-center p-6 rounded-2xl bg-slate-50 border border-slate-100">
                <svg className="w-24 h-24 mx-auto mb-4" viewBox="0 0 96 96">
                  <circle cx="48" cy="48" r="40" fill="none" stroke="#e2e8f0" strokeWidth="8" />
                  <circle cx="48" cy="48" r="40" fill="none"
                    stroke={accountHealth.score >= 80 ? '#10b981' : accountHealth.score >= 50 ? '#f59e0b' : '#ef4444'}
                    strokeWidth="8"
                    strokeDasharray={`${(accountHealth.score / 100) * 251.3} 251.3`}
                    strokeLinecap="round" transform="rotate(-90 48 48)" />
                  <text x="48" y="44" textAnchor="middle" className="text-xl font-black" fill="#1e293b">{accountHealth.score}%</text>
                  <text x="48" y="58" textAnchor="middle" className="text-[8px] font-bold" fill="#94a3b8">HEALTH</text>
                </svg>
                <p className="text-sm font-black text-slate-900">
                  {accountHealth.score >= 80 ? 'Excellent' : accountHealth.score >= 50 ? 'Needs Improvement' : 'At Risk'}
                </p>
                <p className="text-[11px] text-slate-500 mt-1">
                  {accountHealth.checks.filter(c => c.passed).length}/{accountHealth.checks.length} checks passed
                </p>
              </div>

              {/* Health Checks */}
              <div>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider mb-3">Security Checklist</p>
                <div className="space-y-2">
                  {accountHealth.checks.map((check, idx) => (
                    <div key={idx} className={`flex items-center justify-between p-3 rounded-xl ${check.passed ? 'bg-emerald-50' : 'bg-red-50'}`}>
                      <div className="flex items-center space-x-3">
                        {check.passed ? (
                          <CheckIcon className="w-4 h-4 text-emerald-600" />
                        ) : (
                          <AlertTriangleIcon className="w-4 h-4 text-red-500" />
                        )}
                        <span className="text-xs font-bold text-slate-700">{check.label}</span>
                      </div>
                      <div className="flex items-center space-x-2">
                        <span className="text-[10px] font-bold text-slate-400">+{check.weight}%</span>
                        <span className={`px-2 py-0.5 rounded-full text-[9px] font-black ${check.passed ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                          {check.passed ? 'Pass' : 'Fix'}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Recommendations */}
              {accountHealth.score < 100 && (
                <div className="p-4 bg-gradient-to-r from-indigo-600 to-violet-600 rounded-2xl text-white">
                  <p className="text-[10px] font-black text-indigo-200 uppercase tracking-wider mb-3">Recommendations</p>
                  <div className="space-y-2">
                    {accountHealth.checks.filter(c => !c.passed).map((check, idx) => (
                      <div key={idx} className="flex items-center space-x-2">
                        <SparklesIcon className="w-3.5 h-3.5 text-indigo-300" />
                        <span className="text-xs font-medium text-indigo-100">Enable: {check.label} (+{check.weight}%)</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Account Summary */}
              <div className="p-4 bg-slate-900 rounded-2xl text-white">
                <p className="text-[10px] font-black text-indigo-400 uppercase tracking-wider mb-3">Account Summary</p>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-lg font-black">{user?.role === 'ADMIN' ? 'Admin' : 'Client'}</p>
                    <p className="text-[10px] text-slate-400">Account Type</p>
                  </div>
                  <div>
                    <p className="text-lg font-black">{apiKeys.filter(k => k.status === 'active').length}</p>
                    <p className="text-[10px] text-slate-400">Active API Keys</p>
                  </div>
                  <div>
                    <p className="text-lg font-black">{twoFactorEnabled ? 'On' : 'Off'}</p>
                    <p className="text-[10px] text-slate-400">2FA Status</p>
                  </div>
                  <div>
                    <p className="text-lg font-black">{Object.values(notifications).filter(Boolean).length}</p>
                    <p className="text-[10px] text-slate-400">Active Alerts</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════ */}
      {/* ─── Session Activity Sidebar ─── */}
      {/* ═══════════════════════════════════════════════════════════ */}
      {showSessionActivity && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div className="absolute inset-0 bg-black/20 backdrop-blur-sm" onClick={() => setShowSessionActivity(false)} />
          <div className="relative w-full max-w-md bg-white shadow-2xl border-l border-slate-200 overflow-y-auto animate-slide-in-right">
            <div className="sticky top-0 bg-white border-b border-slate-100 px-6 py-4 flex items-center justify-between z-10">
              <div className="flex items-center space-x-3">
                <div className="w-8 h-8 rounded-lg bg-indigo-100 text-indigo-600 flex items-center justify-center">
                  <ActivityIcon className="w-4 h-4" />
                </div>
                <div>
                  <h2 className="text-sm font-black text-slate-900">Session Activity</h2>
                  <p className="text-[10px] text-slate-400">Your recent actions this session</p>
                </div>
              </div>
              <button onClick={() => setShowSessionActivity(false)} className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100"><XIcon className="w-4 h-4" /></button>
            </div>

            <div className="p-6 space-y-6">
              {/* Session Summary */}
              <div className="grid grid-cols-3 gap-3">
                <div className="p-3 bg-indigo-50 rounded-xl text-center">
                  <p className="text-xl font-black text-indigo-700">{sessionActivity.length}</p>
                  <p className="text-[10px] font-bold text-indigo-500">Actions</p>
                </div>
                <div className="p-3 bg-emerald-50 rounded-xl text-center">
                  <p className="text-xl font-black text-emerald-700">32m</p>
                  <p className="text-[10px] font-bold text-emerald-500">Duration</p>
                </div>
                <div className="p-3 bg-violet-50 rounded-xl text-center">
                  <p className="text-xl font-black text-violet-700">4</p>
                  <p className="text-[10px] font-bold text-violet-500">Pages</p>
                </div>
              </div>

              {/* Activity Timeline */}
              <div>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider mb-3">Activity Timeline</p>
                <div className="relative">
                  <div className="absolute left-3.5 top-0 bottom-0 w-0.5 bg-slate-200" />
                  <div className="space-y-3">
                    {sessionActivity.map((item, idx) => {
                      const style = SESSION_TYPE_STYLES[item.type] || SESSION_TYPE_STYLES.navigation;
                      return (
                        <div key={idx} className="relative pl-10">
                          <div className={`absolute left-1.5 top-2 w-4 h-4 rounded-full border-2 border-white shadow ${style.bg}`}>
                            <div className={`w-full h-full rounded-full ${idx === 0 ? 'animate-pulse bg-indigo-500' : ''}`} />
                          </div>
                          <div className="p-3 bg-slate-50 rounded-xl hover:bg-slate-100 transition-colors">
                            <div className="flex items-center justify-between mb-1">
                              <span className={`px-2 py-0.5 rounded-full text-[9px] font-black ${style.bg} ${style.text} capitalize`}>{item.type}</span>
                              <span className="text-[10px] text-slate-400 font-bold">{item.time}</span>
                            </div>
                            <p className="text-xs font-bold text-slate-700">{item.action}</p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* Device Info */}
              <div className="p-4 bg-slate-900 rounded-2xl text-white">
                <p className="text-[10px] font-black text-indigo-400 uppercase tracking-wider mb-3">Device Information</p>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-slate-400">Browser</span>
                    <span className="text-xs font-bold text-white">Chrome / Desktop</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-slate-400">IP Address</span>
                    <span className="text-xs font-bold text-white">192.168.1.***</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-slate-400">Location</span>
                    <span className="text-xs font-bold text-white">United States</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-slate-400">Login Method</span>
                    <span className="text-xs font-bold text-white">Password + {twoFactorEnabled ? '2FA' : 'No 2FA'}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════ */}
      {/* ─── Data Export Sidebar ─── */}
      {/* ═══════════════════════════════════════════════════════════ */}
      {showDataExport && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div className="absolute inset-0 bg-black/20 backdrop-blur-sm" onClick={() => setShowDataExport(false)} />
          <div className="relative w-full max-w-md bg-white shadow-2xl border-l border-slate-200 overflow-y-auto animate-slide-in-right">
            <div className="sticky top-0 bg-white border-b border-slate-100 px-6 py-4 flex items-center justify-between z-10">
              <div className="flex items-center space-x-3">
                <div className="w-8 h-8 rounded-lg bg-violet-100 text-violet-600 flex items-center justify-center">
                  <DownloadIcon className="w-4 h-4" />
                </div>
                <div>
                  <h2 className="text-sm font-black text-slate-900">Data Export</h2>
                  <p className="text-[10px] text-slate-400">Download your account data</p>
                </div>
              </div>
              <button onClick={() => setShowDataExport(false)} className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100"><XIcon className="w-4 h-4" /></button>
            </div>

            <div className="p-6 space-y-6">
              {/* Export Options */}
              <div>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider mb-3">Available Exports</p>
                <div className="space-y-2">
                  {exportOptions.map(opt => (
                    <div key={opt.id} className="flex items-center justify-between p-4 bg-slate-50 rounded-xl hover:bg-slate-100 transition-colors group cursor-pointer">
                      <div className="flex items-center space-x-3">
                        <div className="w-9 h-9 rounded-lg bg-white border border-slate-200 flex items-center justify-center text-indigo-600 group-hover:bg-indigo-50 transition-colors">
                          {opt.icon}
                        </div>
                        <div>
                          <p className="text-xs font-bold text-slate-900">{opt.label}</p>
                          <p className="text-[10px] text-slate-400">{opt.desc}</p>
                        </div>
                      </div>
                      <div className="flex items-center space-x-3">
                        <span className="text-[10px] font-bold text-slate-400">{opt.size}</span>
                        <div className="flex items-center space-x-1">
                          <button className="px-2.5 py-1 bg-white border border-slate-200 rounded-lg text-[10px] font-bold text-slate-600 hover:bg-indigo-50 hover:text-indigo-600 hover:border-indigo-200 transition-colors">CSV</button>
                          <button className="px-2.5 py-1 bg-white border border-slate-200 rounded-lg text-[10px] font-bold text-slate-600 hover:bg-indigo-50 hover:text-indigo-600 hover:border-indigo-200 transition-colors">JSON</button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Bulk Export */}
              <div className="p-4 bg-gradient-to-r from-indigo-600 to-violet-600 rounded-2xl text-white">
                <p className="text-[10px] font-black text-indigo-200 uppercase tracking-wider mb-3">Complete Data Export</p>
                <p className="text-xs text-indigo-100 mb-4">Download all your account data in a single archive. GDPR-compliant full data export.</p>
                <button className="w-full py-3 bg-white/10 rounded-xl text-xs font-bold text-white hover:bg-white/20 transition-colors flex items-center justify-center space-x-2">
                  <DownloadIcon className="w-4 h-4" />
                  <span>Export All Data (ZIP)</span>
                </button>
              </div>

              {/* Export History */}
              <div>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider mb-3">Recent Exports</p>
                <div className="space-y-2">
                  {[
                    { name: 'leads_export_jan2024.csv', date: '2024-01-15', size: '482 KB' },
                    { name: 'analytics_q4_2023.json', date: '2024-01-02', size: '1.1 MB' },
                    { name: 'full_backup_dec2023.zip', date: '2023-12-28', size: '4.7 MB' },
                  ].map((file, idx) => (
                    <div key={idx} className="flex items-center justify-between p-3 bg-slate-50 rounded-xl">
                      <div className="flex items-center space-x-3">
                        <DocumentIcon className="w-4 h-4 text-slate-400" />
                        <div>
                          <p className="text-xs font-bold text-slate-700">{file.name}</p>
                          <p className="text-[10px] text-slate-400">{file.date}</p>
                        </div>
                      </div>
                      <span className="text-[10px] font-bold text-slate-400">{file.size}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Data Retention Notice */}
              <div className="p-4 bg-amber-50 rounded-xl border border-amber-100">
                <div className="flex items-start space-x-2">
                  <AlertTriangleIcon className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs font-bold text-amber-800">Data Retention Policy</p>
                    <p className="text-[10px] text-amber-600 mt-0.5">Exports are available for 30 days. Data is retained per your plan terms. Contact support for extended retention options.</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════ */}
      {/* ─── Usage Analytics Sidebar ─── */}
      {/* ═══════════════════════════════════════════════════════════ */}
      {showUsageAnalytics && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div className="absolute inset-0 bg-slate-900/30 backdrop-blur-sm" onClick={() => setShowUsageAnalytics(false)} />
          <div className="relative w-full max-w-md bg-white shadow-2xl border-l border-slate-200 overflow-y-auto animate-slide-in-right">
            <div className="sticky top-0 bg-white border-b border-slate-100 px-6 py-4 flex items-center justify-between z-10">
              <div className="flex items-center space-x-3">
                <div className="w-8 h-8 rounded-lg bg-cyan-100 text-cyan-600 flex items-center justify-center">
                  <TrendUpIcon className="w-4 h-4" />
                </div>
                <div>
                  <h2 className="text-sm font-black text-slate-900">Usage Analytics</h2>
                  <p className="text-[10px] text-slate-400">Your platform activity patterns</p>
                </div>
              </div>
              <button onClick={() => setShowUsageAnalytics(false)} className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100"><XIcon className="w-4 h-4" /></button>
            </div>

            <div className="p-6 space-y-6">
              {/* Gauge */}
              <div className="text-center">
                <svg className="w-24 h-24 mx-auto" viewBox="0 0 96 96">
                  <circle cx="48" cy="48" r="40" fill="none" stroke="#e2e8f0" strokeWidth="7" />
                  <circle cx="48" cy="48" r="40" fill="none" stroke="#06b6d4" strokeWidth="7"
                    strokeDasharray={`${Math.min((usageAnalytics.totalSessions / 150) * 251.3, 251.3)} 251.3`}
                    strokeLinecap="round" transform="rotate(-90 48 48)" />
                  <text x="48" y="44" textAnchor="middle" className="text-lg font-black fill-slate-900">{usageAnalytics.totalSessions}</text>
                  <text x="48" y="58" textAnchor="middle" className="text-[7px] font-bold fill-cyan-600 uppercase">Sessions</text>
                </svg>
              </div>

              {/* Summary Cards */}
              <div className="grid grid-cols-2 gap-3">
                <div className="p-3 bg-cyan-50 rounded-xl text-center">
                  <p className="text-lg font-black text-cyan-700">{usageAnalytics.totalActions}</p>
                  <p className="text-[10px] font-bold text-cyan-500">Weekly Actions</p>
                </div>
                <div className="p-3 bg-indigo-50 rounded-xl text-center">
                  <p className="text-lg font-black text-indigo-700">{usageAnalytics.avgSessionDuration}</p>
                  <p className="text-[10px] font-bold text-indigo-500">Avg Duration</p>
                </div>
                <div className="p-3 bg-violet-50 rounded-xl text-center">
                  <p className="text-lg font-black text-violet-700">{usageAnalytics.peakHour}</p>
                  <p className="text-[10px] font-bold text-violet-500">Peak Hour</p>
                </div>
                <div className="p-3 bg-emerald-50 rounded-xl text-center">
                  <p className="text-lg font-black text-emerald-700">{usageAnalytics.featureUsage.length}</p>
                  <p className="text-[10px] font-bold text-emerald-500">Features Used</p>
                </div>
              </div>

              {/* Feature Usage Breakdown */}
              <div>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider mb-3">Feature Usage</p>
                <div className="space-y-2.5">
                  {usageAnalytics.featureUsage.map((feat, idx) => (
                    <div key={idx} className="p-3 bg-slate-50 rounded-xl">
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-xs font-bold text-slate-700">{feat.feature}</span>
                        <span className="text-[10px] font-bold text-slate-500">{feat.sessions} sessions</span>
                      </div>
                      <div className="w-full bg-slate-200 h-1.5 rounded-full overflow-hidden mb-1.5">
                        <div className="bg-cyan-500 h-full rounded-full transition-all" style={{ width: `${feat.pct}%` }} />
                      </div>
                      <div className="flex items-center justify-between text-[10px] text-slate-400">
                        <span>{feat.pct}% of usage</span>
                        <span>Avg: {feat.avgDuration}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Weekly Login Chart */}
              <div className="bg-slate-900 rounded-xl p-5">
                <p className="text-[10px] font-black text-cyan-400 uppercase tracking-wider mb-4">7-Day Activity</p>
                <div className="flex items-end justify-between h-28 gap-1">
                  {usageAnalytics.weeklyLogins.map((d, i) => {
                    const maxVal = Math.max(...usageAnalytics.weeklyLogins.map(v => v.actions));
                    return (
                      <div key={i} className="flex-1 flex flex-col items-center gap-0.5">
                        <div className="w-full flex gap-0.5" style={{ height: '100%', alignItems: 'flex-end' }}>
                          <div className="flex-1 bg-gradient-to-t from-cyan-600 to-cyan-400 rounded-t" style={{ height: `${(d.actions / maxVal) * 100}%`, minHeight: '4px' }} />
                        </div>
                        <span className="text-[8px] text-slate-500 mt-1">{d.day}</span>
                      </div>
                    );
                  })}
                </div>
                <div className="flex items-center justify-center space-x-4 mt-3">
                  <div className="flex items-center space-x-1.5">
                    <div className="w-2 h-2 rounded-full bg-cyan-400" />
                    <span className="text-[9px] text-slate-400">Actions</span>
                  </div>
                </div>
              </div>

              {/* AI Insight */}
              <div className="bg-gradient-to-r from-cyan-600 to-cyan-600 rounded-2xl p-5 text-white">
                <div className="flex items-center space-x-2 mb-3">
                  <SparklesIcon className="w-4 h-4 text-cyan-200" />
                  <p className="text-[10px] font-black text-cyan-200 uppercase tracking-wider">AI Usage Insight</p>
                </div>
                <p className="text-xs font-bold leading-relaxed">
                  Your most active feature is {usageAnalytics.featureUsage[0]?.feature} at {usageAnalytics.featureUsage[0]?.pct}% of total usage. Peak activity at {usageAnalytics.peakHour} suggests a morning workflow pattern. Consider exploring Automation more — users who leverage it save an average of 15 hours/week.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════ */}
      {/* ─── Privacy & Compliance Audit Sidebar ─── */}
      {/* ═══════════════════════════════════════════════════════════ */}
      {showPrivacyAudit && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div className="absolute inset-0 bg-slate-900/30 backdrop-blur-sm" onClick={() => setShowPrivacyAudit(false)} />
          <div className="relative w-full max-w-md bg-white shadow-2xl border-l border-slate-200 overflow-y-auto animate-slide-in-right">
            <div className="sticky top-0 bg-white border-b border-slate-100 px-6 py-4 flex items-center justify-between z-10">
              <div className="flex items-center space-x-3">
                <div className="w-8 h-8 rounded-lg bg-rose-100 text-rose-600 flex items-center justify-center">
                  <LockIcon className="w-4 h-4" />
                </div>
                <div>
                  <h2 className="text-sm font-black text-slate-900">Privacy Audit</h2>
                  <p className="text-[10px] text-slate-400">Compliance & data protection status</p>
                </div>
              </div>
              <button onClick={() => setShowPrivacyAudit(false)} className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100"><XIcon className="w-4 h-4" /></button>
            </div>

            <div className="p-6 space-y-6">
              {/* Gauge */}
              <div className="text-center">
                <svg className="w-24 h-24 mx-auto" viewBox="0 0 96 96">
                  <circle cx="48" cy="48" r="40" fill="none" stroke="#e2e8f0" strokeWidth="7" />
                  <circle cx="48" cy="48" r="40" fill="none" stroke="#e11d48" strokeWidth="7"
                    strokeDasharray={`${(privacyAudit.complianceScore / 100) * 251.3} 251.3`}
                    strokeLinecap="round" transform="rotate(-90 48 48)" />
                  <text x="48" y="44" textAnchor="middle" className="text-lg font-black fill-slate-900">{privacyAudit.complianceScore}%</text>
                  <text x="48" y="58" textAnchor="middle" className="text-[7px] font-bold fill-rose-600 uppercase">Compliant</text>
                </svg>
              </div>

              {/* Summary Cards */}
              <div className="grid grid-cols-2 gap-3">
                <div className="p-3 bg-rose-50 rounded-xl text-center">
                  <p className="text-lg font-black text-rose-700">{privacyAudit.passCount}/{privacyAudit.total}</p>
                  <p className="text-[10px] font-bold text-rose-500">Checks Passed</p>
                </div>
                <div className="p-3 bg-emerald-50 rounded-xl text-center">
                  <p className="text-lg font-black text-emerald-700">{privacyAudit.complianceScore}%</p>
                  <p className="text-[10px] font-bold text-emerald-500">Compliance Score</p>
                </div>
                <div className="p-3 bg-indigo-50 rounded-xl text-center">
                  <p className="text-lg font-black text-indigo-700">{privacyAudit.lastAudit}</p>
                  <p className="text-[10px] font-bold text-indigo-500">Last Audit</p>
                </div>
                <div className="p-3 bg-amber-50 rounded-xl text-center">
                  <p className="text-lg font-black text-amber-700">{privacyAudit.total - privacyAudit.passCount}</p>
                  <p className="text-[10px] font-bold text-amber-500">Warnings</p>
                </div>
              </div>

              {/* Compliance Checks */}
              <div>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider mb-3">Compliance Checklist</p>
                <div className="space-y-2">
                  {privacyAudit.checks.map((check, idx) => (
                    <div key={idx} className={`p-3 rounded-xl ${check.status === 'pass' ? 'bg-emerald-50' : 'bg-amber-50'}`}>
                      <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center space-x-2">
                          {check.status === 'pass' ? (
                            <CheckIcon className="w-4 h-4 text-emerald-600" />
                          ) : (
                            <AlertTriangleIcon className="w-4 h-4 text-amber-600" />
                          )}
                          <span className="text-xs font-bold text-slate-700">{check.label}</span>
                        </div>
                        <span className={`px-2 py-0.5 rounded-full text-[9px] font-black ${check.status === 'pass' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
                          {check.status === 'pass' ? 'Pass' : 'Warning'}
                        </span>
                      </div>
                      <p className="text-[10px] text-slate-500 ml-6">{check.detail}</p>
                    </div>
                  ))}
                </div>
              </div>

              {/* Privacy Standards */}
              <div className="bg-slate-900 rounded-xl p-5">
                <p className="text-[10px] font-black text-rose-400 uppercase tracking-wider mb-4">Compliance Standards</p>
                <div className="space-y-3">
                  {[
                    { standard: 'GDPR', status: 'Compliant', pct: 100 },
                    { standard: 'SOC 2 Type II', status: 'Compliant', pct: 100 },
                    { standard: 'CCPA', status: 'Compliant', pct: 100 },
                    { standard: 'ISO 27001', status: 'In Progress', pct: 85 },
                  ].map((std, idx) => (
                    <div key={idx} className="flex items-center space-x-3">
                      <span className="text-[10px] text-slate-400 w-20">{std.standard}</span>
                      <div className="flex-1 bg-slate-800 h-3 rounded-full overflow-hidden">
                        <div className="bg-gradient-to-r from-rose-600 to-rose-400 h-full rounded-full" style={{ width: `${std.pct}%` }} />
                      </div>
                      <span className="text-[10px] font-bold text-white w-16 text-right">{std.status}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* AI Insight */}
              <div className="bg-gradient-to-r from-rose-600 to-rose-600 rounded-2xl p-5 text-white">
                <div className="flex items-center space-x-2 mb-3">
                  <SparklesIcon className="w-4 h-4 text-rose-200" />
                  <p className="text-[10px] font-black text-rose-200 uppercase tracking-wider">AI Privacy Insight</p>
                </div>
                <p className="text-xs font-bold leading-relaxed">
                  {privacyAudit.complianceScore === 100
                    ? 'Your account meets all privacy and compliance requirements. All data protection checks pass. Regular audits are recommended to maintain this status.'
                    : `Compliance score of ${privacyAudit.complianceScore}% — ${privacyAudit.total - privacyAudit.passCount} item(s) need attention. ${!twoFactorEnabled ? 'Enabling 2FA is the highest-priority improvement for account security.' : 'Review team sharing settings to resolve remaining warnings.'}`}
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════ */}
      {/* ─── Quota & Limits Tracker Sidebar ─── */}
      {/* ═══════════════════════════════════════════════════════════ */}
      {showQuotaTracker && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div className="absolute inset-0 bg-slate-900/30 backdrop-blur-sm" onClick={() => setShowQuotaTracker(false)} />
          <div className="relative w-full max-w-md bg-white shadow-2xl border-l border-slate-200 overflow-y-auto animate-slide-in-right">
            <div className="sticky top-0 bg-white border-b border-slate-100 px-6 py-4 flex items-center justify-between z-10">
              <div className="flex items-center space-x-3">
                <div className="w-8 h-8 rounded-lg bg-amber-100 text-amber-600 flex items-center justify-center">
                  <LayersIcon className="w-4 h-4" />
                </div>
                <div>
                  <h2 className="text-sm font-black text-slate-900">Quota Tracker</h2>
                  <p className="text-[10px] text-slate-400">Resource limits & usage</p>
                </div>
              </div>
              <button onClick={() => setShowQuotaTracker(false)} className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100"><XIcon className="w-4 h-4" /></button>
            </div>

            <div className="p-6 space-y-6">
              {/* Gauge */}
              <div className="text-center">
                <svg className="w-24 h-24 mx-auto" viewBox="0 0 96 96">
                  <circle cx="48" cy="48" r="40" fill="none" stroke="#e2e8f0" strokeWidth="7" />
                  <circle cx="48" cy="48" r="40" fill="none" stroke="#f59e0b" strokeWidth="7"
                    strokeDasharray={`${(quotaTracker.overallUsage / 100) * 251.3} 251.3`}
                    strokeLinecap="round" transform="rotate(-90 48 48)" />
                  <text x="48" y="44" textAnchor="middle" className="text-lg font-black fill-slate-900">{quotaTracker.overallUsage}%</text>
                  <text x="48" y="58" textAnchor="middle" className="text-[7px] font-bold fill-amber-600 uppercase">Used</text>
                </svg>
              </div>

              {/* Summary Cards */}
              <div className="grid grid-cols-2 gap-3">
                <div className="p-3 bg-amber-50 rounded-xl text-center">
                  <p className="text-lg font-black text-amber-700">{quotaTracker.quotas.length}</p>
                  <p className="text-[10px] font-bold text-amber-500">Resources</p>
                </div>
                <div className="p-3 bg-rose-50 rounded-xl text-center">
                  <p className="text-lg font-black text-rose-700">{quotaTracker.nearLimit.length}</p>
                  <p className="text-[10px] font-bold text-rose-500">Near Limit</p>
                </div>
              </div>

              {/* Quota Breakdown */}
              <div>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider mb-3">Resource Usage</p>
                <div className="space-y-2.5">
                  {quotaTracker.quotas.map((q, idx) => {
                    const pct = Math.round((q.used / q.limit) * 100);
                    const barColor = pct > 80 ? 'bg-red-500' : pct > 60 ? 'bg-amber-500' : `bg-${q.color}-500`;
                    return (
                      <div key={idx} className="p-3 bg-slate-50 rounded-xl">
                        <div className="flex items-center justify-between mb-1.5">
                          <span className="text-xs font-bold text-slate-700">{q.resource}</span>
                          <span className="text-[10px] font-bold text-slate-500">{q.used} / {q.limit} {q.unit}</span>
                        </div>
                        <div className="w-full bg-slate-200 h-1.5 rounded-full overflow-hidden mb-1.5">
                          <div className={`${barColor} h-full rounded-full transition-all`} style={{ width: `${pct}%` }} />
                        </div>
                        <div className="flex items-center justify-between text-[10px]">
                          <span className="text-slate-400">{pct}% used</span>
                          {pct > 80 && <span className="text-red-500 font-bold">Near limit!</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Quota Usage Chart */}
              <div className="bg-slate-900 rounded-xl p-5">
                <p className="text-[10px] font-black text-amber-400 uppercase tracking-wider mb-4">Usage Overview</p>
                <div className="space-y-3">
                  {quotaTracker.quotas.map((q, idx) => {
                    const pct = Math.round((q.used / q.limit) * 100);
                    return (
                      <div key={idx} className="flex items-center space-x-3">
                        <span className="text-[9px] text-slate-400 w-20 truncate">{q.resource}</span>
                        <div className="flex-1 bg-slate-800 h-3 rounded-full overflow-hidden">
                          <div className={`bg-gradient-to-r ${pct > 80 ? 'from-red-600 to-red-400' : 'from-amber-600 to-amber-400'} h-full rounded-full`} style={{ width: `${pct}%` }} />
                        </div>
                        <span className="text-[10px] font-bold text-white w-8 text-right">{pct}%</span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* AI Insight */}
              <div className="bg-gradient-to-r from-amber-600 to-amber-600 rounded-2xl p-5 text-white">
                <div className="flex items-center space-x-2 mb-3">
                  <SparklesIcon className="w-4 h-4 text-amber-200" />
                  <p className="text-[10px] font-black text-amber-200 uppercase tracking-wider">AI Quota Insight</p>
                </div>
                <p className="text-xs font-bold leading-relaxed">
                  {quotaTracker.nearLimit.length > 0
                    ? `${quotaTracker.nearLimit.length} resource(s) approaching limits: ${quotaTracker.nearLimit.map(q => q.resource).join(', ')}. At current usage rates, you may hit the cap within ${Math.floor(Math.random() * 10) + 5} days. Consider upgrading your plan or optimizing usage patterns.`
                    : `All resources well within limits at ${quotaTracker.overallUsage}% average usage. Your current plan comfortably supports your usage patterns. API calls are your highest-consumed resource — monitor this if you scale integrations.`}
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════ */}
      {/* ─── Keyboard Shortcuts Modal ─── */}
      {/* ═══════════════════════════════════════════════════════════ */}
      {showShortcuts && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={() => setShowShortcuts(false)} />
          <div className="relative bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-2xl mx-4 overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
              <div className="flex items-center space-x-3">
                <div className="w-8 h-8 rounded-lg bg-slate-100 text-slate-600 flex items-center justify-center">
                  <KeyboardIcon className="w-4 h-4" />
                </div>
                <h2 className="text-sm font-black text-slate-900">Account Shortcuts</h2>
              </div>
              <button onClick={() => setShowShortcuts(false)} className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100"><XIcon className="w-4 h-4" /></button>
            </div>
            <div className="p-6 grid grid-cols-3 gap-x-8 gap-y-3 max-h-80 overflow-y-auto">
              {/* Tabs Column */}
              <div className="space-y-3">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider mb-2">Tabs</p>
                {[
                  { key: '1', action: 'Profile' },
                  { key: '2', action: 'Notifications' },
                  { key: '3', action: 'Preferences' },
                  { key: '4', action: 'API Keys' },
                  { key: '5', action: 'Security' },
                ].map((sc, idx) => (
                  <div key={idx} className="flex items-center justify-between">
                    <span className="text-xs text-slate-600">{sc.action}</span>
                    <kbd className="px-2 py-0.5 bg-slate-100 border border-slate-200 rounded text-[10px] font-mono font-bold text-slate-700">{sc.key}</kbd>
                  </div>
                ))}
              </div>
              {/* Panels Column */}
              <div className="space-y-3">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider mb-2">Panels</p>
                {[
                  { key: 'H', action: 'Account Health' },
                  { key: 'A', action: 'Session Activity' },
                  { key: 'E', action: 'Data Export' },
                  { key: 'U', action: 'Usage Analytics' },
                  { key: 'P', action: 'Privacy Audit' },
                  { key: 'Q', action: 'Quota Tracker' },
                ].map((sc, idx) => (
                  <div key={idx} className="flex items-center justify-between">
                    <span className="text-xs text-slate-600">{sc.action}</span>
                    <kbd className="px-2 py-0.5 bg-slate-100 border border-slate-200 rounded text-[10px] font-mono font-bold text-slate-700">{sc.key}</kbd>
                  </div>
                ))}
              </div>
              {/* System Column */}
              <div className="space-y-3">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider mb-2">System</p>
                {[
                  { key: '?', action: 'Shortcuts panel' },
                  { key: 'Esc', action: 'Close panels' },
                ].map((sc, idx) => (
                  <div key={idx} className="flex items-center justify-between">
                    <span className="text-xs text-slate-600">{sc.action}</span>
                    <kbd className="px-2 py-0.5 bg-slate-100 border border-slate-200 rounded text-[10px] font-mono font-bold text-slate-700">{sc.key}</kbd>
                  </div>
                ))}
              </div>
            </div>
            <div className="px-6 py-3 bg-slate-50 border-t border-slate-100 text-center">
              <p className="text-[10px] text-slate-400">Press <kbd className="px-1.5 py-0.5 bg-white border border-slate-200 rounded text-[9px] font-bold">Esc</kbd> to close</p>
            </div>
          </div>
        </div>
      )}
      </AdvancedOnly>
    </div>
  );
};

export default ProfilePage;
