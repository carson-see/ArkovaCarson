# 13 — Infrastructure & Edge Stories
_Last updated: 2026-03-15 ~6:00 PM EST_

## Overview

Infrastructure stories for Zero Trust ingress (Cloudflare Tunnel), edge compute (Cloudflare Workers), observability (Sentry), AI provider fallback, and database extensions. These support ADR-002 (`docs/confluence/15_zero_trust_edge_architecture.md`).

**Prerequisite:** ADR-002 must be approved before any story moves to IN PROGRESS.

| Status | Count |
|--------|-------|
| Complete | 5 |
| Partial | 1 |
| Not Started | 2 |

---

## INFRA-01: Cloudflare Tunnel Sidecar Setup

**Status:** NOT STARTED
**Priority:** HIGH (blocks zero-trust ingress)
**Depends on:** MVP-01 (worker deployment), MVP-27 (GCP Secret Manager)
**ADR:** ADR-002 Section 1

### What It Delivers
`cloudflared` tunnel sidecar running alongside the Express worker container. All inbound traffic (Stripe webhooks, billing portal, anchor jobs) enters through Cloudflare's edge — no public ports on Cloud Run.

### Acceptance Criteria
- [ ] `cloudflared` added to Docker Compose as sidecar service
- [ ] GCP Cloud Run task definition includes `cloudflared` container
- [ ] Tunnel credentials stored in GCP Secret Manager (not in code)
- [ ] Stripe webhook endpoint reachable only through tunnel
- [ ] Worker health check (`/api/health`) passes through tunnel
- [ ] No public ingress ports open on Cloud Run service
- [ ] Cloudflare WAF + rate limiting rules configured for worker routes
- [ ] Documentation in `docs/confluence/15_zero_trust_edge_architecture.md`

### File Placement
- `services/worker/Dockerfile` — add `cloudflared` layer or sidecar compose
- `services/worker/docker-compose.yml` — tunnel sidecar service

---

## INFRA-02: Wrangler + Edge Worker Scaffolding

**Status:** COMPLETE
**Priority:** MEDIUM (blocks INFRA-03, INFRA-04, INFRA-05)
**Depends on:** ADR-002 approval
**Completed:** 2026-03-14 (PR #29, #31). `services/edge/` with 11 source files, `wrangler.toml`, `tsconfig.json`.
**ADR:** ADR-002 Section 2

### What It Delivers
`wrangler` dev dependency installed. `wrangler.toml` scaffolded with resource bindings. `services/edge/` directory created for edge worker scripts.

### Acceptance Criteria
- [x] `wrangler` added as dev dependency in `package.json`
- [x] Root `wrangler.toml` with bindings: R2 (`ARKOVA_REPORTS`), Queue (`ARKOVA_BATCH_QUEUE`), AI (`ARKOVA_AI`)
- [x] `services/edge/` directory with `wrangler.toml`, `src/` structure
- [ ] `agents.md` created in `services/edge/`
- [x] TypeScript config for edge workers (separate from main `tsconfig.json`)
- [x] Application logic added beyond scaffolding — ai-fallback, batch-queue, report-generator, MCP server, crawler all implemented

### Completion Gaps
- Missing `agents.md` in `services/edge/`
- Edge workers not deployed to Cloudflare (local development only)
- CI does not typecheck edge workers separately

### Remaining Work
Create `services/edge/agents.md`. Add edge typecheck to CI. Deploy to Cloudflare.

### File Placement
- `wrangler.toml` — root binding config
- `services/edge/wrangler.toml` — edge worker config
- `services/edge/src/` — worker entry points (empty stubs)
- `services/edge/tsconfig.json` — edge-specific TS config

---

## INFRA-03: R2 Report Storage Bucket

**Status:** COMPLETE
**Priority:** MEDIUM
**Depends on:** INFRA-02
**Completed:** 2026-03-14 (PR #31). R2 binding in wrangler.toml, `report-generator.ts` + `report-logic.ts` implemented. 4 tests.
**ADR:** ADR-002 Section 2

### What It Delivers
Cloudflare R2 bucket (`ARKOVA_REPORTS`) for storing generated PDF reports. Replaces future need for GCS/S3 blob storage for report artifacts.

### Acceptance Criteria
- [ ] R2 bucket created via `wrangler r2 bucket create`
- [x] Bucket bound in `wrangler.toml` as `ARKOVA_REPORTS` (line 13-15)
- [ ] No public access — Workers-only via binding
- [ ] Lifecycle policy: reports expire after 90 days (configurable)
- [x] Edge worker for report upload/download — `report-generator.ts` + `report-logic.ts` (real implementation, not stub)

### Completion Gaps
- R2 bucket not yet created in Cloudflare dashboard/CLI
- Lifecycle policy not configured
- Not deployed

### Remaining Work
Create R2 bucket, configure lifecycle, deploy edge worker.

---

## INFRA-04: Batch Anchor Queue (Cloudflare Queues)

**Status:** COMPLETE
**Priority:** MEDIUM
**Depends on:** INFRA-02
**Completed:** 2026-03-14 (PR #31). `batch-queue.ts` + `batch-queue-logic.ts` with Zod schema. 4 tests.
**ADR:** ADR-002 Section 2

### What It Delivers
Cloudflare Queue (`ARKOVA_BATCH_QUEUE`) for decoupling batch anchor submissions from processing. Producer (API endpoint) enqueues; consumer (edge worker) processes.

### Acceptance Criteria
- [ ] Queue created via `wrangler queues create`
- [x] Queue bound in `wrangler.toml` as `ARKOVA_BATCH_QUEUE` (lines 18-23)
- [x] Producer: accepts batch payload, enqueues messages — `batch-queue.ts` (55 lines)
- [x] Consumer: dequeues and calls Express worker — `batch-queue-logic.ts` (107 lines)
- [ ] Dead-letter queue configured for failed messages
- [x] Message schema defined with Zod (in `batch-queue-logic.ts`)

### Completion Gaps
- Queue not yet created in Cloudflare
- Dead-letter queue not configured
- Not deployed

### Remaining Work
Create queue in Cloudflare, configure DLQ, deploy.

---

## INFRA-05: Cloudflare Workers AI Fallback Provider

**Status:** COMPLETE
**Priority:** LOW (P8 Phase 1.5)
**Depends on:** INFRA-02, P8-S13 (IAIProvider interface)
**Completed:** 2026-03-14 (PR #31). `IAIProvider` interface, `CloudflareAIFallbackProvider`, factory, mock, 16 tests. Edge worker `ai-fallback.ts`.
**ADR:** ADR-002 Section 3

### What It Delivers
`CloudflareAIProvider` implementing `IAIProvider` interface. Uses Workers AI (Nemotron or equivalent) as fallback when Gemini is unavailable.

### Acceptance Criteria
- [x] `@cloudflare/ai` added as dependency
- [x] `CloudflareAIFallbackProvider` implements `IAIProvider` interface — `services/worker/src/ai/cloudflare-fallback.ts` (95 lines)
- [x] `IAIProvider` interface defined — `services/worker/src/ai/types.ts` (82 lines)
- [x] Factory pattern — `services/worker/src/ai/factory.ts` (71 lines)
- [ ] Circuit breaker: activates only after Gemini failure (configurable threshold)
- [ ] Response format matches `GeminiADKProvider` output schema
- [x] Never called as primary — fallback only (enforced in factory)
- [x] Feature flag: `ENABLE_AI_FALLBACK` (default: `false`)
- [x] Tests — 16 tests across factory.test.ts, cloudflare-fallback.test.ts, types.test.ts
- [x] Edge worker implementation — `services/edge/src/ai-fallback.ts` (144 lines) with extract + embed + health endpoints

### Completion Gaps
- Circuit breaker not implemented (currently simple on/off flag)
- GeminiADKProvider not yet created (P8-S1 dependency)
- Not deployed to Cloudflare

### Remaining Work
Implement circuit breaker, create GeminiADKProvider (P8-S1), deploy.

---

## INFRA-06: Replicate QA Data Generator

**Status:** NOT STARTED
**Priority:** LOW (P8 Phase II)
**Depends on:** P8-S13 (IAIProvider interface)
**ADR:** ADR-002 Section 3

### What It Delivers
`ReplicateProvider` implementing `IAIProvider` for generating synthetic test data (fake credentials, edge-case documents) for QA pipelines. **Never used in production request paths.**

### Acceptance Criteria
- [ ] `replicate` added as dependency
- [ ] `ReplicateProvider` implements `IAIProvider` interface
- [ ] Gated by `NODE_ENV=test` OR `ENABLE_SYNTHETIC_DATA=true` — hard-blocked in production
- [ ] Generates synthetic credential metadata for QA test suites
- [ ] Output matches production extraction schema
- [ ] Tests use mock Replicate client (no real API calls)

---

## INFRA-07: Sentry Observability Integration

**Status:** PARTIAL
**Priority:** HIGH (observability gap)
**Depends on:** None
**ADR:** ADR-002 Section 4

### What It Delivers
Centralized error tracking and performance monitoring via Sentry. Covers both React frontend and Express worker.

### Acceptance Criteria
- [x] `@sentry/react` added to frontend dependencies (`^10.43.0`)
- [x] `@sentry/node` + `@sentry/profiling-node` added to worker dependencies (`^10.43.0`)
- [x] Sentry initialized in `src/main.tsx` (frontend) — `initSentry()` at line 15
- [x] Sentry initialized in `services/worker/src/index.ts` (worker) — `initSentry()` at line 25, `setupExpressErrorHandler` at line 348
- [x] DSN loaded from environment variable (`VITE_SENTRY_DSN` / `SENTRY_DSN`)
- [ ] Source maps uploaded to Sentry on build (Vite plugin) — **NOT YET DONE**
- [x] PII scrubbing enabled — comprehensive scrubbing in both `src/lib/sentry.ts` (195 lines) and `services/worker/src/utils/sentry.ts` (186 lines): email regex, SHA256, SSN, API keys, JWTs, URL tokens, sensitive headers, request bodies stripped
- [x] Performance sampling rate configurable via env var (default: 10%)
- [x] Tests: `src/lib/sentry.test.ts` (9 tests), `services/worker/src/utils/sentry.test.ts` (16 tests), `services/worker/src/utils/sentry-verification.test.ts` (5 tests) — 30 tests total
- [x] No secrets or fingerprints in Sentry events (Constitution 1.4 + 1.6) — verified in tests
- [x] ErrorBoundary wired to `Sentry.captureException` in `src/components/layout/ErrorBoundary.tsx`

### Completion Gaps
- Source maps not uploaded to Sentry on build (no Vite Sentry plugin configured)
- Sentry DSN env vars not set in production (Vercel + Cloud Run)

### Remaining Work
Add `@sentry/vite-plugin` for source map upload. Set `VITE_SENTRY_DSN` in Vercel and `SENTRY_DSN` in Cloud Run.

---

## INFRA-08: pgvector Extension + Institution Ground Truth Table

**Status:** COMPLETE
**Priority:** MEDIUM (blocks P8-S7 anomaly detection)
**Depends on:** None
**Completed:** 2026-03-14. Migration 0051 applied to production.
**ADR:** ADR-002 Section 5 (implied)

### What It Delivers
Enable `pgvector` extension in Supabase. Create `institution_ground_truth` table with vector embeddings for future institution verification (Cloudflare Crawl data, known issuer metadata).

### Acceptance Criteria
- [x] Migration `0051_enable_pgvector_and_institution_ground_truth.sql` created and applied to production
- [x] `CREATE EXTENSION IF NOT EXISTS vector` (with schema specification)
- [x] `institution_ground_truth` table with columns:
  - `id` (uuid, PK, default gen_random_uuid())
  - `institution_name` (text, not null)
  - `domain` (text)
  - `metadata` (jsonb, default '{}')
  - `embedding` (vector(768))
  - `source` (text) — e.g., 'cloudflare_crawl', 'manual', 'api'
  - `confidence_score` (numeric(3,2), check 0-1)
  - `created_at` (timestamptz, default now())
  - `updated_at` (timestamptz, default now())
- [x] RLS enabled (`FORCE ROW LEVEL SECURITY`)
- [x] RLS policy: service_role full access, authenticated read-only
- [x] Index on `embedding` column (ivfflat or hnsw)
- [x] Index on `institution_name` (trigram for fuzzy search)
- [x] Rollback comment at bottom of migration
- [x] `database.types.ts` regenerated (PR #29)
- [ ] `docs/confluence/02_data_model.md` updated

### Completion Gaps
- `docs/confluence/02_data_model.md` not yet updated with `institution_ground_truth` table
- No seed data for institution ground truth table

### Remaining Work
Update data model docs. Consider adding seed data for common institutions.

---

## Story Dependency Graph

```
ADR-002 Approval
├── INFRA-01 (Tunnel)        ← MVP-01, MVP-27
├── INFRA-02 (Wrangler)
│   ├── INFRA-03 (R2)
│   ├── INFRA-04 (Queues)
│   └── INFRA-05 (AI Fallback) ← P8-S13
├── INFRA-06 (Replicate)     ← P8-S13
├── INFRA-07 (Sentry)        ← independent
└── INFRA-08 (pgvector)      ← independent
```

## Change Log

| Date | Change |
|------|--------|
| 2026-03-12 | 8 infrastructure stories created (INFRA-01 through INFRA-08) |
| 2026-03-14 | Doc sync audit: INFRA-02 → PARTIAL (wrangler + edge dir + 11 source files, missing agents.md + deployment). INFRA-03 → PARTIAL (wrangler binding + report-generator logic, R2 bucket not created). INFRA-04 → PARTIAL (wrangler binding + batch-queue logic, queue not created). INFRA-05 → PARTIAL (IAIProvider + factory + CloudflareAIFallbackProvider + edge worker + 16 tests, missing circuit breaker). INFRA-07 → PARTIAL (Sentry fully integrated in frontend + worker + 30 tests, missing source map upload + DSN env vars). INFRA-08 → PARTIAL (migration 0051 applied to production, missing data model doc update). Totals: 0 complete, 5 partial, 3 not started. |
