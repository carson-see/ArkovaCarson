# HANDOFF.md — Arkova Phase 3/4 Living State

> **Initialized:** 2026-03-14
> **Purpose:** Track exact project state through Phase 3 (Go-Live) and Phase 4 (Verification API). Replaces MEMORY.md as the active state file. Historical context preserved in `ARCHIVE_memory.md`.
> **Update frequency:** After every significant session or decision.

---

## Current State

### Active Phase: Phase 3 — Go-Live (Production Launch) + P8 AI Intelligence (infrastructure done)

**Goal:** Production launch of Phase 1 credentialing MVP + AI infrastructure foundation
**Methodology:** TDD (Red-Green-Refactor) + Architecture-first (sequential-thinking) + Security self-review + Playwright UI verification
**Overall progress:** 170/192 stories complete (~89%) incl. 13 Beta stories (BETA-01–13). **2,098 tests** (978 frontend + 1,120 worker, all green). 89 migration files (0001-0089, 0033+0078 skipped, 0068 split into 0068a/0068b). P4.5 COMPLETE (13/13). P8: 19/19 (100%). Phase 1.5: 15/16 COMPLETE. GEO: 6 complete, 2 partial, 4 not started. **All 24/24 audit findings resolved.** Bitcoin network: **Signet**. Treasury: `tb1ql90xtpfzpyc03d2dghggqfdksfxe6ucjufah0r`. **8+ real Signet transactions confirmed**. Worker **rev00058**. Frontend on arkova-26.vercel.app. **Pipeline LIVE:** 22,333+ public records (12K EDGAR, 7.7K Fed Register, 2K+ DAPIP, 536 OpenAlex), 9,700+ embeddings, 1,413 SECURED anchors. 12 Cloud Scheduler jobs. MCP server live at edge.arkova.ai. **TLA-01+02 resolved.** Branch protection enabled. Session 11: GEO fixes + embedding acceleration + test stabilization + SOC 2 compliance.

### Open Blockers

| ID | Issue | Severity | Status | Next Action |
|----|-------|----------|--------|-------------|
| ~~CRIT-2~~ | ~~Bitcoin chain client~~ | ~~**OPS-ONLY**~~ | ~~CODE COMPLETE~~ | ~~AWS KMS key provisioning, mainnet treasury funding.~~ |

**No active code blockers.** All remaining items are operational (infrastructure provisioning).

### Recent Changes (2026-03-23, Session 11)

**PRs #150-154 (5 sprints):** GEO fixes + embedding acceleration + test stabilization + SOC 2

| Change | Detail |
|--------|--------|
| GEO infrastructure | robots.txt: 4 new AI crawlers; llms.txt: standard format with live MCP; OG image: SVG→PNG; Schema: address, jobTitle, sameAs, ORCID |
| Embedding acceleration | EMBED_BATCH_SIZE 100→500, EMBED_CONCURRENCY=10 (bounded-concurrency Promise.all) |
| Worker test stabilization | 11 flaky tests fixed: mock fetch for embeddings, beta credit bypass, anchors table mock, sequential RPC mocking |
| Branch protection | Main branch: required CI checks, no force push, no deletions. SOC 2 CC6.1 evidence |
| Test total | 2,098 tests (978 frontend + 1,120 worker), all green |

### Recent Changes (2026-03-23, Session 10)

**PRs #145-149 (5 sprints):** UX overhaul + QR/verify + AI hardening + SOC 2

| Change | Detail |
|--------|--------|
| Sidebar simplified | 5 main items: Dashboard, Documents, Organization, Search, Settings. Billing/Help/Developers in user dropdown. Admin collapsible. |
| Unified Documents page | `/documents` with tabs: All / My Records / Issued to Me / Attestations |
| Create Organization fixed | Dialog-based instead of broken redirect to onboarding |
| Org pages consolidated | OrganizationPage redirects to OrgProfilePage |
| Badge forwardRef | Fixed console ref warning |
| QR download | PNG export on RecordDetailPage for SECURED records |
| Drag-to-verify | SearchPage file drop → client-side hash → auto-search |
| Search type tabs | Issuers / Credentials / Verify Document tabs |
| CLE extraction enhanced | creditHours, creditType, barNumber, activityNumber, providerName, approvedBy |
| Fraud signal detection | AI flags: DUPLICATE_FINGERPRINT, EXPIRED_ISSUER, SUSPICIOUS_DATES, etc. |
| SOC 2 evidence doc | `docs/compliance/soc2-evidence.md` |
| TLA-02 confirmed | tla-verify CI job already existed |
| Production metrics | 22,333 records, 9,700 embeddings, 1,413 SECURED anchors, 12 scheduler jobs |

### Recent Changes (2026-03-23, Session 9)

**PRs #143-144 merged:** DAPIP API fix + UX overhaul + pipeline fixes + TLA-01

| Change | Detail |
|--------|--------|
| DAPIP fetcher fix | API URL migrated to surveys.ope.ed.gov, resumable batching for Cloud Run timeout |
| OpenAlex cursor fix | Was reading response headers (wrong), now reads meta.next_cursor |
| Dashboard simplification | Removed redundant account card + privacy toggle (moved to Settings) |
| Status labels | "Pending" → "Processing", "Secured" → "Verified" with tooltips |
| TLA-01 | credential_type immutability trigger (migration 0089) |
| Cloud Scheduler | Added fetch-dapip (every 10 min), OpenAlex increased to every 30 min |
| Worker deploy | rev00058 with DAPIP batching + OpenAlex cursor fix |
| CI/CD | deploy-worker.yml memory corrected 512Mi → 1Gi |
| Test fixes | PipelineAdminPage mock, lint errors cleaned |
| UX PRD | docs/stories/16_ux_overhaul.md |
| Branch cleanup | 17 stale branches deleted (local + remote) |

### Known UX Issues (Session 9 — user-reported)

| Issue | Severity | Detail |
|-------|----------|--------|
| Sidebar too many items | HIGH | My Records / My Credentials / Attestations should be ONE item |
| Create Organization broken | HIGH | Button redirects to dashboard instead of creating org |
| Document types confusing | HIGH | Users don't understand credential vs document vs attestation — auto-classify from metadata |

### Recent Changes (2026-03-23, Session 6)

**PR #132 merged:** `feat/session6-critical-fixes` — Critical fixes + hardening + P3/P4 polish

| Change | Files | Detail |
|--------|-------|--------|
| Public attestation verify page | `PublicAttestationVerifyPage.tsx`, `App.tsx`, `routes.ts` | `/verify/attestation/:publicId` — full verification display with status, claims, proof, revocation |
| Attestation revoke UI | `AttestationsPage.tsx` | Revoke button + confirmation dialog in detail panel |
| DevelopersPage API reference | `DevelopersPage.tsx` | Org role requirement notice + rate limits + error codes section |
| Admin user detail | `AdminUserDetailPage.tsx`, `admin-lists.ts`, `index.ts` | `/admin/users/:id` with dedicated worker endpoint |
| Dashboard attestation stat | `DashboardPage.tsx`, `StatCard.tsx` | 4th stat card with chevron affordance, onClick prop |
| Admin UX overhaul | `AdminUsersPage.tsx`, `AdminRecordsPage.tsx`, `AdminSubscriptionsPage.tsx` | shadcn Select, mobile card layout, auto-search on filter, clear filters button |
| Centralized platform constants | `platform.ts` | `isPlatformAdmin()`, treasury address, mempool URL helpers — removed from 10 files |
| Mempool links | `AssetDetailView.tsx`, `PipelineAdminPage.tsx` | Treasury fallback for PENDING/SUBMITTED records |
| Unified Secure Document | `SecureDocumentDialog.tsx`, `FileUpload.tsx` | Single catchall: auto-detects single/bulk/CSV upload |
| Anchor filter fix | `anchor.ts` | Pipeline records filtered from individual processor (Merkle batch only) |
| Org onboarding | `OrgOnboardingForm.tsx` | legal_name optional, display_name primary |
| x402 payments | switchboard_flags | `ENABLE_X402_PAYMENTS` enabled in production |
| Demo seed strip | Production DB | OPS-02: `admin@umich-demo.arkova.io` deleted |

### Recent Changes (2026-03-23, Session 5)

**PR #131:** `feat/session5-attestation-anchoring-admin-lists` — Attestation anchoring + admin master lists + EDGAR scaling

| Change | Files | Detail |
|--------|-------|--------|
| Attestation anchoring job | `attestationAnchor.ts`, `0086_*.sql`, `index.ts` | Merkle-batches PENDING attestations to Bitcoin, PENDING→ACTIVE, race condition detection, 8 tests |
| Admin master lists (SN1) | `admin-lists.ts`, `AdminUsersPage.tsx`, `AdminRecordsPage.tsx`, `AdminSubscriptionsPage.tsx` | Paginated searchable detail lists for users/records/subscriptions, click-through from Overview |
| EDGAR scaling | `edgarFetcher.ts`, `index.ts` | Submissions API with 30 S&P 500 CIKs, batch 100→200, historical backfill endpoint |
| Security hardening | `admin-lists.ts` | ilike wildcard sanitization, search length limit, type-safe filter assertions |
| Pipeline UX | `PipelineAdminPage.tsx` | Detail panel auto-scrolls into view on record click |

### Recent Changes (2026-03-22, Session 4)

**PR #130 merged:** `feat/sn3-attestation-ids-edgar-source-url` — Structured attestation IDs + EDGAR source URL display

| Change | Files | Detail |
|--------|-------|--------|
| SN3: Structured attestation IDs | `0085_org_prefix_attestation_ids.sql`, `attestations.ts`, `AttestationsPage.tsx` | Format: ARK-{org_prefix}-{type_code}-{unique_6}. Org prefix auto-generated from display_name. Type codes: VER/END/AUD/APR/WIT/COM/SUP/IDN/CUS. IND default for individual users. |
| EDGAR source_url display | `AssetDetailView.tsx` | Pipeline records show "Source Document" link to SEC EDGAR/OpenAlex/USPTO/Federal Register on record detail page |
| Collision retry | `attestations.ts` | Max 3 retries on UNIQUE_VIOLATION (23505) for public_id collision |
| Attestation tests | `attestations.test.ts` | 26 unit tests: type codes, ID format, validation, collision handling |

### Recent Changes (2026-03-22, Session 2)

**PR #128:** `feat/pipeline-records-browser-anchoring` — awaiting review/merge

| Change | Files | Detail |
|--------|-------|--------|
| Records Browser | `PipelineAdminPage.tsx`, `copy.ts` | Filterable table (source, type, anchor status, search), pagination (25/page), responsive |
| Individual anchoring | `publicRecordAnchor.ts` | Each pipeline doc → own anchor in `anchors` table, visible in Treasury with `[SEC]`/`[OA]` prefix |
| Stale chunk fix | `AIExtractionStep.tsx`, `aiExtraction.ts`, `useSemanticSearch.ts`, `useBulkAnchors.ts` | Dynamic `await import()` → static imports |
| Recipient fix | `useBulkAnchors.ts` | Added missing `orgId` to `/api/recipients` calls |
| Env var | Vercel | `VITE_CRON_SECRET` set for Pipeline Control buttons |

### What's Production-Ready

- Database layer (83 migrations, RLS on all tables, audit trail immutable, GDPR erasure RPCs)
- Auth flow (Supabase auth, Google OAuth, AuthGuard + RouteGuard)
- Org admin credential issuance + individual anchor creation
- Public verification portal (5-section display, verification event logging)
- CI/CD pipeline (typecheck, lint, test, copy-lint, build-check, E2E)
- Worker test coverage (1,010 tests across 66 files, 80%+ on all critical paths)
- Webhook delivery engine + settings UI
- Stripe webhook handlers + billing UI
- PDF + JSON proof downloads
- CSV bulk upload
- Bitcoin chain client (code complete, operational items remain)
- Sentry error tracking with PII scrubbing (frontend + worker)
- AI extraction pipeline (Gemini, OCR, PII stripping, credit tracking)
- Semantic search (pgvector embeddings, cosine similarity)
- MCP server at edge.arkova.ai
- GDPR compliance (PII erasure RPCs, audit log anonymization)
- Precision Engine design system (PRs #117-120, refined 2026-03-22)
- 16 credential templates + type-specific visual cards
- Pipeline: EDGAR + OpenAlex fetchers, embedder, Nessie RAG
- Pipeline admin page with records browser + controls

---

## Session Log

### Session: 2026-03-22 (Session 2) — Pipeline Records Browser + Individual Anchoring

**PR #128 created.** Records browser, individual anchoring, bulk upload fixes.

**Pipeline Records Browser:**
- Added to PipelineAdminPage below existing stats/controls
- Filters: source (EDGAR/USPTO/Fed Register/OpenAlex), record type (dynamic), anchor status (Anchored/Pending), text search (title/source ID)
- Pagination: 25/page with prev/next controls and page indicator
- Responsive: hides Type, Source ID, Fingerprint, Date on smaller screens
- Each row shows: source icon, title, type badge, source ID, fingerprint (truncated), status badge, ingested date, external link

**Individual anchoring rewrite:**
- `publicRecordAnchor.ts` completely rewritten
- Each public record creates its own anchor in `anchors` table (was: one batch anchor for all)
- Anchors owned by `carson@arkova.ai` (platform admin) with `[SEC]`/`[OA]`/`[USPTO]`/`[FR]` filename prefix
- Merkle batching still used for Bitcoin tx (cost efficient: 1 tx per 500 docs)
- Handles duplicate fingerprints via unique constraint detection (23505 error → look up existing)
- Status flow: PENDING → SUBMITTED (after chain tx) → SECURED (after confirmation checker)

**Bulk upload fixes:**
- Stale chunk: 4 files converted from `await import('@/lib/workerClient')` to static imports
- Recipient creation: added missing `orgId` parameter — was silently failing with 400

**Deployment:**
- Worker rev 00044 deploying to Cloud Run
- VITE_CRON_SECRET added to Vercel production env vars
- Frontend will auto-deploy from main after PR merge

### Session: 2026-03-22 (Session 1) — Pipeline Activation (Phase 1.5 Sprint 5)

**Commit e6f9664 pushed to main.** Pipeline end-to-end operational.

- Migrations 0077-0080 applied to production
- EDGAR + OpenAlex fetchers created and run
- 2,540 public records ingested (2,340 EDGAR + 200 OpenAlex)
- 100 embeddings generated (gemini-embedding-001)
- 1 Merkle batch anchored to signet
- Nessie RAG returning real SEC filing results
- Worker rev 00043 deployed
- Gemini embedding model fixed: gemini-embedding-001 via v1beta REST API
- Dockerfile fixed: native module build deps added

### Session: 2026-03-21 — Synthetic Sentinel + MCP Deploy + Credential Templates

PRs #117-120 merged. Design system migration, MCP at edge.arkova.ai, 16 credential templates, DEMO-04.

<!-- Older sessions archived to docs/archive/session-log.md -->

---

## GEO & SEO Optimization (12 stories)

| Story | Priority | Description | Status |
|-------|----------|-------------|--------|
| GEO-01 | CRITICAL | SSR for marketing site | **COMPLETE** |
| GEO-02 | CRITICAL | Fix LinkedIn entity collision | PARTIAL |
| GEO-03 | CRITICAL | Publish /privacy and /terms | **COMPLETE** |
| GEO-04 | HIGH | About page with team bios | NOT STARTED |
| GEO-05 | HIGH | Enhanced schema | **COMPLETE** |
| GEO-06 | HIGH | Deploy upgraded llms.txt | **COMPLETE** |
| GEO-07 | HIGH | Fix broken og:image | **COMPLETE** |
| GEO-08 | HIGH | Content expansion — 5 pages | NOT STARTED |
| GEO-09 | MEDIUM | Community & brand presence | NOT STARTED |
| GEO-10 | MEDIUM | IndexNow for Bing/Copilot | NOT STARTED |
| GEO-11 | MEDIUM | YouTube explainers | NOT STARTED |
| GEO-12 | MEDIUM | Security headers | **COMPLETE** |

---

## Decision Log (Phase 3/4)

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-22 | Pipeline anchoring creates individual anchors per document | Each document must be visible in Treasury — batch-only is insufficient |
| 2026-03-22 | VITE_CRON_SECRET exposed to browser (admin-only page) | Pipeline controls need auth header; page is gated to platform admins |
| 2026-03-14 | IAIProvider as single abstraction for all AI providers | Vendor independence |
| 2026-03-14 | MCP server uses Streamable HTTP transport | Native Cloudflare Workers compat |

---

## Bug Tracker

| ID | Date | Summary | Severity | Status |
|----|------|---------|----------|--------|
| BUG-1.6 | 2026-03-22 | Forgot password error | MEDIUM | OPEN |
| BUG-2.3 | 2026-03-22 | Org admin onboarding error | MEDIUM | OPEN |
| BUG-5.8 | 2026-03-22 | QR code blank page | LOW | OPEN (VITE_APP_URL set) |
| BUG-2.5 | 2026-03-22 | Checklist doesn't show org admin steps | LOW | OPEN |
