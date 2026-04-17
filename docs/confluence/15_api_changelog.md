# API Changelog & Versioning

> Last updated: 2026-04-16

## Versioning Policy

Arkova follows a **stable-first** API versioning strategy:

- **Base URL:** `/api/v1/`
- **Breaking changes** require a new major version (`/api/v2/`) with a 12-month deprecation period (Constitution 1.8)
- **Additive changes** (new nullable fields, new endpoints) are shipped without version bump
- **Frozen schemas:** The `VerificationResult` schema is frozen. Fields cannot be removed or renamed.

## v1.5.0 (planned, Sprint 1) — API Richness

**Source:** 2026-04-16 API surface audit (`docs/BACKLOG.md` TIER 0I). Audit found existing responses expose ~15 fields while the DB stores 30+ per anchor plus linked manifests, audit events, and extraction_manifests. All additions below are **backwards-compatible nullable fields** — no endpoints changed, no existing fields removed.

### `GET /api/v1/verify/{publicId}` — additive fields

| Field | Type | Source | Purpose |
|-------|------|--------|---------|
| `compliance_controls` | `Record<string, string[]> \| null` | `anchors.compliance_controls` JSON | SOC 2 / FERPA / HIPAA / GDPR control IDs for enterprise GRC platforms (Vanta/Drata) |
| `chain_confirmations` | `number \| null` | `anchors.chain_confirmations` | Bitcoin network confirmations — block-level maturity indicator |
| `parent_anchor_id` | `string \| null` | `anchors.parent_anchor_id` (public_id of parent) | Credential lineage — e.g. "this diploma was reissued in 2024" |
| `version_number` | `number \| null` | `anchors.version_number` | Monotonically increasing version within a lineage |
| `revocation_tx_id` | `string \| null` | `anchors.revocation_tx_id` | Independently-verifiable revocation proof chain |
| `revocation_block_height` | `number \| null` | `anchors.revocation_block_height` | Block at which revocation was anchored |
| `file_mime` | `string \| null` | `anchors.file_mime` | Document MIME type |
| `file_size` | `number \| null` | `anchors.file_size` | Document size in bytes |

### `POST /api/v1/ai/extract` — additive fields

| Field | Type | Source | Purpose |
|-------|------|--------|---------|
| `confidenceScores` | `Record<string, number> \| null` | `extraction_manifests.confidence_scores` | Per-field confidence breakdown (not just overall) |
| `subType` | `string \| null` | Gemini v6 output | Fine-grained classification ("MD_LICENSE" vs "MEDICAL") |
| `description` | `string \| null` | Gemini v6 output | 1-2 sentence human-readable summary |
| `fraudSignals` | `string[] \| null` | Gemini cross-field fraud checks | Array of detected fraud indicators |

### New endpoint: `GET /api/v1/anchor/{publicId}/lifecycle`

Returns chain-of-custody event log from `audit_events`:
- `uploaded_at`, `extraction_completed_at`, `pending_anchor_at`, `submitted_at`, `secured_at`, `verified_at[]`, `revoked_at` (nullable)
- Each event includes `event_type`, `timestamp`, `actor_role` (anonymized), optional `metadata`

### New endpoint: `GET /api/v1/anchor/{publicId}/extraction-manifest`

Exposes the VAI-01 verifiable-AI manifest:
- `manifestHash` (deterministic SHA-256 of extraction inputs + output)
- `zkProof`, `zkPublicSignals`, `zkCircuitVersion` (when ZK proof was generated)
- `promptVersion` (hash of extraction prompt at inference time)
- `modelVersion` (e.g. `gemini-golden-v6-endpoint-740332515062972416`)

### SDK impact (must ship in same release)

- `sdks/typescript/src/types.ts` — `VerificationResult`, `ExtractionResult` type additions
- `sdks/python/arkova/types.py` — TypedDict additions
- OpenAPI spec `docs/api/openapi.yaml` — schema refs for new fields and endpoints
- CHANGELOG entry in both SDK packages

## v1.3.1 — 2026-03-31

### Platform Release: UAT Sweep + AI Training + Record Display Fixes

**PRs:** #225 (NMT-03), #226 (NMT-06), #228 (record-display-bugs), #229 (uat-sweep)

### Database Migrations (0147–0152)
- **0147:** ZK-STARK evidence columns on `extraction_manifests` — `zk_proof`, `zk_public_signals`, `zk_proof_protocol`, `zk_circuit_version`, `zk_poseidon_hash`, `zk_proof_generated_at`, `zk_proof_generation_ms` + indexes
- **0148:** Fix `lookup_org_by_email_domain` and `join_org_by_domain` RPCs referencing non-existent `deleted_at` column on organizations table
- **0149:** Fix attestations_select RLS recursion — introduced `get_user_org_id()` SECURITY DEFINER helper function to break recursive RLS evaluation
- **0150:** Add search performance indexes — trigram GIN on `anchors.filename` and `anchors.description`, btree on `credential_type`, partial index on `(created_at DESC) WHERE status IN ('SECURED','SUBMITTED')`
- **0151:** New ARK-prefixed public_id format (`ARK-{CATEGORY}-{6_ALPHANUM}`) for new anchors — categorizes by pipeline source and credential type
- **0152:** Platform admin RLS performance fix — `is_current_user_platform_admin()` helper, admin bypass policies on anchors/attestations, `attestations_select` rewritten with EXISTS instead of IN, `search_public_credentials` optimized (removes metadata::text ILIKE full-scan)

### Frontend Fixes (20 bugs from UAT sweep)
- Search page: auto-execute example queries, tab-aware empty state, terminology compliance (Constitution 1.3)
- Credit widget: "Unlimited / Beta" display (no-limits-during-beta policy)
- Sidebar: hide Organization nav for Individual accounts
- Header: refactored to declarative PAGE_TITLES map
- Developers page: login-state-aware CTA buttons
- Record display: ARK-prefixed public IDs, EDGAR source URLs, description display, email exposure fix
- Admin records: shared `formatCredentialType()` utility
- System health: `getNetworkDisplayName()` for terminology compliance
- Onboarding: removed stepper, CSP frame-ancestors cleanup

### AI Training (NMT-03, NMT-06)
- Nessie confidence recalibration (ECE reduction)
- Nessie v4 training data pipeline with improved data generation

### No API Changes
This release contains no changes to the public verification API. All modifications are internal platform improvements, database performance, and UI fixes.

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
