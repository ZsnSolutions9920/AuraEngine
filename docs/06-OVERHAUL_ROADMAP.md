# Scaliyo Overhaul Roadmap

**Owner:** Engineering
**Started:** 2026-05-08
**Strategic premise:** Reposition Scaliyo as the **AI Revenue Operating System** — one unified surface for outbound revenue work, organised around four operating pillars (Acquire / Engage / Convert / Intelligence) with persistent AI memory and an active Mission Control as the daily entry point.

This document tracks the phased rollout. Phase 1 is shipped in code on this branch. Phases 2–6 are scoped here with acceptance criteria, blast radius, and dependencies, but **not** executed without explicit go-ahead.

---

## Phase 1 — Foundation (✅ shipped this session)

| Deliverable | File(s) | Status |
|---|---|---|
| Central AI config (model name, defaults) | `AuraEngine/lib/aiConfig.ts` (new) | ✅ |
| Replace hardcoded `gemini-3-flash-preview` | `lib/gemini.ts:101`, `lib/dna.ts:441`, `pages/portal/ModelTraining.tsx:423` | ✅ |
| Navigation pillars (Acquire/Engage/Convert/Intelligence) | `lib/navConfig.ts` (rewritten) | ✅ |
| AI memory schema migration | `supabase/migrations/20260508000000_ai_memory_layer.sql` (new) | ✅ |
| Memory access library + Gemini context builder | `lib/memory.ts` (new) | ✅ |
| AI Mission Control page (additive route `/portal/mission`) | `pages/portal/MissionControl.tsx` (new) + App.tsx route | ✅ |
| Phase roadmap document | `docs/06-OVERHAUL_ROADMAP.md` (this file) | ✅ |
| Memory wiring into outreach Gemini calls (outreach-only scope) | `lib/gemini.ts` (3 functions: `generateLeadContent`, `generateEmailSequence`, `generateLeadResearch`) | ✅ |
| Email tracking → `lead_memory` writer | `supabase/migrations/20260508100000_lead_memory_email_tracking.sql` + 3 edge functions (`email-track`, `webhooks-sendgrid`, `webhooks-mailchimp`) | ✅ |
| Sequence completion → `campaign_memory` outcome writer (cron-driven, 48h delay) | `supabase/migrations/20260508200000_campaign_memory_sequence_outcome.sql` | ✅ |
| AI Command Center thumbs feedback → `workspace_memory` writer | `components/ai/MessageRow.tsx` + `pages/portal/AICommandCenter.tsx` | ✅ |
| Mission Control becomes default `/portal` (legacy dashboard moved to `/portal/dashboard` + reachable via "Full dashboard" button) | `App.tsx` route swap + `MissionControl.tsx` header CTA | ✅ |
| Sender health foundation (additive, no send-path changes) — Phase 3.1 | `supabase/migrations/20260508300000_sender_health_foundation.sql` | ✅ |
| DB refinement: `email_messages.workspace_id`, `email_dlq` FK correction, deprecation comments on `ai_prompts` / `ai_usage_logs` / `email_provider_configs` / `strategy_tasks` / `strategy_notes` / legacy `leads` columns | `supabase/migrations/20260508400000_db_refinement.sql` | ✅ |
| Phase 3.2.1 send-path data migration + counters + DLQ wiring (credential source still legacy) | `supabase/migrations/20260508500000_send_path_data_migration.sql` + 3 edge function updates | ✅ |
| Phase 3.2.2 credential source swap — send-email reads from `sender_account_secrets` first, legacy `email_provider_configs` as defensive fallback | `supabase/functions/send-email/index.ts` (`loadSenderAccountCreds` helper) | ✅ |
| DB refinement pass #2: re-point 8 `workspace_id` FKs from `profiles(id)` → `workspaces(id)` (canonical), add 5 missing `workspace_id` indexes | `supabase/migrations/20260509000000_db_refinement_pass2.sql` | ✅ |
| Phase 3.2.3 send-path completion — auto-pick sender when no provider supplied + 429 hard-fail when daily cap reached or sender quarantined | `supabase/functions/send-email/index.ts` | ✅ |
| Cleanup pass — drop `strategy_tasks` / `strategy_notes` / `ai_prompts` tables; drop legacy `leads.name` / `email` / `lastActivity` columns; redefine `import_leads_batch` to omit legacy writes; correct inaccurate `ai_usage_logs` deprecation comment; remove dead `ai_prompts` code from `AIOperations.tsx` | `supabase/migrations/20260509100000_cleanup_pass.sql` + `pages/admin/AIOperations.tsx` | ✅ |
| Sender health + DLQ visibility panel embedded in `/portal/sender-accounts` | `components/portal/SenderHealthPanel.tsx` (new) + `pages/portal/SenderAccountsPage.tsx` + `types.ts` (added Phase 3.1 columns to `SenderAccount`, new `EmailDlqEntry` type) | ✅ |
| Phase 4.1 — Public API foundation: `api_keys` table + `create_api_key` / `verify_api_key` / `revoke_api_key` RPCs + `_shared/api-auth.ts` middleware + `v1-leads` first endpoint + `/portal/api-keys` UI (mint/list/revoke, plaintext shown once) | `supabase/migrations/20260509200000_api_keys.sql`, `supabase/functions/_shared/api-auth.ts`, `supabase/functions/v1-leads/`, `lib/apiKeys.ts`, `pages/portal/ApiKeysPage.tsx`, `App.tsx`, `lib/navConfig.ts`, `types.ts` | ✅ |
| Phase 4.2 — additional v1 endpoints (`v1-sequences`, `v1-campaigns`, `v1-analytics`) + Postgres-backed cluster-wide rate limit (`api_rate_limit_buckets` + `consume_api_rate_limit` RPC + hourly purge cron) + OpenAPI 3.1 spec | 3 new edge fns + `supabase/migrations/20260509400000_api_rate_limit.sql` + `_shared/api-auth.ts` rewrite + `docs/api/openapi.yaml` | ✅ |
| Phase 4.3 — Outbound webhooks: `webhook_endpoints` + `webhook_deliveries` tables, `queue_webhook_event` / `claim_pending_webhook_deliveries` / `mark_webhook_delivery_result` RPCs (exponential backoff: 1m → 5m → 30m → 2h → 12h, dead-letter at 5 attempts), HMAC-SHA256-signed dispatcher edge function | `supabase/migrations/20260509300000_outbound_webhooks.sql` + `supabase/functions/webhook-dispatcher/` | ✅ |
| Phase 4.4 — Streaming admin audit export (CSV/NDJSON, paged 500 rows/chunk, capped at 100k per request, admin-role gated) | `supabase/functions/admin-audit-export/` | ✅ |
| Phase 4.5 — `hasPermission(user, action, resource)` RBAC consolidation (current Admin/Client + TeamRole model wrapped, App.tsx admin gate + super-admin support gate migrated) | `lib/permissions.ts` (new) + `App.tsx` | ✅ |
| Phase 4.6.a — White-label theme tokens (`workspace_branding` table + `lib/branding.ts` with `loadBranding` / `applyBrandingToDocument` + auto-apply on user load in `App.tsx`) | `supabase/migrations/20260509500000_workspace_branding.sql` + `lib/branding.ts` + `App.tsx` | ✅ |

**Why these and not others.** Phase 1 had to be additive and reversible. Memory is foundational (everything in Phase 2 builds on it). Navigation pillars set the product story. Mission Control proves the AI-native pattern without removing the existing dashboard. Centralised AI config removes the friction tax on every future model upgrade. Nothing here touches the email send path, billing, RLS posture, or existing user data.

**What was *not* done and why:**

- **Replacing `ClientDashboard`.** Mission Control ships at `/portal/mission` as a new route. The default `/portal` index is unchanged. Cut over only after Mission Control gets validated with real users — A/B-testable today.
- **Wiring `buildMemoryContext` into the live Gemini calls in `lib/gemini.ts`.** Done as a one-liner in Phase 2 once we agree on which calls should consume memory (every call? only outreach generation? cost implications matter — every call adds 12 + 8 + 8 rows of prompt overhead).
- **pgvector / embeddings.** The memory schema reserves `embedding_meta` JSONB for a Phase 2 column add. We do not need vector search to ship Phase 2; tag/kind retrieval is sufficient until corpus size > a few hundred rows per workspace.

---

## Phase 2 — Realtime + Memory wiring (2–4 weeks)

**Scope:**

1. **Memory write hooks** — invoke `rememberLead` / `rememberCampaign` at three feedback points:
   - ✅ Email open + click + delivered + bounced events (`email-track`, `webhooks-sendgrid`, `webhooks-mailchimp`) → `lead_memory` `kind=interaction` via SECURITY DEFINER `log_lead_memory_email_event` RPC. Migration `20260508100000_lead_memory_email_tracking.sql`. Bot + Apple-privacy filtered. Fire-and-forget; never blocks tracking. **Shipped 2026-05-08.**
   - ✅ Sequence-run completion → `campaign_memory` `kind=outcome` via SECURITY DEFINER `log_campaign_memory_sequence_outcome` RPC. Migration `20260508200000_campaign_memory_sequence_outcome.sql`. Aggregates `email_events` for the run's messages, computes open/click/reply/bounce rates, headline `metric_value` is reply_rate (or open_rate fallback). Confidence weighted by audience size. Hourly pg_cron job `campaign-memory-outcome-sweep` picks up runs completed 48h+ ago that don't yet have an outcome row. Idempotent. **Shipped 2026-05-08.**
   - ✅ User feedback in AI Command Center (thumbs up/down on a generated message) → `workspace_memory` `kind=winning_pattern` (up) or `kind=avoid` (down). Captures the AI response, the preceding user prompt, and the active AI mode. Confidence 0.9 (explicit user signal). UI: lucide-react ThumbsUp/ThumbsDown buttons in `components/ai/MessageRow.tsx` action row, wired in `pages/portal/AICommandCenter.tsx`. Toggle behaviour: clicking the same thumb again clears local state (memory rows are kept — historical signal is preserved). **Shipped 2026-05-08.**
2. **Memory read in Gemini calls** — `lib/gemini.ts` `generateLeadContent`, `generateEmailSequence`, `generateLeadResearch` prepend `await buildMemoryContext({ workspaceId, leadId, campaignId, campaignKind })` to their system prompts. Add a feature flag `memory_context_enabled` in `workspace_memory` (kind=`feature_flag`) so workspaces can opt out if cost spikes.
3. **Realtime subscriptions where polling exists.** From the audit:
   - `useRealtimeJobs.ts` already exists — verify it's the canonical hook for `jobs` table updates.
   - `useRealtimeEmailRun.ts` already exists for `email_sequence_runs`. Sweep the codebase for any place still doing `useEffect + supabase.from(...).select()` on stale-data flows and migrate.
   - **Genuine polling is rare in this codebase** (see "Polling audit" below). The bigger lever is replacing `useQuery` `staleTime: 0` patterns with realtime invalidation.
4. **AI inference for Mission Control recommendations.** Replace the rule-list in `MissionControl.tsx` `buildRecommendations` with an LLM reasoner that consumes `buildMemoryContext` + leads + campaign metrics and returns a ranked action list. Cache the LLM call for 4–6 hours per user.

**Acceptance criteria:**
- Reply-rate uplift measurable on a memory-on cohort vs. memory-off baseline.
- Mission Control "Recommended for today" shows ≥ 1 LLM-generated rec per user.
- No `useEffect` data-fetching loop with `setInterval` survives in `lib/` or `pages/`.

**Blast radius:** Medium. Touches AI cost (every generation +N tokens of memory context) and the email send path's tracking webhook. Reversible via the `memory_context_enabled` feature flag.

### Polling audit (verified in Phase 1)

The polling story is already healthy. Greppable findings from `pages/`, `lib/`, `hooks/`:

| File:line | Pattern | Verdict |
|---|---|---|
| `lib/gemini.ts` (multiple) | `setTimeout(res, 1000 * attempt)` | Retry backoff. Keep. |
| `lib/gemini.ts` (multiple) | `setTimeout(() => controller.abort(), N)` | Request timeout. Keep. |
| `pages/portal/ProfilePage.tsx:182` | `setInterval(..., 1000)` | UI elapsed-time counter while enrichment runs. Not data polling. Keep. |
| `pages/portal/*.tsx` (toast pattern) | `setTimeout(() => setToast(null), N)` | Toast auto-dismiss. Keep. |
| `pages/portal/*.tsx` (copy-confirm) | `setTimeout(() => setCopied(false), 2000)` | Copy-to-clipboard feedback. Keep. |

**Conclusion:** there are zero unjustified data-polling loops in the client. The realtime story is already strong. Phase 2's "realtime work" is therefore not about replacing polling — it's about wiring **write-side events** into memory + Mission Control.

---

## Phase 3 — Outreach scale (4–8 weeks)

### Phase 3.1 — Sender health foundation (✅ shipped 2026-05-08)

Pure-additive groundwork. No send-path behavior changes. Every piece
lights up automatically once Phase 3.2 wires `send-email` to use it.

| Deliverable | File / Object |
|---|---|
| `email_messages.sender_account_id` (nullable FK) | migration `20260508300000_sender_health_foundation.sql` |
| `sender_accounts.{bounce_rate_7d, complaint_rate_7d, consecutive_failures}` | same migration |
| `email_dlq` table (RLS workspace-scoped, write-only by service role) | same migration |
| `compute_sender_health(sender_id)` SECURITY DEFINER | same migration |
| `sender_daily_cap(sender_id)` STABLE function (warmup ramp + health throttle) | same migration |
| `pick_outreach_sender(workspace_id)` STABLE function (health/utilisation ordering) | same migration |
| `refresh-sender-health` pg_cron job (hourly at :22) | same migration |

### Phase 3.2.1 — data migration + counters + DLQ wiring (✅ shipped 2026-05-08)

Reconnaissance ahead of this ship found 3 active `email_provider_configs`
rows (gmail+smtp), 1 pre-existing `sender_accounts` row, and **0 emails sent
in the last 30 days**. The zero-traffic finding made the blast radius
trivially small; this is a much safer window than the roadmap originally
anticipated.

| Deliverable | File / Object |
|---|---|
| Idempotent migration `email_provider_configs` → `sender_accounts` + `sender_account_secrets` (deduped on `(workspace_id, provider, from_email)` UNIQUE) | `supabase/migrations/20260508500000_send_path_data_migration.sql` |
| `reset_sender_failures(sender_id)` + `increment_sender_failures(sender_id)` SECURITY DEFINER RPCs | same migration |
| `send-email` populates `email_messages.workspace_id` + `sender_account_id` on insert; calls `increment_sender_daily_sent` + `reset_sender_failures` on success; `increment_sender_failures` on failure | `supabase/functions/send-email/index.ts` |
| `webhooks-sendgrid` writes `email_dlq` rows on `hard_bounce` (status 5xx), `spam_complaint`, `unsubscribed` | `supabase/functions/webhooks-sendgrid/index.ts` |
| `webhooks-mailchimp` writes `email_dlq` rows on `hard_bounce`, `spam`, `unsub` | `supabase/functions/webhooks-mailchimp/index.ts` |

What this earns: the Phase 3.1 sender-health functions now get real data
the moment any send happens; `email_dlq` starts collecting unrecoverable
failures; `consecutive_failures` ticks correctly so the circuit breaker
in `sender_daily_cap` becomes load-bearing.

What's still pending: send-email continues to read **credentials** from
`email_provider_configs` (legacy). Phase 3.2.2 below flips that.

### Phase 3.2.2 — credential source swap (✅ shipped 2026-05-09)

`send-email` now reads credentials from `sender_account_secrets` first
(joined to `sender_accounts` so `from_email` / `from_name` come from the
public side), falling back to the legacy `email_provider_configs` path
on any miss. New helper `loadSenderAccountCreds(senderAccountId)` returns
`null` whenever:
- the sender_accounts row is missing
- the sender_account_secrets row is missing
- there's no usable cred field (no api_key AND no SMTP host+user)

Defensive design: a failure of the canonical path never breaks sending.
The legacy path catches every edge case until enough send volume gives
us confidence to drop it.

The `sender_account` lookup ordering is: matching `from_email` (if the
caller specified one) → `is_default DESC` → `health_score DESC`.
This means without an explicit `from_email`, the workspace's default
sender (or the healthiest one) is used.

NOT in this ship (deferred to Phase 3.2.3):
- Hard-fail pre-flight cap check (`daily_sent < daily_cap`)
- `pick_outreach_sender` for requests that don't supply a provider

### Phase 3.2.3 — caps + auto-pick (✅ shipped 2026-05-09)

`send-email` now auto-picks the best sender when the caller doesn't supply
a `provider`, and hard-fails on a 429 when the resolved sender is at its
daily cap or quarantined. Both behaviors only apply when a
`sender_account_id` resolved — legacy `email_provider_configs` callers
see no change.

**Auto-pick.** If `body.provider` is null/empty, calls
`pick_outreach_sender(workspace_id)` and uses the returned
`provider` + `from_email` + `sender_account_id`. The RPC orders by
`health_score DESC` and least utilisation, so the auto-picked sender
is the healthiest workspace-bound sender that isn't quarantined.

**Cap pre-flight.** When `sender_account_id` is resolved (whether via
auto-pick or via the existing fallback lookup), `sender_daily_cap` and
`get_sender_daily_sent` are queried in parallel. Two error paths:

- `cap === 0` (sender quarantined, health < 25): 429 with code
  `sender_quarantined` + the offending `sender_account_id`.
- `daily_sent >= daily_cap`: 429 with code `sender_at_cap` plus
  `daily_sent` + `daily_cap` for the caller to surface a clear UX.

Cap-check failure (RPC errors) logs a warning and ALLOWS the send —
observability over availability — so a transient Postgres issue can
never silently block the revenue pipeline.

### Phase 3.2.4+ — remaining cleanup (deferred)

The high-blast piece. Until shipped, `send-email/index.ts` continues to
read from legacy `email_provider_configs` and `email_messages.sender_account_id`
remains null for new rows.

**Required scope — all complete:**
1. ✅ Migrate `email_provider_configs` → `sender_accounts` / `sender_account_secrets` (Phase 3.2.1)
2. ✅ Read creds from `sender_account_secrets` via service role (Phase 3.2.2)
3. ✅ `email_messages.sender_account_id` populated on insert (Phase 3.2.1)
4. ✅ `email_dlq` writes wired in both webhook handlers (Phase 3.2.1)
5. ✅ `consecutive_failures` reset/increment (Phase 3.2.1)
6. ✅ Use `pick_outreach_sender` when caller doesn't supply provider (Phase 3.2.3)
7. ✅ Pre-flight check `daily_sent < daily_cap` and bail with explicit error if at cap (Phase 3.2.3)

**Acceptance criteria:** Health scores trend with real bounce/spam rates;
warmup ramp visible on freshly-enrolled accounts; one sender suspended
(health < 25) → traffic auto-shifts within one cron tick.

### Phase 3.3+ — original Phase 3 scope (still planned, not started)

**Why this phase exists:** Today's email pipeline is `process-email-writing-queue` + `process-scheduled-emails` + `send-email`, dispatched serially per scheduled tick. At ~10 customers × 1k leads × 3-step sequence, this works. At ~100 customers × 5k leads × 7-step sequence, it bottlenecks on (a) Gemini rate limits, (b) provider rate limits, (c) sender reputation.

**Scope:**

1. **Queue priorities.** Push BullMQ queue layer in `backend/` to its full potential:
   - `outreach-write` (priority by deal size / lead score)
   - `outreach-send` (priority by warmup status)
   - `outreach-retry` (transient bounces, delayed)
   - `outreach-dlq` (hard bounces, alert)
2. **Sender rotation + warmup.** `sender_accounts` already exists; add:
   - `sender_account_health` table tracking 7-day spam complaint rate, bounce rate, daily volume cap.
   - Warmup ramp: new accounts capped at 50/day rising to 500/day over 21 days.
   - Round-robin selection weighted by health.
3. **Provider failover.** If Gmail OAuth fails, fall back to SendGrid (or vice versa) for the same workspace. Existing `connect-*` edge functions already enroll multiple providers.
4. **Concurrency control.** Per-workspace rate limit (currently global). Per-domain rate limit on recipient side (don't blast 50 emails into the same MX in 30s).

**Acceptance criteria:**
- Workspace-level send concurrency configurable from `/admin/pricing`.
- One sender suspended → traffic auto-shifts within 60 s.
- DLQ inspectable from `/admin/ops` with replay button.

**Blast radius:** High. This is the revenue path. Recommend doing on a feature branch with a parallel "shadow send" that compares old vs. new before cutting over.

---

## Phase 4 — Enterprise readiness (6–12 weeks)

### Phase 4.1 — Public API foundation (✅ shipped 2026-05-09)

Personal access tokens (PATs) for the public REST API. Plaintext is never
stored at rest — only the SHA-256 hash and the first 12 chars (for UI
display). Plaintext is returned to the user exactly once at create time.

| Component | File / Object |
|---|---|
| `api_keys` table (workspace-scoped RLS) | `supabase/migrations/20260509200000_api_keys.sql` |
| `create_api_key(workspace_id, label, plaintext, scopes, expires_at)` SECURITY DEFINER | same migration |
| `verify_api_key(plaintext)` SECURITY DEFINER (service-role only) | same migration |
| `revoke_api_key(id)` SECURITY DEFINER | same migration |
| `_shared/api-auth.ts` — middleware for any `v1-*` edge function | `supabase/functions/_shared/api-auth.ts` |
| `v1-leads` first endpoint (cursor-paginated, scope `leads.read`) | `supabase/functions/v1-leads/index.ts` |
| `/portal/api-keys` page (mint / list / revoke, plaintext modal) | `pages/portal/ApiKeysPage.tsx` |

**Token format:** `scal_<43-char base64url>` (32 random bytes, browser-side
mint, sha-256 hashed before storage).

**Auth flow:**
```
GET /functions/v1/v1-leads
Authorization: Bearer scal_aBcDeF...

→ _shared/api-auth.ts
   1. Header parse + format check                        (401 invalid_key)
   2. verify_api_key RPC (service-role hash lookup)      (401 invalid_key)
   3. In-memory rate limit: 60 req/min/key               (429 rate_limited)
   4. Required scope check                               (403 missing_scope)
   → workspace_id + scopes returned to handler
```

**Scopes available:** `leads.read`, `leads.write`, `campaigns.read`,
`campaigns.write`, `analytics.read` (only `leads.read` enforced today).

### Phase 4.2+ — additional endpoints + key rotation UX (deferred)

Adding more `v1-*` endpoints follows the same pattern: import
`authenticateApiKey`, declare `requiredScope`, query the data scoped to
`auth.workspaceId`. Patterns owed:

- `v1-sequences`, `v1-campaigns`, `v1-analytics`, `v1-leads` (POST/PATCH)
- OpenAPI 3.1 spec generation
- Postgres-backed rate limiting (current is per-worker in-memory)
- Webhook signing secret rotation flow when 4.3 ships

### Phase 4.3+ — outbound webhooks (still owed)

**Scope:**

1. **SSO / SAML.** Supabase Auth doesn't natively do SAML — three options:
   - (a) Layer WorkOS on top (fastest, ~2 weeks).
   - (b) Use Supabase's "External Auth" with a pre-validated JWT from an IdP gateway.
   - (c) Roll our own SAML responder edge function (longest, most control).
   Recommend (a) for first enterprise deals; revisit (c) at scale.
2. **Public API + key management.**
   - `/api/v1/leads`, `/api/v1/sequences`, `/api/v1/campaigns` — REST + cursor-paginated.
   - Personal access tokens stored in a new `api_keys` table with scoped permissions, hashed-at-rest, rotation policy.
   - Rate limit per key (separate from user JWT path).
3. **Webhook outbound management.**
   - `webhooks_outbound` table: workspace_id, url, secret, event_filter, retries.
   - Sign payloads with HMAC; document `X-Scaliyo-Signature`.
   - Retry with exponential backoff up to 24 h.
4. **Audit exports.** `audit_logs` already exists (per `20260302000001_teamhub_v2_audit_log_upgrade.sql`). Add a streaming export edge function (CSV / JSON) gated to admins, plus a schedulable export-to-S3 hook for SOC2.
5. **RBAC improvements.** Today: Admin / Client / TeamRole. Add: Org Admin, Workspace Admin, Member, Viewer. Replace ad-hoc role checks with a single `hasPermission(user, action, resource)` helper.
6. **White-label.** Theme tokens (logo, colors, domain) stored per workspace; rendered into the SPA via a CSS-vars layer. The Nginx config already supports `app.scaliyo.com`; whitelabel tenants get CNAME-mapped vanity domains.

**Acceptance criteria:**
- One enterprise pilot live on SSO + their own subdomain.
- Public API with at least three endpoints documented (OpenAPI 3.1).
- Audit export downloadable from admin console.

**Blast radius:** Medium. SSO is the highest-blast item — easy to break login for everyone if the redirect handling is wrong. Roll out gated by domain.

---

## Phase 5 — Service decomposition (8–12 weeks)

**Premise:** Today the backend is one Express + BullMQ worker plus 30 edge functions. That's fine. **Don't decompose until you have data showing a specific bottleneck.** Premature service splits cost a quarter and add ops complexity for no scale benefit.

**When to split (decision criteria, not a timeline):**

| Trigger | Service to extract |
|---|---|
| AI generation queue depth > 5 min p95 | **AI Engine** (separate worker pool, GPU-adjacent if needed) |
| Email send latency > 30 s p95 sustained | **Outreach Engine** (separate worker, per-region presence) |
| Analytics query > 2 s on Supabase pg | **Analytics Engine** (read replica + materialised views) |
| Concurrent realtime subscriptions > 10k | **Realtime Gateway** (dedicated WS layer in front of Supabase realtime) |

**Scope (when triggered):** extract into TypeScript packages first (monorepo structure), then optionally into separate deployments. Keep the contract Postgres-row-based via outbox tables — don't introduce a new RPC fabric until you have to.

---

## Phase 6 — Goal-based AI automation (depends on Phase 2 + Phase 5)

**Premise:** Today's automations are `Trigger → Condition → Action`. Goal-based automations are `Goal → Plan → Execute → Observe → Replan`. This is the venture-scale moat — but it requires Phase 2 (memory) and ideally Phase 5 (extractable AI Engine) to be in place first.

**Scope:**

1. **Goal table.** `automation_goals(id, workspace_id, statement, target_metric, target_value, due_at, status)` — e.g. statement="Book 10 SaaS demos", metric=`meetings_booked`, target=10.
2. **Planner.** LLM call that decomposes a goal into a sequence of automation steps with checkpoints. Stored in `automation_plans` with versioning.
3. **Executor.** Runs each step using existing automation primitives (Apollo search → enrichment → sequence start → wait for response → score).
4. **Observer.** After each checkpoint, compares outcome to target. If off-track, calls the Replan LLM.
5. **Memory feedback.** Plans that succeed get written to `workspace_memory` `kind=winning_pattern`. Plans that fail get written to `kind=avoid`. The Planner reads both.

**Acceptance criteria:**
- One worked example end-to-end: "Book 10 SaaS demos" → 10 meetings booked, all triggered by a single user goal entry.
- Replanner adjusts mid-flight at least once based on observed metrics.

**Blast radius:** Highest. This is the most novel surface and the most failure-prone. Build behind a feature flag, opt-in only for design-partner customers.

---

## Architecture map (target end state)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        scaliyo.com (marketing)                           │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      app.scaliyo.com  (React SPA)                        │
│   Mission Control · Acquire · Engage · Convert · Intelligence            │
│                       Cmd+K command palette                              │
└──────────────┬───────────────┬─────────────────┬────────────────────────┘
               │ JWT           │ JWT             │ JWT
               ▼               ▼                 ▼
┌────────────────────┐ ┌────────────────┐ ┌─────────────────────────────┐
│  Supabase Auth     │ │ Supabase REST  │ │ Supabase Realtime           │
│  (+ SSO via WorkOS)│ │ (RLS-scoped)   │ │ (jobs / runs / memory tail) │
└────────────────────┘ └─────┬──────────┘ └─────────────────────────────┘
                             │
                  ┌──────────┴───────────────────────────────────┐
                  ▼                                              ▼
          ┌───────────────┐                            ┌───────────────────┐
          │ Postgres      │                            │  Edge Functions   │
          │ (RLS, pgcron) │                            │  (gemini-proxy,   │
          │ ────────────  │                            │   billing-*,      │
          │ workspaces    │                            │   send-email,     │
          │ leads         │                            │   apollo-*,       │
          │ workspace_mem │                            │   social-*,       │
          │ lead_memory   │                            │   image-gen)      │
          │ campaign_mem  │                            └─────────┬─────────┘
          │ jobs/queues   │                                      │
          └──────┬────────┘                                      ▼
                 │                                     ┌──────────────────┐
                 ▼                                     │  Google Gemini   │
       ┌──────────────────┐                            │  + Imagen        │
       │ Backend worker   │                            └──────────────────┘
       │ (Express+BullMQ) │
       │ ai-queue         │   ── Phase 5 split:        ┌──────────────────┐
       │ data-queue       │   AI Engine (separate)     │  Stripe          │
       │ research/cheerio │   Outreach Engine          │  ElevenLabs      │
       └──────────────────┘   Analytics Engine         │  Apollo          │
                                                       │  LinkedIn / Meta │
                                                       └──────────────────┘
```

The bold lines (workspace_mem / lead_memory / campaign_mem) are net-new in Phase 1. The "Phase 5 split" lanes are dotted — extract only when triggered.

---

## Decisions needed before Phase 2 starts

I'm flagging these so we can discuss before sinking work into them:

1. **Memory context cost.** Every Gemini call carries an extra ~500–2,000 tokens of memory context. At Free-tier 200 credits/month, this matters. Two options:
   - (a) Apply only to `outreach generation` calls (highest-leverage), not lead research / blog / dashboard insights.
   - (b) Apply universally; raise plan credit limits to compensate.
2. **Mission Control as default `/portal`.** When do we cut over from `ClientDashboard` to `MissionControl` as the index route? Recommend: behind a feature flag for 2–4 weeks, then default-on, then remove `ClientDashboard` after 4 weeks of zero rollback events.
3. **SSO vendor.** WorkOS vs. Auth0 vs. Cognito vs. building on Supabase's own. Affects pricing model + lock-in.
4. **Public API surface.** Read-only first, or read+write? Read-only ships faster but converts fewer Enterprise pilots.
5. **Whitelabel scope.** Just colors/logo, or full vanity domain? Vanity domain needs CNAME + per-tenant TLS via Let's Encrypt automation.

---

## Out of scope for this overhaul (deliberately)

- **Mobile native app.** The mobile portal under `/portal/mobile` is a responsive React shell. A native app is a separate product. Not on this roadmap.
- **Full migration consolidation.** The 65 timestamped migrations + ~20 legacy `supabase-*.sql` files at `AuraEngine/` root are messy but not broken. Consolidating them is busywork until we hit Postgres limits.
- **Replacing the Strategy Hub.** `strategy_tasks` / `strategy_notes` are flagged for product decision in `20260413400000_drop_orphan_tables.sql`. That decision happens before any related code changes — ask the product owner.
- **Voice agent rebuild.** ElevenLabs integration works. Phase 2 may add memory awareness; full rebuild is not justified by current usage data.

---

*Generated 2026-05-08 against git HEAD `853ea41`. Owner: Engineering. Update this file at the end of every phase.*
