# HANDOFF.md — Arkova Phase 3/4 Living State

> **Initialized:** 2026-03-14
> **Purpose:** Track exact project state through Phase 3 (Go-Live) and Phase 4 (Verification API). Replaces MEMORY.md as the active state file. Historical context preserved in `ARCHIVE_memory.md`.
> **Update frequency:** After every significant session or decision.

---

## Current State

### Active Phase: Phase 3 — Go-Live (Production Launch) + P8 AI Intelligence (infrastructure done)

**Goal:** Production launch of Phase 1 credentialing MVP + AI infrastructure foundation
**Methodology:** TDD (Red-Green-Refactor) + Architecture-first (sequential-thinking) + Security self-review + Playwright UI verification
**Overall progress:** 151/163 stories complete (93%). 1,814 tests (867 frontend + 947 worker). 67 migration files (0001-0067, 0033 skipped). P4.5 COMPLETE (13/13). P8: 19/19 (100%). GEO: 5 complete, 2 partial, 5 not started. **All 24/24 audit findings resolved.**

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

### P8 AI Intelligence — 19/19 COMPLETE (All phases done)

| Story | Description | Status |
|-------|-------------|--------|
| P8-S1 | Gemini API Integration (GeminiProvider + circuit breaker) | **COMPLETE** — 13 tests |
| P8-S2 | AI Cost Tracking (migration 0059 + credits RPCs) | **COMPLETE** — 17 tests |
| P8-S3 | AI Feature Flags (3 switchboard flags + middleware) | **COMPLETE** — 17 tests |
| P8-S4 | AI Extraction Service (POST /api/v1/ai/extract) | **COMPLETE** — 6 tests |
| P8-S5 | AI Extraction UI (OCR + PII strip + suggestions) | **COMPLETE** — 18 tests |
| P8-S7 | Cloudflare Crawler (university ingestion) | **COMPLETE** — 5 tests |
| P8-S10 | pgvector Embedding Schema (migration 0060) | **COMPLETE** — merged PR #71 |
| P8-S11 | Embedding Generation Pipeline | **COMPLETE** — 18 tests |
| P8-S12 | Semantic Search UI | **COMPLETE** — 20 tests |
| P8-S13 | Batch AI Processing (Cloudflare Queues) | **COMPLETE** — 4 tests |
| P8-S14 | Batch AI Dashboard | **COMPLETE** — 5 tests |
| P8-S15 | R2 Report Storage (zero-egress signed URLs) | **COMPLETE** — 4 tests |
| P8-S17 | AI Provider Abstraction (IAIProvider + factory + fallback) | **COMPLETE** — 16 tests |
| P8-S18 | Client-Side PII Stripping (Constitution 4A) | **COMPLETE** — 27 tests |
| P8-S19 | Agentic Verification Endpoint | **COMPLETE** — 5 tests |
| P8-S6 | Extraction Learning / Feedback Loop (Phase II) | **COMPLETE** — migration 0064, 8 tests |
| P8-S8 | Duplicate Detection / Integrity Scoring (Phase II) | **COMPLETE** — migration 0064, 10 tests |
| P8-S9 | Admin Review Queue (Phase II) | **COMPLETE** — migration 0064, 8 tests |
| P8-S16 | AI Reports Dashboard (Phase II) | **COMPLETE** — 6 tests |

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

- Database layer (67 migrations, RLS on all tables, audit trail immutable, GDPR erasure RPCs)
- Auth flow (Supabase auth, Google OAuth, AuthGuard + RouteGuard)
- Org admin credential issuance + individual anchor creation
- Public verification portal (5-section display, verification event logging)
- CI/CD pipeline (typecheck, lint, test, copy-lint, build-check, E2E)
- Worker test coverage (947 tests across 54+ files, 80%+ on all critical paths)
- Webhook delivery engine + settings UI
- Stripe webhook handlers + billing UI
- PDF + JSON proof downloads
- CSV bulk upload
- Onboarding flow
- Bitcoin chain client (code complete, operational items remain)
- Sentry error tracking with PII scrubbing (frontend + worker)
- AI provider abstraction (IAIProvider interface, factory, mock, CF fallback)
- AI extraction pipeline (Gemini, OCR, PII stripping, credit tracking)
- Semantic search (pgvector embeddings, cosine similarity, Nordic Vault UI)
- Edge worker infrastructure (batch queue, report storage, crawler, AI fallback)
- AI documentation (llms.txt + AGENTS.md for agent discovery)
- Remote MCP server (Cloudflare Worker, Streamable HTTP, OAuth + API key auth)
- GDPR compliance (PII erasure RPCs, audit log anonymization, data retention policies)
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
| GEO-05 | HIGH | Enhanced schema (WebSite, speakable, AggregateOffer) | **COMPLETE** (speakable + AggregateOffer deployed) |
| GEO-06 | HIGH | Deploy upgraded llms.txt | **COMPLETE** |
| GEO-07 | HIGH | Fix broken og:image + complete meta tags | **COMPLETE** |
| GEO-08 | HIGH | Content expansion — 5 core pages | NOT STARTED |
| GEO-09 | MEDIUM | Community & brand presence launch | NOT STARTED |
| GEO-10 | MEDIUM | IndexNow for Bing/Copilot | NOT STARTED |
| GEO-11 | MEDIUM | YouTube explainers + VideoObject schema | NOT STARTED |
| GEO-12 | MEDIUM | Security headers + technical SEO hardening | **COMPLETE** (vercel.json headers) |

**GEO Audit Score:** 42→63→~72/100 (re-audited 2026-03-16) | **Target:** 80/100
**Reports:** `docs/archive/geo/` (GEO-AUDIT-REPORT, GEO-CRAWLER-ACCESS, GEO-LLMSTXT-ANALYSIS, GEO-SCHEMA-REPORT)

---

## Session Log

> **Full session history (25+ entries, 2026-03-14 through 2026-03-17) archived to `docs/archive/session-log.md`.**
> Only the most recent session is kept here. Older entries are in the archive.

### Session: 2026-03-17 — Close Out All 8 Remaining Audit Findings

**All 8 open audit findings (AUDIT-12, 17, 18, 19, 21, 22, 23, 24) resolved:**
- **AUDIT-12 (Testing):** 8 new test files for untested hooks (+42 frontend tests): useTheme, useTreasuryStatus, useAIReports, useExtractionFeedback, useIntegrityScore, useReviewQueue, usePublicSearch, useCredentialTemplate
- **AUDIT-17 (Schema):** Migration `0067_add_performance_indexes.sql` — 12 composite indexes on frequently queried columns (anchors, audit_events, webhook_delivery_logs, verification_events, subscriptions, ai_usage_events, review_queue, ai_reports, extraction_feedback)
- **AUDIT-18 (Monitoring):** Structured health check endpoint — critical checks (DB) determine HTTP status, informational checks (stripe/sentry/ai config) in `?detailed=true` response only
- **AUDIT-19 (API):** Resolved as false positive — rate limit headers already consistent across all endpoints
- **AUDIT-21 (Types):** `callRpc<T>()` typed wrapper in `services/worker/src/utils/rpc.ts` eliminates 9 `as any` casts in worker. 13 frontend casts deferred to OPS-01 type regeneration.
- **AUDIT-22 (Logging):** Investigated — `console.log` in sentry.ts and `console.error` in config.ts are intentional due to circular dependency (logger → config). Documented with AUDIT-22 comments.
- **AUDIT-23 (Edge):** Resolved as false positive — edge worker bindings already fully typed in `services/edge/src/env.ts`
- **AUDIT-24 (Docs):** `docs/confluence/01_architecture_overview.md` fully updated — P8 AI architecture section, expanded tech stack, 32+ table inventory, processing pipeline, credit system, provider abstraction, review queue states, edge worker routes

**Also fixed:** Pre-existing TS error in `batch-anchor.ts` (spread type on `Json` metadata field)

**Test counts:** 1,814 total (867 frontend + 947 worker). Migration count: 67 (0001-0067, 0033 skipped).
**Docs updated:** BACKLOG.md (24/24 audit findings resolved), CLAUDE.md (stats), HANDOFF.md (session log), `docs/confluence/01_architecture_overview.md` (P8 AI architecture)

<!-- Older sessions archived to docs/archive/session-log.md -->

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
