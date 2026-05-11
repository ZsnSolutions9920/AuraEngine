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
| Webhook UI (`/portal/webhooks`) — list endpoints with status/failure badges, expandable per-endpoint deliveries panel with retry, create modal with event-type multi-select, "save the secret now" reveal modal, send-test button | `pages/portal/WebhooksPage.tsx` + `lib/webhooks.ts` (CRUD helpers + `mintWebhookSecret`) | ✅ |
| Branding settings UI (`/portal/branding`) — logo upload (reuses `uploadBase64Image`), favicon/email-logo URL inputs, primary/accent/background color pickers (with hex input + clear), product name + support email, side-by-side live preview, save-and-apply | `pages/portal/BrandingPage.tsx` | ✅ |
| Webhook event triggers — 7 SQL `AFTER` triggers fan out via `queue_webhook_event`: `lead.created`, `lead.updated` (status changes), `sequence.completed`, `email.sent`, `email.bounced`, `email.spam_complaint`, `email.unsubscribed`. All wrapped in `EXCEPTION WHEN OTHERS RAISE WARNING` so a fan-out failure can never block the underlying mutation. | `supabase/migrations/20260510000000_webhook_event_triggers.sql` | ✅ |
| `hasPermission()` sweep — replaced ad-hoc `is_super_admin` checks in `AdminLayout.tsx` (Support Console nav gate) and `SupportProvider.tsx` (isSuperAdmin computation) with `canEnterSupport()`. Display labels (e.g., "Administrator" vs "Client Node") deliberately left as-is since they're presentational, not access gates. | `components/layout/AdminLayout.tsx`, `components/support/SupportProvider.tsx` | ✅ |
| Phase 4.3 (cron) — webhook dispatcher auto-invoked every minute via pg_net. `invoke_webhook_dispatcher()` SECURITY DEFINER reads service-role key from `supabase_vault`, POSTs to the dispatcher edge function. Vault secret provisioned out-of-band (one-shot temp migration deleted post-apply, never enters git history). | `supabase/migrations/20260510100000_webhook_dispatcher_cron.sql` | ✅ |
| Phase 4.2 (writes) — `POST /v1-leads` with idempotency. New `api_idempotency` table keyed on `(workspace_id, key)`, body-hash-verified, 24h TTL with hourly purge cron. v1-leads now serves both GET (leads.read) and POST (leads.write) with validation: at-least-one-identifier, status enum, score 0..100. Idempotent replays return the original response with `X-Scaliyo-Idempotent-Replay: true`. Same-key + different-body = 409 `idempotency_conflict`. | `supabase/migrations/20260510200000_api_idempotency.sql` + `supabase/functions/v1-leads/index.ts` rewrite | ✅ |
| Phase 4.6.b (foundation) — Vanity domain schema + DNS verification. `workspace_domains` table (workspace_id, domain unique-lower, verification_token, status, is_primary). `add_workspace_domain` RPC mints a 16-byte hex token. `verify-domain` edge function does parallel DoH lookups for TXT `_scaliyo-verify.<domain>` (matching token) OR CNAME pointing at `app.scaliyo.com`/`scaliyo.com`. TLS provisioning + Nginx server-block templating intentionally deferred to next session. | `supabase/migrations/20260510300000_workspace_domains.sql` + `supabase/functions/verify-domain/` | ✅ |
| Phase 4.6.b (TLS) — Vanity-domain Nginx + Let's Encrypt automation. ACME catch-all on default_server serves `/.well-known/acme-challenge/` for any host. `provision-vanity-domain.sh` + `poll-vanity-domains.sh` + `install-vanity-tls.sh` shell scripts (NOPASSWD-scoped sudo for `certbot` and `nginx`). `provisioned_at` + `cert_expires_at` + `last_provision_error` columns on `workspace_domains`. `mark_domain_provisioned`/`mark_domain_provision_failed` RPCs. `/portal/branding` Custom-domain section with add/verify/DNS instructions/cert status. | `supabase/migrations/20260510400000_workspace_domain_provisioning.sql`, `nginx/aurafunnel.conf`, `scripts/{vanity-server-block.conf.tmpl, provision-vanity-domain.sh, poll-vanity-domains.sh, install-vanity-tls.sh}`, `lib/domains.ts`, `pages/portal/BrandingPage.tsx`, `App.tsx` no-op, `.github/workflows/deploy.yml` | ✅ |
| DB refinement pass #3: 5 missing indexes (`lead_tag_assignments` × 2, `team_invites` × 2 incl. `WHERE status='pending'` partial, `workspaces.owner_id`, `usage_counters` composite) + backfill of 20 historical `email_messages.workspace_id` nulls via `workspace_members` + flip to `NOT NULL` | `supabase/migrations/20260510500000_db_refinement_pass3.sql`, `supabase/migrations/20260510600000_email_messages_workspace_id_not_null.sql` | ✅ |
| Repo hygiene: gitignore `lib/**/*.js` + `*.d.ts`; remove stale `leadFieldMapper.{js,d.ts}` artifacts | `AuraEngine/.gitignore` | ✅ |
| Pre-login branding from Host header — `get_branding_by_domain(p_domain)` SECURITY DEFINER RPC granted to `anon`; SPA `loadBrandingByHost(host)` lib helper; `App.tsx` runs once at mount before auth resolves and applies CSS vars + favicon + product name. Returns null on platform hosts (scaliyo.com / app.scaliyo.com / localhost). Phase 4.6.b finally has its branded login experience. | `supabase/migrations/20260511000000_get_branding_by_domain.sql` + `lib/branding.ts` + `App.tsx` | ✅ |
| CI deploy.yml hardening: removed `continue-on-error: true` from Nginx sync step (failures now surface); added `set -euxo pipefail` + diagnostic `ls -la` / `id` to the Sync scripts/ step for the next deploy that touches scripts/ | `.github/workflows/deploy.yml` | ✅ |
| Phase 4.2 write API expansion: `PATCH /v1-leads?id=<uuid>` + `POST /v1-sequences` + `PATCH /v1-sequences?id=<uuid>`, all with same idempotency pattern (sha256 of `METHOD:id:body`, 24h cache, replay-on-match, 409-on-conflict). Workspace-scoped via FK constraint in the UPDATE so cross-workspace UUID guessing is blocked. | `supabase/functions/v1-leads/index.ts`, `supabase/functions/v1-sequences/index.ts` | ✅ |
| OpenAPI 3.1 spec extended with the new endpoints + `IdempotencyKey` parameter + `BadRequest`/`Conflict` responses + `LeadCreate`/`LeadPatch`/`SequenceCreate`/`SequencePatch` schemas | `docs/api/openapi.yaml` | ✅ |
| `/portal/api-docs` in-app API reference page — bespoke renderer with curl-runnable examples, method-color badges, scope chips, copy-to-clipboard, error-code table. Cross-linked from `/portal/api-keys`. | `pages/portal/ApiDocsPage.tsx` + `App.tsx` route | ✅ |
| Phase 6.1 — Goal-based AI automation: storage layer (`automation_goals` + versioned `automation_plans` + `store_plan_version` RPC), LLM planner (`generateGoalPlan` with 8 canonical primitives + JSON response schema + memory-context injection), `/portal/goals` UI with create modal, expandable plan panel, version history. Executor / Observer / Memory-feedback loop are 6.2+. | `supabase/migrations/20260511100000_automation_goals.sql` + `lib/goals.ts` + `pages/portal/GoalsPage.tsx` + `App.tsx` route + `lib/navConfig.ts` (added "Goals" under CONVERT pillar) | ✅ |
| Phase 6.2.a — Dry-run executor: `automation_step_runs` table, `goal-executor` edge fn (topo-sort + per-step stub handlers, all 8 primitives simulated, `live` mode 403'd), `runPlanPreview` lib helper, "Run preview" button + per-step status pills in `/portal/goals`. Zero real side effects — Phase 6.2.b wires safe primitives for real. | `supabase/migrations/20260511200000_automation_step_runs.sql` + `supabase/functions/goal-executor/` + `lib/goals.ts` + `pages/portal/GoalsPage.tsx` | ✅ |
| Phase 6.2.b — Live executor (partial): `workspace_feature_flags` table + `workspace_has_flag` RPC; goal-executor live mode gated on `goal_executor_live` flag; real Apollo search + checkpoint evaluation; other primitives stubbed with explicit "deferred" messages. UI: live toggle in header (with confirm) + "Run live" button on goal cards. | `supabase/migrations/20260511300000_workspace_feature_flags.sql` + `supabase/functions/goal-executor/index.ts` rewrite + `lib/goals.ts` + `pages/portal/GoalsPage.tsx` | ✅ |
| Phase 6.2.c — Remaining safe primitives: `enrich_leads` (Gemini per lead, cap 20), `lead_score` (Gemini ICP with JSON response, cap 50), `team_task` (auto-creates "AI Goals" board + "To Do" list, inserts card), `wait` (≤30s inline / longer persists not_before + paused goal + cron resume). New `claim_resumable_goal_step_runs` RPC + `resume-paused-goals` pg_cron (every 5 min) + executor resume mode. | `supabase/migrations/20260511400000_phase_6_2_c.sql` + `supabase/functions/goal-executor/index.ts` rewrite | ✅ |
| Phase 6.2.d (skeleton) — `email_sequence` + `social_post` routed through gate check on `goal_executor_send_email` / `goal_executor_send_social` workspace flags. Both still stubbed (no actual send) — next ship wires the real send path. | `supabase/functions/goal-executor/index.ts` `liveGatedStub` | ✅ |
| Phase 6.3 (skeleton) — Hourly `observe-goal-drift` pg_cron detects 3 drift kinds (past_due_with_unmet_target, paused_too_long, stalled_running) and writes `workspace_memory(kind='observation')` rows. 24h de-dup. | `supabase/migrations/20260511500000_goal_observer.sql` | ✅ |
| Phase 6.4 — Memory feedback loop: `log_goal_outcome_to_memory` TRIGGER on `automation_goals` status → terminal, writes `winning_pattern` (completed) or `avoid` (failed/cancelled) to `workspace_memory` with plan summary + step-run aggregate. Confidence weighted by step count. `generateGoalPlan` already reads these — the loop is closed. | `supabase/migrations/20260511400000_phase_6_2_c.sql` (trigger lives here for cohesion with 6.2.c migration) | ✅ |

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

### Phase 6.1 — Goal storage + Planner + UI (✅ shipped 2026-05-11)

The first slice of the venture-scale moat. Customers can state a goal
in plain language; the AI generates a structured plan grounded in
workspace memory. Plans are versioned and stored. Execution is **not**
wired yet — that's Phase 6.2.

| Component | File / Object |
|---|---|
| `automation_goals` table (workspace-scoped RLS, status state machine) | `supabase/migrations/20260511100000_automation_goals.sql` |
| `automation_plans` table (versioned, JSONB plan body, one active per goal) | same migration |
| `store_plan_version()` SECURITY DEFINER RPC — atomic deactivate-prior + version-bump + insert + status advance | same migration |
| 8 canonical primitives — `apollo_search`, `enrich_leads`, `lead_score`, `email_sequence`, `social_post`, `team_task`, `wait`, `checkpoint` | `lib/goals.ts` `PRIMITIVE_KINDS` |
| `generateGoalPlan()` LLM planner — system prompt enforces primitive constraint, response is JSON, workspace memory injected from `buildMemoryContext` (winning_pattern + avoid + tone + preferences) | `lib/goals.ts` |
| `planAndStoreFromGoal()` convenience — wraps status transitions (draft → planning → planned/draft on failure) | `lib/goals.ts` |
| `/portal/goals` UI — list goals with progress bars + status pills, create modal (statement + metric + target + due + guardrails), per-goal expandable plan panel with step-by-step rendering, risks, assumptions, version history | `pages/portal/GoalsPage.tsx` |
| Nav entry under CONVERT pillar | `lib/navConfig.ts` |

What this earns: customers can today articulate a sales outcome in
the UI, watch the AI decompose it into a plan with ~3-12 steps citing
specific automation primitives, and review/replan if the plan looks
off. The plan is descriptive only — no automation runs from it until
6.2.

### Phase 6.2.a — Dry-run executor (✅ shipped 2026-05-11)

The orchestrator skeleton with all primitives stubbed. Zero real
side effects: no Apollo searches, no email sends, no social posts.
Lets customers see step-by-step what an active plan WOULD do,
validating planner output before Phase 6.2.b wires real execution.

| Component | File / Object |
|---|---|
| `automation_step_runs` table (service-role write only; users see status via SELECT-only policy) | `supabase/migrations/20260511200000_automation_step_runs.sql` |
| `set_goal_status` + `advance_goal_progress` RPCs | same migration |
| `goal-executor` edge function: topo-sort steps, walk in dep order, write step run rows | `supabase/functions/goal-executor/` |
| 8 primitive stub handlers (apollo_search, enrich_leads, lead_score, email_sequence, social_post, team_task, wait, checkpoint) returning shaped "would have done X" payloads | same edge fn |
| `live` mode explicitly rejected with 403 `live_not_enabled` (gated until 6.2.b) | same edge fn |
| `lib/goals.ts` `runPlanPreview()` + `listStepRunsForPlan()` + `AutomationStepRun` type | `lib/goals.ts` |
| `/portal/goals` "Run preview" button + per-step status pill + preview output rendering | `pages/portal/GoalsPage.tsx` |
| Goal status state expanded: `running` added | migration ALTER + lib type |

**Safety posture:** the executor never invokes another edge function,
never writes to leads / email_messages / email_sequence_runs / any
prospect-facing table. The only mutations are on
`automation_step_runs` (its own state) and `automation_goals`
(status + progress). Service-role-only writes prevent client-side
fabrication of "this step succeeded".

### Phase 6.2.b — Live executor, partial (✅ shipped 2026-05-11)

Gated live execution for the two safest primitives. Every other
primitive remains stubbed in live mode with a clear "deferred to
Phase 6.2.c" message so the goal status accurately reflects partial
completion.

| Component | File / Object |
|---|---|
| `workspace_feature_flags` table + `workspace_has_flag(workspace_id, flag_key)` SECURITY DEFINER lookup | `supabase/migrations/20260511300000_workspace_feature_flags.sql` |
| `goal-executor` refactor: `mode='live'` gated on `goal_executor_live` flag; returns 403 `live_not_enabled` if off | `supabase/functions/goal-executor/index.ts` |
| Live `apollo_search` handler: invokes existing apollo-search edge fn with the user's JWT (consumes their Apollo credits); stores top 5 results + pagination in step_run.output | same edge fn |
| Live `checkpoint` handler: queries one of 5 supported metrics (`leads_total`, `leads_new_30d`, `qualified_leads`, `emails_sent_in_range`, `active_sequences`) and compares to threshold | same edge fn |
| Live deferred stub for `wait`, `enrich_leads`, `lead_score`, `team_task`: status='skipped' with explicit "Phase 6.2.c" message | same edge fn |
| Live always-gated for `email_sequence`, `social_post`: same skipped stub with "Phase 6.2.d" message | same edge fn |
| `isLiveModeEnabled` / `setLiveModeEnabled` / `runPlanLive` lib helpers | `lib/goals.ts` |
| `/portal/goals` Live toggle in header (with confirmation) + "Run live" button on goal cards (visible only when flag on) | `pages/portal/GoalsPage.tsx` |

**Safety posture:** Live mode still NEVER writes to `leads`,
`email_messages`, `email_sequence_runs`, or any prospect-facing
table. The only side effects of running a plan in live mode today
are: (1) one or more Apollo API calls (consuming the workspace's
Apollo credits), and (2) read-only metric queries for checkpoint
evaluation.

### Phase 6.2.c — Remaining safe primitives (✅ shipped 2026-05-11)

All four primitives wired for real execution behind the
`goal_executor_live` flag:

| Primitive | Implementation |
|---|---|
| `enrich_leads` | Picks up to 20 leads with empty `insights`; calls Gemini per lead with a B2B research prompt; writes back to `leads.insights`. |
| `lead_score` | Picks up to 50 unscored leads; Gemini ICP scoring with strict JSON response; writes `leads.score` + tracks hot/warm/cold counts. |
| `team_task` | Auto-creates a workspace "AI Goals" board + "To Do" list on first use; inserts a `teamhub_cards` row with the planner's title + description. |
| `wait` | ≤30s waits sleep inline. Longer waits persist `not_before` on the step run, transition the goal to `paused`, and exit. A pg_cron worker (`resume-paused-goals`, every 5 min) detects ready steps via `claim_resumable_goal_step_runs` and re-invokes the executor in resume mode. |

Resume mode is supported by the executor itself: with `body.resume=true`,
it skips step_runs that already have a terminal status, then continues
from the first `pending` step (the one the cron just claimed).

### Phase 6.2.d — email_sequence + social_post gates (skeleton ✅ shipped)

Two new feature flags reserved:
  `goal_executor_send_email`
  `goal_executor_send_social`

Live executor now routes these primitives through `liveGatedStub()`:
  - Flag off: `skipped` with "requires workspace flag X" error blurb
  - Flag on: `skipped` with "flag enabled but send wiring not yet shipped"

This is honest about the boundary: enabling the flag is opt-in, but
actual send wiring is the next-session ship. No customer can
accidentally send emails today.

### Phase 6.3 — Observer (skeleton ✅ shipped 2026-05-11)

Hourly `observe-goal-drift` pg_cron job scans active / running / paused
goals and detects three drift signals:
  - `past_due_with_unmet_target` — past `due_at` with progress < target
  - `paused_too_long` — paused > 12h (cron resume should have unstuck)
  - `stalled_running` — running but no step_run completion in 6h

Each observation writes a `workspace_memory(kind='observation')` row,
de-duped per goal+kind on a 24h window. The next planner / replanner
call reads these via `buildMemoryContext`.

### Phase 6.3.b — LLM replanner (NOT YET)

The auto-replan loop: when an observation indicates drift, generate a
new plan version with the prior plan + actual outcomes + observations
in context. Mark prior `is_active=false` with `superseded_reason='replan'`.

### Phase 6.4 — Memory feedback loop (✅ shipped 2026-05-11)

`log_goal_outcome_to_memory()` TRIGGER fires on
`automation_goals.status` transitions to a terminal state. Writes a
`workspace_memory` row with `kind='winning_pattern'` (completed) or
`kind='avoid'` (failed/cancelled), payload includes the plan summary,
step-run aggregate counts, and the goal's target metric.

Confidence weighted by step count (≥5 = 0.85, ≥3 = 0.70, else 0.55) so
the planner trusts longer-run outcomes more.

Future `generateGoalPlan` calls already pull
`kind=winning_pattern + avoid` via `buildMemoryContext` — the loop is
fully closed.

### Phase 6.3 — Observer + Replanner (NOT YET)

Periodic job that evaluates each active goal's checkpoints. If a
checkpoint metric is missed, calls the LLM replanner to generate a
new plan version (stored as `created_by_kind='replanner'`). The
replanner gets the prior plan + actual outcomes + memory.

### Phase 6.4 — Memory feedback loop (NOT YET)

On goal completion: write `workspace_memory kind='winning_pattern'`
with the successful plan and outcomes. On goal failure / cancellation:
write `kind='avoid'` with reasons. Closes the loop so future planner
runs get smarter automatically.

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
