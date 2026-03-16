# HANDOFF.md — Arkova Phase 3/4 Living State

> **Initialized:** 2026-03-14
> **Purpose:** Track exact project state through Phase 3 (Go-Live) and Phase 4 (Verification API). Replaces MEMORY.md as the active state file. Historical context preserved in `ARCHIVE_memory.md`.
> **Update frequency:** After every significant session or decision.

---

## Current State

### Active Phase: Phase 3 — Go-Live (Production Launch) + P8 AI Intelligence (infrastructure done)

**Goal:** Production launch of Phase 1 credentialing MVP + AI infrastructure foundation
**Methodology:** TDD (Red-Green-Refactor) + Architecture-first (sequential-thinking) + Security self-review + Playwright UI verification
**Overall progress:** 146/163 stories complete (90%). 1,538+ tests. 60 migrations (0001-0060, 0033 skipped). P4.5 COMPLETE (13/13). P8: 15/19 (79%). GEO: 4 complete, 3 partial, 5 not started.

### Open Blockers

| ID | Issue | Severity | Status | Next Action |
|----|-------|----------|--------|-------------|
| ~~CRIT-2~~ | ~~Bitcoin chain client~~ | ~~**OPS-ONLY**~~ | ~~CODE COMPLETE~~ | ~~AWS KMS key provisioning, mainnet treasury funding. See `docs/confluence/15_operational_runbook.md`.~~ |
| ~~CRIT-3~~ | ~~Stripe plan change/downgrade~~ | ~~HIGH~~ | ~~RESOLVED 2026-03-14~~ | ~~PR #43~~ |
| ~~UAT-S5~~ | ~~UAT Sprint 5 — 9 critical/high UI bugs~~ | ~~HIGH~~ | ~~RESOLVED 2026-03-15~~ | ~~PR #47~~ |
| ~~UAT-S6~~ | ~~UAT Sprint 6 — 8 medium/low UI polish bugs~~ | ~~MEDIUM~~ | ~~RESOLVED 2026-03-15~~ | ~~PR #48~~ |

**No active code blockers.** All remaining items are operational (infrastructure provisioning).

### MVP Launch Gap Stories (testnet launch blockers)

All HIGH+ launch blockers resolved:

| Story | Priority | Description | Status |
|-------|----------|-------------|--------|
| ~~MVP-01~~ | ~~CRITICAL~~ | ~~Worker production deployment~~ | ~~COMPLETE (OPS-ONLY — env vars, Stripe webhook). See runbook.~~ |
| ~~MVP-02~~ | ~~HIGH~~ | ~~Global toast/notification system~~ | ~~COMPLETE (PRs #36, #37, #40)~~ |
| ~~MVP-03~~ | ~~HIGH~~ | ~~Legal pages~~ | ~~COMPLETE~~ |
| ~~MVP-04~~ | ~~HIGH~~ | ~~Brand assets~~ | ~~COMPLETE (PR #30)~~ |
| ~~MVP-05~~ | ~~HIGH~~ | ~~Error boundary + 404~~ | ~~COMPLETE~~ |
| ~~MVP-11~~ | ~~HIGH~~ | ~~Stripe plan change/downgrade~~ | ~~COMPLETE (PR #43)~~ |

### P8 AI Intelligence — 10/19 COMPLETE (Phase I done)

| Story | Description | Status |
|-------|-------------|--------|
| P8-S1 | Gemini API Integration (GeminiProvider + circuit breaker) | **COMPLETE** — 13 tests (PR #68) |
| P8-S2 | AI Cost Tracking (migration 0059 + credits RPCs) | **COMPLETE** — 17 tests (PR #68) |
| P8-S3 | AI Feature Flags (3 switchboard flags + middleware) | **COMPLETE** — 17 tests (PR #68) |
| P8-S4 | AI Extraction Service (POST /api/v1/ai/extract) | **COMPLETE** — 6 tests (PR #68) |
| P8-S5 | AI Extraction UI (OCR + PII strip + suggestions) | **COMPLETE** — 18 tests (PR #68) |
| P8-S7 | Cloudflare Crawler (university ingestion) | **COMPLETE** — 5 tests (PR #31) |
| P8-S13 | Batch AI Processing (Cloudflare Queues) | **COMPLETE** — 4 tests (PR #31) |
| P8-S15 | R2 Report Storage (zero-egress signed URLs) | **COMPLETE** — 4 tests (PR #31) |
| P8-S17 | AI Provider Abstraction (IAIProvider + factory + fallback) | **COMPLETE** — 16 tests (PR #31) |
| P8-S18 | Client-Side PII Stripping (Constitution 4A) | **COMPLETE** — 27 tests (PR #68) |

### Sentry Integration

| Component | Status |
|-----------|--------|
| Worker (`@sentry/node` + profiling) | **COMPLETE** — PII scrubbing, 21 tests |
| Frontend (`@sentry/react` + replay) | **COMPLETE** — PII scrubbing, 9 tests |
| ErrorBoundary wired to Sentry | **COMPLETE** |

### Cloudflare Infrastructure

| Component | Status |
|-----------|--------|
| DLP policy (SSN/Tax ID block) | **COMPLETE** — script + 12 verification tests |
| Load Balancer (health checks) | **COMPLETE** — script ready |
| Edge worker bindings (R2, Queues, AI) | **COMPLETE** — wrangler.toml uncommented |

### AI Documentation & MCP Server (Phase 4)

| Component | Status |
|-----------|--------|
| `public/llms.txt` | **COMPLETE** — 12 validation tests |
| `public/AGENTS.md` | **COMPLETE** — tool docs + OAuth instructions |
| MCP Server (P8-S19) | **COMPLETE** — verify + search tools, OAuth/API key auth, 8 tests |
| MCP tools module | **COMPLETE** — shared logic for verify_credential + search_credentials |

### What's Production-Ready

- Database layer (58 migrations, RLS on all tables, audit trail immutable)
- Auth flow (Supabase auth, Google OAuth, AuthGuard + RouteGuard)
- Org admin credential issuance + individual anchor creation
- Public verification portal (5-section display, verification event logging)
- CI/CD pipeline (typecheck, lint, test, copy-lint, build-check, E2E)
- Worker test coverage (604 tests across 24+ files, 80%+ on all critical paths)
- Webhook delivery engine + settings UI
- Stripe webhook handlers + billing UI
- PDF + JSON proof downloads
- CSV bulk upload
- Onboarding flow
- Bitcoin chain client (code complete, operational items remain)
- Sentry error tracking with PII scrubbing (frontend + worker)
- AI provider abstraction (IAIProvider interface, factory, mock, CF fallback)
- Edge worker infrastructure (batch queue, report storage, crawler, AI fallback)
- AI documentation (llms.txt + AGENTS.md for agent discovery)
- Remote MCP server (Cloudflare Worker, Streamable HTTP, OAuth + API key auth)
- **"Nordic Vault" UI design system** (PR #42) — DM Sans + JetBrains Mono fonts, mesh gradients, glassmorphism, glow shadows, staggered animations. Full rules in CLAUDE.md Section 5 + `feedback_frontend_aesthetics.md`.
- **User Flow Gaps (UF-01 through UF-10) ALL COMPLETE** — CredentialRenderer, public search, recipient inbox, PENDING status UX, metadata entry, usage tracking, enhanced verification, share flow, breadcrumbs/nav polish, onboarding checklist
- **GCP Infrastructure** — Cloud Run (worker deployed), Secret Manager (7 secrets), Cloud Scheduler (4 cron jobs)

### GEO & SEO Optimization (NEW — 12 stories)

| Story | Priority | Description | Status |
|-------|----------|-------------|--------|
| GEO-01 | CRITICAL | SSR for marketing site (crawlers see empty div) | **COMPLETE** (PR #2, Vite SSR prerender) |
| GEO-02 | CRITICAL | Fix LinkedIn entity collision + expand sameAs | PARTIAL (sameAs fixed; LinkedIn page + Wikidata external) |
| GEO-03 | CRITICAL | Publish /privacy and /terms on marketing site | NOT STARTED |
| GEO-04 | HIGH | About page with team bios + Person schema | NOT STARTED |
| GEO-05 | HIGH | Enhanced schema (WebSite, speakable, AggregateOffer) | PARTIAL (WebSite deployed; speakable + AggregateOffer pending) |
| GEO-06 | HIGH | Deploy upgraded llms.txt | **COMPLETE** |
| GEO-07 | HIGH | Fix broken og:image + complete meta tags | **COMPLETE** |
| GEO-08 | HIGH | Content expansion — 5 core pages | NOT STARTED |
| GEO-09 | MEDIUM | Community & brand presence launch | NOT STARTED |
| GEO-10 | MEDIUM | IndexNow for Bing/Copilot | NOT STARTED |
| GEO-11 | MEDIUM | YouTube explainers + VideoObject schema | NOT STARTED |
| GEO-12 | MEDIUM | Security headers + technical SEO hardening | NOT STARTED |

**GEO Audit Score:** 42/100 | **Target:** 72/100 in 90 days
**Reports:** `GEO-AUDIT-REPORT.md`, `GEO-CRAWLER-ACCESS.md`, `GEO-LLMSTXT-ANALYSIS.md`, `GEO-SCHEMA-REPORT.md`

---

## Session Log

### Session: 2026-03-16 — CISO Security Audit (Launch Readiness)

**Comprehensive security audit across 8 domains:**
- Secrets scan, injection attacks, RLS policies (all 32 tables), auth & access control, PII & data protection, cryptographic controls, dependency audit, compliance gap analysis (SOC 2, GDPR, FERPA, ESIGN, eIDAS, AU Privacy Act, EU AI Act)

**Verdict: CONDITIONAL PASS — 4 CRITICAL, 8 HIGH, 14 MEDIUM, 10 LOW, 3 INFO**

**CRITICAL findings (must fix before launch):**
1. **PII-01:** `actor_email` stored in plaintext in append-only `audit_events` — impossible to erase per GDPR Art. 17
2. **PII-02:** No right-to-erasure mechanism — no account deletion flow, no anonymization RPC
3. (Grouped with PII-01/02 as single remediation effort)

**HIGH findings:**
- SEC-01: Demo credentials (`Demo1234!`) still in production Supabase
- INJ-01: PostgREST filter injection in `mcp-tools.ts:188`
- RLS-01: 13 tables missing GRANT to authenticated (policies exist but unreachable)
- RLS-02: api_keys readable by non-admin org members
- AUTH-01: Unauthenticated `/jobs/process-anchors` endpoint
- PII-03: No data retention policy on any table

**Positive findings:**
- 100% RLS + FORCE coverage (32/32 tables)
- 29/29 SECURITY DEFINER functions have `SET search_path = public`
- Zero dependency CVEs (1,464 deps scanned)
- Strong cryptographic implementations throughout
- Comprehensive Sentry PII scrubbing
- Constitution 1.6 boundary enforced (no fingerprinting in worker)

**Output:** `docs/security/launch_readiness_security_audit.md` (full report with 39 findings, compliance gap tables, remediation priorities)

### Session: 2026-03-15 — P8 Phase I AI Intelligence (6 stories)

**P8 Phase I Implementation (PR #68):**
- **P8-S3 + P8-S18 (Wave 1, parallel):** AI feature flags (`aiFeatureGate.ts` middleware, 3 switchboard flags, TTL-cached reads) + PII stripping (`piiStripper.ts` with SSN/email/phone/DOB/studentID/name regex). 44 tests.
- **P8-S1 + P8-S2 (Wave 2):** Gemini API integration (`GeminiProvider` with circuit breaker 5/60s, retry 3x 500ms, `@google/generative-ai`) + AI cost tracking (migration 0059 `ai_credits` + `ai_usage_events`, SECURITY DEFINER RPCs, `GET /api/v1/ai/usage`). 30 tests.
- **P8-S4 + P8-S5 (Wave 3):** Extraction service (`POST /api/v1/ai/extract`, auth + credit check + audit) + Extraction UI (`ocrWorker.ts` PDF.js+Tesseract.js, `aiExtraction.ts` orchestrator, `AIFieldSuggestions.tsx` with Nordic Vault aesthetic). 24 tests.
- **Migration 0059:** `ai_credits` table (org_id, user_id, monthly_allocation, used_this_month, period dates) + `ai_usage_events` table (event_type, provider, tokens_used, credits_consumed). RLS policies. SECURITY DEFINER RPCs.
- **32 files changed, +4,027 lines.** 117+ new tests. 1,538 total tests.
- **Phase 6 lint cleanup merged:** PR #67 squash-merged into main (7 stories, 91 ESLint fixes).

**Verification:** 0 TS errors, 0 lint errors, 0 copy violations, all 1,538 tests pass.

### Session: 2026-03-15 — GEO-01 SSR Prerender for Marketing Site

**Changes to arkova-marketing repo (`carson-see/arkova-marketing`, branch `feat/geo-01-ssr-prerender`, PR #2):**
- **GEO-01 COMPLETE:** Implemented Vite SSR prerender pipeline. Build now renders React app to static HTML at build time — AI crawlers see full marketing content (11 headings, 49 paragraphs) instead of empty `<div id="root">`.
- **Approach:** Custom prerender script using `react-dom/server` `renderToString`. No new framework (Astro/Next.js) needed. Zero new dependencies.
- **Files:** `src/entry-server.tsx` (SSR entry), `prerender.mjs` (build script), `src/main.tsx` (hydrateRoot + createRoot fallback), `index.html` (dark class + noscript fallback)
- **Verification:** Playwright screenshot confirms identical visual rendering. FAQ accordion, dark mode, mobile menu all hydrate correctly.

**Story doc updates:** `docs/stories/15_geo_seo.md` GEO-01 → COMPLETE (3/12 COMPLETE, 2 PARTIAL, 7 NOT STARTED). CLAUDE.md Section 8 GEO row updated.

### Session: 2026-03-15 — GEO Quick Wins (GEO-07, GEO-06, GEO-02, GEO-05)

**Changes to arkova-marketing repo (`carson-see/arkova-marketing`, branch `geo/quick-wins-07-06-02-05`):**
- **GEO-07 COMPLETE:** Fixed broken `og:image` (`og-image.png` → `arkova-logo.png`), added `og:site_name="Arkova"`, `twitter:site="@arkaboratory"`, `twitter:image`. Extended meta description to 153 chars.
- **GEO-06 COMPLETE:** Deployed upgraded `llms.txt` (formal spec with API docs, MCP server reference, auth, rate limits). Replaced marketing-copy version.
- **GEO-02 PARTIAL:** Fixed `sameAs` LinkedIn URL from `/company/arkova` (Arkova Partners) to `/company/arkovatech`. Added GitHub (`carson-see/ArkovaCarson`) to `sameAs` array. Remaining: create actual LinkedIn company page + Wikidata entry (external tasks).
- **GEO-05 PARTIAL:** Added `WebSite` JSON-LD schema with `alternateName`, `publisher` reference. Now 4 JSON-LD blocks total (Organization, SoftwareApplication, FAQPage, WebSite). Remaining: `speakable` WebPage + `AggregateOffer` enhancement.

**Story doc updates:** `docs/stories/15_geo_seo.md` updated (2 COMPLETE, 2 PARTIAL, 8 NOT STARTED). `00_stories_index.md` and CLAUDE.md Section 8 updated with GEO row.

### Session: 2026-03-15 — GEO Audit + Story Creation

**GEO Audit (5 parallel subagents):**
- Full audit of arkova.ai — Composite GEO Score: **42/100**
- AI Citability: 52, Brand Authority: 12, Content Quality: 24, Technical: 52, Schema: 52, Platform: 34
- Critical finding: React SPA renders empty `<div id="root">` — AI crawlers see zero content
- Critical finding: LinkedIn sameAs links to wrong company ("Arkova Partners")
- Generated reports: `GEO-AUDIT-REPORT.md`, `GEO-CRAWLER-ACCESS.md`, `GEO-LLMSTXT-ANALYSIS.md`, `GEO-SCHEMA-REPORT.md`
- Generated ready-to-deploy `llms-txt-generated.txt` (95/100 score) and `GEO-SCHEMA-REPORT.md` with 5 JSON-LD blocks

**Story Creation (12 new stories — GEO-01 through GEO-12):**
- `docs/stories/15_geo_seo.md` — full story doc with research sections per story
- Stories indexed in `00_stories_index.md`, added to CLAUDE.md Section 6, added to HANDOFF.md
- Each story includes: research tasks, user story, acceptance criteria, effort estimate
- Priorities: 3 CRITICAL (SSR, LinkedIn fix, privacy/terms), 5 HIGH, 4 MEDIUM
- Total story count: 163 (was 151)

**Updated llms.txt** (`public/llms.txt`) — upgraded from marketing copy to formal standard with API docs, MCP server reference, auth instructions

### Session: 2026-03-15 — UF Sprint C (Recipient Inbox, Share Flow, Nav Polish, Onboarding)

**UF Sprint C (PR #62):**
- **UF-03:** `anchor_recipients` table (migration 0056), `get_my_credentials` RPC, `link_credentials_on_signup` trigger, `useMyCredentials` hook, `MyCredentialsPage`, `hashEmail()` utility in `fileHasher.ts`. IssueCredentialForm wired to insert recipient records. 9 tests (4 useMyCredentials + 5 hashEmail).
- **UF-08:** `ShareSheet` component (copy link, QR code, email share via `window.open`). OrgRegistryTable "Copy Link" row action. 6 tests.
- **UF-09:** `Breadcrumbs` component (route-aware, nested paths). Sidebar org context ("MANAGING: OrgName"). Auth redirect toast via Sonner. Settings privacy description + Sign Out button. 8 tests.
- **UF-10:** `GettingStartedChecklist` (role-specific ORG_ADMIN/INDIVIDUAL steps, localStorage-persisted, progress bar, dismissible). Enhanced empty states with CTAs. 7 tests.
- **All 10 UF stories now COMPLETE.** +30 tests (586 total frontend). Migration 0056 pending production application.

**UAT verified:** Desktop (1280px) + mobile (375px) screenshots confirm all Sprint C features render correctly. No console errors.

### Session: 2026-03-16 — UF Sprint B (Metadata Entry, Public Search, Usage, Verification)

**UF Sprint B (PR #61):**
- **UF-05:** Dynamic metadata form fields from template schema, MetadataFieldRenderer, seed DIPLOMA/CERTIFICATE/LICENSE schemas
- **UF-02:** SearchPage + IssuerRegistryPage, `search_public_issuers` + `get_public_issuer_registry` RPCs, migration 0055
- **UF-06:** UsageWidget, usage progress bar on Dashboard + PricingPage, 80%/100% warning toasts
- **UF-07:** RevocationDetails, VerifierProofDownload, issuer section with public registry link, mobile-optimized layout
- +54 tests. 556 total frontend. Migrations 0054 + 0055 applied to production.

### Session: 2026-03-16 — UF Sprint A (CredentialRenderer + PENDING Status UX)

**UF Sprint A (PR #60):**
- **UF-01:** CredentialRenderer (3 modes: template+metadata, metadata-only, filename-only), useCredentialTemplate hook, `get_public_template` RPC (migration 0054)
- **UF-04:** Enhanced success screens (SecureDocumentDialog + IssueCredentialForm), pulsing amber PENDING badges, public verification includes PENDING with "Anchoring In Progress" banner
- +20 tests. 502 total frontend.

### Session: 2026-03-16 — Ops Sprint (GCP, DNS, Stripe)

- GCP Cloud Scheduler: 4 cron jobs (process-anchors, webhook-retries, generate-reports, credit-expiry). MVP-28 COMPLETE.
- GCP Cloud Run deployed + verified. MVP-26 COMPLETE.
- GCP Secret Manager: 7 secrets mounted. MVP-27 COMPLETE.
- Vercel: VITE_APP_URL set, domains configured.
- DNS: arkova.ai → Cloudflare (owen/sandra NS), arkova.io decommissioned.
- Stripe webhook: `we_1TBHb6BBeICNeQqrolzWA2yj` registered.

### Session: 2026-03-15 — Full Documentation Reconciliation (Board Presentation Prep)

**Documentation sync:**
- Fixed math errors in stories index (89→96 complete, 51→44 not started)
- Updated CLAUDE.md Section 8: P6 6/6, P7 11/13, DH 12/12, MVP 15/27, P8 4/19, INFRA 5/8+1 partial. Total 96/141 (68%)
- Reclassified CRIT-2 from HIGH to OPS-ONLY (all code complete, operational items only)
- Removed orphaned code section from CLAUDE.md (P6-TS-03 now wired)
- Updated all 7 story group docs with correct statuses
- Updated HANDOFF.md blockers (all resolved) and session log
- Migration count updated: 53 files (0052-0053 applied to production)

**P6-TS-03 completion (PR #57):**
- `VerificationWidget` routed at `/embed/verify/:publicId` via `EmbedVerifyPage`
- Barrel export `src/components/embed/index.ts`
- `logVerificationEvent` calls with `method='embed'`
- 12 new tests (10 widget + 2 page)

**PRs merged:** #53, #54, #55, #56, #57
**Migrations applied to production:** 0052, 0053

### Session: 2026-03-16 — Hardening Sprint 4 (Test Gaps + Route Fix + Doc Sync)

**Fixes:**
- Fix PricingPage test failure: `BILLING_LABELS.PAGE_TITLE` appeared in both Header and PricingPage `<h1>` — changed to `getAllByText` (PR #53)
- Remove unused `mockSelect` variable in useAnchor.test.ts (lint error) (PR #53)
- Fix SETTINGS_API_KEYS route mismatch: was rendering `DashboardPage`, now renders `ApiKeySettingsPage` placeholder with "coming soon" message (PR #54)
- Add `API_KEY_LABELS` to `copy.ts` for centralized UI strings (PR #54)

**Test Coverage:**
- 41 new hook tests across 6 previously untested hooks (PR #55):
  - useAuth (9 tests), useProfile (9 tests), useAnchors (4 tests)
  - useCredentialLifecycle (8 tests), useCredentialTemplates (6 tests), useOrganization (5 tests)
- Frontend test count: 467 (up from 426)

**Documentation Sync:**
- Bug log: all 17 UAT bugs marked RESOLVED (PRs #47, #48)
- Stories index: completion counts updated (70/141 complete, up from 52/141), INFRA partial count corrected (6 not 5)
- HANDOFF.md: UAT sprints marked RESOLVED, BUG-AUDIT-01 marked RESOLVED, MVP-01 status updated

### Session: 2026-03-15 — UI Redesign ("Nordic Vault") + UAT Bug Bounty Audit + Sprint Planning

**UI Redesign (PR #42):**
- Comprehensive "Nordic Vault" aesthetic applied across 14 files (+564/-246 lines)
- Fonts: DM Sans (headings/body) + JetBrains Mono (code/fingerprints) via Google Fonts
- Atmospheric: mesh gradients, dot patterns, glassmorphism header, glow shadows
- Motion: staggered reveal animations, floating orbs, shimmer loading states
- Components updated: Sidebar, Header, AppShell, AuthLayout, LoginForm, StatCard, EmptyState, RecordsList, PricingCard, VaultDashboard, DashboardPage
- Design system documented in: CLAUDE.md Section 5, `feedback_frontend_aesthetics.md`, MEMORY.md
- **Note:** Some component files were externally modified (UAT fixes, MVP-07 mobile, MVP-09 search) — aesthetic classes may need re-application in affected components

### Session: 2026-03-15 — UAT Bug Bounty Audit + Sprint Planning

**UAT Testing:**
- Comprehensive UAT audit across 12 pages, 3 viewports (desktop 1280px, tablet 768px, mobile 375px)
- Tested: Login, Dashboard, My Records, Record Detail, Organization, Settings, Billing, Help, Public Verify, Privacy, Terms, Contact, 404
- **17 bugs discovered** (3 Critical, 6 High, 5 Medium, 3 Low)
- All findings documented in `docs/bugs/uat_2026_03_15.md`

**Sprint Planning:**
- **Sprint 5** (Critical + High): 9 bugs — mobile sidebar, auth errors, billing route, header title, help link, avatar dropdown, badge overlap, org table columns, profile API dedup
- **Sprint 6** (Medium + Low): 8 bugs — layout fixes, loading states, forgot password, QR URL
- Full sprint plans in `docs/stories/14_uat_sprints.md`

**Key Findings:**
- Mobile sidebar does NOT auto-collapse — app unusable on mobile (contradicts MVP-07 COMPLETE status)
- `/billing` route silently redirects to Dashboard — users cannot access billing
- Supabase `oauth_client_id` auth error fires on every page load (6x per load)
- `useProfile()` hook causes 8+ redundant API calls per page load (performance)
- Header permanently says "Dashboard" regardless of current page
- Help link and avatar dropdown are dead/non-functional

**Positive Findings:**
- Public verification page is excellent (clean 5-section layout)
- Record detail page is strong (fingerprint, lifecycle, QR, re-verify, proof downloads)
- Legal pages, 404, and Secure Document dialog all work well
- All Supabase API calls returning real data (200/204)

**Files Created:**
- `docs/bugs/uat_2026_03_15.md` — Full 17-bug report with reproduction steps
- `docs/stories/14_uat_sprints.md` — Sprint 5 + Sprint 6 execution plans
- Updated: CLAUDE.md (Section 8 + 9), HANDOFF.md, MEMORY.md, stories index, bug log

### Session: 2026-03-14 — Phase 5 Bitcoin Anchor Verification

**Verification endpoint:**
- `POST /api/verify-anchor` — accepts a `fingerprint` (64-char hex SHA-256, NOT a file) and returns frozen verification schema result
- Constitution 1.6 compliant: documents never leave the device; only the hash is sent
- Wired into Express worker with CORS + rate limiting
- DB lookup via `anchors` table (fingerprint → status, chain_tx_id, block height, public_id)

**Verification module:**
- `services/worker/src/api/verify-anchor.ts` — pure function with injectable DB lookup for testability
- Input validation (rejects non-hex, wrong length, empty)
- Maps internal statuses (SECURED→ACTIVE), omits jurisdiction when null (frozen schema)
- Returns: verified, status, network_receipt_id, anchor_timestamp, record_uri

**Tests (10):**
- Full E2E: dummy PDF → SHA-256 → mock Bitcoin receipt → verification match
- Tampered document fails verification (different hash = not found)
- PENDING, REVOKED, and SECURED status handling
- Invalid/empty fingerprint rejection
- Jurisdiction omission when null

**Constitution compliance notes:**
- Server-side document hashing was NOT implemented (violates Constitution 1.6)
- OpenTimestamps was NOT used (Decision Log: "Direct OP_RETURN only")
- Existing infrastructure leveraged: `fileHasher.ts` (client), `BitcoinChainClient` (worker), `anchor_chain_index` (DB)

**Test results:** 866 total tests (502 worker + 364 frontend/infra), 0 type errors, 0 failures

### Session: 2026-03-14 — Phase 4 Agentic Upsell & Documentation

**AI Documentation:**
- `public/llms.txt` — API docs optimized for LLM consumption (frozen schema, endpoints, auth, rate limits)
- `public/AGENTS.md` — Agent integration guide (MCP connection, tool schemas, usage examples)
- 12 validation tests: heading hierarchy, required sections, frozen fields, banned terms, size limit

**MCP Server (P8-S19):**
- `services/edge/src/mcp-server.ts` — Cloudflare Worker MCP server using `McpServer` + `WebStandardStreamableHTTPServerTransport`
- `services/edge/src/mcp-tools.ts` — Shared tool definitions + handlers for `verify_credential` and `search_credentials`
- OAuth 2.0 + API key auth via `validateAuth()` (checks X-API-Key header or Bearer token against Supabase)
- Edge worker routed at `/mcp` with CORS support
- 8 tests: tool definitions, verify input validation, search with limits

**Test results:** 856 total tests (364 frontend/infra + 492 worker), 0 type errors, 0 failures

### Session: 2026-03-14 — Phase 2 Compliance + Phase 3 AI Intelligence

**Phase 2 Compliance & Resiliency:**
- Sentry integration: worker (`@sentry/node` + profiling) and frontend (`@sentry/react` + replay)
- PII scrubbing: emails, SHA-256 fingerprints, SSNs, API keys, JWTs, auth headers, request bodies
- ErrorBoundary wired to `Sentry.captureException()`
- Cloudflare DLP: SSN/EIN/ITIN block script (`infra/cloudflare/dlp-policy.ts`)
- Cloudflare LB: health check script (`infra/cloudflare/load-balancer.ts`)

**Phase 3 AI Intelligence:**
- P8-S17: `IAIProvider` interface + `createAIProvider()` factory + `CloudflareFallbackProvider` + `MockAIProvider`
- P8-S13: Batch queue consumer with throttling (5 concurrent, 200ms delay) + progress tracking
- P8-S15: R2 report storage with path-traversal-safe keys + zero-egress signed URLs
- P8-S7: Cloudflare crawler with SSRF protection, HTML parsing, embedding generation, Supabase insertion
- Edge worker entry point updated with `/crawl` route
- Wrangler config: R2, Queues, Workers AI bindings all uncommented and active

**Test results:** 836 total tests (492 worker + 344 frontend/infra), 0 type errors, 0 failures

### Session: 2026-03-14 — Methodology Upgrade
- Upgraded CLAUDE.md with 4 mandatory methodology rules (Architect, TDD, Security, Tooling mandates)
- Renamed MEMORY.md → ARCHIVE_memory.md (historical context preserved)
- Initialized this HANDOFF.md file

---

## Decision Log (Phase 3/4)

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-14 | Methodology upgrade: TDD + Architecture-first + Security self-review + Playwright verification | Systematic quality gates before every code change |
| 2026-03-14 | MEMORY.md archived, HANDOFF.md replaces it | Clean state tracking for Phase 3/4 without legacy clutter |
| 2026-03-14 | IAIProvider as single abstraction for all AI providers | Vendor independence; hot-swap via AI_PROVIDER env var |
| 2026-03-14 | Cloudflare fallback in degraded mode (heuristic) when no Workers AI binding | Express worker can still provide basic extraction without edge deployment |
| 2026-03-14 | SSRF protection in crawler via domain allowlist pattern | Prevent internal network scanning via crawl endpoint |
| 2026-03-14 | Batch queue throttle: 5 concurrent, 200ms delay | Prevent Gemini API rate limit exhaustion |
| 2026-03-14 | MCP server uses WebStandardStreamableHTTPServerTransport (stateful mode) | Native Cloudflare Workers compat; session management via crypto.randomUUID() |
| 2026-03-14 | MCP auth: dual-mode (API key + OAuth Bearer) | API keys for machine-to-machine; OAuth for enterprise SSO |
| 2026-03-14 | llms.txt + AGENTS.md in public/ for agent discovery | Cloudflare AI Tooling style guide compliance |

---

## Phase 4 Readiness (Verification API — Post-Launch)

**Status:** **13/13 P4.5 stories COMPLETE.** Full Verification API with batch processing, job polling, usage tracking, OpenAPI docs, API key management UI, and load tests. Migrations 0057-0058. P8-S19 (Agentic Verification) also **COMPLETE** via MCP server.

---

## Files Changed — Phase 2/3/4 Initial Build (2026-03-14)

> Historical reference from the session that created HANDOFF.md. Later sessions tracked in Session Log above.

### Phase 2 Compliance
| File | Action |
|------|--------|
| `services/worker/src/utils/sentry.ts` | NEW — Worker Sentry init + PII scrubbing |
| `services/worker/src/utils/sentry.test.ts` | NEW — 16 tests |
| `services/worker/src/utils/sentry-verification.test.ts` | NEW — 5 verification tests |
| `services/worker/src/index.ts` | MODIFIED — Sentry init + error handler |
| `src/lib/sentry.ts` | NEW — Frontend Sentry init + PII scrubbing |
| `src/lib/sentry.test.ts` | NEW — 9 tests |
| `src/main.tsx` | MODIFIED — initSentry() call |
| `src/components/layout/ErrorBoundary.tsx` | MODIFIED — Sentry.captureException |
| `infra/cloudflare/dlp-policy.ts` | NEW — DLP SSN/Tax ID block script |
| `infra/cloudflare/load-balancer.ts` | NEW — LB health check script |
| `tests/infra/dlp-verification.test.ts` | NEW — 12 DLP tests |

### Phase 3 AI Intelligence
| File | Action |
|------|--------|
| `services/worker/src/ai/types.ts` | NEW — IAIProvider interface |
| `services/worker/src/ai/types.test.ts` | NEW — 4 tests |
| `services/worker/src/ai/factory.ts` | NEW — Provider factory |
| `services/worker/src/ai/factory.test.ts` | NEW — 8 tests |
| `services/worker/src/ai/cloudflare-fallback.ts` | NEW — CF Workers AI fallback |
| `services/worker/src/ai/cloudflare-fallback.test.ts` | NEW — 4 tests |
| `services/worker/src/ai/mock.ts` | NEW — Mock provider for tests |
| `services/edge/src/env.ts` | NEW — Typed CF environment bindings |
| `services/edge/src/batch-queue.ts` | REWRITTEN — Real queue consumer |
| `services/edge/src/batch-queue-logic.ts` | NEW — Throttled batch processing |
| `services/edge/src/report-generator.ts` | REWRITTEN — R2 storage + signed URLs |
| `services/edge/src/report-logic.ts` | NEW — Report generation + R2 keys |
| `services/edge/src/ai-fallback.ts` | REWRITTEN — Nemotron endpoints |
| `services/edge/src/cloudflare-crawler.ts` | NEW — University directory ingestion |
| `services/edge/src/crawler-logic.ts` | NEW — HTML parsing + ground truth records |
| `services/edge/src/index.ts` | MODIFIED — Added /crawl route |
| `services/edge/wrangler.toml` | MODIFIED — All bindings uncommented |
| `tests/infra/batch-queue.test.ts` | NEW — 4 tests |
| `tests/infra/r2-report.test.ts` | NEW — 4 tests |
| `tests/infra/crawler.test.ts` | NEW — 5 tests |

### Phase 4 Agentic Upsell & Documentation
| File | Action |
|------|--------|
| `public/llms.txt` | NEW — LLM-optimized API documentation |
| `public/AGENTS.md` | NEW — Agent integration guide with MCP tools |
| `services/edge/src/mcp-server.ts` | NEW — Cloudflare MCP server (Streamable HTTP + OAuth) |
| `services/edge/src/mcp-tools.ts` | NEW — Tool definitions + handlers (verify + search) |
| `services/edge/src/index.ts` | MODIFIED — Added /mcp route |
| `tests/infra/llms-txt.test.ts` | NEW — 12 validation tests |
| `tests/infra/mcp-server.test.ts` | NEW — 8 tool + handler tests |

---

## Bug Tracker

| ID | Date | Summary | Severity | Status | Detail |
|----|------|---------|----------|--------|--------|
| ~~BUG-AUDIT-01~~ | ~~2026-03-12~~ | ~~No global toast system~~ | ~~HIGH~~ | ~~RESOLVED 2026-03-15~~ | ~~All mutation hooks have toasts (PRs #36, #37, #40)~~ |
| ~~BUG-AUDIT-02~~ | ~~2026-03-12~~ | ~~Dead footer links~~ | ~~HIGH~~ | ~~RESOLVED~~ | ~~Pages created + routed (committed)~~ |
| BUG-AUDIT-03 | 2026-03-12 | No favicon/logo/OG tags | HIGH | COMPLETE | PR #30 merged |

---

## Verification Pending

**MCP Server verification:** After `wrangler deploy`, test with MCP Inspector:
```bash
npx @modelcontextprotocol/inspector https://arkova-edge.<account>.workers.dev/mcp
```
Then call `verify_credential` with `{ "public_id": "ARK-2026-001" }` and `search_credentials` with `{ "query": "University of Michigan" }`.

**llms.txt validation:** Verify at `https://arkova-edge.<account>.workers.dev/llms.txt` — should return valid markdown under 5KB with all required sections.

**Crawl test on live university domain:** Requires deployed edge worker with Workers AI binding. Run:
```bash
# After wrangler deploy:
curl -X POST https://arkova-edge.<account>.workers.dev/crawl \
  -H 'Content-Type: application/json' \
  -d '{"domains":["umich.edu"]}'
```
Then verify in Supabase:
```sql
SELECT institution_name, domain, source, confidence_score,
       embedding IS NOT NULL as has_embedding
FROM institution_ground_truth
WHERE source = 'cloudflare_crawl';
```
