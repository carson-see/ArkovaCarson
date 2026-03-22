# HANDOFF.md — Arkova Phase 3/4 Living State

> **Initialized:** 2026-03-14
> **Purpose:** Track exact project state through Phase 3 (Go-Live) and Phase 4 (Verification API). Replaces MEMORY.md as the active state file. Historical context preserved in `ARCHIVE_memory.md`.
> **Update frequency:** After every significant session or decision.

---

## Current State

### Active Phase: Phase 3 — Go-Live (Production Launch) + P8 AI Intelligence (infrastructure done)

**Goal:** Production launch of Phase 1 credentialing MVP + AI infrastructure foundation
**Methodology:** TDD (Red-Green-Refactor) + Architecture-first (sequential-thinking) + Security self-review + Playwright UI verification
**Overall progress:** 165/192 stories complete (~86%) incl. 13 Beta stories (BETA-01–13). 2,076+ tests. 85 migration files (0001-0085, 0033+0078 skipped, 0068 split into 0068a/0068b). P4.5 COMPLETE (13/13). P8: 19/19 (100%). Phase 1.5: 14/16 COMPLETE. GEO: 6 complete, 2 partial, 4 not started. **All 24/24 audit findings resolved.** Bitcoin network: **Signet**. Treasury: `tb1ql90xtpfzpyc03d2dghggqfdksfxe6ucjufah0r`. **8+ real Signet transactions confirmed** (incl. Merkle batch anchor `5d652cf4...`). Worker rev 00052 deployed. Frontend on arkova-26.vercel.app (app.arkova.ai). **Pipeline LIVE:** 11,547+ public records, 1,000+ embeddings, Nessie RAG returning real results. MCP server live at edge.arkova.ai. **Individual anchoring rewritten** — each document gets its own anchor visible in Treasury. **Attestation IDs** now use structured format: ARK-{org_prefix}-{type_code}-{unique}.

### Open Blockers

| ID | Issue | Severity | Status | Next Action |
|----|-------|----------|--------|-------------|
| ~~CRIT-2~~ | ~~Bitcoin chain client~~ | ~~**OPS-ONLY**~~ | ~~CODE COMPLETE~~ | ~~AWS KMS key provisioning, mainnet treasury funding.~~ |

**No active code blockers.** All remaining items are operational (infrastructure provisioning).

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
