import { ContentType, ContentCategory, ToneType, EmailSequenceConfig, EmailStep, Lead, BusinessProfile, BusinessAnalysisResult, KnowledgeBase } from "../types";
import { supabase } from "./supabase";
import { resolvePrompt } from "./promptResolver";
import { leadDisplayName } from "./queries";
import { getGeminiClient } from "./geminiClient";
import { AI_MODELS } from "./aiConfig";
import { buildMemoryContext, resolveWorkspaceForUser } from "./memory";

// AI Memory injection (Phase 2 — outreach-only scope).
//
// Resolves the user's workspace and pulls workspace + (optionally) lead +
// campaign memory rows. Returns "" on any failure so outreach generation
// never breaks if the memory layer is unavailable.
async function safeMemoryContext(opts: {
  userId?: string;
  leadId?: string;
  campaignKind?: string;
  campaignId?: string;
}): Promise<string> {
  if (!opts.userId) return '';
  try {
    const workspaceId = await resolveWorkspaceForUser(opts.userId);
    if (!workspaceId) return '';
    return await buildMemoryContext({
      workspaceId,
      leadId: opts.leadId,
      campaignKind: opts.campaignKind,
      campaignId: opts.campaignId,
    });
  } catch (err) {
    console.warn('[memory] context build failed; proceeding without memory:', err);
    return '';
  }
}

const buildBusinessContext = (profile?: BusinessProfile): string => {
  if (!profile) return '';
  const parts: string[] = [];
  if (profile.companyName) parts.push(`Company: ${profile.companyName}`);
  if (profile.industry) parts.push(`Industry: ${profile.industry}`);
  if (profile.companyWebsite) parts.push(`Website: ${profile.companyWebsite}`);
  if (profile.productsServices) parts.push(`Products/Services: ${profile.productsServices}`);
  if (profile.valueProp) parts.push(`Value Proposition: ${profile.valueProp}`);
  if (profile.targetAudience) parts.push(`Target Audience: ${profile.targetAudience}`);
  if (profile.pricingModel) parts.push(`Pricing Model: ${profile.pricingModel}`);
  if (profile.salesApproach) parts.push(`Sales Approach: ${profile.salesApproach}`);
  if (profile.businessDescription) parts.push(`Business Description: ${profile.businessDescription}`);
  if (profile.phone) parts.push(`Phone: ${profile.phone}`);
  if (profile.businessEmail) parts.push(`Contact Email: ${profile.businessEmail}`);
  if (profile.address) parts.push(`Address: ${profile.address}`);
  if (profile.socialLinks) {
    const socials = Object.entries(profile.socialLinks).filter(([_, v]) => v).map(([k, v]) => `${k}: ${v}`);
    if (socials.length) parts.push(`Social Media: ${socials.join(', ')}`);
  }
  if (profile.services?.length) {
    parts.push(`Services: ${profile.services.map(s => `${s.name}${s.description ? ' - ' + s.description : ''}`).join('; ')}`);
  }
  if (profile.pricingTiers?.length) {
    parts.push(`Pricing: ${profile.pricingTiers.map(t => `${t.name} ${t.price || ''}${t.features?.length ? ' (' + t.features.slice(0, 3).join(', ') + ')' : ''}`).join('; ')}`);
  }
  if (profile.competitiveAdvantage) parts.push(`Competitive Advantage: ${profile.competitiveAdvantage}`);
  if (profile.contentTone) parts.push(`Brand Tone: ${profile.contentTone}`);
  if (profile.uniqueSellingPoints?.length) parts.push(`USPs: ${profile.uniqueSellingPoints.join(', ')}`);
  if (parts.length === 0) return '';
  return `\n\nYOUR BUSINESS CONTEXT:\n${parts.join('\n')}`;
};

export const buildEmailFooter = (profile?: BusinessProfile): string => {
  if (!profile) return '';

  const hasContent = profile.companyName || profile.address || profile.phone ||
    profile.businessEmail || profile.companyWebsite || profile.socialLinks;
  if (!hasContent) return '';

  let html = '<div style="margin-top:40px;padding-top:24px;border-top:2px solid #e2e8f0;font-family:Arial,Helvetica,sans-serif">';

  // Company name
  if (profile.companyName) {
    html += `<p style="margin:0 0 4px;font-size:14px;font-weight:700;color:#1e293b">${profile.companyName}</p>`;
  }

  // Industry tagline
  if (profile.industry) {
    html += `<p style="margin:0 0 12px;font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:1px">${profile.industry}</p>`;
  }

  // Contact row: phone, email, website
  const contactParts: string[] = [];
  if (profile.phone) {
    contactParts.push(`<a href="tel:${profile.phone.replace(/\s/g, '')}" style="color:#6366f1;text-decoration:none">${profile.phone}</a>`);
  }
  if (profile.businessEmail) {
    contactParts.push(`<a href="mailto:${profile.businessEmail}" style="color:#6366f1;text-decoration:none">${profile.businessEmail}</a>`);
  }
  if (profile.companyWebsite) {
    const displayUrl = profile.companyWebsite.replace(/^https?:\/\//, '');
    contactParts.push(`<a href="${profile.companyWebsite}" style="color:#6366f1;text-decoration:none">${displayUrl}</a>`);
  }
  if (contactParts.length) {
    html += `<p style="margin:0 0 8px;font-size:12px;color:#64748b;line-height:1.8">${contactParts.join(' &nbsp;&middot;&nbsp; ')}</p>`;
  }

  // Address
  if (profile.address) {
    html += `<p style="margin:0 0 12px;font-size:12px;color:#64748b;line-height:1.6">${profile.address}</p>`;
  }

  // Social links
  if (profile.socialLinks) {
    const socials = Object.entries(profile.socialLinks)
      .filter(([_, v]) => v)
      .map(([k, v]) => `<a href="${v}" style="color:#6366f1;text-decoration:none;font-weight:600">${k.charAt(0).toUpperCase() + k.slice(1)}</a>`);
    if (socials.length) {
      html += `<p style="margin:0 0 8px;font-size:12px">${socials.join(' &nbsp;&middot;&nbsp; ')}</p>`;
    }
  }

  // Unsubscribe / legal line
  html += '<p style="margin:16px 0 0;font-size:10px;color:#94a3b8;line-height:1.5">';
  html += 'You received this email because of your business relationship with us. ';
  html += '<a href="#" style="color:#94a3b8;text-decoration:underline">Unsubscribe</a>';
  html += '</p>';

  html += '</div>';
  return html;
};

const MAX_RETRIES = 3;
const TIMEOUT_MS = 15000;
const MODEL_NAME = AI_MODELS.text;

export interface AIResponse {
  text: string;
  tokens_used: number;
  model_name: string;
  prompt_name: string;
  prompt_version: number;
}

export interface StreamOptions {
  stream: true;
  onChunk: (accumulatedText: string) => void;
}

export const generateLeadContent = async (lead: Lead, type: ContentType, businessProfile?: BusinessProfile, userId?: string): Promise<AIResponse> => {
  const ai = getGeminiClient();

  const resolved = await resolvePrompt('sales_outreach', userId, {
    systemInstruction: `You are a world-class B2B sales development representative specializing in hyper-personalized outreach.
Your goal is to generate high-conversion ${type} content that feels human, researched, and valuable.
Avoid generic corporate jargon. Focus on the prospect's pain points and industry context.`,
    promptTemplate: `TARGET PROSPECT DATA:
    Name: {{lead_name}}
    Title/Role: Lead
    Company: {{company}}
    Intelligence Score: {{score}}/100
    AI-Detected Insights: {{insights}}

    CONTENT TYPE: {{type}}

    REQUIREMENTS:
    1. Reference the company name naturally.
    2. Leverage the intelligence insight to show deep research.
    3. Include a soft but clear Call to Action (CTA).
    4. Maintain a {{tone}} tone.
    5. Do not exceed 150 words.`,
    temperature: 0.8,
    topP: 0.9,
  });

  const pName = resolved.isCustom ? 'sales_outreach_custom' : 'sales_outreach';
  const pVersion = resolved.promptVersion;

  const systemInstruction = resolved.systemInstruction;

  const finalPrompt = resolved.promptTemplate
    .replace('{{lead_name}}', leadDisplayName(lead))
    .replace('{{company}}', lead.company)
    .replace('{{score}}', lead.score.toString())
    .replace('{{insights}}', lead.insights)
    .replace('{{type}}', type)
    .replace('{{tone}}', lead.score > 80 ? 'high-priority and urgent' : 'helpful and consultative');

  // AI memory: pull workspace prefs + this lead's prior interactions.
  const memoryCtx = await safeMemoryContext({ userId, leadId: lead.id });

  let attempt = 0;
  while (attempt < MAX_RETRIES) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const response = await ai.models.generateContent({
        model: MODEL_NAME,
        contents: finalPrompt,
        config: {
          systemInstruction: systemInstruction + buildBusinessContext(businessProfile) + memoryCtx,
          temperature: resolved.temperature,
          topP: resolved.topP,
          topK: 40,
        }
      });

      clearTimeout(timeoutId);

      const text = response.text;
      if (!text) throw new Error("Empty response from intelligence engine.");
      
      return {
        text,
        tokens_used: response.usageMetadata?.totalTokenCount || 0,
        model_name: MODEL_NAME,
        prompt_name: pName,
        prompt_version: pVersion
      };
    } catch (error: unknown) {
      attempt++;
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      console.warn(`Gemini Attempt ${attempt} failed:`, errMsg);
      if (attempt === MAX_RETRIES) {
        return {
          text: `NEURAL TIMEOUT: The intelligence engine is currently overloaded. Please try again in 30 seconds. (Error: ${errMsg})`,
          tokens_used: 0,
          model_name: MODEL_NAME,
          prompt_name: pName,
          prompt_version: pVersion
        };
      }
      // Wait before retry
      await new Promise(res => setTimeout(res, 1000 * attempt));
    }
  }

  return {
    text: "CRITICAL FAILURE: Neural links disconnected.",
    tokens_used: 0,
    model_name: MODEL_NAME,
    prompt_name: pName,
    prompt_version: pVersion
  };
};

export const generateDashboardInsights = async (leads: Lead[], businessProfile?: BusinessProfile, userId?: string): Promise<string> => {
  const ai = getGeminiClient();

  const leadSummary = leads.slice(0, 20).map(l =>
    `${l.name} (${l.company}) - Score: ${l.score}, Status: ${l.status}`
  ).join('\n');

  const statusBreakdown: Record<string, number> = {};
  leads.forEach(l => { statusBreakdown[l.status] = (statusBreakdown[l.status] || 0) + 1; });

  const avgScore = leads.length > 0
    ? Math.round(leads.reduce((a, b) => a + b.score, 0) / leads.length)
    : 0;

  const resolved = await resolvePrompt('dashboard_insights', userId, {
    systemInstruction: 'You are a senior B2B sales analytics AI. Provide actionable, data-driven insights. Be concise and specific.',
    promptTemplate: `You are an AI sales strategist analyzing a B2B lead pipeline. Provide 3-5 actionable insights based on this data.

PIPELINE SUMMARY:
- Total Leads: {{total_leads}}
- Average Score: {{avg_score}}/100
- Status Breakdown: {{status_breakdown}}
- Hot Leads (score > 80): {{hot_leads}}

TOP LEADS:
{{lead_summary}}

Provide concise, data-driven recommendations. Focus on:
1. Which leads to prioritize and why
2. Pipeline health assessment
3. Suggested next actions
4. Timing recommendations

Keep response under 300 words. Be specific, not generic.`,
    temperature: 0.7,
    topP: 0.9,
  });

  const prompt = resolved.promptTemplate
    .replace('{{total_leads}}', leads.length.toString())
    .replace('{{avg_score}}', avgScore.toString())
    .replace('{{status_breakdown}}', Object.entries(statusBreakdown).map(([k, v]) => `${k}: ${v}`).join(', '))
    .replace('{{hot_leads}}', leads.filter(l => l.score > 80).length.toString())
    .replace('{{lead_summary}}', leadSummary);

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const response = await ai.models.generateContent({
      model: MODEL_NAME,
      contents: prompt,
      config: {
        systemInstruction: resolved.systemInstruction + buildBusinessContext(businessProfile),
        temperature: resolved.temperature,
        topP: resolved.topP,
      }
    });

    clearTimeout(timeoutId);
    return response.text || 'No insights generated.';
  } catch (error: unknown) {
    throw new Error(`Gemini analysis failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
};

// === Content Generation Module v2 ===

const CADENCE_DAYS: Record<string, number> = {
  daily: 1,
  every_2_days: 2,
  every_3_days: 3,
  weekly: 7
};

const GOAL_LABELS: Record<string, string> = {
  book_meeting: 'Book a Meeting',
  product_demo: 'Schedule a Product Demo',
  nurture: 'Nurture & Build Relationship',
  re_engage: 'Re-engage Cold Leads',
  upsell: 'Upsell Existing Customers'
};

export const generateEmailSequence = async (
  leads: Lead[],
  config: EmailSequenceConfig,
  businessProfile?: BusinessProfile,
  userId?: string,
  streamOpts?: StreamOptions
): Promise<AIResponse> => {
  const ai = getGeminiClient();

  const leadContext = leads.slice(0, 5).map(l => {
    let ctx = `- ${l.name} at ${l.company} (Score: ${l.score}, Status: ${l.status}, Insights: ${l.insights})`;
    if (l.knowledgeBase) {
      const kb = l.knowledgeBase;
      const parts: string[] = [];
      if (kb.website) parts.push(`Website: ${kb.website}`);
      if (kb.linkedin) parts.push(`LinkedIn: ${kb.linkedin}`);
      if (kb.extraNotes) parts.push(`Notes: ${kb.extraNotes}`);
      if (parts.length > 0) ctx += `\n  Knowledge: ${parts.join(', ')}`;
    }
    return ctx;
  }).join('\n');

  const cadenceDays = CADENCE_DAYS[config.cadence] || 2;
  const goalLabel = GOAL_LABELS[config.goal] || config.goal;

  const resolved = await resolvePrompt('email_sequence', userId, {
    systemInstruction: `You are an expert email sequence copywriter for B2B sales. Generate high-converting email sequences that feel human and personalized. Tone: ${config.tone}.`,
    promptTemplate: `Generate a {{sequence_length}}-email outreach sequence for B2B sales.

TARGET AUDIENCE (sample leads):
{{lead_context}}

SEQUENCE CONFIG:
- Goal: {{goal_label}}
- Number of Emails: {{sequence_length}}
- Cadence: Every {{cadence_days}} day(s)
- Tone: {{tone}}
- Total leads in audience: {{audience_count}}

REQUIREMENTS:
1. Each email must have a clear subject line and body.
2. Use ONLY these personalization placeholders: {{first_name}}, {{company}}, {{ai_insight}}, {{your_name}}.
3. Each email should build on the previous, escalating urgency naturally.
4. Email 1: Introduction & value proposition
5. Final email: Break-up email with last chance CTA
6. Keep each email under 200 words.
7. Match the {{tone}} tone consistently.
8. Use the lead's Knowledge Base data to tailor messaging.

FORMAT YOUR RESPONSE EXACTLY LIKE THIS (repeat for each email):
===EMAIL_START===
STEP: [number]
DELAY: Day [number]
SUBJECT: [subject line]
BODY:
[email body]
===EMAIL_END===`,
    temperature: 0.85,
    topP: 0.9,
  });

  const prompt = resolved.promptTemplate
    .replace(/\{\{sequence_length\}\}/g, config.sequenceLength.toString())
    .replace('{{lead_context}}', leadContext)
    .replace('{{goal_label}}', goalLabel)
    .replace('{{cadence_days}}', cadenceDays.toString())
    .replace(/\{\{tone\}\}/g, config.tone)
    .replace('{{audience_count}}', config.audienceLeadIds.length.toString());

  // AI memory: workspace prefs + outcomes from past email_sequence campaigns.
  // We don't filter to a specific campaignId because this is generation time —
  // the new sequence doesn't have an id yet.
  const memoryCtx = await safeMemoryContext({
    userId,
    campaignKind: 'email_sequence',
  });

  const genConfig = {
    systemInstruction: resolved.systemInstruction + buildBusinessContext(businessProfile) + memoryCtx,
    temperature: resolved.temperature,
    topP: resolved.topP,
    topK: 40,
  };

  let attempt = 0;
  while (attempt < MAX_RETRIES) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

      let text: string;
      let tokensUsed = 0;

      if (streamOpts?.stream) {
        const stream = await ai.models.generateContentStream({
          model: MODEL_NAME,
          contents: prompt,
          config: genConfig,
        });
        text = '';
        for await (const chunk of stream) {
          text += chunk.text || '';
          streamOpts.onChunk(text);
        }
        // Token count not available in stream mode
      } else {
        const response = await ai.models.generateContent({
          model: MODEL_NAME,
          contents: prompt,
          config: genConfig,
        });
        text = response.text || '';
        tokensUsed = response.usageMetadata?.totalTokenCount || 0;
      }

      clearTimeout(timeoutId);
      if (!text) throw new Error("Empty sequence response.");

      return {
        text,
        tokens_used: tokensUsed,
        model_name: MODEL_NAME,
        prompt_name: 'email_sequence',
        prompt_version: resolved.promptVersion
      };
    } catch (error: unknown) {
      attempt++;
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      if (attempt === MAX_RETRIES) {
        return {
          text: `SEQUENCE GENERATION FAILED: ${errMsg}`,
          tokens_used: 0,
          model_name: MODEL_NAME,
          prompt_name: 'email_sequence',
          prompt_version: resolved.promptVersion
        };
      }
      await new Promise(res => setTimeout(res, 1000 * attempt));
    }
  }

  return { text: "CRITICAL FAILURE", tokens_used: 0, model_name: MODEL_NAME, prompt_name: 'email_sequence', prompt_version: resolved.promptVersion };
};

export const generateContentByCategory = async (
  lead: Lead,
  category: ContentCategory,
  tone: ToneType,
  additionalContext?: string,
  businessProfile?: BusinessProfile,
  userId?: string
): Promise<AIResponse> => {
  const ai = getGeminiClient();

  // Map ContentCategory to prompt keys
  const categoryKeyMap: Record<ContentCategory, string> = {
    [ContentCategory.EMAIL_SEQUENCE]: 'content_email',
    [ContentCategory.LANDING_PAGE]: 'content_landing_page',
    [ContentCategory.SOCIAL_MEDIA]: 'content_social',
    [ContentCategory.BLOG_ARTICLE]: 'content_blog',
    [ContentCategory.REPORT]: 'content_report',
    [ContentCategory.PROPOSAL]: 'content_proposal',
    [ContentCategory.AD_COPY]: 'content_ad',
  };

  const hardcodedPrompts: Record<ContentCategory, { system: string; prompt: string }> = {
    [ContentCategory.EMAIL_SEQUENCE]: {
      system: 'You are an expert email copywriter.',
      prompt: `Write a compelling cold email for {{lead_name}} at {{company}}. Score: {{score}}. Insights: {{insights}}. Tone: {{tone}}. Use ONLY these placeholders: {{first_name}}, {{company}}, {{your_name}}. Write all other details as actual specific content. Under 200 words.`
    },
    [ContentCategory.LANDING_PAGE]: {
      system: 'You are a conversion-focused landing page copywriter.',
      prompt: `Create landing page copy targeting {{company}} in their industry. Include:\n- Hero headline & subheadline (use {{company}} tag)\n- 3 benefit bullets\n- Social proof section placeholder\n- CTA section\nUse ONLY {{company}} and {{first_name}} as placeholders. Tone: {{tone}}. Lead insights: {{insights}}.`
    },
    [ContentCategory.SOCIAL_MEDIA]: {
      system: 'You are a B2B social media strategist.',
      prompt: `Generate 3 LinkedIn posts targeting professionals like {{lead_name}} at {{company}}.\nEach post should:\n- Hook in first line\n- Provide value\n- End with engagement question or CTA\nUse ONLY {{first_name}} and {{company}} as placeholders. Tone: {{tone}}. Industry insights: {{insights}}.`
    },
    [ContentCategory.BLOG_ARTICLE]: {
      system: 'You are a B2B content marketing expert.',
      prompt: `Write a blog article outline + intro targeting companies like {{company}}.\n- Title (SEO-optimized)\n- 5-section outline with key points\n- Full intro paragraph (150 words)\n- Meta description\nDo NOT use any placeholders. Write all content with specific details. Tone: {{tone}}. Industry context: {{insights}}.`
    },
    [ContentCategory.REPORT]: {
      system: 'You are a B2B research analyst and report writer.',
      prompt: `Create a whitepaper/report outline for {{company}}'s industry:\n- Executive Summary\n- 4-5 key sections with bullet points\n- Data points to include\n- Conclusion with CTA\nDo NOT use any placeholders. Tone: {{tone}}. Context: {{insights}}.`
    },
    [ContentCategory.PROPOSAL]: {
      system: 'You are a senior sales proposal writer.',
      prompt: `Draft a business proposal for {{lead_name}} at {{company}}:\n- Opening (reference their company and challenges)\n- Problem Statement\n- Proposed Solution (3 key deliverables)\n- Timeline\n- Pricing placeholder\n- Next Steps / CTA\nUse ONLY {{first_name}}, {{company}}, {{your_name}} as placeholders. Tone: {{tone}}. Lead score: {{score}}. Insights: {{insights}}.`
    },
    [ContentCategory.AD_COPY]: {
      system: 'You are a performance marketing copywriter specializing in high-converting B2B ad copy.',
      prompt: `Create compelling ad copy targeting {{company}}'s industry:\n- Google Search Ad: 3 headlines (max 30 chars each) + 2 descriptions (max 90 chars each)\n- LinkedIn Sponsored Ad: Headline + body (max 150 words) + CTA\n- A/B variant with a different angle\nTone: {{tone}}. Lead insights: {{insights}}.`
    }
  };

  const promptKey = categoryKeyMap[category];
  const fallbackConfig = hardcodedPrompts[category];

  const resolved = await resolvePrompt(promptKey, userId, {
    systemInstruction: fallbackConfig.system,
    promptTemplate: fallbackConfig.prompt,
    temperature: 0.8,
    topP: 0.9,
  });

  const finalCategoryPrompt = resolved.promptTemplate
    .replace(/\{\{lead_name\}\}/g, leadDisplayName(lead))
    .replace(/\{\{company\}\}/g, lead.company || '')
    .replace(/\{\{score\}\}/g, lead.score.toString())
    .replace(/\{\{insights\}\}/g, lead.insights || '')
    .replace(/\{\{tone\}\}/g, tone)
    .replace(/\{\{first_name\}\}/g, lead.first_name || '')
    + (additionalContext ? ` ${additionalContext}` : '');

  let attempt = 0;
  while (attempt < MAX_RETRIES) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 20000);

      const response = await ai.models.generateContent({
        model: MODEL_NAME,
        contents: finalCategoryPrompt,
        config: {
          systemInstruction: resolved.systemInstruction + buildBusinessContext(businessProfile),
          temperature: resolved.temperature,
          topP: resolved.topP,
          topK: 40,
        }
      });

      clearTimeout(timeoutId);
      const text = response.text;
      if (!text) throw new Error("Empty content response.");

      return {
        text,
        tokens_used: response.usageMetadata?.totalTokenCount || 0,
        model_name: MODEL_NAME,
        prompt_name: promptKey,
        prompt_version: resolved.promptVersion
      };
    } catch (error: unknown) {
      attempt++;
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      if (attempt === MAX_RETRIES) {
        return {
          text: `GENERATION FAILED: ${errMsg}`,
          tokens_used: 0,
          model_name: MODEL_NAME,
          prompt_name: promptKey,
          prompt_version: resolved.promptVersion
        };
      }
      await new Promise(res => setTimeout(res, 1000 * attempt));
    }
  }

  return { text: "CRITICAL FAILURE", tokens_used: 0, model_name: MODEL_NAME, prompt_name: promptKey, prompt_version: resolved.promptVersion };
};

export const generateLeadResearch = async (
  lead: Pick<Lead, 'first_name' | 'last_name' | 'primary_email' | 'company' | 'insights'>,
  socialUrls: Record<string, string>,
  businessProfile?: BusinessProfile,
  userId?: string
): Promise<AIResponse> => {
  const ai = getGeminiClient();

  const urlContext = Object.entries(socialUrls)
    .filter(([_, v]) => v)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join('\n');

  const emailDomain = lead.primary_email?.includes('@') ? lead.primary_email.split('@')[1] : '';

  // Determine the best website URL to crawl
  const websiteUrl = socialUrls.website || (emailDomain ? `https://${emailDomain}` : lead.company ? `https://${lead.company.toLowerCase().replace(/\s+/g, '')}.com` : '');

  const resolved = await resolvePrompt('lead_research', userId, {
    systemInstruction: `You are an advanced Web Intelligence Agent acting as a Senior Data Extraction Engineer and Business Analyst.

Your task is to crawl and analyze a business website and generate a structured Business Profile knowledge base that can auto-populate a SaaS business profile form.

You must extract only verified information directly from the website's public pages.

Do NOT guess.
Do NOT infer beyond explicit content.
If a field cannot be verified, return null and include a reason.`,
    promptTemplate: `Given a website URL, crawl relevant public pages, identify business identity and positioning, extract structured business information, normalize and format data into a clean JSON schema, and include confidence scores and citations for each extracted field.

INPUT:
- Root website URL: {{website_url}}
- Lead Name: {{lead_name}}
- Company: {{company}}
{{email_domain}}
{{insights}}

SOCIAL / WEB PRESENCE:
{{url_context}}

CRAWLING STRATEGY:
Start at homepage. Extract internal links from header navigation, footer navigation, sitemap.xml (if available), robots.txt (for sitemap reference), and primary anchor links.

Prioritize crawling pages with URLs or anchor text containing: about, company, team, services, solutions, products, platform, features, pricing, plans, contact, locations, faq, support, terms, privacy.

Stay within the same domain (and relevant subdomains like app.domain.com). Stop crawling early once all required sections are found. Crawl depth limit: 50 relevant internal pages maximum.

PAGE CLASSIFICATION:
Classify each crawled page as: Home, About, Services, Products, Pricing, Contact, FAQ, Legal, Blog, or Other. Prefer official company pages over blog posts.

EXTRACTION RULES:
- Business Name: Extract from logo alt text, header branding, footer copyright, legal pages. Must match official branding.
- Industry: Determine only from explicit statements like "We are a digital marketing agency", "We build accounting software". If ambiguous, return null with low confidence.
- Services: Extract service names as separate structured items. Summaries must be concise (max 2 sentences).
- Products: Extract actual product names. If SaaS, identify platform type, key features, and integrations.
- Pricing: Only extract if clearly visible. If pricing requires login or contact form, set pricing_model to "quote-based" and has_pricing_page to false. Do not estimate prices.
- Contact: Extract only publicly listed email addresses, phone numbers, and contact form URLs.
- Address: Extract structured address fields if clearly stated. If multiple offices exist, include all.

CONFIDENCE SCORING:
- 1.0 = explicitly stated and confirmed across pages
- 0.7 = clearly implied but not repeated
- 0.4 = partial evidence
- 0.0 = not found

DO NOT: Hallucinate pricing, guess founding year, assume industry from domain name, extract from unrelated blog guest posts, include third-party reviews unless hosted on main domain.

Return ONE structured JSON object in this exact schema (no commentary outside the JSON):

{
  "identity": {
    "business_name": "",
    "tagline": "",
    "short_description": "",
    "long_description": "",
    "founded_year": null,
    "company_type": "",
    "logo_url": "",
    "primary_domain": ""
  },
  "industry": {
    "primary_industry": "",
    "secondary_industries": [],
    "industry_keywords": [],
    "confidence_score": 0.0,
    "evidence": []
  },
  "offerings": {
    "services": [
      {
        "name": "",
        "summary": "",
        "categories": [],
        "target_customers": [],
        "evidence": []
      }
    ],
    "products": [
      {
        "name": "",
        "type": "",
        "summary": "",
        "features": [],
        "use_cases": [],
        "integrations": [],
        "evidence": []
      }
    ]
  },
  "pricing": {
    "has_pricing_page": false,
    "pricing_url": "",
    "pricing_model": "",
    "plans": [
      {
        "plan_name": "",
        "price": "",
        "billing_period": "",
        "included_features": [],
        "limits": [],
        "evidence": []
      }
    ],
    "confidence_score": 0.0
  },
  "contact": {
    "primary_email": "",
    "primary_phone": "",
    "contact_form_url": "",
    "support_email": "",
    "sales_email": "",
    "evidence": []
  },
  "locations": {
    "headquarters": {
      "street": "",
      "city": "",
      "state_region": "",
      "postal_code": "",
      "country": ""
    },
    "other_locations": [],
    "evidence": []
  },
  "social_links": {
    "linkedin": "",
    "facebook": "",
    "instagram": "",
    "twitter": "",
    "youtube": ""
  },
  "lead_context": {
    "mentioned_on_website": "",
    "title": "",
    "talking_points": [],
    "outreach_angle": "",
    "risk_factors": []
  },
  "meta": {
    "crawl_pages_count": 0,
    "last_updated_detected": "",
    "confidence_overall": 0.0
  }
}`,
    temperature: 0.3,
    topP: 0.9,
  });

  const prompt = resolved.promptTemplate
    .replace('{{website_url}}', websiteUrl)
    .replace('{{lead_name}}', leadDisplayName(lead))
    .replace('{{company}}', lead.company)
    .replace('{{email_domain}}', emailDomain ? `- Email Domain: ${emailDomain}` : '')
    .replace('{{insights}}', lead.insights ? `- Existing Insights: ${lead.insights}` : '')
    .replace('{{url_context}}', urlContext || 'None provided');

  // AI memory: workspace prefs only — research runs before the lead is saved,
  // so there is no leadId yet, and research isn't a campaign.
  const memoryCtx = await safeMemoryContext({ userId });

  const systemInstruction = resolved.systemInstruction + buildBusinessContext(businessProfile) + memoryCtx;

  let attempt = 0;
  while (attempt < MAX_RETRIES) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

      let response;
      try {
        // Try with Google Search grounding first
        response = await ai.models.generateContent({
          model: MODEL_NAME,
          contents: prompt,
          config: {
            systemInstruction,
            temperature: resolved.temperature,
            topP: resolved.topP,
            tools: [{ googleSearch: {} }],
          }
        });
      } catch (groundingError: unknown) {
        console.warn('Google Search grounding failed for lead research, falling back:', groundingError instanceof Error ? groundingError.message : 'Unknown error');
        response = null;
      }

      // If grounding returned empty (no candidates/text), fall back to inference-only
      if (!response?.text) {
        console.warn('Google Search grounding returned empty response for lead research, falling back to inference-only.');
        response = await ai.models.generateContent({
          model: MODEL_NAME,
          contents: prompt,
          config: {
            systemInstruction,
            temperature: resolved.temperature,
            topP: resolved.topP,
          }
        });
      }

      clearTimeout(timeoutId);
      const text = response.text;
      if (!text) throw new Error("Empty research response.");

      return {
        text,
        tokens_used: response.usageMetadata?.totalTokenCount || 0,
        model_name: MODEL_NAME,
        prompt_name: 'lead_research',
        prompt_version: resolved.promptVersion
      };
    } catch (error: unknown) {
      attempt++;
      console.warn(`Lead research attempt ${attempt} failed:`, error instanceof Error ? error.message : 'Unknown error');
      if (attempt === MAX_RETRIES) {
        return {
          text: '',
          tokens_used: 0,
          model_name: MODEL_NAME,
          prompt_name: 'lead_research',
          prompt_version: 2
        };
      }
      await new Promise(res => setTimeout(res, 1000 * attempt));
    }
  }

  return { text: '', tokens_used: 0, model_name: MODEL_NAME, prompt_name: 'lead_research', prompt_version: 2 };
};

/**
 * Parse the JSON research response into structured KnowledgeBase fields.
 * Maps the new web intelligence JSON schema to the existing KnowledgeBase interface.
 */
export const parseLeadResearchResponse = (text: string): Partial<KnowledgeBase> => {
  const result: Partial<KnowledgeBase> = {};

  // Try to parse JSON from the response
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    const stripped = text.replace(/```(?:json)?\s*/g, '').replace(/```/g, '').trim();
    try {
      data = JSON.parse(stripped);
    } catch {
      const match = stripped.match(/\{[\s\S]*\}/);
      if (match) {
        try { data = JSON.parse(match[0]); } catch { /* fall through */ }
      }
    }
  }

  if (data) {
    // Map identity fields
    if (data.identity) {
      if (data.identity.company_type) result.title = data.identity.company_type;
      if (data.identity.long_description || data.identity.short_description) {
        result.companyOverview = data.identity.long_description || data.identity.short_description;
      }
    }

    // Map industry
    if (data.industry?.primary_industry) {
      result.industry = data.industry.primary_industry;
    }

    // Map location from headquarters
    if (data.locations?.headquarters) {
      const hq = data.locations.headquarters;
      const parts = [hq.city, hq.state_region, hq.country].filter(Boolean);
      if (parts.length > 0) result.location = parts.join(', ');
    }

    // Map lead context
    if (data.lead_context) {
      if (data.lead_context.title) result.title = data.lead_context.title;
      if (data.lead_context.talking_points?.length) result.talkingPoints = data.lead_context.talking_points;
      if (data.lead_context.outreach_angle) result.outreachAngle = data.lead_context.outreach_angle;
      if (data.lead_context.risk_factors?.length) result.riskFactors = data.lead_context.risk_factors;
      if (data.lead_context.mentioned_on_website && data.lead_context.mentioned_on_website.toLowerCase() !== 'not found') {
        result.mentionedOnWebsite = data.lead_context.mentioned_on_website;
      }
    }

    // Build a comprehensive research brief from extracted data
    const briefParts: string[] = [];
    if (data.identity?.business_name) briefParts.push(`${data.identity.business_name}${data.identity.tagline ? ' — ' + data.identity.tagline : ''}`);
    if (data.identity?.long_description) briefParts.push(data.identity.long_description);
    if (data.industry?.primary_industry) briefParts.push(`Industry: ${data.industry.primary_industry}${data.industry.secondary_industries?.length ? ' (' + data.industry.secondary_industries.join(', ') + ')' : ''}`);
    if (data.offerings?.services?.length) briefParts.push(`Services: ${data.offerings.services.map((s: any) => s.name).join(', ')}`);
    if (data.offerings?.products?.length) briefParts.push(`Products: ${data.offerings.products.map((p: any) => p.name).join(', ')}`);
    if (data.pricing?.pricing_model) briefParts.push(`Pricing: ${data.pricing.pricing_model}${data.pricing.plans?.length ? ' — ' + data.pricing.plans.map((p: any) => `${p.plan_name}: ${p.price}`).join(', ') : ''}`);
    if (data.contact?.primary_email) briefParts.push(`Contact: ${data.contact.primary_email}`);
    if (data.meta?.confidence_overall != null) briefParts.push(`Overall confidence: ${(data.meta.confidence_overall * 100).toFixed(0)}%`);
    if (briefParts.length > 0) result.aiResearchBrief = briefParts.join('\n\n');

    // Map employee count from meta if available
    if (data.meta?.crawl_pages_count) {
      result.employeeCount = result.employeeCount || undefined;
    }
  }

  result.aiResearchedAt = new Date().toISOString();

  return result;
};

// === Business Profile AI Analysis ===

const parseAnalysisJSON = (text: string): BusinessAnalysisResult | null => {
  try {
    // Try direct parse first
    return JSON.parse(text);
  } catch {
    // Strip markdown code fences
    const stripped = text.replace(/```(?:json)?\s*/g, '').replace(/```/g, '').trim();
    try {
      return JSON.parse(stripped);
    } catch {
      // Regex extract first JSON object
      const match = stripped.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          return JSON.parse(match[0]);
        } catch {
          return null;
        }
      }
      return null;
    }
  }
};

export const analyzeBusinessFromWeb = async (
  websiteUrl: string,
  socialUrls?: { linkedin?: string; twitter?: string; instagram?: string; facebook?: string },
  userId?: string
): Promise<AIResponse & { analysis: BusinessAnalysisResult | null }> => {
  const ai = getGeminiClient();

  const socialContext = socialUrls
    ? Object.entries(socialUrls)
        .filter(([_, v]) => v)
        .map(([k, v]) => `- ${k}: ${v}`)
        .join('\n')
    : '';

  const resolved = await resolvePrompt('business_analysis', userId, {
    systemInstruction: `You are an advanced Web Intelligence Agent.

Your task is to crawl and analyze a public business website and extract accurate business information to help auto-populate a structured business profile.

You must extract only explicitly verifiable information from the website.

Do not guess.
Do not infer unstated facts.
If information cannot be confirmed, state that it was not found.

Always respond with valid JSON only.`,
    promptTemplate: `INPUT

Website URL: {{website_url}}
{{social_context}}

Maximum crawl depth: 40 internal pages
Language: English (unless otherwise detected)

CRAWLING INSTRUCTIONS

Start from the homepage.

Extract internal links from:
- Header navigation
- Footer navigation
- Sitemap.xml (if available)
- Primary internal anchor links

Prioritize crawling pages containing:
about, company, team, services, solutions, products, platform, features, pricing, plans, contact, locations, faq, terms, privacy

Remain within the same root domain.

Ignore:
- Login-only content
- Blog posts unrelated to core business identity
- Third-party embedded content

Stop crawling once all required business information is found.

INFORMATION TO EXTRACT

Extract and clearly label the following:

1. Business Identity
- Official business name
- Tagline (if explicitly shown)
- Short description (1-2 sentences from homepage or About)
- Detailed description (3-6 sentences summarizing company positioning)
- Company type (e.g., SaaS, marketing agency, ecommerce store, healthcare provider)
- Primary domain
Only use statements clearly written on the website.

2. Industry Classification
Determine the primary industry ONLY if explicitly stated.
Valid examples: "We are a digital marketing agency", "We build accounting software", "We are a private medical clinic"
If unclear or implied only, state "Industry not explicitly stated."

3. Services
List each service separately. For each service:
- Service name
- Brief explanation
- Target audience (if stated)
Do not combine multiple services into one paragraph.

4. Products
If the company sells products or offers a software platform, for each product:
- Product name
- Product type (software, subscription, physical product, etc.)
- Summary
- Key features (if listed)
- Integrations (if listed)
If no distinct product exists, clearly state that.

5. Pricing
Determine:
- Whether a pricing page exists
- Pricing model (subscription, per-project, hourly, quote-based)
- Plan names (if available)
- Public price amounts (if visible)
If pricing requires contacting sales, state: "Pricing is quote-based."
Never estimate prices.

6. Contact Information
Extract:
- Public email addresses
- Phone numbers
- Contact form URL
- Support email (if separate)
- Sales email (if separate)
Only extract visible contact details.

7. Address / Location
If listed, extract: Full address, City, Region/state, Postal code, Country
If multiple offices exist, list all.
Do not infer from domain country.

8. Social Media
Extract official links from header/footer:
LinkedIn, Facebook, Instagram, Twitter/X, YouTube

VALIDATION RULES
- Prefer About and Contact pages over blog posts.
- If conflicting information appears, prefer the most detailed and most recent page.
- If information appears multiple times consistently, treat it as confirmed.
- If uncertain, state that it cannot be verified.

BEHAVIORAL CONSTRAINTS
- Do not hallucinate missing data.
- Do not assume industry from domain name.
- Do not generate marketing copy.
- Do not summarize beyond what is written.
- Be factual and concise.

OUTPUT FORMAT

Return a JSON object using this exact structure.

For string fields, use { "value": "...", "confidence": 0-100 }.
For array fields (services, pricingTiers, uniqueSellingPoints), use { "value": [...], "confidence": 0-100 }.

Confidence rules:
- 80-100: Information explicitly found and confirmed on the website
- 50-79: Information found but only in one place or partially stated
- 1-49: Information could not be confirmed — set value to "" for string fields
- 0: Information not found at all — set value to ""

{
  "companyName": { "value": "...", "confidence": 0-100 },
  "industry": { "value": "...", "confidence": 0-100 },
  "productsServices": { "value": "summary of all products/services found", "confidence": 0-100 },
  "targetAudience": { "value": "...", "confidence": 0-100 },
  "valueProp": { "value": "short description or tagline", "confidence": 0-100 },
  "pricingModel": { "value": "e.g. Starter $X/mo, Pro $Y/mo or Pricing is quote-based", "confidence": 0-100 },
  "salesApproach": { "value": "company type or business model", "confidence": 0-100 },
  "phone": { "value": "...", "confidence": 0-100 },
  "businessEmail": { "value": "...", "confidence": 0-100 },
  "address": { "value": "full address if found", "confidence": 0-100 },
  "socialLinks": { "linkedin": "...", "twitter": "...", "instagram": "...", "facebook": "...", "youtube": "..." },
  "followUpQuestions": ["..."],
  "services": { "value": [{ "id": "svc-1", "name": "Service Name", "description": "What this service does" }], "confidence": 0-100 },
  "pricingTiers": { "value": [{ "id": "tier-1", "name": "Plan Name", "price": "$29/mo", "description": "Plan summary", "features": ["feature1", "feature2"] }], "confidence": 0-100 },
  "companyStory": { "value": "Company founding story and mission from About page", "confidence": 0-100 },
  "foundedYear": { "value": "2020", "confidence": 0-100 },
  "teamSize": { "value": "50-100 employees", "confidence": 0-100 },
  "teamHighlights": { "value": "Key team members or leadership info", "confidence": 0-100 },
  "testimonialsThemes": { "value": "Common themes from customer reviews", "confidence": 0-100 },
  "uniqueSellingPoints": { "value": ["USP 1", "USP 2", "USP 3"], "confidence": 0-100 },
  "competitiveAdvantage": { "value": "What sets them apart from competitors", "confidence": 0-100 },
  "contentTone": { "value": "e.g. Professional yet friendly, Technical, Casual", "confidence": 0-100 },
  "keyClients": { "value": "Notable clients or logos found on site", "confidence": 0-100 }
}

Rules:
- For phone, businessEmail, address: only include if explicitly found on the website. Set confidence to 0 and value to "" if not found.
- For socialLinks: only include platforms with links found on the website. Omit platforms not found.
- For services: list every distinct service/product as a separate entry with id, name, description.
- For pricingTiers: list every pricing tier with id, name, price, description, and features array. If quote-based, return an empty array.
- For uniqueSellingPoints: extract 3-5 specific USPs only if clearly stated on the website.
- Generate 2-4 follow-up questions for any fields with confidence below 70 or value set to "".
- Return ONLY valid JSON.`,
    temperature: 0.3,
    topP: 0.9,
  });

  const prompt = resolved.promptTemplate
    .replace('{{website_url}}', websiteUrl)
    .replace('{{social_context}}', socialContext ? `\nSOCIAL MEDIA PROFILES:\n${socialContext}` : '');

  const systemInstruction = resolved.systemInstruction;

  // Grounded inference: enable URL context (Gemini fetches the actual page
  // contents at `websiteUrl`) and Google Search (for related public signals
  // like the company's LinkedIn / Crunchbase / news). Previously grounding
  // returned empty text on this prompt — but that was against the retired
  // gemini-3-flash-preview model. 2.5-flash handles tools + JSON-in-text
  // output reliably.
  //
  // Each attempt is bounded to ANALYSIS_TIMEOUT_MS so the wizard can never
  // sit indefinitely if Gemini stalls. With MAX_RETRIES=3 and a 60s cap
  // plus 1s/2s back-offs, worst-case total wait is ~183s before we surface
  // a clear failure.
  const ANALYSIS_TIMEOUT_MS = 60_000;
  let attempt = 0;
  while (attempt < MAX_RETRIES) {
    try {
      const response = await Promise.race([
        ai.models.generateContent({
          model: MODEL_NAME,
          contents: prompt,
          config: {
            systemInstruction,
            temperature: resolved.temperature,
            topP: resolved.topP,
            tools: [
              { urlContext: {} },
              { googleSearch: {} },
            ],
          } as never,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Business analysis timed out after ${ANALYSIS_TIMEOUT_MS / 1000}s. The model is taking too long — try a simpler URL or skip to manual entry.`)),
            ANALYSIS_TIMEOUT_MS,
          )
        ),
      ]);

      const text = response.text;
      if (!text) throw new Error("Empty response from business analysis.");

      const analysis = parseAnalysisJSON(text);

      return {
        text: text,
        tokens_used: response.usageMetadata?.totalTokenCount || 0,
        model_name: MODEL_NAME,
        prompt_name: 'business_analysis',
        prompt_version: resolved.promptVersion,
        analysis
      };
    } catch (error: unknown) {
      attempt++;
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      console.warn(`Business analysis attempt ${attempt} failed:`, errMsg);
      if (attempt === MAX_RETRIES) {
        return {
          text: `ANALYSIS FAILED: ${errMsg}`,
          tokens_used: 0,
          model_name: MODEL_NAME,
          prompt_name: 'business_analysis_web',
          prompt_version: 1,
          analysis: null
        };
      }
      await new Promise(res => setTimeout(res, 1000 * attempt));
    }
  }

  return {
    text: 'CRITICAL FAILURE: Business analysis could not be completed.',
    tokens_used: 0,
    model_name: MODEL_NAME,
    prompt_name: 'business_analysis_web',
    prompt_version: 1,
    analysis: null
  };
};

export const generateFollowUpQuestions = async (
  currentProfile: BusinessProfile,
  previousQA?: { field: string; question: string; answer: string }[],
  userId?: string
): Promise<{ questions: { field: string; question: string; placeholder: string }[]; tokens_used: number }> => {
  const ai = getGeminiClient();

  const profileContext = Object.entries(currentProfile)
    .filter(([_, v]) => v)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join('\n');

  const previousContext = previousQA?.length
    ? `\nALREADY ANSWERED:\n${previousQA.map(qa => `- Q: ${qa.question}\n  A: ${qa.answer} (field: ${qa.field})`).join('\n')}`
    : '';

  const emptyFields = ['companyName', 'industry', 'productsServices', 'targetAudience', 'valueProp', 'pricingModel', 'salesApproach']
    .filter(f => !currentProfile[f as keyof BusinessProfile]);

  const resolved = await resolvePrompt('follow_up_questions', userId, {
    systemInstruction: 'You are a business strategy consultant. Ask insightful questions to understand a company. Always respond with valid JSON only.',
    promptTemplate: `Based on this partially-filled business profile, generate 2-4 targeted follow-up questions to fill in the gaps.

CURRENT PROFILE:
{{profile_context}}

EMPTY/MISSING FIELDS: {{empty_fields}}
{{previous_context}}

Return a JSON object with this structure:
{
  "questions": [
    { "field": "productsServices", "question": "What are the main products or services your company offers?", "placeholder": "e.g. Cloud-based CRM platform for small businesses" }
  ]
}

Guidelines:
- Only ask about fields that are empty or vague
- Don't repeat questions already answered
- Make questions conversational and specific
- Provide helpful placeholder text
- Return ONLY valid JSON`,
    temperature: 0.5,
    topP: 0.9,
  });

  const prompt = resolved.promptTemplate
    .replace('{{profile_context}}', profileContext || 'No fields filled yet')
    .replace('{{empty_fields}}', emptyFields.join(', ') || 'None')
    .replace('{{previous_context}}', previousContext);

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const response = await ai.models.generateContent({
      model: MODEL_NAME,
      contents: prompt,
      config: {
        systemInstruction: resolved.systemInstruction,
        temperature: resolved.temperature,
        topP: resolved.topP,
      }
    });

    clearTimeout(timeoutId);
    const text = response.text || '';
    const parsed = parseAnalysisJSON(text) as any;

    return {
      questions: parsed?.questions || [],
      tokens_used: response.usageMetadata?.totalTokenCount || 0
    };
  } catch (error: unknown) {
    console.warn('Follow-up question generation failed:', error instanceof Error ? error.message : 'Unknown error');
    return { questions: [], tokens_used: 0 };
  }
};

// === AI Command Center — General-Purpose Gemini Response ===

const MODE_SYSTEM_INSTRUCTIONS: Record<string, string> = {
  analyst: 'You are a senior data analyst for a B2B sales pipeline. Cite specific lead names, scores, and percentages. Use markdown tables when comparing data. Be precise and data-driven.',
  strategist: 'You are a sales strategist for a B2B pipeline. Create actionable plans and reference leads by name. Always end with a clear next step the user can take immediately.',
  coach: 'You are a sales coach reviewing a B2B pipeline. Give honest, constructive feedback. Identify strengths and weaknesses from the actual data. Be encouraging but direct.',
  creative: 'You are a content specialist for B2B sales outreach. Write personalized content referencing specific lead details (name, company, insights). Never produce generic templates — every piece must be tailored to the data provided.',
};

export const generateCommandCenterResponse = async (
  userPrompt: string,
  mode: 'analyst' | 'strategist' | 'coach' | 'creative',
  leads: Lead[],
  conversationHistory: { role: 'user' | 'ai'; content: string }[],
  businessProfile?: BusinessProfile,
  userId?: string,
  streamOpts?: StreamOptions
): Promise<AIResponse> => {
  const ai = getGeminiClient();

  // Build lead context from top 15 leads
  const topLeads = leads.slice(0, 15);
  const leadContext = topLeads.map(l => {
    const parts = [`- ${l.name} (${l.company}) — Score: ${l.score}, Status: ${l.status}`];
    if (l.insights) parts.push(`  Insights: ${l.insights}`);
    if (l.knowledgeBase) {
      const urls = Object.entries(l.knowledgeBase)
        .filter(([k, v]) => v && k !== 'extraNotes')
        .map(([k, v]) => `${k}: ${v}`);
      if (urls.length > 0) parts.push(`  Links: ${urls.join(', ')}`);
      if (l.knowledgeBase.extraNotes) parts.push(`  Notes: ${l.knowledgeBase.extraNotes}`);
    }
    return parts.join('\n');
  }).join('\n');

  // Pipeline stats
  const statusBreakdown: Record<string, number> = {};
  leads.forEach(l => { statusBreakdown[l.status] = (statusBreakdown[l.status] || 0) + 1; });
  const avgScore = leads.length > 0
    ? Math.round(leads.reduce((a, b) => a + b.score, 0) / leads.length)
    : 0;
  const hotCount = leads.filter(l => l.score > 80).length;

  const pipelineStats = `PIPELINE STATS:
- Total Leads: ${leads.length}
- Average Score: ${avgScore}/100
- Hot Leads (80+): ${hotCount}
- Status Breakdown: ${Object.entries(statusBreakdown).map(([k, v]) => `${k}: ${v}`).join(', ')}`;

  const contextBlock = `${pipelineStats}

TOP LEADS:
${leadContext || 'No leads in pipeline.'}`;

  // Build multi-turn contents from conversation history (last 10)
  const historySlice = conversationHistory.slice(-10);
  const contents: { role: 'user' | 'model'; parts: { text: string }[] }[] = [];

  // First message includes full context
  if (historySlice.length > 0) {
    for (const msg of historySlice.slice(0, -1)) {
      contents.push({
        role: msg.role === 'user' ? 'user' : 'model',
        parts: [{ text: msg.content }],
      });
    }
  }

  // Current user prompt with context
  contents.push({
    role: 'user',
    parts: [{ text: `${contextBlock}\n\nUSER REQUEST:\n${userPrompt}` }],
  });

  const defaultSystemInstruction = MODE_SYSTEM_INSTRUCTIONS[mode] || MODE_SYSTEM_INSTRUCTIONS.analyst;
  const promptKey = `command_center_${mode}`;

  const resolved = await resolvePrompt(promptKey, userId, {
    systemInstruction: defaultSystemInstruction,
    promptTemplate: `{{pipeline_context}}\n\nUSER REQUEST:\n{{user_prompt}}`,
    temperature: mode === 'creative' ? 0.85 : 0.7,
    topP: 0.9,
  });

  const genConfig = {
    systemInstruction: resolved.systemInstruction + buildBusinessContext(businessProfile),
    temperature: resolved.temperature,
    topP: resolved.topP,
    topK: 40,
  };

  let attempt = 0;
  while (attempt < MAX_RETRIES) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 20000);

      let text: string;
      let tokensUsed = 0;

      if (streamOpts?.stream) {
        const stream = await ai.models.generateContentStream({
          model: MODEL_NAME,
          contents,
          config: genConfig,
        });
        text = '';
        for await (const chunk of stream) {
          text += chunk.text || '';
          streamOpts.onChunk(text);
        }
      } else {
        const response = await ai.models.generateContent({
          model: MODEL_NAME,
          contents,
          config: genConfig,
        });
        text = response.text || '';
        tokensUsed = response.usageMetadata?.totalTokenCount || 0;
      }

      clearTimeout(timeoutId);
      if (!text) throw new Error('Empty response from Command Center.');

      return {
        text,
        tokens_used: tokensUsed,
        model_name: MODEL_NAME,
        prompt_name: promptKey,
        prompt_version: resolved.promptVersion,
      };
    } catch (error: unknown) {
      attempt++;
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      console.warn(`Command Center Gemini attempt ${attempt} failed:`, errMsg);
      if (attempt === MAX_RETRIES) {
        return {
          text: '',
          tokens_used: 0,
          model_name: MODEL_NAME,
          prompt_name: promptKey,
          prompt_version: resolved.promptVersion,
        };
      }
      await new Promise(res => setTimeout(res, 1000 * attempt));
    }
  }

  return { text: '', tokens_used: 0, model_name: MODEL_NAME, prompt_name: promptKey, prompt_version: resolved.promptVersion };
};

export const generateContentSuggestions = async (
  content: string,
  mode: 'email' | 'linkedin' | 'proposal',
  businessProfile?: BusinessProfile,
  userId?: string
): Promise<AIResponse> => {
  const ai = getGeminiClient();

  const modeLabel = mode === 'email' ? 'cold email' : mode === 'linkedin' ? 'LinkedIn post' : 'sales proposal';

  const resolved = await resolvePrompt('content_suggestions', userId, {
    systemInstruction: 'You are a senior content optimization specialist for B2B sales. Analyze content and provide specific, actionable improvement suggestions. Always use the exact delimited format requested.',
    promptTemplate: `Analyze the following content and return exactly 5 improvement suggestions.

CONTENT TO ANALYZE:
{{content}}

For each suggestion, use this exact delimited format:

===SUGGESTION===
TYPE: [one of: word|metric|personalization|structure|cta]
CATEGORY: [one of: high|medium|style]
TITLE: [short actionable title, max 10 words]
DESCRIPTION: [1-2 sentences explaining why this matters]
ORIGINAL_TEXT: [exact quote to replace, or empty for structure/cta]
REPLACEMENT: [improved text]
IMPACT_LABEL: [e.g. "+12% opens"]
IMPACT_PERCENT: [number only]
===END_SUGGESTION===

Return exactly 5 suggestions.`,
    temperature: 0.7,
    topP: 0.9,
  });

  const prompt = resolved.promptTemplate
    .replace('{{content}}', content);

  let attempt = 0;
  while (attempt < MAX_RETRIES) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const response = await ai.models.generateContent({
        model: MODEL_NAME,
        contents: prompt,
        config: {
          systemInstruction: resolved.systemInstruction + buildBusinessContext(businessProfile),
          temperature: resolved.temperature,
          topP: resolved.topP,
        }
      });

      clearTimeout(timeoutId);
      const text = response.text;
      if (!text) throw new Error("Empty suggestions response.");

      return {
        text,
        tokens_used: response.usageMetadata?.totalTokenCount || 0,
        model_name: MODEL_NAME,
        prompt_name: 'content_suggestions',
        prompt_version: resolved.promptVersion
      };
    } catch (error: unknown) {
      attempt++;
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      if (attempt === MAX_RETRIES) {
        return {
          text: `SUGGESTIONS FAILED: ${errMsg}`,
          tokens_used: 0,
          model_name: MODEL_NAME,
          prompt_name: 'content_suggestions',
          prompt_version: resolved.promptVersion
        };
      }
      await new Promise(res => setTimeout(res, 1000 * attempt));
    }
  }

  return { text: '', tokens_used: 0, model_name: MODEL_NAME, prompt_name: 'content_suggestions', prompt_version: resolved.promptVersion };
};

// === Pipeline Strategy Generation ===

export interface PipelineStrategyInput {
  totalLeads: number;
  avgScore: number;
  statusBreakdown: Record<string, number>;
  hotLeads: number;
  recentActivity: string;
  emailsSent: number;
  emailsOpened: number;
  conversionRate: number;
  businessProfile?: BusinessProfile;
}

export interface PipelineStrategyResponse {
  recommendations: string[];
  sprintGoals: { title: string; target: number; current: number; unit: string; deadline: string }[];
  risks: string[];
  priorityActions: string[];
}

export const generatePipelineStrategy = async (
  input: PipelineStrategyInput,
  userId?: string
): Promise<AIResponse> => {
  const ai = getGeminiClient();

  const statusStr = Object.entries(input.statusBreakdown)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');

  const resolved = await resolvePrompt('pipeline_strategy', userId, {
    systemInstruction: 'You are a senior B2B sales strategist. Analyze pipeline data and produce actionable strategy recommendations. Always use the exact delimited format requested.',
    promptTemplate: `Analyze this B2B sales pipeline and generate strategic recommendations.

PIPELINE DATA:
- Total Leads: {{total_leads}}
- Average Lead Score: {{avg_score}}/100
- Status Breakdown: {{status_breakdown}}
- Hot Leads (score > 80): {{hot_leads}}
- Emails Sent: {{emails_sent}}
- Emails Opened: {{emails_opened}}
- Conversion Rate: {{conversion_rate}}%
- Recent Activity: {{recent_activity}}

Respond using EXACTLY this delimited format:

===FIELD===RECOMMENDATIONS: [3-5 items separated by | pipes]===END===
===FIELD===SPRINT_GOALS: [4 goals, format: title|target|current|unit|deadline]===END===
===FIELD===RISKS: [2-4 items separated by | pipes]===END===
===FIELD===PRIORITY_ACTIONS: [Top 3 items separated by | pipes]===END===

Be specific and data-driven.`,
    temperature: 0.7,
    topP: 0.9,
  });

  const prompt = resolved.promptTemplate
    .replace('{{total_leads}}', input.totalLeads.toString())
    .replace('{{avg_score}}', input.avgScore.toString())
    .replace('{{status_breakdown}}', statusStr)
    .replace('{{hot_leads}}', input.hotLeads.toString())
    .replace('{{emails_sent}}', input.emailsSent.toString())
    .replace('{{emails_opened}}', input.emailsOpened.toString())
    .replace('{{conversion_rate}}', input.conversionRate.toString())
    .replace('{{recent_activity}}', input.recentActivity);

  let attempt = 0;
  while (attempt < MAX_RETRIES) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 20000);

      const response = await ai.models.generateContent({
        model: MODEL_NAME,
        contents: prompt,
        config: {
          systemInstruction: resolved.systemInstruction + buildBusinessContext(input.businessProfile),
          temperature: resolved.temperature,
          topP: resolved.topP,
        }
      });

      clearTimeout(timeoutId);
      const text = response.text;
      if (!text) throw new Error('Empty strategy response.');

      return {
        text,
        tokens_used: response.usageMetadata?.totalTokenCount || 0,
        model_name: MODEL_NAME,
        prompt_name: 'pipeline_strategy',
        prompt_version: resolved.promptVersion,
      };
    } catch (error: unknown) {
      attempt++;
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      console.warn(`Pipeline strategy attempt ${attempt} failed:`, errMsg);
      if (attempt === MAX_RETRIES) {
        return {
          text: '',
          tokens_used: 0,
          model_name: MODEL_NAME,
          prompt_name: 'pipeline_strategy',
          prompt_version: resolved.promptVersion,
        };
      }
      await new Promise(res => setTimeout(res, 1000 * attempt));
    }
  }

  return { text: '', tokens_used: 0, model_name: MODEL_NAME, prompt_name: 'pipeline_strategy', prompt_version: resolved.promptVersion };
};

export const parsePipelineStrategyResponse = (text: string): PipelineStrategyResponse => {
  const result: PipelineStrategyResponse = {
    recommendations: [],
    sprintGoals: [],
    risks: [],
    priorityActions: [],
  };

  const extractField = (fieldName: string): string | undefined => {
    const regex = new RegExp(`===FIELD===${fieldName}:\\s*([\\s\\S]*?)===END===`, 'i');
    const match = text.match(regex);
    return match?.[1]?.trim() || undefined;
  };

  const recsRaw = extractField('RECOMMENDATIONS');
  if (recsRaw) {
    result.recommendations = recsRaw.split('|').map(r => r.trim()).filter(Boolean);
  }

  const goalsRaw = extractField('SPRINT_GOALS');
  if (goalsRaw) {
    const lines = goalsRaw.split('\n').map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      const parts = line.split('|').map(p => p.trim());
      if (parts.length >= 5) {
        result.sprintGoals.push({
          title: parts[0],
          target: parseInt(parts[1]) || 10,
          current: parseInt(parts[2]) || 0,
          unit: parts[3],
          deadline: parts[4],
        });
      }
    }
  }

  const risksRaw = extractField('RISKS');
  if (risksRaw) {
    result.risks = risksRaw.split('|').map(r => r.trim()).filter(Boolean);
  }

  const actionsRaw = extractField('PRIORITY_ACTIONS');
  if (actionsRaw) {
    result.priorityActions = actionsRaw.split('|').map(a => a.trim()).filter(Boolean);
  }

  return result;
};

// === Blog Content Generation ===

export type BlogContentMode = 'full_draft' | 'outline_only' | 'improve' | 'expand';

export interface BlogContentParams {
  mode: BlogContentMode;
  topic: string;
  tone?: string;
  category?: string;
  keywords?: string[];
  existingContent?: string;
  businessProfile?: BusinessProfile;
}

export const generateBlogContent = async (params: BlogContentParams, userId?: string, streamOpts?: StreamOptions): Promise<AIResponse> => {
  const ai = getGeminiClient();

  const modeKeyMap: Record<BlogContentMode, string> = {
    full_draft: 'blog_full_draft',
    outline_only: 'blog_outline',
    improve: 'blog_improve',
    expand: 'blog_expand',
  };

  const modeInstructions: Record<BlogContentMode, string> = {
    full_draft: `Write a complete, publication-ready blog post about "{{topic}}". Include:
- An engaging title (if not provided)
- Introduction that hooks the reader
- 3-5 well-structured sections with ## headings
- Practical examples or data points
- A compelling conclusion with a call to action
- Target 600-1200 words
- Use markdown formatting throughout
{{tone_guide}}{{category_guide}}{{keyword_guide}}

Output the blog content in clean markdown format.`,
    outline_only: `Create a detailed blog post outline for "{{topic}}". Include:
- A compelling title suggestion
- Introduction summary (2-3 sentences)
- 5-7 section headings (##) with 2-3 bullet points each
- Conclusion summary
- 3 suggested keywords for SEO
- Format in markdown
{{tone_guide}}{{category_guide}}{{keyword_guide}}`,
    improve: `Rewrite and improve the following blog content about "{{topic}}". Make it more:
- Engaging and readable
- Well-structured with clear headings
- Professional yet conversational
- SEO-friendly

EXISTING CONTENT TO IMPROVE:
{{existing_content}}
{{tone_guide}}{{category_guide}}{{keyword_guide}}`,
    expand: `Expand the following blog content about "{{topic}}". For each section:
- Add more detail, examples, and depth
- Include relevant statistics or data points
- Add transition sentences between sections
- Ensure each section is at least 150 words

EXISTING CONTENT TO EXPAND:
{{existing_content}}
{{tone_guide}}{{category_guide}}{{keyword_guide}}`,
  };

  const promptKey = modeKeyMap[params.mode];
  const resolved = await resolvePrompt(promptKey, userId, {
    systemInstruction: 'You are an expert blog content writer specializing in B2B and technology topics. You write engaging, well-researched content in clean markdown format. Your posts are SEO-friendly and provide genuine value to readers.',
    promptTemplate: modeInstructions[params.mode],
    temperature: params.mode === 'outline_only' ? 0.7 : 0.85,
    topP: 0.9,
  });

  const toneGuide = params.tone ? `\nTONE: Write in a ${params.tone} tone.` : '';
  const categoryGuide = params.category ? `\nCATEGORY: This is a ${params.category} post.` : '';
  const keywordGuide = params.keywords?.length ? `\nKEYWORDS TO INCLUDE: ${params.keywords.join(', ')}` : '';

  const prompt = resolved.promptTemplate
    .replace('{{topic}}', params.topic)
    .replace('{{existing_content}}', params.existingContent || '(No content provided)')
    .replace('{{tone_guide}}', toneGuide)
    .replace('{{category_guide}}', categoryGuide)
    .replace('{{keyword_guide}}', keywordGuide);

  const genConfig = {
    systemInstruction: resolved.systemInstruction + buildBusinessContext(params.businessProfile),
    temperature: resolved.temperature,
    topP: resolved.topP,
    topK: 40,
  };

  let attempt = 0;
  while (attempt < MAX_RETRIES) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

      let text: string;
      let tokensUsed = 0;

      if (streamOpts?.stream) {
        const stream = await ai.models.generateContentStream({
          model: MODEL_NAME,
          contents: prompt,
          config: genConfig,
        });
        text = '';
        for await (const chunk of stream) {
          text += chunk.text || '';
          streamOpts.onChunk(text);
        }
      } else {
        const response = await ai.models.generateContent({
          model: MODEL_NAME,
          contents: prompt,
          config: genConfig,
        });
        text = response.text || '';
        tokensUsed = response.usageMetadata?.totalTokenCount || 0;
      }

      clearTimeout(timeoutId);
      if (!text) throw new Error('Empty blog content response.');

      return {
        text,
        tokens_used: tokensUsed,
        model_name: MODEL_NAME,
        prompt_name: promptKey,
        prompt_version: resolved.promptVersion,
      };
    } catch (error: unknown) {
      attempt++;
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      console.warn(`Blog content generation attempt ${attempt} failed:`, errMsg);
      if (attempt === MAX_RETRIES) {
        return {
          text: `GENERATION FAILED: ${errMsg}`,
          tokens_used: 0,
          model_name: MODEL_NAME,
          prompt_name: promptKey,
          prompt_version: resolved.promptVersion,
        };
      }
      await new Promise(res => setTimeout(res, 1000 * attempt));
    }
  }

  return { text: '', tokens_used: 0, model_name: MODEL_NAME, prompt_name: promptKey, prompt_version: resolved.promptVersion };
};

// === Social Media Caption Generation ===

export type SocialPlatform = 'linkedin' | 'twitter' | 'facebook';

export interface SocialCaptionParams {
  platform: SocialPlatform;
  postTitle: string;
  postExcerpt?: string;
  postUrl: string;
  businessProfile?: BusinessProfile;
}

export const generateSocialCaption = async (params: SocialCaptionParams, userId?: string): Promise<AIResponse> => {
  const ai = getGeminiClient();

  const promptKey = `social_${params.platform}`;

  const platformRules: Record<SocialPlatform, string> = {
    linkedin: `Write a LinkedIn post. Include:
- A hook in the first line that stops the scroll
- 2-3 sentences expanding on the key insight
- A clear call to action to read the full post
- 3-5 relevant hashtags at the end
- Professional but conversational tone
- Maximum 300 words`,
    twitter: `Write a tweet (max 280 characters including URL). Include:
- A punchy, attention-grabbing message
- The key takeaway in 1-2 sentences
- 1-2 relevant hashtags
- Leave room for the URL (23 characters)`,
    facebook: `Write a Facebook post. Include:
- An engaging opening question or statement
- A brief summary of what readers will learn
- A call to action to click through
- Conversational and approachable tone
- Maximum 200 words`,
  };

  const resolved = await resolvePrompt(promptKey, userId, {
    systemInstruction: 'You are an expert social media copywriter for B2B brands. Write engaging, platform-native captions that drive clicks. Output only the caption text.',
    promptTemplate: `Generate a social media caption for sharing this blog post:

BLOG POST TITLE: {{post_title}}
{{post_excerpt}}
POST URL: {{post_url}}

PLATFORM: ${params.platform.toUpperCase()}

${platformRules[params.platform]}

Output ONLY the caption text.`,
    temperature: 0.85,
    topP: 0.9,
  });

  const prompt = resolved.promptTemplate
    .replace('{{post_title}}', params.postTitle)
    .replace('{{post_excerpt}}', params.postExcerpt ? `EXCERPT: ${params.postExcerpt}` : '')
    .replace('{{post_url}}', params.postUrl);

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const response = await ai.models.generateContent({
      model: MODEL_NAME,
      contents: prompt,
      config: {
        systemInstruction: resolved.systemInstruction + buildBusinessContext(params.businessProfile),
        temperature: resolved.temperature,
        topP: resolved.topP,
      }
    });

    clearTimeout(timeoutId);
    const text = response.text;
    if (!text) throw new Error('Empty caption response.');

    return {
      text,
      tokens_used: response.usageMetadata?.totalTokenCount || 0,
      model_name: MODEL_NAME,
      prompt_name: promptKey,
      prompt_version: resolved.promptVersion,
    };
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : 'Unknown error';
    return {
      text: `Caption generation failed: ${errMsg}`,
      tokens_used: 0,
      model_name: MODEL_NAME,
      prompt_name: promptKey,
      prompt_version: resolved.promptVersion,
    };
  }
};

// === Workflow Email Personalization ===

export interface PersonalizeEmailInput {
  subjectTemplate: string;  // already tag-resolved
  bodyTemplate: string;     // already tag-resolved
  lead: Lead;
  businessProfile?: BusinessProfile;
  tone?: ToneType;
}

export async function generatePersonalizedEmail(
  input: PersonalizeEmailInput,
  userId?: string
): Promise<{ subject: string; htmlBody: string; tokensUsed: number }> {
  const ai = getGeminiClient();

  const leadContext = [
    `Name: ${leadDisplayName(input.lead)}`,
    `Company: ${input.lead.company}`,
    `Score: ${input.lead.score}/100`,
    input.lead.insights ? `Insights: ${input.lead.insights}` : '',
    input.lead.knowledgeBase?.industry ? `Industry: ${input.lead.knowledgeBase.industry}` : '',
    input.lead.knowledgeBase?.companyOverview ? `Company Overview: ${input.lead.knowledgeBase.companyOverview}` : '',
    input.lead.knowledgeBase?.talkingPoints?.length ? `Talking Points: ${input.lead.knowledgeBase.talkingPoints.join(', ')}` : '',
    input.lead.knowledgeBase?.outreachAngle ? `Outreach Angle: ${input.lead.knowledgeBase.outreachAngle}` : '',
  ].filter(Boolean).join('\n');

  const toneLabel = input.tone || ToneType.PROFESSIONAL;

  const resolved = await resolvePrompt('email_personalization', userId, {
    systemInstruction: 'You are an expert B2B email copywriter. Rewrite emails to feel personally crafted for each recipient. Keep them concise, human, and action-oriented. Always use the exact output format requested.',
    promptTemplate: `Rewrite the following email to feel more natural and tailored to this specific prospect. Keep the overall structure and CTA intact. Keep the body under 200 words. Output HTML for the body.

PROSPECT CONTEXT:
{{lead_context}}

CURRENT SUBJECT:
{{subject_template}}

CURRENT BODY:
{{body_template}}

TONE: {{tone}}

Respond in EXACTLY this format:
SUBJECT: [rewritten subject line]
BODY: [rewritten HTML email body]`,
    temperature: 0.8,
    topP: 0.9,
  });

  const prompt = resolved.promptTemplate
    .replace('{{lead_context}}', leadContext)
    .replace('{{subject_template}}', input.subjectTemplate)
    .replace('{{body_template}}', input.bodyTemplate)
    .replace('{{tone}}', toneLabel);

  let attempt = 0;
  while (attempt < MAX_RETRIES) {
    try {
      // Wrap the API call in a proper timeout since AbortController
      // cannot be passed to the GoogleGenAI SDK
      const response = await Promise.race([
        ai.models.generateContent({
          model: MODEL_NAME,
          contents: prompt,
          config: {
            systemInstruction: resolved.systemInstruction + buildBusinessContext(input.businessProfile),
            temperature: resolved.temperature,
            topP: resolved.topP,
          }
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Gemini API timed out')), TIMEOUT_MS)
        ),
      ]);

      const text = response.text || '';

      const subjectMatch = text.match(/SUBJECT:\s*(.+?)(?:\n|$)/);
      const bodyMatch = text.match(/BODY:\s*([\s\S]*?)$/);

      if (subjectMatch && bodyMatch) {
        return {
          subject: subjectMatch[1].trim(),
          htmlBody: bodyMatch[1].trim(),
          tokensUsed: response.usageMetadata?.totalTokenCount || 0,
        };
      }

      // If parsing failed, fall back to original
      console.warn('AI personalization response could not be parsed, using original content');
      return {
        subject: input.subjectTemplate,
        htmlBody: input.bodyTemplate,
        tokensUsed: response.usageMetadata?.totalTokenCount || 0,
      };
    } catch (error: unknown) {
      attempt++;
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      console.warn(`Email personalization attempt ${attempt} failed:`, errMsg);
      if (attempt === MAX_RETRIES) {
        // Graceful degradation: return original content
        return {
          subject: input.subjectTemplate,
          htmlBody: input.bodyTemplate,
          tokensUsed: 0,
        };
      }
      await new Promise(res => setTimeout(res, 1000 * attempt));
    }
  }

  return {
    subject: input.subjectTemplate,
    htmlBody: input.bodyTemplate,
    tokensUsed: 0,
  };
}

export const parseEmailSequenceResponse = (rawText: string, config: EmailSequenceConfig): EmailStep[] => {
  const steps: EmailStep[] = [];
  const emailBlocks = rawText.split('===EMAIL_START===').filter(b => b.trim());

  for (const block of emailBlocks) {
    const cleaned = block.replace('===EMAIL_END===', '').trim();
    const stepMatch = cleaned.match(/STEP:\s*(\d+)/);
    const delayMatch = cleaned.match(/DELAY:\s*(.+)/);
    const subjectMatch = cleaned.match(/SUBJECT:\s*(.+)/);
    const bodyMatch = cleaned.match(/BODY:\s*([\s\S]*?)$/);

    if (stepMatch && subjectMatch && bodyMatch) {
      steps.push({
        id: `step-${stepMatch[1]}-${Date.now()}`,
        stepNumber: parseInt(stepMatch[1]),
        subject: subjectMatch[1].trim(),
        body: bodyMatch[1].trim(),
        delay: delayMatch ? delayMatch[1].trim() : `Day ${parseInt(stepMatch[1])}`,
        tone: config.tone
      });
    }
  }

  // Fallback: if structured parsing fails, create steps from plain text
  if (steps.length === 0 && rawText.length > 50) {
    const sections = rawText.split(/(?:Email\s*#?\s*\d|Subject\s*\d)/i).filter(s => s.trim().length > 20);
    for (let i = 0; i < Math.min(sections.length, config.sequenceLength); i++) {
      steps.push({
        id: `step-${i + 1}-${Date.now()}`,
        stepNumber: i + 1,
        subject: `Email ${i + 1} - Follow Up`,
        body: sections[i].trim(),
        delay: `Day ${1 + i * (CADENCE_DAYS[config.cadence] || 2)}`,
        tone: config.tone
      });
    }
  }

  return steps;
};

// === Workflow Optimization ===

export interface WorkflowOptimizationInput {
  nodes: { id: string; type: string; title: string; description: string; config: Record<string, any> }[];
  stats: { leadsProcessed: number; conversionRate: number; timeSavedHrs: number; roi: number };
  leadCount: number;
}

export const generateWorkflowOptimization = async (
  input: WorkflowOptimizationInput,
  businessProfile?: BusinessProfile,
  userId?: string
): Promise<AIResponse> => {
  const ai = getGeminiClient();

  const nodesSummary = input.nodes.map((n, i) =>
    `${i + 1}. [${n.type.toUpperCase()}] ${n.title} — ${n.description}`
  ).join('\n');

  const resolved = await resolvePrompt('workflow_optimization', userId, {
    systemInstruction: 'You are a marketing automation expert. Analyze workflows and provide specific, data-driven optimization suggestions. Be concise and actionable.',
    promptTemplate: `Analyze this automation workflow and suggest specific improvements.

WORKFLOW NODES:
{{nodes_summary}}

PERFORMANCE STATS:
- Leads Processed: {{leads_processed}}
- Conversion Rate: {{conversion_rate}}%
- Time Saved: {{time_saved_hrs}} hours
- ROI: {{roi}}%
- Available Leads: {{lead_count}}

Provide 3-5 specific, actionable suggestions. Each suggestion should:
- Reference specific nodes by name when relevant
- Include expected impact
- Be immediately implementable

Return each suggestion on its own line, prefixed with "- ".`,
    temperature: 0.7,
    topP: 0.9,
  });

  const prompt = resolved.promptTemplate
    .replace('{{nodes_summary}}', nodesSummary)
    .replace('{{leads_processed}}', input.stats.leadsProcessed.toString())
    .replace('{{conversion_rate}}', input.stats.conversionRate.toString())
    .replace('{{time_saved_hrs}}', input.stats.timeSavedHrs.toString())
    .replace('{{roi}}', input.stats.roi.toString())
    .replace('{{lead_count}}', input.leadCount.toString());

  let attempt = 0;
  while (attempt < MAX_RETRIES) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const response = await ai.models.generateContent({
        model: MODEL_NAME,
        contents: prompt,
        config: {
          systemInstruction: resolved.systemInstruction + buildBusinessContext(businessProfile),
          temperature: resolved.temperature,
          topP: resolved.topP,
        }
      });

      clearTimeout(timeoutId);
      const text = response.text;
      if (!text) throw new Error('Empty optimization response.');

      return {
        text,
        tokens_used: response.usageMetadata?.totalTokenCount || 0,
        model_name: MODEL_NAME,
        prompt_name: 'workflow_optimization',
        prompt_version: resolved.promptVersion,
      };
    } catch (error: unknown) {
      attempt++;
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      console.warn(`Workflow optimization attempt ${attempt} failed:`, errMsg);
      if (attempt === MAX_RETRIES) {
        return {
          text: `OPTIMIZATION FAILED: ${errMsg}`,
          tokens_used: 0,
          model_name: MODEL_NAME,
          prompt_name: 'workflow_optimization',
          prompt_version: resolved.promptVersion,
        };
      }
      await new Promise(res => setTimeout(res, 1000 * attempt));
    }
  }

  return { text: '', tokens_used: 0, model_name: MODEL_NAME, prompt_name: 'workflow_optimization', prompt_version: resolved.promptVersion };
};

// === Guest Post Pitch Generation ===

export interface GuestPostPitchParams {
  blogName: string;
  blogUrl?: string;
  contactName?: string;
  tone: string;
  proposedTopics?: string;
  businessProfile?: BusinessProfile;
}

export const generateGuestPostPitch = async (
  params: GuestPostPitchParams,
  userId?: string
): Promise<AIResponse> => {
  const ai = getGeminiClient();

  const resolved = await resolvePrompt('guest_post_pitch', userId, {
    systemInstruction: 'You are an expert guest post outreach specialist. Write compelling, personalized pitch emails that blog editors actually want to respond to. Be concise and professional.',
    promptTemplate: `Write a guest post pitch email for the following blog.

TARGET BLOG:
- Blog Name: {{blog_name}}
{{blog_url}}
{{contact_name}}

TONE: {{tone}}
{{proposed_topics}}

REQUIREMENTS:
1. Write a compelling subject line that stands out in an editor's inbox
2. Open with a specific compliment about their blog (reference the blog name)
3. Briefly introduce yourself and your expertise
4. Propose 2-3 specific article ideas with working titles
5. Explain the value each topic would bring to their readers
6. Include a brief author bio paragraph
7. Keep the email under 300 words
8. End with a clear, low-pressure call to action

Respond in EXACTLY this format:
===FIELD===SUBJECT: [pitch email subject line]===END===
===FIELD===BODY: [full email body in plain text]===END===`,
    temperature: 0.85,
    topP: 0.9,
  });

  const prompt = resolved.promptTemplate
    .replace('{{blog_name}}', params.blogName)
    .replace('{{blog_url}}', params.blogUrl ? `- Blog URL: ${params.blogUrl}` : '')
    .replace('{{contact_name}}', params.contactName ? `- Editor/Contact: ${params.contactName}` : '')
    .replace('{{tone}}', params.tone)
    .replace('{{proposed_topics}}', params.proposedTopics ? `\nPROPOSED TOPICS:\n${params.proposedTopics}` : '');

  let attempt = 0;
  while (attempt < MAX_RETRIES) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const response = await ai.models.generateContent({
        model: MODEL_NAME,
        contents: prompt,
        config: {
          systemInstruction: resolved.systemInstruction + buildBusinessContext(params.businessProfile),
          temperature: resolved.temperature,
          topP: resolved.topP,
          topK: 40,
        }
      });

      clearTimeout(timeoutId);
      const text = response.text;
      if (!text) throw new Error('Empty pitch response.');

      return {
        text,
        tokens_used: response.usageMetadata?.totalTokenCount || 0,
        model_name: MODEL_NAME,
        prompt_name: 'guest_post_pitch',
        prompt_version: resolved.promptVersion,
      };
    } catch (error: unknown) {
      attempt++;
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      console.warn(`Guest post pitch attempt ${attempt} failed:`, errMsg);
      if (attempt === MAX_RETRIES) {
        return {
          text: `PITCH GENERATION FAILED: ${errMsg}`,
          tokens_used: 0,
          model_name: MODEL_NAME,
          prompt_name: 'guest_post_pitch',
          prompt_version: resolved.promptVersion,
        };
      }
      await new Promise(res => setTimeout(res, 1000 * attempt));
    }
  }

  return { text: '', tokens_used: 0, model_name: MODEL_NAME, prompt_name: 'guest_post_pitch', prompt_version: resolved.promptVersion };
};

export const parseGuestPostPitchResponse = (text: string): { subject: string; body: string } => {
  const extractField = (fieldName: string): string | undefined => {
    const regex = new RegExp(`===FIELD===${fieldName}:\\s*([\\s\\S]*?)===END===`, 'i');
    const match = text.match(regex);
    return match?.[1]?.trim() || undefined;
  };

  return {
    subject: extractField('SUBJECT') || '',
    body: extractField('BODY') || text,
  };
};