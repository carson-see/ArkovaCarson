# services/worker/src/api/v1/agents.md

Public v1 API surface — frozen contract per CLAUDE.md §1.8. Additive nullable fields only; breaking changes require `v2+` prefix and 12-month deprecation.

## 2026-05-22 Anchor Submit Scope Fix

- `POST /api/v1/anchor` is the canonical submit route; `POST /api/v1/anchor/submit` is a compatibility alias that reuses the same handler.
- Anchor submit accepts API keys with either `anchor:write` or `write:anchors`. Read-only `/api/v1/anchor/:publicId/*` middleware must skip non-GET requests so submit reaches the write scope guard.

## 2026-05-20 Fraud Visual Endpoint Status

- `ai-fraud-visual.ts` is retained for back-compat but now fails closed with HTTP 410 after request validation. It must not call Gemini or any server-side image-analysis provider because SCRUM-1955 requires fraud document/image analysis to run in a client-side worker and send only structured findings server-side.
- `credentials-ctdl.ts` exposes anonymous `GET /api/v1/credentials/:publicId/ctdl` for SCRUM-1875. It returns public CTDL JSON-LD only for anchored/revoked public IDs and audits every request as `ctdl.requested`.
- PR #841 containment: `anchor-submit.ts` and `anchor-bulk.ts` must reject `credential_type=CPE` before DB access while `ENABLE_PROFESSIONAL_EDUCATION_SCHEMA_READY=false`; CPE is absent from prod until schema reconciliation.

## Files

- `router.ts` — mounts every v1 endpoint with its `requireScope(...)` gate. Anonymous-GET allow on `/verify` is intentional (Constitution §1.10 zero-friction public verification, rate-limited 100/min).
- **`anchor-submit.ts`** — `POST /api/v1/anchor`. Frozen Zod request shape. Duplicate fingerprint handling: pre-insert dedup returns existing public_id with HTTP 200 (idempotent); insert-race unique constraint violation (23505) returns HTTP 409 `anchor_creation_conflict`; other insert errors return 500 `anchor_creation_failed`. Now wired (SCRUM-1740 commit 9fdaed23) to `ensureAnchorQuotaAvailable` → 402 problem+json `quota_exhausted` for sandbox orgs over their `anchor_quota`. Gate runs AFTER dedup so re-anchoring an existing fingerprint doesn't burn quota.
- `verify.ts` — `GET /api/v1/verify/:public_id`. Anonymous-allowed.
- `credentials-ctdl.ts` — `GET /api/v1/credentials/:publicId/ctdl`. Anonymous-allowed, public-safe CTDL JSON-LD projection.
- `anchor-bulk.ts`, `attestations.ts`, `oracle.ts`, `cle-verify.ts`, etc. — additional v1 surfaces.
- `cle-verify.ts` — CLE public responses must stay allowlisted. Never return raw `metadata`, `claims`, `filename`, `chain_tx_id`, internal `id`, bar numbers, or attorney names. Submit logs also omit attorney identifiers and internal anchor UUIDs.

## 2026-05-27 Attestation Verification Endpoint (SCRUM-1873)

- `GET /api/v1/verify/attestation/:attestationId` verifies legally binding attestations from `legally_binding_attestations` table (SCRUM-1871/1872/1873 chain).
- Public, anonymous-allowed. Uses `ARK-ATT-*` public IDs only. Separate from `GET /api/v1/attestations/:publicId` which handles general `attestations` table.
- Mounted BEFORE the generic `/verify` catch-all in router.ts to avoid route shadowing.
- Response never includes `attestation_statement` (private per migration 0314 COMMENT).

## 2026-05-31 CPE compliance-log export (SCRUM-1848 / SCRUM-1859 + SCRUM-1860)

- `POST /api/v1/exports/cpe-log` — JWT-authed (mounted behind `requireAuth`), per-user **10 requests/hour** rate limit (`cpeLogExportRateLimiter`, in-memory `rateLimit()` bucket keyed `cpe-log-export:<userId>`; 11th → 429 + `Retry-After`). Body `{ user_id, period_start, period_end, format: 'pdf'|'json' }` (Zod `.strict()`, `period_start<=period_end`). Generates **both** PDF + JSON synchronously, uploads to Supabase Storage (bucket `EXPORTS_STORAGE_BUCKET`, default `exports`), and returns a signed URL for each (1h TTL) plus `request_id` + `record_count`.
- Org/user scope: a caller may export only **their own** records. `user_id !== req.authUserId` → 403; no org membership → 403. The worker query is filtered by BOTH `user_id` AND `org_id` (defense in depth); `org_id` is resolved from the caller's `profiles` row, never trusted from the body.
- Worker logic lives in `services/worker/src/exports/cpe-log-export.ts` (DI `db`/`storage`/`logger` — no Storage *migration* required; bucket is provisioned as an ops step, keeping this T2 not T3). `cpe_log_v1` JSON schema is `.strict()` + frozen-friendly. Per-credential fields: title, provider, NASBA status, CPE hours, field of study, delivery method, completion date, Arkova verification URL (`${frontendUrl}/verify/<public_id>`), anchor timestamp (`chain_timestamp` = Network Observed Time), evidence level. **`extraction_confidence` / `extraction_source` are deliberately NOT exported.**
- PDF carries the mandatory NASBA non-affiliation disclaimer **verbatim** (`NASBA_DISCLAIMER_TEXT`).
- `cpe_log.exported` audit event (category `ADMIN`) carries **metadata only** — `actor_id`, `org_id`, `period_start`, `period_end`, `format`, `record_count`, `request_id`; **no export body content** (CC7 — covered by a dedicated leak test). Audit failure is non-fatal.
- The export **UI (SCRUM-1861) is intentionally deferred** — `src/pages/*` / `src/lib/copy.ts` are locked by other in-flight PRs; this story ships backend-only.

## Scope mapping (verified 2026-05-08)
| Endpoint | Scope |
|---|---|
| `POST /api/v1/anchor`, `POST /api/v1/anchor/submit` | `anchor:write` or `write:anchors` |
| `GET /api/v1/verify/<id>` | anonymous OR `verify` |
| `GET /api/v1/verify/attestation/<id>` | anonymous (SCRUM-1873) |
| `POST /api/v1/batch-verify` | `verify:batch` |
| `GET /api/v1/credentials/<id>/ctdl` | anonymous OR `verify` |
| `GET /api/v1/usage` | `usage:read` |
| `/api/v1/anchor/bulk`, `/api/v1/contracts` | `anchor:write` |
| `POST /api/v1/exports/cpe-log` | Supabase JWT (own records only) |

## Conventions
- Request validation: Zod `safeParse` with structured `details: [{path, code, message}]` 400 response.
- Response shape: never include `id`, `org_id`, `user_id`, `fingerprint`, `agent_id`, `key_id` (CLAUDE.md §6 banned-field list — enforced runtime in `services/worker/src/api/v2/mcpParity.ts`).
- 402 problem+json shape: `{type, title, status, error, message}` plus per-error context.

## 2026-05-26 SCRUM-2014 Anchor Insert Error Handling

- `anchor-submit.ts` now catches insert failures with structured error responses: duplicate fingerprint returns 409 with `public_id`; other insert errors return 500 with `anchor_insert_failed` code instead of unhandled exception. Three TDD tests added.
- Insert-error diagnostics may log coarse Postgres error code + org context only; do not log raw error objects, fingerprints, or schema identifiers such as constraint names.

## 2026-05-26 SCRUM-2013 Credential Type Enum Drift Fix

- `anchor-bulk.ts` CREDENTIAL_TYPES expanded 8→27 to match canonical `ANCHOR_CREDENTIAL_TYPES`.

## Open work
- SCRUM-1740 (PR #738) — quota gate awaits Carson merge + Mon deploy.
