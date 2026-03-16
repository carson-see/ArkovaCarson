# P4.5 Verification API — Story Documentation
_Last updated: 2026-03-15 | 13/13 stories COMPLETE (100%)_

## Group Overview

P4.5 Verification API delivers a programmatic API for third-party credential verification. All 13 stories are behind the `ENABLE_VERIFICATION_API` feature flag (default: `false`).

Key deliverables:
- Feature flag middleware gating all `/api/v1/*` endpoints
- API key lifecycle: creation, HMAC-SHA256 hashing, rotation, revocation, audit
- Single and batch verification endpoints with frozen response schema
- Free tier enforcement (10K requests/month)
- Rate limiting per API key tier
- API key management UI
- OpenAPI documentation
- Load testing suite

### Phase 1 Foundation (COMPLETE)

5 stories implemented in the initial sprint:
- **P4.5-TS-12** — Feature gate middleware (TTL-cached switchboard flag)
- **P4.5-TS-03** — API key auth middleware (HMAC-SHA256 hashing, `ak_` prefix, scoped keys)
- **P4.5-TS-01** — `GET /api/v1/verify/:publicId` (frozen response schema)
- **P4.5-TS-07** — Key CRUD endpoints (POST/GET/PATCH/DELETE with audit logging)
- **P4.5-TS-05** — Usage tracking + free tier quota enforcement (10K/month)

**Migration:** 0057 (`verification_api_foundation.sql`) — creates `api_keys` table, `api_key_usage` table, `api_key_rate_limit_tier` enum, `ENABLE_VERIFICATION_API` flag, RLS policies.

**Test coverage:** 62 new tests (10 featureGate + 16 apiKeyAuth + 11 usageTracking + 12 verify + 13 keys). Worker total: 665 tests.

### Phase 2 Full API (COMPLETE)

8 remaining stories implemented:
- **P4.5-TS-02** — `POST /api/v1/verify/batch` (sync ≤20, async >20 with job creation)
- **P4.5-TS-06** — `GET /api/v1/jobs/:jobId` (ownership check, 24h cleanup)
- **P4.5-TS-08** — `GET /api/v1/usage` (per-key breakdown, unlimited tier)
- **P4.5-TS-04** — OpenAPI 3.0 docs at `/api/docs` (Swagger UI) + `/api/docs/spec.json`
- **P4.5-TS-09** — API Key Management UI (`ApiKeySettings`, `useApiKeys` hook, two-phase secret display)
- **P4.5-TS-10** — API Usage Dashboard Widget (`ApiUsageDashboard` with progress bar)
- **P4.5-TS-11** — API Key Scope Display (`ApiKeyScopeDisplay` with color-coded badges)
- **P4.5-TS-13** — Rate limit load tests (anon/keyed/batch tiers, concurrent simulation)

**Migration:** 0058 (`batch_verification_jobs.sql`) — creates batch job table with RLS.

**Gap fixes:** Agent discoverability via `/.well-known/openapi.json` redirect + `Link` header (RFC 8631) on all API responses.

**Test coverage:** 54 new tests (11 batch + 4 jobs + 4 usage + 9 docs + 8 page + 8 component + 6 dashboard + 4 scope + 12 load). Worker total: 693. Frontend total: 634.

## Architecture Context

**Design Principle: Feature-Flagged API.** The entire API surface is gated behind `ENABLE_VERIFICATION_API`. When false, all `/api/v1/*` routes return HTTP 503. The `/health` endpoint is always available regardless of flag state.

**Frozen Response Schema (ADR-001):** The verification API response format is immutable once published. No field removals, type changes, or semantic changes without a new version prefix (`/api/v2/*`). Additive changes (new nullable fields) are allowed. The schema is defined in CLAUDE.md Section 10 and implemented in the `get_public_anchor` RPC (migration 0044).

**API Key Security Model:** Raw API keys are never stored. Keys are hashed with HMAC-SHA256 using `API_KEY_HMAC_SECRET` before persistence. On each request, the incoming key is hashed and compared against the stored hash. Key lifecycle events (create, revoke) are logged to `audit_events`.

**Rate Limiting Tiers:**
| Tier | Limit | Applies To |
|------|-------|-----------|
| Anonymous | 100 req/min per IP | Unauthenticated requests |
| API Key (Free) | 1,000 req/min per key | Free tier API keys |
| API Key (Paid) | Custom per plan | Paid tier API keys |
| Batch | 10 req/min per key | POST `/api/v1/verify/batch` |

## Existing Infrastructure

Significant foundational infrastructure already exists that P4.5 builds upon:

| Component | Status | Notes |
|-----------|--------|-------|
| Rate limiter middleware | Ready | `services/worker/src/utils/rateLimit.ts` (104 lines). In-memory store with configurable windows. Pre-configured `api` limiter exists. |
| Switchboard flags | Ready | `src/lib/switchboard.ts` + migration 0021. Flag table, history, `get_flag()` RPC. Just needs `ENABLE_VERIFICATION_API` entry. |
| Public verification RPC | Ready | `get_public_anchor()` (migration 0044). Returns frozen schema format. Granted to anon + authenticated. |
| Webhook delivery | Ready | `services/worker/src/webhooks/delivery.ts` (259 lines). HMAC signing, retry, idempotency. |
| Worker Express app | Ready | Health, Stripe webhook, job routes all working. Ready for `/api/v1/*` routes. |
| Worker DB utils | Ready | Supabase client, Pino logger, correlation ID, Zod config. |
| Proof package schema | Ready | `src/lib/proofPackage.ts` (171 lines). Zod-validated v1.0 format. |

## Dependency Chain

```
1. P4.5-TS-12 (Feature flag middleware) ← No dependencies
   |
2. P4.5-TS-03 (API keys + HMAC + rate limiting) ← P1-TS-03
   |
   ├── 3. P4.5-TS-01 (GET /verify/:publicId) ← P6-TS-01
   ├── 4. P4.5-TS-06 (GET /jobs/:jobId) ← P4.5-TS-03
   ├── 6. P4.5-TS-07 (Key CRUD endpoints) ← P4.5-TS-03
   └── 7. P4.5-TS-05 (Free tier enforcement) ← P4.5-TS-03
       |
5. P4.5-TS-02 (POST /verify/batch) ← P4.5-TS-01
       |
8. P4.5-TS-08 (GET /usage) ← P4.5-TS-05
       |
9. P4.5-TS-04 (OpenAPI docs) ← All above
       |
10. P4.5-TS-09 (API Key Management UI) ← P4.5-TS-07
11. P4.5-TS-10 (Usage Dashboard Widget) ← P4.5-TS-05
12. P4.5-TS-11 (Key Scope Display) ← P4.5-TS-09
13. P4.5-TS-13 (Load tests) ← All deployed
```

## File Placement (Planned)

```
services/worker/src/
  api/
    verify.ts              # GET /api/v1/verify/:publicId
    batch.ts               # POST /api/v1/verify/batch
    jobs.ts                # GET /api/v1/jobs/:jobId
    keys.ts                # POST/GET/PATCH/DELETE /api/v1/keys
    usage.ts               # GET /api/v1/usage
  middleware/
    apiKeyAuth.ts          # API key extraction + HMAC validation
    featureGate.ts         # ENABLE_VERIFICATION_API enforcement
    usageTracking.ts       # Increment monthly usage counter
  schemas/
    api.ts                 # Zod schemas for API payloads
    types.ts               # TypeScript interfaces for API responses

src/components/
  api/
    ApiKeySettings.tsx     # Key management UI
    ApiUsageDashboard.tsx  # Usage display widget
    ApiKeyScopeDisplay.tsx # Scope badges + editing

src/pages/
  ApiKeySettingsPage.tsx   # Routed at /settings/api-keys

tests/load/                # K6 or Artillery load test scenarios
```

## Environment Variables (Required)

```bash
ENABLE_VERIFICATION_API=false    # Feature flag (default off)
API_KEY_HMAC_SECRET=             # HMAC-SHA256 secret for key hashing
CORS_ALLOWED_ORIGINS=*           # CORS configuration for API
```

---

## Stories

---

### P4.5-TS-12: Feature Flag Middleware

**Status:** ✅ COMPLETE
**Points:** 3
**Dependencies:** None
**Completed:** 2026-03-15

#### User Story

As the platform operator, I want to gate the entire verification API behind a feature flag so that it can be enabled/disabled without redeployment.

#### What Exists

- Switchboard flag infrastructure (`switchboard_flags` table, `get_flag()` RPC, migration 0021)
- `ENABLE_VERIFICATION_API` referenced in CLAUDE.md but **not yet in the database**
- `/health` endpoint already exists in worker Express app

#### What's Missing

- Flag entry in `switchboard_flags` seed data
- Express middleware function checking flag on each request
- 503 response format (JSON with `error` and `message`)
- Cache layer for flag reads to avoid per-request DB queries

#### Acceptance Criteria

- [ ] `ENABLE_VERIFICATION_API` flag added to `switchboard_flags` (default: `false`)
- [ ] Middleware returns HTTP 503 with `{ error: "service_unavailable", message: "Verification API is not currently enabled" }` for all `/api/v1/*` when flag is `false`
- [ ] `/health` always responds regardless of flag state
- [ ] Flag change takes effect without worker restart (TTL-based cache, max 60s)
- [ ] CORS headers applied to `/api/v1/*` routes using `CORS_ALLOWED_ORIGINS` env var

#### Implementation Tasks

- [ ] Write migration 0051: insert `ENABLE_VERIFICATION_API` into `switchboard_flags` (default false)
- [ ] Create `services/worker/src/middleware/featureGate.ts` — Express middleware that reads flag via `get_flag()` RPC with 60s TTL in-memory cache
- [ ] Register middleware on `/api/v1/*` route group in `services/worker/src/index.ts`
- [ ] Add CORS middleware for `/api/v1/*` using `CORS_ALLOWED_ORIGINS` env var
- [ ] Add `CORS_ALLOWED_ORIGINS` to worker `config.ts` (optional, default `*`)
- [ ] Update `supabase/seed.sql` with new flag entry
- [ ] Write unit tests for featureGate middleware (flag on → pass-through, flag off → 503, `/health` always available)
- [ ] Write integration test verifying flag toggle propagates within cache TTL

#### Definition of Done

- Migration applied, seed updated, types regenerated
- Middleware unit tests passing (on/off/health scenarios)
- `typecheck` + `lint` + `test` + `lint:copy` all green
- `docs/confluence/13_switchboard.md` updated with new flag

---

### P4.5-TS-03: API Keys Table + HMAC + Rate Limiting

**Status:** ✅ COMPLETE
**Points:** 8
**Dependencies:** P1-TS-03 (audit events), P4.5-TS-12 (feature gate)
**Completed:** 2026-03-15

#### User Story

As an API consumer, I want to create API keys that authenticate my requests and receive rate limiting appropriate to my tier so that I can programmatically verify credentials.

#### What Exists

- Rate limiter middleware (`rateLimit.ts`) with configurable windows and pre-configured `api` limiter
- `audit_events` table for key lifecycle logging
- Worker DB utils (Supabase client, Pino logger)

#### What's Missing

- `api_keys` table with HMAC-SHA256 key hash storage
- `api_key_usage` table for monthly quota tracking
- API key extraction middleware (from `Authorization: Bearer` or `X-API-Key` header)
- HMAC-SHA256 comparison logic using `API_KEY_HMAC_SECRET`
- Per-key rate limit configuration
- RLS policies (users read own org's keys, `service_role` full access)
- Key generation utility (crypto-random, prefixed `ak_live_` / `ak_test_`)

#### Acceptance Criteria

- [ ] `api_keys` table created with columns: `id` (uuid), `org_id` (fk), `key_prefix` (first 8 chars for identification), `key_hash` (HMAC-SHA256), `name`, `scopes` (text[]), `rate_limit_tier` (enum: free/paid/custom), `last_used_at`, `expires_at`, `is_active` (default true), `created_at`, `created_by` (fk), `revoked_at`, `revocation_reason`
- [ ] `api_key_usage` table created with columns: `id`, `org_id`, `api_key_id`, `month` (text, YYYY-MM), `request_count` (int, default 0), `last_reset_at`
- [ ] `FORCE ROW LEVEL SECURITY` on both tables
- [ ] RLS: org members can SELECT own org's keys; INSERT/UPDATE/DELETE via `service_role` only
- [ ] Raw keys never persisted — HMAC-SHA256 hash stored using `API_KEY_HMAC_SECRET`
- [ ] Key extraction from `Authorization: Bearer ak_live_...` and `X-API-Key: ak_live_...` headers
- [ ] Rate limiting configured per key tier (free: 1,000/min, paid: custom, anonymous: 100/min per IP)
- [ ] Key create and revoke events logged to `audit_events`
- [ ] Key prefix (`ak_live_` for production, `ak_test_` for test) included in generated keys

#### Implementation Tasks

- [ ] Write migration 0052: create `api_keys` table with all columns, indexes, RLS policies
- [ ] Write migration 0053: create `api_key_usage` table with composite unique on (api_key_id, month), RLS policies
- [ ] Create `services/worker/src/middleware/apiKeyAuth.ts` — extract key from headers, HMAC-SHA256 hash, compare against `api_keys`, attach key metadata to `req`
- [ ] Create `services/worker/src/utils/apiKeyGenerator.ts` — generate crypto-random key with `ak_live_` / `ak_test_` prefix, return { raw, hash, prefix }
- [ ] Extend rate limiter in `rateLimit.ts` to support per-key tier configuration
- [ ] Add `API_KEY_HMAC_SECRET` to worker `config.ts` (required when `ENABLE_VERIFICATION_API=true`)
- [ ] Write Zod schemas for API key create/update requests in `services/worker/src/schemas/api.ts`
- [ ] Update seed data with test API key for demo org
- [ ] Regenerate `database.types.ts`
- [ ] Write unit tests: key generation, HMAC hashing, header extraction, tier-based rate limiting
- [ ] Write RLS tests: cross-org isolation, service_role bypass

#### Definition of Done

- Migrations applied, seed updated, types regenerated
- Unit + RLS tests passing
- `typecheck` + `lint` + `test` + `lint:copy` all green
- `docs/confluence/02_data_model.md` updated with new tables
- `docs/confluence/03_security_rls.md` updated with RLS policies
- `docs/confluence/12_verification_api.md` updated with key security model

---

### P4.5-TS-01: GET /api/v1/verify/:publicId

**Status:** ✅ COMPLETE
**Points:** 5
**Dependencies:** P6-TS-01 (get_public_anchor RPC), P4.5-TS-03 (API key auth)
**Completed:** 2026-03-15

#### User Story

As an API consumer, I want to verify a single credential by public ID and receive a structured response so that I can integrate credential verification into my application.

#### What Exists

- `get_public_anchor()` RPC (migration 0044) already returns data in frozen schema format
- Rate limiter middleware ready
- API key auth middleware (from P4.5-TS-03)

#### What's Missing

- Express route handler for `GET /api/v1/verify/:publicId`
- Response formatting to match frozen schema exactly (including `jurisdiction` omission rule)
- Usage tracking increment per request
- Rate limit headers on every response (`X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`)
- Verification event logging with `method='api'`

#### Acceptance Criteria

- [ ] `GET /api/v1/verify/:publicId` returns frozen schema response (see Section below)
- [ ] Anonymous access allowed at 100 req/min per IP
- [ ] API key access at 1,000 req/min per key
- [ ] Rate limit headers on every response: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`
- [ ] HTTP 404 with `{ error: "not_found", message: "Credential not found" }` for unknown publicId
- [ ] HTTP 429 with `Retry-After` header when rate limit exceeded
- [ ] Verification event logged to `verification_events` with `method='api'`
- [ ] `jurisdiction` field omitted from response when null (not returned as `null`)
- [ ] Usage counter incremented in `api_key_usage` for authenticated requests
- [ ] Response includes `Cache-Control: no-store` (credential status can change)

#### Implementation Tasks

- [ ] Create `services/worker/src/api/verify.ts` — Express router with `GET /:publicId` handler
- [ ] Call `get_public_anchor()` RPC and map result to frozen schema
- [ ] Implement `jurisdiction` omission logic: conditional spread `...(jurisdiction && { jurisdiction })`
- [ ] Apply rate limiting middleware (anonymous vs. API key tier)
- [ ] Add rate limit response headers via middleware
- [ ] Increment `api_key_usage.request_count` for authenticated requests
- [ ] Fire verification event to `verification_events` table (fire-and-forget, non-blocking)
- [ ] Register route in worker `index.ts` under `/api/v1/verify`
- [ ] Write Zod schema for response validation in `services/worker/src/schemas/api.ts`
- [ ] Write unit tests: successful verify, 404, rate limit headers, jurisdiction omission, event logging
- [ ] Write integration test: anonymous vs. key-authenticated rate limits

#### Definition of Done

- Route handler passing all unit + integration tests
- Frozen schema response validated against Zod schema in tests
- `typecheck` + `lint` + `test` + `lint:copy` all green
- `docs/confluence/12_verification_api.md` updated with endpoint documentation

---

### P4.5-TS-02: POST /api/v1/verify/batch

**Status:** NOT STARTED
**Points:** 5
**Dependencies:** P4.5-TS-01 (single verify endpoint)
**Blocked by:** P4.5-TS-01

#### User Story

As an API consumer with many credentials to verify, I want to submit a batch of public IDs in a single request so that I can efficiently verify multiple credentials without making individual calls.

#### What Exists

- Single verify endpoint (P4.5-TS-01) with frozen schema response
- Rate limiter middleware with per-key configuration
- `get_public_anchor()` RPC

#### What's Missing

- Express route handler for `POST /api/v1/verify/batch`
- Request validation (array of public_ids, max batch size)
- Concurrent RPC execution with timeout handling
- Batch job tracking for large requests (async with job ID)
- Stricter rate limiting (10 req/min per API key)

#### Acceptance Criteria

- [ ] `POST /api/v1/verify/batch` accepts `{ public_ids: string[] }` body
- [ ] Returns `{ results: VerificationResult[], job_id?: string }` matching frozen schema per item
- [ ] Rate limited to 10 req/min per API key
- [ ] API key required (HTTP 401 for anonymous batch access)
- [ ] Maximum batch size: 100 public_ids per request (HTTP 400 if exceeded)
- [ ] Synchronous for batches ≤ 20: results returned inline
- [ ] Async for batches > 20: returns `{ job_id }` immediately, results via `GET /api/v1/jobs/:jobId`
- [ ] Each item in results includes `public_id` field for correlation
- [ ] Partial results on timeout: verified items returned, timed-out items marked `{ verified: null, error: "timeout" }`
- [ ] Usage counter incremented by number of items verified (not number of requests)

#### Implementation Tasks

- [ ] Create `services/worker/src/api/batch.ts` — Express router with `POST /` handler
- [ ] Write Zod schema for batch request: `{ public_ids: z.array(z.string()).min(1).max(100) }`
- [ ] Implement sync path (≤ 20 items): `Promise.allSettled()` with per-item timeout
- [ ] Implement async path (> 20 items): create job record, enqueue for background processing, return job_id
- [ ] Create `batch_verification_jobs` table (migration) if async path needed: id, api_key_id, status (submitted/processing/complete/failed), public_ids, results (jsonb), created_at, completed_at
- [ ] Apply 10 req/min rate limit for batch endpoint specifically
- [ ] Require API key auth (reject anonymous with 401)
- [ ] Increment usage counter by `public_ids.length` (not by 1)
- [ ] Register route in worker `index.ts` under `/api/v1/verify/batch`
- [ ] Write unit tests: valid batch, oversized batch (400), anonymous rejection (401), rate limit (429), sync vs async threshold, partial timeout results
- [ ] Write integration test: batch of 5 with mix of valid/invalid public_ids

#### Definition of Done

- Route handler passing all unit + integration tests
- Batch size limits and rate limits enforced
- `typecheck` + `lint` + `test` + `lint:copy` all green
- `docs/confluence/12_verification_api.md` updated with batch endpoint documentation

---

### P4.5-TS-06: GET /api/v1/jobs/:jobId

**Status:** NOT STARTED
**Points:** 3
**Dependencies:** P4.5-TS-02 (batch verification creates jobs)
**Blocked by:** P4.5-TS-03

#### User Story

As an API consumer who submitted a batch verification, I want to poll a job status endpoint so that I can retrieve results when processing completes.

#### What Exists

- Batch verification endpoint (P4.5-TS-02) creates job records for async batches
- Worker job processing infrastructure (`services/worker/src/jobs/`)

#### What's Missing

- Express route handler for `GET /api/v1/jobs/:jobId`
- Job status response format
- Ownership validation (API key must own the job)

#### Acceptance Criteria

- [ ] `GET /api/v1/jobs/:jobId` returns job status: `{ job_id, status, results?, created_at, completed_at? }`
- [ ] Status values: `submitted` | `processing` | `complete` | `failed`
- [ ] `results` array included only when `status = complete`
- [ ] API key required — must be the key that created the job (HTTP 403 otherwise)
- [ ] HTTP 404 for unknown job_id
- [ ] Job records auto-expire after 24 hours (cleanup in worker cron)

#### Implementation Tasks

- [ ] Create `services/worker/src/api/jobs.ts` — Express router with `GET /:jobId` handler
- [ ] Query `batch_verification_jobs` table by `id` and `api_key_id`
- [ ] Return 403 if `api_key_id` doesn't match requesting key
- [ ] Return 404 if job not found
- [ ] Include `results` only for `status = complete`
- [ ] Add cron job to clean up expired jobs (> 24h old)
- [ ] Register route in worker `index.ts` under `/api/v1/jobs`
- [ ] Write unit tests: all status values, ownership check (403), not found (404), expired cleanup
- [ ] Write integration test: submit batch → poll until complete → verify results

#### Definition of Done

- Route handler passing all unit + integration tests
- Job lifecycle (submit → process → complete/fail → expire) tested
- `typecheck` + `lint` + `test` + `lint:copy` all green
- `docs/confluence/12_verification_api.md` updated with job polling documentation

---

### P4.5-TS-07: Key CRUD Endpoints

**Status:** ✅ COMPLETE
**Points:** 5
**Dependencies:** P4.5-TS-03 (api_keys table)
**Completed:** 2026-03-15

#### User Story

As an organization admin, I want REST endpoints to create, list, update, and revoke API keys so that I can manage programmatic access to the verification API.

#### What Exists

- `api_keys` table (from P4.5-TS-03)
- API key generation utility
- `audit_events` table for lifecycle logging

#### What's Missing

- Express route handlers for key CRUD operations
- Key creation response (raw key shown once, never again)
- Key masking for list/get responses (show only prefix + last 4 chars)
- Revocation with reason tracking
- Audit event logging for all operations

#### Acceptance Criteria

- [ ] `POST /api/v1/keys` creates new key: accepts `{ name, scopes? }`, returns `{ key_id, raw_key, prefix, name, scopes, created_at }` — raw_key shown **once**
- [ ] `GET /api/v1/keys` lists org's keys: returns array of `{ key_id, prefix, name, scopes, is_active, last_used_at, created_at }` — **never raw key**
- [ ] `GET /api/v1/keys/:keyId` returns single key detail (masked)
- [ ] `PATCH /api/v1/keys/:keyId` updates `name` and/or `scopes` only
- [ ] `DELETE /api/v1/keys/:keyId` revokes key: accepts optional `{ reason }` body, sets `is_active=false`, `revoked_at=now()`, `revocation_reason`
- [ ] All operations require authenticated session (Supabase auth, not API key) — these are management endpoints
- [ ] All operations logged to `audit_events` with action type and key_id
- [ ] RLS enforces org-scoped access (user sees only own org's keys)
- [ ] Maximum 10 active keys per org (HTTP 400 if exceeded on create)

#### Implementation Tasks

- [ ] Create `services/worker/src/api/keys.ts` — Express router with POST, GET, GET/:id, PATCH/:id, DELETE/:id handlers
- [ ] Implement key creation: generate key, store HMAC hash, return raw key once
- [ ] Implement key listing: query `api_keys` for org, mask key (prefix + `...` + last 4)
- [ ] Implement key update: validate only `name`/`scopes` are modifiable
- [ ] Implement key revocation: soft-delete (set `is_active=false`, `revoked_at`, `revocation_reason`)
- [ ] Add Supabase session auth middleware for management endpoints (not API key auth)
- [ ] Write audit event helper: log create/update/revoke to `audit_events`
- [ ] Enforce max 10 active keys per org (count check before create)
- [ ] Write Zod schemas for create/update request bodies
- [ ] Register route in worker `index.ts` under `/api/v1/keys`
- [ ] Write unit tests: create (raw key in response), list (masked), update, revoke (with reason), max key limit, audit logging
- [ ] Write RLS tests: cross-org isolation for key CRUD

#### Definition of Done

- All CRUD operations passing unit + RLS tests
- Raw key never persisted, never returned after creation
- Audit trail complete for all lifecycle events
- `typecheck` + `lint` + `test` + `lint:copy` all green
- `docs/confluence/04_audit_events.md` updated with key lifecycle events
- `docs/confluence/12_verification_api.md` updated with key management endpoints

---

### P4.5-TS-05: Free Tier Enforcement

**Status:** ✅ COMPLETE
**Points:** 5
**Dependencies:** P4.5-TS-03 (api_key_usage table)
**Completed:** 2026-03-15

#### User Story

As the platform operator, I want to enforce a monthly request quota on free tier API keys so that API usage is sustainable and paid tiers offer clear value.

#### What Exists

- `api_key_usage` table (from P4.5-TS-03) tracking monthly request counts
- Rate limiter middleware
- `billing_accounts` table with plan information

#### What's Missing

- Quota enforcement middleware
- Monthly counter reset logic
- HTTP 429 response with upgrade URL
- Quota headers on every response
- Paid tier exemption logic

#### Acceptance Criteria

- [ ] Monthly request counter tracked per API key in `api_key_usage`
- [ ] Counter resets automatically on 1st of each month (or on first request of new month)
- [ ] HTTP 429 returned when free tier quota (10,000/month) exceeded: `{ error: "quota_exceeded", message: "Monthly API quota exceeded", upgrade_url: "/pricing", used: N, limit: 10000 }`
- [ ] Response headers on every authenticated request: `X-Quota-Used`, `X-Quota-Limit`, `X-Quota-Reset` (ISO date of next reset)
- [ ] Paid tier keys exempt from monthly quota (checked via `rate_limit_tier` on `api_keys`)
- [ ] Quota check happens after rate limit check (rate limit first, then quota)

#### Implementation Tasks

- [ ] Create `services/worker/src/middleware/usageTracking.ts` — middleware that:
  - Reads current month's usage from `api_key_usage`
  - Compares against quota (10K for free tier)
  - Returns 429 if exceeded
  - Increments counter on pass-through
  - Skips check for paid tier keys
- [ ] Implement lazy reset: if `month` column doesn't match current YYYY-MM, reset `request_count` to 0
- [ ] Add quota response headers to all authenticated API responses
- [ ] Add `FRONTEND_URL` or configurable `upgrade_url` to 429 response
- [ ] Write worker cron job: bulk reset stale usage records monthly (belt-and-suspenders for lazy reset)
- [ ] Write unit tests: under quota (pass), at quota (pass), over quota (429), paid tier (exempt), month rollover reset
- [ ] Write integration test: exhaust quota across multiple requests, verify 429

#### Definition of Done

- Quota enforcement passing all unit + integration tests
- Reset logic verified across month boundaries
- `typecheck` + `lint` + `test` + `lint:copy` all green
- `docs/confluence/12_verification_api.md` updated with quota documentation

---

### P4.5-TS-08: GET /api/v1/usage

**Status:** NOT STARTED
**Points:** 2
**Dependencies:** P4.5-TS-05 (usage tracking)
**Blocked by:** P4.5-TS-05

#### User Story

As an API consumer, I want to check my current month's API usage so that I can monitor my quota consumption and plan accordingly.

#### What Exists

- `api_key_usage` table with monthly counters (from P4.5-TS-03/TS-05)
- Usage tracking middleware incrementing counters

#### What's Missing

- Express route handler for `GET /api/v1/usage`
- Response format aggregating usage across all org keys
- Reset date calculation

#### Acceptance Criteria

- [ ] `GET /api/v1/usage` returns `{ used, limit, remaining, reset_date, keys: [{ key_prefix, used }] }`
- [ ] `used` = sum of all org key usage for current month
- [ ] `limit` = org's monthly quota (10,000 for free, plan-specific for paid)
- [ ] `remaining` = max(0, limit - used)
- [ ] `reset_date` = ISO 8601 date of next month's 1st day
- [ ] `keys` array breaks down usage per API key (prefix only, never raw)
- [ ] API key required (management auth or API key)
- [ ] Scoped to requesting key's org

#### Implementation Tasks

- [ ] Create `services/worker/src/api/usage.ts` — Express router with `GET /` handler
- [ ] Query `api_key_usage` for all keys in org for current month
- [ ] Aggregate total usage, compute remaining
- [ ] Look up org's plan for quota limit (default 10K for free)
- [ ] Calculate `reset_date` as first day of next month
- [ ] Return per-key breakdown with prefix only
- [ ] Register route in worker `index.ts` under `/api/v1/usage`
- [ ] Write unit tests: single key, multiple keys, zero usage, quota exceeded, paid tier limit

#### Definition of Done

- Route handler passing all unit tests
- `typecheck` + `lint` + `test` + `lint:copy` all green
- `docs/confluence/12_verification_api.md` updated with usage endpoint documentation

---

### P4.5-TS-04: OpenAPI Documentation

**Status:** NOT STARTED
**Points:** 5
**Dependencies:** All API route stories (P4.5-TS-01, TS-02, TS-06, TS-07, TS-08)
**Blocked by:** P4.5-TS-01, P4.5-TS-02, P4.5-TS-06, P4.5-TS-07, P4.5-TS-08

#### User Story

As an API consumer, I want interactive API documentation so that I can understand endpoints, authentication, and rate limits without reading source code.

#### What Exists

- All API routes implemented (from preceding stories)
- Zod schemas for request/response validation
- Worker Express app serving routes

#### What's Missing

- OpenAPI 3.0 specification (YAML or JSON)
- Swagger UI integration in worker
- Request/response examples for each endpoint
- Authentication documentation (API key + anonymous)
- Rate limiting documentation per tier

#### Acceptance Criteria

- [ ] OpenAPI 3.0 spec auto-generated or maintained alongside route definitions
- [ ] Swagger UI served at `GET /api/docs` with interactive try-it-out
- [ ] All endpoints documented: verify, batch, jobs, keys, usage
- [ ] Request/response examples included for every endpoint
- [ ] Authentication methods documented: API key (Bearer + X-API-Key), anonymous
- [ ] Rate limiting documented per tier with headers explained
- [ ] Frozen response schema defined as `VerificationResult` component (single source of truth)
- [ ] Error response schemas documented (400, 401, 403, 404, 429, 500, 503)
- [ ] `/api/docs` accessible without authentication

#### Implementation Tasks

- [ ] Install `swagger-ui-express` + `@asteasolutions/zod-to-openapi` (or equivalent)
- [ ] Create `services/worker/src/api/docs.ts` — OpenAPI spec generation from Zod schemas
- [ ] Define `VerificationResult` component matching frozen schema
- [ ] Define error response components (ApiError, RateLimitError, QuotaExceededError)
- [ ] Add authentication scheme definitions (API key bearer, API key header)
- [ ] Generate examples for each endpoint (successful + error cases)
- [ ] Mount Swagger UI at `/api/docs` in worker `index.ts`
- [ ] Ensure `/api/docs` is not gated by feature flag or API key auth
- [ ] Write test: `/api/docs` returns 200 with HTML, spec is valid OpenAPI 3.0
- [ ] Write test: all defined routes exist in spec

#### Definition of Done

- Swagger UI accessible and functional at `/api/docs`
- OpenAPI spec validates against OpenAPI 3.0 schema
- All endpoints documented with examples
- `typecheck` + `lint` + `test` + `lint:copy` all green
- `docs/confluence/12_verification_api.md` updated with docs endpoint info

---

### P4.5-TS-09: API Key Management UI

**Status:** NOT STARTED
**Points:** 8
**Dependencies:** P4.5-TS-07 (key CRUD endpoints)
**Blocked by:** P4.5-TS-07

#### User Story

As an organization admin, I want a settings page to create, view, and revoke API keys so that I can manage programmatic access from the Arkova dashboard.

#### What Exists

- Key CRUD endpoints (from P4.5-TS-07)
- Settings page pattern (OrgSettingsPage, WebhookSettings)
- shadcn/ui components (Dialog, Table, Badge, Button)
- Copy utility pattern (`src/lib/copy.ts`)

#### What's Missing

- `ApiKeySettings.tsx` component
- `ApiKeySettingsPage.tsx` routed at `/settings/api-keys`
- Create key dialog (name + scope selection)
- One-time raw key display with copy-to-clipboard
- Key list table (masked keys, status, last used)
- Revoke confirmation dialog
- Route registration in `App.tsx`

#### Acceptance Criteria

- [ ] `src/components/api/ApiKeySettings.tsx` component created following WebhookSettings pattern
- [ ] `src/pages/ApiKeySettingsPage.tsx` routed at `/settings/api-keys`
- [ ] Route added to `src/lib/routes.ts` and `App.tsx`
- [ ] Sidebar link added under Settings section
- [ ] Create key dialog: name input (required), scope checkboxes (optional, default all)
- [ ] Raw key displayed once on creation with copy-to-clipboard button and warning that it won't be shown again
- [ ] Key list table: prefix, name, scopes (badges), status (active/revoked), last used (relative time), created date
- [ ] Revoke button with confirmation dialog (optional reason input)
- [ ] Empty state when no keys exist
- [ ] Loading and error states
- [ ] All UI strings in `src/lib/copy.ts`

#### Implementation Tasks

- [ ] Create `src/components/api/ApiKeySettings.tsx` with create dialog, key list table, revoke dialog
- [ ] Create `src/pages/ApiKeySettingsPage.tsx` (thin wrapper)
- [ ] Create `src/hooks/useApiKeys.ts` — hook calling key CRUD endpoints
- [ ] Add route constant `API_KEY_SETTINGS` to `src/lib/routes.ts`
- [ ] Register route in `App.tsx` under authenticated layout
- [ ] Add sidebar navigation link in `Sidebar.tsx`
- [ ] Add copy strings to `src/lib/copy.ts`: page title, empty state, create dialog labels, revoke confirmation, raw key warning
- [ ] Implement copy-to-clipboard for raw key (with toast notification)
- [ ] Write component tests: render, create flow (dialog → raw key display), list rendering, revoke flow (dialog → confirmation)
- [ ] Write E2E spec: navigate to settings, create key, verify masked in list, revoke

#### Definition of Done

- Component tests + E2E spec passing
- UI follows existing settings page patterns
- All strings in `copy.ts`, no banned terms
- `typecheck` + `lint` + `test` + `lint:copy` all green
- Seed data click-through still works

---

### P4.5-TS-10: API Usage Dashboard Widget

**Status:** NOT STARTED
**Points:** 3
**Dependencies:** P4.5-TS-05 (usage tracking), P4.5-TS-08 (usage endpoint)
**Blocked by:** P4.5-TS-05

#### User Story

As an organization admin, I want to see my API usage at a glance so that I can monitor consumption and know when I'm approaching my quota.

#### What Exists

- Usage endpoint `GET /api/v1/usage` (from P4.5-TS-08)
- Dashboard component patterns (StatCard, progress bars)
- shadcn/ui Progress component

#### What's Missing

- `ApiUsageDashboard.tsx` widget component
- Color-coded progress bar (green/amber/red based on usage %)
- Integration into dashboard or API key settings page

#### Acceptance Criteria

- [ ] Widget component created: `src/components/api/ApiUsageDashboard.tsx`
- [ ] Displays: requests used, limit, percentage, days remaining until reset
- [ ] Progress bar with color thresholds: green (0-70%), amber (70-90%), red (90-100%)
- [ ] "Upgrade" CTA shown when usage > 80% for free tier
- [ ] Integrated into `ApiKeySettingsPage` (above key list) and optionally into main dashboard
- [ ] Loading skeleton while fetching usage data
- [ ] All UI strings in `src/lib/copy.ts`

#### Implementation Tasks

- [ ] Create `src/components/api/ApiUsageDashboard.tsx` using shadcn/ui Card + Progress
- [ ] Create `src/hooks/useApiUsage.ts` — hook calling `GET /api/v1/usage`
- [ ] Implement color logic: compute percentage, map to green/amber/red Tailwind classes
- [ ] Calculate days remaining: `reset_date` minus today
- [ ] Add UpgradePrompt CTA for free tier when usage > 80%
- [ ] Integrate into `ApiKeySettingsPage` (above key table)
- [ ] Add copy strings for usage labels, upgrade CTA
- [ ] Write component tests: render at various usage levels (10%, 75%, 95%, 100%), upgrade CTA visibility

#### Definition of Done

- Component tests passing for all usage thresholds
- Color thresholds visually correct
- `typecheck` + `lint` + `test` + `lint:copy` all green

---

### P4.5-TS-11: API Key Scope Display

**Status:** NOT STARTED
**Points:** 2
**Dependencies:** P4.5-TS-09 (key management UI)
**Blocked by:** P4.5-TS-09

#### User Story

As an organization admin, I want to see and edit what scopes each API key has so that I can follow least-privilege access principles.

#### What Exists

- API key management UI (from P4.5-TS-09) displaying keys in a table
- `scopes` column on `api_keys` table
- Badge component from shadcn/ui

#### What's Missing

- Scope badge rendering per key in the key list
- Scope description tooltips
- Scope editing in key update flow

#### Acceptance Criteria

- [ ] Scope badges displayed per key in the key list (e.g., `verify`, `verify:batch`, `keys:read`)
- [ ] Tooltip on badge hover showing scope description
- [ ] Scope editing in key update dialog (checkbox list)
- [ ] Available scopes: `verify` (single verify), `verify:batch` (batch), `keys:manage` (key CRUD), `usage:read` (usage endpoint)
- [ ] Default scope on key creation: `verify` only
- [ ] Scope changes logged to `audit_events`

#### Implementation Tasks

- [ ] Define scope constants and descriptions in `src/lib/copy.ts`
- [ ] Create `src/components/api/ApiKeyScopeDisplay.tsx` — render badges with tooltips
- [ ] Add scope checkbox list to create key dialog and update dialog in `ApiKeySettings.tsx`
- [ ] Update `useApiKeys.ts` hook to pass scopes on create/update calls
- [ ] Write component tests: badge rendering, tooltip content, scope editing
- [ ] Write unit test: scope change triggers audit event

#### Definition of Done

- Scope badges render correctly in key list
- Scope editing works in create + update flows
- `typecheck` + `lint` + `test` + `lint:copy` all green

---

### P4.5-TS-13: Rate Limit Load Tests

**Status:** NOT STARTED
**Points:** 5
**Dependencies:** All API endpoints deployed and functional
**Blocked by:** All other P4.5 stories

#### User Story

As the platform operator, I want load tests validating rate limiting behavior so that I can be confident the API handles burst traffic correctly and degrades gracefully under pressure.

#### What Exists

- Load test framework in `tests/load/` (25 scenarios from E2E testing sprint)
- All API endpoints deployed behind feature flag

#### What's Missing

- Verification API-specific load test scenarios
- Rate limit validation tests (verify 429 responses)
- Concurrent key isolation tests
- Performance baseline metrics
- Report generation

#### Acceptance Criteria

- [ ] Load test framework extended for verification API scenarios (K6, Artillery, or Autocannon)
- [ ] Spike test: burst 500 req in 10s from single IP, verify ≥ 80% get 429 after rate limit
- [ ] Sustained load test: hold at 90 req/min (just under anonymous limit) for 5 min, verify 0% 429s
- [ ] Ramp-up test: 10 → 200 req/min over 5 min, identify breaking point
- [ ] Batch endpoint test: 15 batch requests in 1 min, verify ≥ 5 get 429
- [ ] Key isolation test: 2 keys at 900 req/min each, verify neither gets 429 (each under 1000 limit)
- [ ] Report generation: latency (p50/p95/p99), throughput (req/s), error rate (%), rate limit accuracy
- [ ] All tests runnable via `npm run test:load:api`

#### Implementation Tasks

- [ ] Create `tests/load/api/` directory for verification API load scenarios
- [ ] Write spike test scenario: burst above anonymous rate limit
- [ ] Write sustained load scenario: hold near limit boundary
- [ ] Write ramp-up scenario: gradual increase to find ceiling
- [ ] Write batch rate limit scenario: verify 10 req/min enforcement
- [ ] Write key isolation scenario: concurrent keys with independent limits
- [ ] Configure report output (JSON + HTML summary)
- [ ] Add `test:load:api` script to `package.json`
- [ ] Write README in `tests/load/api/` explaining scenarios and how to run
- [ ] Run baseline and document results in `docs/confluence/12_verification_api.md`

#### Definition of Done

- All 6 load test scenarios passing against local worker instance
- Report generation producing actionable metrics
- Baseline results documented
- `typecheck` + `lint` + `test` + `lint:copy` all green (load tests not in CI gate)

---

## Frozen Response Schema

```json
{
  "verified": true,
  "status": "ACTIVE | REVOKED | SUPERSEDED | EXPIRED",
  "issuer_name": "string",
  "recipient_identifier": "string (hashed, never raw PII)",
  "credential_type": "string",
  "issued_date": "string | null",
  "expiry_date": "string | null",
  "anchor_timestamp": "string",
  "bitcoin_block": "number | null",
  "network_receipt_id": "string | null",
  "merkle_proof_hash": "string | null",
  "record_uri": "https://app.arkova.io/verify/{public_id}",
  "jurisdiction": "string (omitted when null, not returned as null)"
}
```

**Immutability Rules:**
- No field removals
- No type changes
- No semantic changes
- Additive changes (new nullable fields) allowed
- Breaking changes require: v2+ URL prefix, 12-month deprecation notice, migration guide

---

## Architectural Decisions

| Decision | Rationale |
|----------|-----------|
| All stories behind feature flag | API can be enabled/disabled without deployment |
| HMAC-SHA256 for key storage | Raw keys never at rest — only hash comparison |
| 503 when flag is false (not 404) | Communicates "service exists but is disabled" |
| Frozen schema immutability | API consumers depend on stable response format |
| record_uri uses HTTPS (ADR-001) | Universal browser/agent/HTTP client compatibility |
| Post-launch scheduling | Phase 1 launch is higher priority than API access |
| Sync/async batch threshold at 20 | Balance responsiveness (small batches) with reliability (large batches) |
| Management endpoints use session auth | Key CRUD is admin-only, not API-key authenticated |
| Max 10 keys per org | Prevent key sprawl, encourage rotation over accumulation |

## Related Documentation

- [12_verification_api.md](../confluence/12_verification_api.md) — Verification API architecture
- [13_switchboard.md](../confluence/13_switchboard.md) — Feature flag configuration
- [03_security_rls.md](../confluence/03_security_rls.md) — RLS patterns for new tables
- [02_data_model.md](../confluence/02_data_model.md) — Data model (api_keys, api_key_usage tables)
- [04_audit_events.md](../confluence/04_audit_events.md) — Audit events for key lifecycle
- CLAUDE.md Section 10 — Frozen schema and build order

## Change Log

| Date | Change |
|------|--------|
| 2026-03-10 | Initial P4.5 story documentation created (Session 3 of 3). |
| 2026-03-12 | Expanded all 13 stories with User Story, Implementation Tasks, and Definition of Done. Added points estimates, file placement for usage.ts and scope display. Added architectural decisions for batch threshold, session auth, and key limits. |
