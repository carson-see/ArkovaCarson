# 13 — Infrastructure & Edge Stories
_Last updated: 2026-03-12 ~2:00 PM EST_

## Overview

Infrastructure stories for Zero Trust ingress (Cloudflare Tunnel), edge compute (Cloudflare Workers), observability (Sentry), AI provider fallback, and database extensions. These support ADR-002 (`docs/confluence/15_zero_trust_edge_architecture.md`).

**Prerequisite:** ADR-002 must be approved before any story moves to IN PROGRESS.

| Status | Count |
|--------|-------|
| Complete | 0 |
| Partial | 0 |
| Not Started | 8 |

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

**Status:** NOT STARTED
**Priority:** MEDIUM (blocks INFRA-03, INFRA-04, INFRA-05)
**Depends on:** ADR-002 approval
**ADR:** ADR-002 Section 2

### What It Delivers
`wrangler` dev dependency installed. `wrangler.toml` scaffolded with resource bindings. `services/edge/` directory created for edge worker scripts.

### Acceptance Criteria
- [ ] `wrangler` added as dev dependency in `package.json`
- [ ] Root `wrangler.toml` with bindings: R2 (`ARKOVA_REPORTS`), Queue (`ARKOVA_BATCH_QUEUE`), AI (`ARKOVA_AI`)
- [ ] `services/edge/` directory with `wrangler.toml`, `src/` structure
- [ ] `agents.md` created in `services/edge/`
- [ ] TypeScript config for edge workers (separate from main `tsconfig.json`)
- [ ] No application logic — scaffolding only

### File Placement
- `wrangler.toml` — root binding config
- `services/edge/wrangler.toml` — edge worker config
- `services/edge/src/` — worker entry points (empty stubs)
- `services/edge/tsconfig.json` — edge-specific TS config

---

## INFRA-03: R2 Report Storage Bucket

**Status:** NOT STARTED
**Priority:** MEDIUM
**Depends on:** INFRA-02
**ADR:** ADR-002 Section 2

### What It Delivers
Cloudflare R2 bucket (`ARKOVA_REPORTS`) for storing generated PDF reports. Replaces future need for GCS/S3 blob storage for report artifacts.

### Acceptance Criteria
- [ ] R2 bucket created via `wrangler r2 bucket create`
- [ ] Bucket bound in `wrangler.toml` as `ARKOVA_REPORTS`
- [ ] No public access — Workers-only via binding
- [ ] Lifecycle policy: reports expire after 90 days (configurable)
- [ ] Edge worker stub for report upload/download

---

## INFRA-04: Batch Anchor Queue (Cloudflare Queues)

**Status:** NOT STARTED
**Priority:** MEDIUM
**Depends on:** INFRA-02
**ADR:** ADR-002 Section 2

### What It Delivers
Cloudflare Queue (`ARKOVA_BATCH_QUEUE`) for decoupling batch anchor submissions from processing. Producer (API endpoint) enqueues; consumer (edge worker) processes.

### Acceptance Criteria
- [ ] Queue created via `wrangler queues create`
- [ ] Queue bound in `wrangler.toml` as `ARKOVA_BATCH_QUEUE`
- [ ] Producer stub: accepts batch payload, enqueues messages
- [ ] Consumer stub: dequeues and calls Express worker for processing
- [ ] Dead-letter queue configured for failed messages
- [ ] Message schema defined with Zod

---

## INFRA-05: Cloudflare Workers AI Fallback Provider

**Status:** NOT STARTED
**Priority:** LOW (P8 Phase 1.5)
**Depends on:** INFRA-02, P8-S13 (IAIProvider interface)
**ADR:** ADR-002 Section 3

### What It Delivers
`CloudflareAIProvider` implementing `IAIProvider` interface. Uses Workers AI (Nemotron or equivalent) as fallback when Gemini is unavailable.

### Acceptance Criteria
- [ ] `@cloudflare/ai` added as dependency (scoped to `services/edge/`)
- [ ] `CloudflareAIProvider` implements `IAIProvider` interface
- [ ] Circuit breaker: activates only after Gemini failure (configurable threshold)
- [ ] Response format matches `GeminiADKProvider` output schema
- [ ] Never called as primary — fallback only
- [ ] Feature flag: `ENABLE_AI_FALLBACK` (default: `false`)
- [ ] Tests with mock Workers AI binding

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

**Status:** NOT STARTED
**Priority:** HIGH (observability gap)
**Depends on:** None
**ADR:** ADR-002 Section 4

### What It Delivers
Centralized error tracking and performance monitoring via Sentry. Covers both React frontend and Express worker.

### Acceptance Criteria
- [ ] `@sentry/react` added to frontend dependencies
- [ ] `@sentry/node` + `@sentry/profiling-node` added to worker dependencies
- [ ] Sentry initialized in `src/main.tsx` (frontend) with React Error Boundary integration
- [ ] Sentry initialized in `services/worker/src/index.ts` (worker)
- [ ] DSN loaded from environment variable (`VITE_SENTRY_DSN` / `SENTRY_DSN`)
- [ ] Source maps uploaded to Sentry on build (Vite plugin)
- [ ] PII scrubbing enabled (no user emails, no document fingerprints in breadcrumbs)
- [ ] Performance sampling rate configurable via env var (default: 10%)
- [ ] Test: Sentry captures unhandled rejection in worker
- [ ] No secrets or fingerprints in Sentry events (Constitution 1.4 + 1.6)

---

## INFRA-08: pgvector Extension + Institution Ground Truth Table

**Status:** NOT STARTED
**Priority:** MEDIUM (blocks P8-S7 anomaly detection)
**Depends on:** None
**ADR:** ADR-002 Section 5 (implied)

### What It Delivers
Enable `pgvector` extension in Supabase. Create `institution_ground_truth` table with vector embeddings for future institution verification (Cloudflare Crawl data, known issuer metadata).

### Acceptance Criteria
- [ ] Migration `0051_enable_pgvector_and_institution_ground_truth.sql` created
- [ ] `CREATE EXTENSION IF NOT EXISTS vector` (with schema specification)
- [ ] `institution_ground_truth` table with columns:
  - `id` (uuid, PK, default gen_random_uuid())
  - `institution_name` (text, not null)
  - `domain` (text)
  - `metadata` (jsonb, default '{}')
  - `embedding` (vector(768))
  - `source` (text) — e.g., 'cloudflare_crawl', 'manual', 'api'
  - `confidence_score` (numeric(3,2), check 0-1)
  - `created_at` (timestamptz, default now())
  - `updated_at` (timestamptz, default now())
- [ ] RLS enabled (`FORCE ROW LEVEL SECURITY`)
- [ ] RLS policy: service_role full access, authenticated read-only
- [ ] Index on `embedding` column (ivfflat or hnsw)
- [ ] Index on `institution_name` (trigram for fuzzy search)
- [ ] Rollback comment at bottom of migration
- [ ] `database.types.ts` regenerated
- [ ] `docs/confluence/02_data_model.md` updated

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
