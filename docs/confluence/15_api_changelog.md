# API Changelog & Versioning

> Last updated: 2026-03-23

## Versioning Policy

Arkova follows a **stable-first** API versioning strategy:

- **Base URL:** `/api/v1/`
- **Breaking changes** require a new major version (`/api/v2/`) with a 12-month deprecation period (Constitution 1.8)
- **Additive changes** (new nullable fields, new endpoints) are shipped without version bump
- **Frozen schemas:** The `VerificationResult` schema is frozen. Fields cannot be removed or renamed.

## v1.3.0 — 2026-03-23

### New Endpoints
- `POST /api/v1/webhooks/test` — Send test webhook events for endpoint verification
- `GET /api/v1/webhooks/deliveries` — View webhook delivery logs for self-service debugging

### New Features
- **X-Request-Id header** on every response for distributed tracing and support debugging
- **Idempotency-Key header** support on all POST/PUT/PATCH endpoints (24h cache, Stripe pattern)
- **API key scope enforcement** — keys are now restricted to their granted scopes (`verify`, `verify:batch`, `keys:manage`, `usage:read`)
- **Cursor-based pagination** on attestation list endpoint (`?cursor=...`)
- **`expires_at` field** in 202 Accepted responses for async batch jobs
- **`job.completed` webhook event** dispatched when batch verification jobs finish
- **Upstash Redis rate limiting adapter** for horizontal scaling (optional)
- **Synchronous quota enforcement** — usage incremented before processing, not after

### Improvements
- Standardized error format (`{error: {code, message}}`) across all non-v1 routes
- Retry-After header on all 503 responses (RFC 7231 compliant)
- Job retention extended from 24 hours to 7 days
- Partial result caching for batch jobs (items saved progressively)
- CORS: Expose X-Request-Id, rate limit, and quota headers to browser clients

### Documentation
- OpenAPI spec expanded to cover all Phase 1.5 endpoints (anchor, attestations, entity, compliance, regulatory, CLE, nessie)
- Webhook event catalog with payload schemas and signature verification examples (Node.js, Python, Go)

## v1.2.0 — 2026-03-15

### New Endpoints
- `POST /api/v1/anchor` — Submit credentials for Bitcoin anchoring
- `POST/GET/PATCH /api/v1/attestations` — Attestation CRUD
- `GET /api/v1/verify/entity` — Entity verification across all records
- `POST /api/v1/compliance/check` — Compliance risk scoring
- `GET /api/v1/regulatory/lookup` — Public regulatory record search
- `GET/POST /api/v1/cle` — CLE verification
- `POST /api/v1/nessie/query` — RAG query interface

### New Features
- x402 payment protocol support on paid endpoints
- AI Intelligence endpoints (extract, search, embed, feedback, integrity, review, reports)

## v1.1.0 — 2026-03-01

### New Endpoints
- `GET /api/v1/verify/search` — Agentic verification search (semantic)

### New Features
- Webhook system with HMAC signatures, exponential backoff, circuit breaker, SSRF protection
- Dead letter queue for failed webhook deliveries

## v1.0.0 — 2026-02-15

### Initial Release
- `GET /api/v1/verify/{publicId}` — Single credential verification
- `POST /api/v1/verify/batch` — Batch verification (sync ≤20, async >20)
- `GET /api/v1/jobs/{jobId}` — Async job polling
- `GET/POST/PATCH/DELETE /api/v1/keys` — API key management
- `GET /api/v1/usage` — Usage statistics
- OpenAPI 3.0 spec at `/api/docs`
- HMAC-SHA256 API key management
- 3-tier rate limiting (anonymous, keyed, batch)
