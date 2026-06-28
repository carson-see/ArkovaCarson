# services/worker/src/api/v1/agents.md

Public v1 API surface — frozen contract per CLAUDE.md §1.8. Additive nullable fields only; breaking changes require `v2+` prefix and 12-month deprecation.

## 2026-06-11 CTDL Safety Gate (PR #1146)

- `credentials-ctdl.ts` treats `CtdlPiiSafetyError` from the serializer as a fail-closed public response: HTTP 404 `{ error: 'not_found' }` with `ctdl.requested` audit outcome `safety_blocked`. Never return a CTDL body when the serializer blocks on transcript/education learner-name PII confidence. The credential's public contract (status/date/identifier/revocation fields) is otherwise unchanged from main.
- CTDL `ceterms:ctid` is optional (shipped via #1178). The endpoint must not invent CE CTIDs from Arkova public IDs; only explicit real CE CTIDs may appear.

## 2026-06-01 Audit Export Org-Lookup Error Classification

- `audit-export.ts` (both `POST /audit-export` and `POST /audit-export/batch`) now uses `.maybeSingle()` + an explicit `error` check for the `profiles.org_id` lookup. A Supabase/operational failure (e.g. PGRST301) returns 500 (`Failed to generate audit export` / `Failed to generate batch audit export`); only a successful query with a null `org_id` returns 403 `Organization membership required`. Previously `.single()` with no error inspection let a DB fault fall through to a misleading 403, masking a 500-class fault.
- Same error-classification pattern as `cpe-log-export.ts` (PR #1029). Error logging is coarse `message` + `code` only — never row contents or PII (§1.4).

## 2026-05-22 Anchor Submit Scope Fix

- `POST /api/v1/anchor` is the canonical submit route; `POST /api/v1/anchor/submit` is a compatibility alias that reuses the same handler.
- Anchor submit accepts API keys with either `anchor:write` or `write:anchors`. Read-only `/api/v1/anchor/:publicId/*` middleware must skip non-GET requests so submit reaches the write scope guard.

## 2026-05-20 Fraud Visual Endpoint Status

- `ai-fraud-visual.ts` is retained for back-compat but now fails closed with HTTP 410 after request validation. It must not call Gemini or any server-side image-analysis provider because SCRUM-1955 requires fraud document/image analysis to run in a client-side worker and send only structured findings server-side.
- `credentials-ctdl.ts` exposes anonymous `GET /api/v1/credentials/:publicId/ctdl` for SCRUM-1875. It returns public CTDL JSON-LD only for anchored/revoked public IDs and audits every request as `ctdl.requested`.
- PR #841 containment: `anchor-submit.ts` and `anchor-bulk.ts` must reject `credential_type=CPE` before DB access while `ENABLE_PROFESSIONAL_EDUCATION_SCHEMA_READY=false`; CPE is absent from prod until schema reconciliation.

## 2026-06-23 Verified-identity entitlement gate (PAY-01 / SCRUM-2384)

- `identity.ts` adds `GET /api/v1/identity/entitlement` (JWT-authed via `requireAuthMw`). Returns `{ entitled: boolean }` — the verified-only feature gate. Delegates to `../../billing/entitlements.ts` `hasActiveVerifiedEntitlement`, which requires BOTH an open `identity_verified` entitlement window AND an `active` subscription whose **current** period covers now (SCRUM-1791 — never gates on a stale `current_period_*` row). Fail-closed: any read error → `{ entitled: false }`. Org is resolved from the caller's `profiles` row, never trusted from input. No new scope (identity routes are JWT-only, not behind the verification-API feature gate).
- The entitlement is GRANTED by the Stripe `identity.verification_session.verified` webhook (`stripe/handlers.ts`) and REVOKED on `customer.subscription.deleted`. No schema change — reuses the existing `entitlements` table.

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

## 2026-06-01 ORG-ADMIN per-member CPE export (SCRUM-1849 / SCRUM-1863 — CPE-R3, stacked on #1029)

- `POST /api/v1/exports/org/cpe-log` — JWT-authed (router `requireAuth`), per-**admin** **10 requests/hour** rate limit on a SEPARATE bucket (`orgCpeLogExportRateLimiter`, `scope: 'org-cpe-log-export'`) so org exports don't share the R2 own-user budget (`scope: 'cpe-log-export'`). Body `{ user_id, period_start, period_end, format: 'pdf'|'json' }` where **`user_id` is the MEMBER to export** (not the caller). Zod `.strict()` (rejects any body-supplied `org_id`/extra fields), `period_start<=period_end`.
- Sibling of the CPE-R2 own-user export — **reuses** `generateCpeLogExport` + the Storage seam from `services/worker/src/exports/cpe-log-export.ts` (no duplication, base unchanged). Only the AUTHZ model differs: own-user-only → **ORG_ADMIN-acts-on-member**.
- **Authorization (all application-code — worker is service_role / RLS-bypassed, so these ARE the tenant boundary):** (1) authenticated; (2) caller belongs to an org (`getCallerOrgIdResult`) else 403; (3) caller is ORG_ADMIN of that org (`isCallerOrgAdminResult`) else 403; (4) target `user_id` is a member of the **caller's resolved org** (`isUserMemberOfOrgResult(target, callerOrgId)`) else **403 (cross-org)**. Org is ALWAYS resolved from the caller, **never from the body** — admin of org A can never reach a member of org B. The reused worker re-filters by BOTH `user_id` AND `org_id` (defense in depth). **403 vs 500 (PR #1045 review):** each authz lookup uses the `*Result` org-auth variant and inspects its `error` flag — a DB/operational failure returns **500** (generic message + `request_id`, logged server-side), NOT a misleading 403. 403 is reserved for a *definitive* negative (lookup succeeded: no org / not admin / not a member). Mirrors the own-user CPE export endpoint (#1029).
- **Response body** is `{ request_id, record_count, requested_format, exports{pdf,json} }`. It deliberately does **NOT** echo the target member's raw `user_id` (`member_id` was dropped in PR #1045 review — the caller already supplied it, and echoing a raw internal user_id on the frozen v1 contract is avoidable exposure). The target member id is still recorded server-side in the admin audit row.
- **Cross-org isolation is the key deliverable.** Enforced + tested in `org-cpe-log-export.test.ts`: admin of A → member of B = 403 (named `org-cpe-export.cross-org.POST.returns.403`), admin → non-member = 403, admin → own-org member = 200. INDIVIDUAL/non-admin = 403. A DB error on any authz lookup = 500 (not 403). The worker uses service_role (RLS bypassed), so these are **application-code authz tests with mocked membership lookups** (`isCallerOrgAdminResult`/`isUserMemberOfOrgResult` mocked); the membership-resolver DB behavior (incl. the 403-vs-500 `error` signal) is unit-tested separately in `api/_org-auth.test.ts`. `npm run test:rls` (frontend Vitest harness) does not cover worker service-role endpoints.
- **Membership model:** `isUserMemberOfOrg` (added to the canonical `src/api/_org-auth.ts` seam) returns true if EITHER an `org_members(user_id, org_id)` row exists OR `profiles.org_id === orgId` — mirroring `isCallerOrgAdmin`'s dual-source precedence. Boolean form fails closed on lookup error / empty inputs; the `isUserMemberOfOrgResult` variant additionally surfaces a DB `error` (→ 500) vs a true non-member (→ 403).
- **Audit:** the reused worker emits its own metadata-only `cpe_log.exported` row (actor = the exported member). Because an admin action must record the ADMIN + target member, the endpoint emits an ADDITIONAL `cpe_log.exported` row with `actor_id = admin`, `org_id = caller org`, `target_type = 'org_cpe_log_export'`, and metadata-only `details` (`target_member_id`, `acting_as: 'ORG_ADMIN'`, period, format, record_count, request_id) — **no export body content (CC7, covered by a leak test)**. Non-fatal.
- **No migration** — reuses `audit_events` + Storage + `rateLimit` + the existing `org_members`/`profiles` membership model. **T2** (public API surface, worker behavior; no schema/RLS/migration). Org CPE dashboard **UI (subtask SCRUM-1862) deferred** — `src/pages/*`/`src/lib/copy.ts` locked.

## 2026-05-31 CLE compliance-log export (SCRUM-1870)

- `POST /api/v1/exports/cle-log` — JWT-authed (mounted behind `requireAuth`), per-user **10 requests/hour** rate limit (`cleLogExportRateLimiter`, in-memory `rateLimit()` bucket keyed `cle-log-export:<userId>`; **separate `scope` from the CPE limiter** so the two exports don't share a budget; 11th → 429 + `Retry-After`). Body `{ user_id, jurisdiction (US state code), period_start, period_end, format: 'pdf'|'json' }` (Zod `.strict()`, `period_start<=period_end`, `jurisdiction` validated via `normalizeJurisdiction`). Generates **both** PDF + JSON synchronously, uploads to Supabase Storage (bucket `EXPORTS_STORAGE_BUCKET`, default `exports`), returns a signed URL for each (1h TTL) plus `request_id` + `record_count` + `jurisdiction`.
- Org/user scope: a caller may export only **their own** records. `user_id !== req.authUserId` → 403; no org membership → 403. The worker query is filtered by BOTH `user_id` AND `org_id`; `org_id` is resolved from the caller's `profiles` row, never trusted from the body. The profile lookup uses `.maybeSingle()` and **captures the Supabase `error`**: an operational DB failure → **500** (generic message + `request_id`, error logged server-side only), NOT a misleading 403 (CodeRabbit fix on PR #1034 — same misclassification the CPE sibling had). 403 is reserved for a *successful* query that returns a null `org_id`.
- Rate-limiter key: `cleLogExportRateLimiter` sets `scope: 'cle-log-export'` and the `keyGenerator` returns ONLY the user id — `rateLimit()` prefixes the bucket key with `${scope}:`, so re-prefixing in the keyGenerator would double it (`cle-log-export:cle-log-export:<user>`). Effective bucket key is `cle-log-export:<userId>`.
- Worker logic lives in `services/worker/src/exports/cle-log-export.ts` (DI `db`/`storage`/`logger`; **reuses the CPE Storage adapter** — no Storage *migration* required, bucket provisioned as an ops step → T2 not T3). `cle_log_v1` JSON schema is `.strict()` + frozen-friendly. **Ethics hours are a SEPARATE subtotal** (per-record `ethics_hours` + `summary.ethics_hours`), never combined with `summary.total_credit_hours`. Per-credential fields from `cle_metadata`: title, provider (`approved_provider_name`), `provider_approval_status`, total `credit_hours`, **`ethics_hours`**, `jurisdiction`, `delivery_format`, completion date (`issued_at`), Arkova verification URL, anchor timestamp (`chain_timestamp` = Network Observed Time), evidence level. **`extraction_confidence` / `extraction_source` are deliberately NOT exported (allowlist mapper).**
- Jurisdiction filter accepts a bare state code (`CA`) or the `US-`prefixed ISO form (`US-CA`); query matches `cle_metadata->>'jurisdiction'` against both. `credential_type = 'CLE'` (confirmed valid prod enum value) + `deleted_at IS NULL`, period on `issued_at`, 5000-record cap (mirrors CPE).
- PDF carries the mandatory CLE non-affiliation disclaimer **verbatim** (`CLE_DISCLAIMER_TEXT`): "Arkova is not affiliated with any state bar or bar association." The original AC draft's "state bar **of accountancy** or bar association" was a CPE/NASBA copy-paste artifact (accountancy = CPA, not attorneys); corrected per PR #1034 review (test asserts the literal text).
- `cle_log.exported` audit event (category `ADMIN`) carries **metadata only** — `actor_id`, `org_id`, `jurisdiction`, `period_start`, `period_end`, `format`, `record_count`, `request_id`; **no export body content** (CC7 — dedicated leak test). Audit failure is non-fatal.
- The export **UI is intentionally deferred** — `src/pages/*` / `src/lib/copy.ts` are locked by other in-flight PRs; this story ships backend-only.

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
| `POST /api/v1/exports/org/cpe-log` | Supabase JWT + ORG_ADMIN (own-org members only) |
| `POST /api/v1/exports/cle-log` | Supabase JWT (own records only) |

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
