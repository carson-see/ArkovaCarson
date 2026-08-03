# services/worker/src/api/v1/agents.md

Public v1 API surface — frozen contract per CLAUDE.md §1.8. Additive nullable fields only; breaking changes require `v2+` prefix and 12-month deprecation.

## 2026-08-02 — the PostgREST `.in()` filter-width class, API surface (follows #1839/#1853)

`chunkForInFilter` (`utils/postgrest-filter.ts`) is the ONLY supported way to build an `.in()`
filter over a caller-sized list. Do not hand-roll `for (i += SIZE)`; do not reach for
`POSTGREST_ROW_LIMIT` (that governs how many rows come back, not how wide the URL may be).

The class has TWO halves and a fix that addresses only one is not a fix:

1. **Width.** An over-wide filter takes `400 Bad Request` from the proxy in front of PostgREST.
2. **The discarded error.** postgrest-js **resolves** a 400 as `{ data: null, error }` — it does not
   throw. `const { data } = await ...` therefore turns a hard failure into an empty result that is
   indistinguishable from "nothing matched", and the surrounding `catch` never runs.

Fixed on this surface, with the error policy each site actually needs:

- **`anchor-evidence.ts` / `anchor-lifecycle.ts`** — both carried a byte-identical private copy of the
  actor-id -> profile `public_id` lookup, unbounded and error-discarding, so lifecycle entries lost
  actor attribution at HTTP 200. Deduped into **`utils/profilePublicIds.ts`** — one copy, so a future
  fix cannot land at one call site and miss the other. Partial results are returned deliberately (a
  missing actor already renders as unattributed); an ALL-chunks-failed read throws via
  `assertNotAllChunksFailed` and the routers' `try/catch` makes it a 500.
- **`usage.ts`** — `api_key_usage` read with the error discarded, so `GET /usage` reported **0 requests
  this month** on a billing-reconciliation surface. Now 500s on ANY chunk error: an understated total
  is a wrong answer, not a smaller one. NOTE the pre-existing tests in `usage.test.ts` never imported
  the router (they assert against object literals they build themselves) — if you change `usage.ts`,
  only the second describe block can fail.
- **`compliance-audit.ts`** — `loadJurisdictionRules` discarded its error, and an audit with no
  applicable rules scores as fully compliant. That is a **fail-OPEN compliance verdict at HTTP 201**:
  a perfect score awarded because nothing was checked. Now throws. Also chunked even though
  `jurisdictions` is Zod-capped at 50 today, so the width guarantee lives at the query rather than
  depending on a `.max()` in the request schema staying put.
- **`directory-opt-out.ts`** — `records` is capped at 1000 but `public_id` is `z.string().min(1)` with
  **no max**, so the update filters had no byte bound at all. Errors were never read, so the response
  claimed `updated: 0, failed: N` and tagged every record `error: 'Not found'` — a false statement
  about rows in the caller's own org. Failed chunks now report **`update_failed`**, kept distinct from
  the `Not found` we can actually substantiate (chunk succeeded, row not returned).
- **`webhooks.ts` (`GET /deliveries`) / `grc.ts` (`GET /sync-logs`)** — both combine the filter with
  `.order().limit()`. Each chunk asks for the newest `limit` rows and the results are merged, re-sorted
  and re-capped, because the global newest `limit` is necessarily contained in the union of the
  per-chunk newest `limit`. `grc.ts` additionally discarded the `grc_connections` error, which
  `!connections?.length` read as "this org has no connections" at HTTP 200.

**Two new failure responses on a frozen surface (§1.8):** `GET /usage` and `POST /compliance/audit`
now 500 where a broken read previously returned a confident 200/201. No documented success schema
changed; both replace a response that was wrong.

Every fix is mutation-verified — each was reverted individually to confirm its test kills only its own
defect. One first cut (`compliance-audit`) passed against the defective code because it 500'd for an
unrelated seeded reason, and was rewritten so the rules read is the only variable. **A guard with no
test that dies without it is a comment.**
## 2026-08-02 SECURITY — outbound PII gate on `GET /api/v1/verify/:publicId/provenance` (the FOURTH public projection)

**Mounted `router.use('/verify', provenanceRouter)` with NO `requireScope` and NO auth middleware, and `provenance.ts` has no auth check of its own — it is fully anonymous.** Two leaks, closed with two *different* treatments, and the difference is the reusable lesson:

- **`revocation_reason`** — issuer-authored free text that *might* carry identity. Two layers, same as everywhere else: academic records (`isEducationCredentialType`) emit none at all, every other type passes `publicFreeTextOrNull`. `credential_type` had to be added to the SELECT — its absence is *why* this projection could not apply the rule the others do.
- **`signatures.signer_name`** — a person's name **by construction**: it is `cert.subject_cn` (`signatures.ts:248`), the X.509 Subject CN, stored beside `signer_org`/`location`/`contact_info`. **A value detector is useless against it** — the measured finding behind this whole contract is that no regex separates a bare name from an institution name. So it is **never emitted and never SELECTed**, so a future edit to the detail string cannot reintroduce it. This is the first field on any of these surfaces treated as *never-emit* rather than *gate-or-suppress*, because it is the first that is definitionally an identity rather than prose that may contain one. What survives: that a signature exists, when, its format/level, and an `evidence_ref` resolving the signer through an **authenticated** surface.

**`format`/`level` are emitted unguarded, and that was checked rather than assumed:** both are DB CHECK-constrained closed vocabularies (`signatures_format_check` = XAdES/PAdES/CAdES, `signatures_level_check` = B-B/B-T/B-LT/B-LTA) *and* Zod-enum validated at the write path (`signatures.ts:85`).

**Three facts, three strings.** `no reason provided` is a *claim*. Asserting it over a reason that exists but was suppressed is false (§1.5, §1.13 R-7), so a suppressed reason degrades to a bare `Revoked` — which asserts nothing about why — while a genuinely absent reason keeps the original wording. `hasStoredFreeText` is what distinguishes them; don't collapse the branches.

**New shared module: `public-projection-text.ts`.** The TS value layer (`publicFreeTextOrNull`, `hasStoredFreeText`) now lives in ONE place, imported by `verify.ts` and `provenance.ts`. It was extracted from `verify.ts` the moment a second caller appeared. **Do not copy it into a third file** — two copies of the wrapper is the same drift the contract exists to prevent, just one level down from the detectors. The contract test asserts no other file defines `publicFreeTextOrNull`.

**A FIFTH ungated projection is open and recorded:** `GET /api/v1/anchor/:publicId/evidence` (`anchor-evidence.ts:254,256`) emits `issuer_name` and `description` raw and is anon-reachable via `anchorAnonAllow`. It is in the contract's `known_ungated_projections`. It was NOT fixed here because it is a **signed evidence package** — changing what it contains needs its own decision about whether omission invalidates the package's own hash. Its two sibling routers on the same mount (`anchor-lifecycle.ts`, `anchor-extraction-manifest.ts`) were checked and emit no free text.

## 2026-08-02 SECURITY — outbound PII gate on `GET /api/v1/verify/:publicId` (the THIRD public projection)

**VULNERABILITY CLASS — do not reintroduce:** `buildVerificationResult` in `verify.ts` emitted `anchor.description` **raw** to anonymous callers, for every credential type, including `DEGREE`/`TRANSCRIPT`/`CERTIFICATE`. The route is anon-reachable by design (`router.ts`: `if (!req.apiKey && req.method === 'GET') next()`). It was **not** covered by the REG-02 `directory_info_opt_out` suppression sitting directly above it in the same function — that block gates `issuer_name`/`recipient_identifier`/`issued_date`/`expiry_date` only — so even an explicitly opted-out learner was exposed here.

**There are THREE public projections of the same anchor rows, and they must not drift again:**

| # | Surface | Owner | Landed |
|---|---|---|---|
| 1 | `public.get_public_anchor` (anon-GRANTed, browser/PostgREST) | migration `0385` | PR #1841 |
| 2 | `GET /api/v1/credentials/:publicId/ctdl` | `ctdl/ctdl-pii-guard.ts` | PR #1815 |
| 3 | `GET /api/v1/verify/:publicId` | `api/v1/verify.ts` | this change |

The rule is written down ONCE in `scripts/ci/public-pii-projection-contract.json`. **Change it there plus all three implementations in one PR** — the contract test fails otherwise, which is the point.

**The policy decision (stated, not inherited).** Academic-record suppression here is **UNCONDITIONAL**, matching the other two — deliberately NOT gated on `directory_info_opt_out`, even though the surrounding REG-02 code is. Opt-out means the default is *publish*, and default-publish is the defect class; the field was not covered by the opt-out anyway; and one row with three anonymous projections giving three answers is not a privacy posture (the verify **page** reads the SQL path, which suppresses — the API disagreeing with the page it serves *is* the drift). Cost: an issuer-authored description no longer ships on an academic record for anyone. It already did not ship on either other public projection, so nothing publicly reachable elsewhere is lost.

**What the gate does.** Two layers, mirroring 0385:
- **Structural** — `isEducationCredentialType()` (from the guard, `DEGREE`/`CERTIFICATE`/`TRANSCRIPT`) ⇒ `description` omitted outright. `issuer_name` and `jurisdiction` are **not** structurally suppressed: the issuer is an *institution*, not the learner, and a jurisdiction tag is informational (§1.5). Same split as 0385.
- **Value** — `publicFreeTextOrNull()` runs on every credential type over `description`, `issuer_name`, `jurisdiction`, `sub_type`, `file_mime`. It **omits, never throws**: this body is a verification ANSWER, and 404ing would tell an anonymous verifier a genuinely anchored document does not exist. (The CTDL path fails closed instead, correctly — its body is a *publication*.)

**Rules for anyone touching this file:**
- **Reuse the detector, never re-implement it.** Import from `../../ctdl/ctdl-pii-guard.js` — the guard, not `ctdl-serializer.js`. The guard is deliberately dependency-free so a non-CTDL path can use it without dragging the CTDL serializer onto this hot anonymous route. A second hand-rolled copy of these patterns is the drift.
- **Do NOT add a learner-name heuristic.** Measured twice (PR #1815, then again for 0385): the capitalised-pair patterns catch **zero** real leak shapes (bare, all-caps, non-ASCII, apostrophe, hyphenated all evade `[A-Z][a-z]{1,}`) while `for` as a bare preposition drops "Center for Professional Development", "Society for Human Resource Management", "Ethics for Trial Lawyers", "Revoked for Non Payment". Those strings are pinned in the contract's `must_publish_vectors`. Learner names are covered *structurally* here, which is precision-independent.
- **Do NOT "reconcile" `FERPA_EDUCATION_TYPES`.** `constants/ferpa.ts` carries a **fourth** member (`CLE`) on purpose: it drives the FERPA §99.33 re-disclosure notice and the §99.37 directory opt-out — notice/consent mechanics over the wider practitioner+academic set — not free-text suppression. Two lists, two jobs. Both are pinned by `src/tests/public-anchor-pii-projection.contract.test.ts`; a change there failing CI is the signal to make a decision, not to edit the pin.
- **`STRUCTURAL_API_RICH_KEYS` is an ALLOW-list and the gate FAILS CLOSED against it.** Every *string*-valued API-RICH key not named there routes through the value gate, so a future additive §1.8 field is gated by default instead of shipping raw because nobody remembered. Adding a key there publishes it raw to anonymous callers — state why it is safe in the contract. (`sub_type` is bare `text` in the schema — no CHECK, no enum — and `file_mime` is client-supplied, so both are gated; the numeric/jsonb members carry no free text.)
- **The gate lives in `buildVerificationResult`, not in the route handler, on purpose.** `oracle.ts` and `batch.ts` reuse that builder, so all three surfaces inherit the fix. A route-level gate would have left two of them leaking.
- `utils/verifyCache.ts` `KEY_PREFIX` was bumped `verify:v2:` → `verify:v3:` as part of this change. That is a **security** requirement, not hygiene: the gate runs before `setCachedVerification`, so new writes are safe, but entries written by the pre-fix build carry a raw `description` and would keep serving it for the rest of the 5-minute TTL after deploy.

**Tests.** `verify-pii-projection.test.ts` drives the **real router through supertest** — not `buildVerificationResult` in isolation — because the finding is that the route is anonymously reachable, and a unit test on the builder would not prove that. It loads its corpus from the shared contract rather than restating it. `src/tests/public-anchor-pii-projection.contract.test.ts` gained a source-shape suite proving the rule cannot silently disappear (a behavioural suite alone cannot catch an edit that deletes the gate and its tests together). All three guards were mutation-verified: dropping the academic branch fails 16 behavioural tests; importing `containsLearnerNamePii` fails the contract test; exempting `sub_type` fails both.

## 2026-07-28 R19 — fingerprint_source additive field (advances SCRUM-2481)

`verify.ts`: `VerificationResult` / `AnchorByPublicId` / `AnchorSelectRow` gained `fingerprint_source: 'document_bytes' | 'issuer_record_attestation' | null` (migration `0376`, `anchors.fingerprint_source`). Additive nullable — §1.8, no version bump. Wired through `API_RICH_KEYS` / `EMPTY_API_RICH_FIELDS` / `mapAnchorRow` / `defaultLookup`'s select string. `docs/api/openapi.yaml` `VerificationResult` schema updated to match. `__test-helpers__/build-anchor.ts` (shared fixture) updated — any NEW hand-built `AnchorByPublicId` literal elsewhere needs the field too (existing callers that spread `EMPTY_API_RICH_FIELDS`, e.g. `batch.ts`/`oracle.ts`, pick it up automatically). Out of scope for this PR: `anchor-bulk.ts` (`POST /api/v1/anchor/bulk`, currently zero callers per the PI-0.5 bulk-upload audit) also always receives pre-computed fingerprints and should set `fingerprint_source: 'document_bytes'` once wired up by whichever workstream lands that.
## 2026-07-28 Two unreachable endpoint groups fixed (endpoint-reachability audit)

- **AdES signatures (`/sign`, `/signatures`, `/verify-signature`, `/signatures/:id`, `/signatures/:id/revoke`) — all 404'd.** `router.ts` mounted `signaturesRouter` three times, at `/sign`, `/signatures`, `/verify-signature` — but the router's OWN internal route strings already carry those exact segments (see `signatures.ts`'s header comment), so Express required the segment TWICE (e.g. only `POST /api/v1/sign/sign` matched, never `POST /api/v1/sign`). Fixed by mounting `signaturesRouter` ONCE at `/`, matching the existing `signatureComplianceRouter` / `keyInventoryRouter` precedent immediately below it in the same file. A new local `requireSignatureAuth` middleware (path-guarded, same pattern as `adesFeatureGate.ts`'s `isAdesPath`) preserves the pre-existing auth split: `/sign` and `/signatures*` require JWT auth, `/verify-signature` stays public (mirrors `/verify/:publicId`; `signatures.ts` already conditionally skips its audit-event write when `req.authUserId` is absent). **If you touch this mount again:** don't reintroduce a sub-path prefix for `signaturesRouter` — its route strings are already the full contract paths documented in `docs/stories/23_phase3_esignatures.md` §4. Regression tests: `router.test.ts` (static source guard) + `signatures-router-mount.test.ts` (real supertest requests against the actual mount composition, including a negative case proving the OLD triple-mount shape 404s).
- **`GET /api/v1/credits` and `POST /api/v1/credits/purchase` — always 401.** `credits.ts` read `req.userId`/`req.orgId`, but the v1 router's OWN `requireAuth` (a DIFFERENT function from `requireAuth` in `services/worker/src/routes/middleware.ts`, used by non-v1 routes) sets `req.authUserId` instead. TypeScript didn't catch it because both field pairs are legitimate optional properties on the global `Express.Request` augmentation (declared by different middleware for different routers) — a locally-redeclared `interface AuthenticatedRequest` in `credits.ts` shadowed the same names without adding any real guarantee that THIS router's mount populates them. Fixed: read `req.authUserId`; resolve org id via `getCallerOrgId(userId)` (the shared `_org-auth.ts` resolver used elsewhere in v1, e.g. `signatures.ts`) rather than trusting a client-supplied `x-org-id` header — unlike `hipaa-audit.ts` / `directory-opt-out.ts` / `emergency-access.ts` (which use `requireOrgId` header-trust), credits touches billing, so header-trust would let any authenticated caller read/spend another org's credit pool. `credits.test.ts` carries a static source guard (`credits.ts field-name guard`) pinning this so a future edit can't silently reintroduce `req.userId`/`req.orgId` here.
## 2026-07-28 Pentest-prep: served-spec parity + jurisdiction omit-when-null (API contract audit)

- **Spec parity (§1.8-safe, additive-only):** `docs.ts` (`openApiSpec`, served at `/api/docs`, `/api/docs/spec.json`, and the `/api/v1/openapi.json` redirect) was missing 12 real, mounted endpoints: `GET /verify/{publicId}/proof`, `POST /attestations/batch-verify`, `POST /attestations/batch-create`, `POST /webhooks/deliveries/{id}/replay`, `GET /webhooks/dlq`, `POST /webhooks/dlq/{id}/resolve`, `GET /cle/requirements`, `GET /ai/review/stats`, `PATCH /ai/review/{itemId}`, `GET /ai/integrity/{anchorId}`, `POST /ai/embed/batch`, `GET /ai/feedback/accuracy`, `GET /ai/feedback/analysis`. All added. Also fixed a real spec bug (not just an omission): the existing `POST /ai/integrity` entry never matched anything live — the router mounts `POST /ai/integrity/compute` — and the `/compliance/check` response/request schema had wrong field names (`entity` documented as a bare string instead of an object; `entity_type` enum documented as `['person','organization']` instead of the actual `['individual','organization']`).
- **`docs/api/openapi.yaml` demoted** — `docs.ts` is now the sole canonical v1 spec (matches the v2 pattern: `api/v2/openapi.ts`). See `docs/api/canonical-sources.md` and `docs/api/agents.md` for the full rationale; the static YAML is kept only for Swagger-import/offline convenience and the `check-api-scope-vocabulary.ts` scope check, not as an endpoint-completeness source.
- **New CI guard:** `docs.routeParity.test.ts` walks the real `.stack` of `verify-proof`, `attestations`, `webhooks`, `cle-verify`, `ai-review`, `ai-integrity`, `ai-embed`, and `ai-feedback` routers and fails if any mounted route+method is absent from `openApiSpec`. It also re-checks `router.ts` mount prefixes so a moved mount fails the test instead of silently invalidating it. Extend the `MOUNTS` table there to widen coverage to the rest of `/api/v1` — the extraction logic is router-agnostic.
- **`jurisdiction: null` fixed in two more builders** (frozen-schema §1.8 — nullable fields are omitted, never emitted as a literal `null`): `anchor-evidence.ts`'s `buildEvidencePackage` (`EvidencePackage.jurisdiction` is now optional/non-null, built via conditional spread — was the last unguarded builder on this surface; `verify.ts`, `signatures.ts`, `attestations.ts`, `cle-verify.ts` already did this correctly) and `compliance-check.ts`'s `entity.jurisdiction` (caller-echoed request input, not anchor state, but given the same omit-when-null treatment for a single consistent contract across the surface rather than "null here, omitted there").
## 2026-07-28 SECURITY — cross-tenant authorization bypass via unverified `x-org-id` (fix)

**VULNERABILITY CLASS — do not reintroduce:** `services/worker/src/middleware/requireOrgId.ts` previously read `req.headers['x-org-id']` **verbatim** and attached it to `req.orgId` with **no check** that the authenticated caller belonged to that org. Since the worker's `db` client is **service_role and bypasses RLS by design** (`utils/db.ts`), RLS provided zero protection for anything reading `req.orgId` — the header WAS the entire tenant boundary. Any authenticated Arkova user (any valid Supabase JWT, any org) could read/write **any other org's** data on every route trusting `req.orgId`, or a hand-rolled `x-org-id` read.

**Fixed routes (all now go through membership-validated `req.orgId`, with `requireOrgAdmin` layered on top where the privilege level warrants it — see each file's own doc comment for the full per-route decision):**
- `ferpa-disclosures.ts` — POST (member) / GET list + GET export (ORG_ADMIN, per its own "admin/compliance_officer only" docstring).
- `directory-opt-out.ts` — PATCH / POST bulk / GET (all member-level; inherits the middleware fix, no route change needed).
- `hipaa-audit.ts` — GET + GET /export, both ORG_ADMIN (reading a HIPAA audit trail warrants more than plain membership).
- `emergency-access.ts` — POST request + GET list + PATCH revoke stay member-level; PATCH `/approve` is now ORG_ADMIN (the privilege-escalating half of dual control).
- `org-kyb.ts` (mounted outside this router, in `index.ts`, but same class) — POST `/:orgId/start` now ORG_ADMIN, GET `/:orgId/status` now member-level. Previously had **zero** org check on either route (any authenticated user could submit or read ANY org's KYB by guessing/enumerating org UUIDs) — its own misleading "RLS gates this" comment was **false** for the same service_role-bypasses-RLS reason above.
- `signatureCompliance.ts`'s `GET /signatures/:id/audit-proof` — previously had **zero** org check (the only route in that file without one; every sibling route already used the correct `getCallerOrgId`/`isCallerOrgAdmin` pattern). `generateAuditProof` (in `signatures/compliance/auditProofExporter.ts`) now requires and scopes by `orgId`.

**The fix, and the pattern to follow for any NEW org-scoped route:**
- `middleware/requireOrgId.ts` — the header is now only a disambiguation hint for a caller who may belong to more than one org; it is validated via `isUserMemberOfOrgResult` (the canonical `api/_org-auth.ts` seam — the SAME helper `org-cpe-log-export.ts` / `version-resolution.ts` already used correctly) and REJECTED (403) on any mismatch. A DB/operational error during the lookup is 500, never a masked 403.
- `middleware/requireOrgAdmin.ts` (NEW) — chain AFTER `requireOrgId` when a route needs ORG_ADMIN, not merely membership. Delegates to `isCallerOrgAdminResult`.
- **Do not read `x-org-id` (or any client-controlled org identifier) directly in a handler and trust it.** Either mount `requireOrgId` (+ `requireOrgAdmin` if needed) upstream, or — for routes where the org id is a route param, not a header (e.g. `org-kyb.ts`) — call `isUserMemberOfOrgResult` / `isCallerOrgAdminResult` directly before touching the DB.
- **RLS is not a backstop here.** Every table this vulnerability touched (`ferpa_disclosure_log`, `emergency_access_grants`, `kyb_events`, `signatures`, `organizations`, `anchors`) already had correct FORCE RLS + org-scoped policies (verified against `supabase/migrations/00000000000000_baseline_at_main_HEAD.sql`) — RLS was never the gap. The worker's service_role client bypasses RLS entirely, so application-code authorization (the `_org-auth.ts` helpers) is the ONLY tenant boundary for any service_role-executed query. Any new route added under this router needs its own explicit membership/admin check — RLS will not save it.
## 2026-08-02 — merge resolution note (PR #1738 rebased onto #1839's anchor-bulk duplicate-check fix)

PR #1738 (below) and the duplicate-check fix documented further down this file (Zod-cap-vs-URL-budget
dedup defect, fixed via `chunkForInFilter` + fail-closed 503 + `normalizeFingerprint`) touched the
same insert call in `anchor-bulk.ts` on adjacent lines — #1738 added the missing `filename` field
(NOT NULL fix), main added `normalizeFingerprint(row.fingerprint)` in place of a bare
`row.fingerprint.toLowerCase()`. Merge resolution kept both: `normalizeFingerprint()` (main's
version — `.trim().toLowerCase()`, matching the normalization used everywhere else in this file,
vs #1738's bare `.toLowerCase()`) for the fingerprint, and #1738's `filename` fallback unchanged.
`fetchExistingFingerprints`/`chunkForInFilter`/the fail-closed 503 path were untouched by #1738 and
carried through as-is. Also verified against `docs/release/wave-merge-choreography-2026-08.md`
"Collision 2" (`FileUpload.tsx` dispatch routing, #1736 vs #1738): main already carried the required
union (multi-file all-spreadsheet-vs-mixed check + single-spreadsheet mode-choice step), auto-merged
clean, confirmed correct by re-reading the merged `dispatchFiles` and its test coverage rather than
trusting the clean exit.

## 2026-07-28 Dashboard bridge for mixed-format batch anchoring (SCRUM-2911 W1, founder P0)

- **`anchor-bulk.ts` bug fix:** the insert into `anchors` never set `filename`, which is `NOT NULL` at the DB layer — every real (non-mocked) call to `POST /api/v1/anchor/bulk` would have failed a Postgres constraint violation; the unit suite's fully-mocked `db` never caught it. `BulkAnchorRowSchema` gained an optional `filename` field (additive, §1.8-safe); the insert falls back to a synthetic `bulk-${fingerprint.slice(0,12)}` placeholder when the caller doesn't supply one (mirrors `anchor-submit.ts`'s `api-${fingerprint}` pattern). Regression test in `anchor-bulk.test.ts`.
- **New `anchor-bulk-self-service.ts`** (`POST /api/v1/anchor/bulk/self-service`, mounted in `router.ts` BEFORE `/anchor/bulk` — same route-shadowing rule as `/verify/search` before `/verify`): the browser dashboard cannot reach `/api/v1/anchor/bulk` directly because that route is `apiKeyAuth`-gated (`ak_...` keys only), and the dashboard authenticates with a Supabase session JWT. This bridge is the bulk-anchor analogue of `webhooks-self-service.ts` — mounted behind the router's local `requireAuth`, it re-derives `org_id` from `profiles` (never trusts the client), synthesizes an `ApiKeyMeta`-shaped caller (`scopes: ['anchor:write']`), and delegates into the SAME, byte-for-byte unmodified `anchorBulkRouter` — no duplicated dedup/credit/quota/insert logic. Any org member may call it (document creation, not an admin setting). No-org accounts get 403 `organization_required` (org-scoped credits are canonical per the 2026-07-28 CTO ruling R4; individuals still use the single-document flow). Dedicated rate limiter `anchorBulkSelfServiceRateLimiter` (10 req/min per user, Constitution §1.10 batch tier).
- Frontend consumer: `src/components/upload/MixedBatchUploadWizard.tsx`, wired via `SecureDocumentDialog.tsx`'s `onMixedBatchDetected` (fired by `FileUpload.tsx` for a multi-file drop that isn't all-spreadsheets).
## 2026-07-28 root-mount auth-leak on signatureComplianceRouter/keyInventoryRouter (bug hunt during PR #1754)

- `router.ts` mounted `signatureComplianceRouter` and `keyInventoryRouter` as `router.use('/', adesSignatureGate(), requireAuth, ...)` (and `...requireAuth, aiRateLimiter, keyInventoryRouter` for the latter). `router.use(path, mw1, mw2, subRouter)` registers EACH middleware as its OWN Express layer at that path — a bare `'/'` path matches every request. `adesSignatureGate()` path-guards itself (bypasses non-AdES paths, per its own 2026-04-18-incident fix — see `adesFeatureGate.ts` header), but the local `requireAuth` had no such guard, so it ran — and 401'd — on every request that reached this point in the stack, including routes registered LATER in the file: `GET /api/v1/regulatory/alerts` and `GET /api/v1/compliance/rules`, both documented and implemented as public/anonymous. `aiRateLimiter` on the key-inventory mount had the same unguarded-leak shape (silently consuming its shared rate-limit budget for unrelated downstream requests).
- Fixed by adding `isComplianceSignaturesPath`/`requireComplianceAuth`/`complianceAiRateLimiter` guards (router.ts) that only enforce auth/rate-limiting for the `/signatures*` sub-paths these two routers actually own, letting everything else fall through untouched — same pattern as `requireSignatureAuth` (PR #1754, for the adjacent `signaturesRouter` mount) and `adesSignatureGate`'s own `_isAdesPath` guard. Auth on the compliance/key-inventory routes themselves is unchanged (still 401s without a Supabase JWT).
- Confirmed via real Express instantiation (not just source-string assertion): regression test in `src/tests/api-e2e.test.ts` mounts the actual `apiV1Router` and asserts both previously-401'd public routes now pass, while `/api/v1/signatures/key-inventory` and `/api/v1/signatures/export` still 401 without auth. Existing isolated sub-router tests (`compliance-rules.test.ts`, `key-inventory.test.ts`, `signatureCompliance.test.ts`) mount their router alone and never exercise the full `router.ts` mount order, so they could not have caught this bug class.

## 2026-07-22 inferJurisdiction word-boundary fix (bug hunt)

- `ai-extract.ts`'s `inferJurisdiction` (used only inside `buildFastFallbackExtraction`, the degraded fallback that runs when the primary AI provider errors/times out) had a regex bug: `/\bKenya|KDPA|ODPC\b/i`-style `|`-chains only bind `\b` to the FIRST/LAST alternative, leaving interior alternatives (`KDPA`, `OAIC`/`AHPRA`/`TEQSA`, `USA`) completely unanchored — they matched as raw substrings anywhere in the text (e.g. "CAUSATION" contains "USA" and incorrectly returned `jurisdiction: 'United States'`). Fixed by wrapping each `|`-chain's alternatives in a shared `\b(?:...)\b`/`(?!\w)` boundary, applied per-alternative correctly. Also fixed a latent, independent bug found in the same regexes: the original `U\.S\.\b` alternative's trailing `\b` could essentially never match in practice (a period is virtually always followed by another non-word character, so the word/non-word transition `\b` requires never occurs) — replaced with a trailing `(?!\w)` lookahead, which is boundary-correct for alternatives ending in either a letter or a period. `inferJurisdiction` is now exported for direct unit testing (mirrors the existing `resolveExtractionLatencyBudgetMs` export pattern).

## 2026-07-21 CTDL import consumer — demo-able caller for the importer (SCRUM-2913, PR #1603)

_Restored 2026-07-28 — lost off `main` by the union-merge-driver incident (see `docs/incidents/2026-07-28-agents-md-union-drop-remediation.md`)._

- **New ADDITIVE authed route** `GET /api/v1/credentials/ctdl/import?ctid=ce-<uuid>` (`credentials-ctdl-import.ts`, `buildCredentialsCtdlImportRouter`). Given a CE CTID it fetches the PUBLIC CE Registry `/graph/<ctid>` envelope and runs it through `parseCtdlEnvelope({ credentialNodesOnly: true })`, returning the bounded `{ ctid, registry:{ retrievedAt, envelopeSha256, envelopeSignatureVerified:null }, count, records: ImportedCtdlRecord[] }`. Works for ANY valid CTID — no demo CTID is baked in. This is the missing caller that makes the importer demo-able (give a CTID → clean parsed record). §1.8-safe: purely additive, no change to any existing route/contract.
- **Mount** (`router.ts`): `router.use('/credentials/ctdl/import', requireAuth, ctdlImportRateLimiter, credentialsCtdlImportRouter)` placed BEFORE the anon serializer mount `router.use('/credentials', anchorAnonAllow, credentialsCtdlRouter)`. The specific sub-path scopes `requireAuth` (Supabase JWT) to exactly this route so the public serializer's `/credentials/:publicId/ctdl` stays anon — the two `/credentials` paths are disjoint (`/ctdl/import` never matches `/:publicId/ctdl`). Inherits the global `verificationApiGate()` (ENABLE_VERIFICATION_API) and `apiKeyAuth`+rate-limit stack; a dedicated per-user `ctdlImportRateLimiter` (10/min) throttles the outbound fetch.
- **SSRF-proof by construction:** the client supplies ONLY `ctid`, validated STRICTLY against the anchored `REAL_CTID_PATTERN` (`^ce-<uuid>$`, reused from `ctdl-ctid-guard.ts`) — a single string (arrays/pollution → 400) with no host/path/`@`/`#`/`?`/whitespace. The fetch URL is `${DEFAULT_REGISTRY_BASE_URL}/graph/${ctid}` built from the SERVER-side base (imported identifier); no URL/host/base is ever taken from the request. Egress goes through the shared `safeFetch` (scheme allow-list, resolve-and-pin IP, private/metadata reject, 5 MiB body cap) with `maxRedirects: 0` (any 3xx refused — never chased cross-host) + an 8 s AbortController deadline (importer's 10k-node cap is the belt).
- **§1.6A discipline:** raw registry bytes are SHA-256'd (public-envelope fingerprint — outside the client-only boundary) and parsed, and are NEVER logged/Sentry'd/embedded in an Error/written to the audit row. `ctdl.import.requested` audit rows carry only ctid + outcome + http_status + record_count. Error messages are value-free.
- **R-7 claims guard:** the assembled response is run through `assertNoProhibitedClaimInJsonLd` before send (fail-closed 500 on a Registry-listing / legal-sufficiency overclaim from a hostile record). `envelopeSignatureVerified` is emitted `null` (measured/unchecked) and is never rendered as CE endorsement of Arkova.
- **Error map:** invalid/missing/array ctid → 400 `invalid_ctid` (before any fetch); registry 404 → 404 `registry_record_not_found`; timeout → 504 `registry_timeout`; oversize body → 413 `registry_record_too_large`; registry 5xx / redirect / other non-2xx / fetch fault → 502 `registry_bad_gateway`; malformed JSON → 422 `registry_record_unparseable`; unauth → 401. Tests: `credentials-ctdl-import.test.ts` (19) mock the outbound fetch (inject `SafeFetchDeps`) and feed the committed real `ctdl/__fixtures__/ce-real-graph-*.json` bytes — no real network; includes an SSRF suite proving host/path/`@`/`../`/`http://` ctids are rejected before any resolve/dispatch, and a logger-spy assert that raw bytes never reach any log call.

## 2026-07-17 Anchor credit-gate idempotency (SCRUM-2970, BUG-2026-07-17-012)

- `anchor-submit.ts` restructured to insert-then-deduct: the PENDING anchor row is inserted first, then `ensureAnchorCreditAvailable` runs with `reference_id` = the new row's id (repo pattern per `credential-sources.ts`). Previously the gate called `deduct_org_credit` with `p_reference_id=null`, bypassing the 0326 idempotency ledger so a retry double-deducted. A fingerprint-derived reference was rejected in review (free re-anchor after soft-delete). On deduct failure the never-paid row is hard-deleted (compensation) and the frozen 402/503 bodies are returned unchanged; an HTTP retry of the same request is absorbed by the dedup lookup before the gate.

## 2026-07-06 S3-P0 producer-contract pin (no route changes)

- `verify-proof.bundle-producer.test.ts` pins that a row written EXACTLY the way the S3-P0 batch producer writes it (app-tree branch + `merkle_index` + `batch_id` + `op_return_payload` = "ARKV"‖root with NO version byte, bytea `\x` wire shape) plus the PROOF-03 confirmation columns yields a COMPLETE non-null `proof_bundle` from `buildProofResponse` — the "/proof stops being empty" contract. `verify-proof.ts` itself is UNCHANGED (frozen §1.8 surface; `proof_bundle.signature` remains the reserved always-null inline placeholder — the signed envelope stays at the outer `?format=signed` level).

## 2026-07-06 AI-03 recursive byte-smuggling guard (Carson P1, PR #1413)

_Restored 2026-07-28 — lost off `main` by the union-merge-driver incident (see `docs/incidents/2026-07-28-agents-md-union-drop-remediation.md`)._

- `ai-template.ts` `assertNoDocumentPayload` is now RECURSIVE over nested objects/arrays (the schema accepts `z.unknown()` values, so a first-level-only walk let `{fields:{metadata:{rawDocument:"<base64>"}}}` through to `GeminiProvider.reconstructTemplate`). At ANY depth it rejects: banned document-shaped keys, `data:` URIs, base64-shaped strings (≥512 chars pure base64/base64url alphabet), per-value length > 20k, key names > 256 chars, nesting > 8 levels, and a CUMULATIVE string budget (50k across all values + key names) that blocks documents chunked across many small keys. Issues carry key paths + bounded messages only — never values.
- The two route handlers (`/template`, `/tags`) share one `aiRouteHandler` factory (auth → validate → invoke → value-free log → respond); per-route deltas are declarative specs. AI-03 value-omission lock-ins unchanged and still test-locked in `__tests__/ai-template.contract.test.ts`.

## 2026-06-24 Batch AI extraction credit accounting (BUG-2026-06-24-013, T2)

- `ai-extract-batch.ts` (`POST /api/v1/ai/extract-batch`) moved from an UP-FRONT batch debit + failure-only refund to **per-item debit/refund inside `parallelMap`** (parity with the single path `ai-extract.ts`). Batch-level double-accounting is now structurally impossible.
- **No free batch:** the per-row debit runs BEFORE the provider call. When the org has a finite credit balance (`checkAICredits` returned non-null) and the per-row `deductAICredits(...,1)` returns falsy, that row is skipped with `{ success:false, error:'insufficient_credits' }` and the provider is NOT called. The old "log `'…deduction failed — proceeding'` and extract anyway" free-extraction path is gone. An up-front 402 still rejects the whole batch when `hasCredits === false` (cheap guard), but the per-row debit is the authoritative gate.
- **Only successes stay charged:** each failed/timed-out row refunds **its own** single credit (`deductAICredits(...,-1)`) — there is no blanket `-failedCount` batch refund that could credit work never paid for. Cached rows and unmetered-beta rows (balance null) are never debited, so they are never refunded.
- **No swallowed refund:** if a per-row refund fails after a successful debit, the code enqueues an `ai_credits.reconcile_refund` job via `submitJob` (`AI_CREDIT_RECONCILE_JOB_TYPE`, payload = `{orgId,userId,amount,reason,fingerprint,source}`, metadata-only, no row text) instead of `.catch(()=>{})`. A lost refund is an overcharge — it is surfaced, not dropped.
- **Fingerprint cache (EFF-1 parity):** each row checks `ai_usage_events` by `fingerprint` (same query as the single path) and, on hit, returns `provider:'cache'` with no debit and no provider call → batch retries are idempotent and don't re-charge already-extracted rows. Successful extractions now write `result_json` into the usage event so they populate the cache.
- **Per-row latency budget:** `BATCH_ROW_LATENCY_BUDGET_MS` (`config.aiBatchRowLatencyBudgetMs`, env `AI_BATCH_ROW_LATENCY_BUDGET_MS`, default 8000, clamped 1000–30000) bounds each provider call; a timeout is treated as a failed+refunded row, not a charge. Sourced via typed config (SCRUM-1258), not an ad-hoc `process.env` read.
- Response gains `summary.cached`; the frozen success/result shape is otherwise unchanged. No new banned fields exposed; logs/job payloads carry `orgId`/`userId`/`fingerprint`/`rowIndex` only, never `row.text`.

## 2026-06-11 CTDL Safety Gate (PR #1146)

- `credentials-ctdl.ts` treats `CtdlPiiSafetyError` from the serializer as a fail-closed public response: HTTP 404 `{ error: 'not_found' }` with `ctdl.requested` audit outcome `safety_blocked`. Never return a CTDL body when the serializer blocks on transcript/education learner-name PII confidence. The credential's public contract (status/date/identifier/revocation fields) is otherwise unchanged from main.
- CTDL `ceterms:ctid` is optional (shipped via #1178). The endpoint must not invent CE CTIDs from Arkova public IDs; only explicit real CE CTIDs may appear.

## 2026-07-06 CE-04 contact-hour sourcing in normalizeAnchorRow (SCRUM-2375, S3)

- `normalizeAnchorRow` additionally derives `contactHours` (CE continuing-education ContactHour credit) from an allow-listed metadata key set (`contact_hours`/`credit_hours`/`ce_credit_hours` + camelCase) via `contactHoursFromMetadata`, accepting plain numbers or CANONICAL decimal strings only (`/^\d+(\.\d+)?$/` — round-1 review fix on PR #1412: `Number()`-coercible forms like `'0x10'`/`'1e3'`/`'Infinity'`/`'+5'` are ignored) and gating through the serializer-exported `normalizeContactHours` plausibility check (0 < v ≤ `MAX_CONTACT_HOURS` = 1000, the constant shared with `ctdl-validation.ts`). `ceu`/`ceus` are NOT allow-listed — no fabricated unit conversion. The serializer emits it as `ceterms:creditValue` (ValueProfile + `creditUnit:ContactHour`) for CPE/CLE only; see `ctdl/agents.md`. Additive optional field on the public CTDL body (§1.8-safe). CONFLATION GUARD: unrelated to the billing `credit_ledger`.

## 2026-07-06 CE-06a claims_blocked audit outcome + revocationReason PII (PR #1412 round-1 review fixes)

- `credentials-ctdl.ts` now catches `ProhibitedClaimError` from the serializer's final claims assert with its own audit outcome `claims_blocked` (HTTP 500 `internal_error`, no body, value-free error message), mirroring `CtdlPiiSafetyError`'s `safety_blocked` instead of the generic `error` bucket — claims blocks are observable in `audit_events`.
- BUG-2026-07-06-002 / SCRUM-2630 (pre-existing): a PII-bearing `revocation_reason` no longer ships on the public 410 body — the serializer routes it through `cleanPublicFreeText` (honest omission; 410 + `ceterms:revocationDate` unchanged). See `ctdl/agents.md`.

## 2026-07-01 CE-03 expiration sourcing in normalizeAnchorRow (SCRUM-2374, S2)

- `normalizeAnchorRow` (now exported for unit tests) maps a raw `anchors` row into a `CtdlAnchor`. It reads issued-person expiry from `expires_at` (NEVER mapped to `ceterms:expirationDate` — see `ctdl/agents.md`) and derives `resourceAvailableUntil` (offering expiry, the only expiry CTDL emits) from an allow-listed metadata key set (`resource_available_until`/`offering_available_until`/`offering_end_date` + camelCase) via `resourceAvailableUntilFromMetadata`. Non-date and non-allow-listed values are ignored (honest omission).

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
  - **SCRUM-2481 — a caller may NOT assert its own issuer-authenticated evidence level.** `metadata.verification_level` used to flow from this request body straight into the service-role insert, and `get_public_anchor` serves it to anonymous verifiers, so any API-key holder could mint an anchor that renders the green issuer-authenticated badge. The route now runs the parsed public-safe metadata through `stripClientUnassertableEvidenceClaims` (`lib/credential-evidence.ts`) and drops `issuer_anchored` / `source_signed`. Lower tiers (`account_linked`, `captured_url`, `captured_upload_ai`) still persist untouched. Strip, don't reject: the request still 201s so the frozen §1.8 contract is unchanged, and the attempt is logged with `stripped` + `attemptedVerificationLevel`. If stripping empties the metadata, the column is omitted so Postgres applies its NULL default (SCRUM-1732 contract). Any new evidence field a client can send must be checked against the same question — *can the server prove this?* — before it is added to the persisted allowlist. **This guard covers this route only.** The browser writes `anchors` directly over PostgREST, which no API guard can see; migration `0384` carries the same rule at the DB layer and is what actually makes the badge unforgeable.
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

- `POST /api/v1/exports/cpe-log` — JWT-authed (mounted behind `requireAuth`), per-user **10 requests/hour** rate limit (`cpeLogExportRateLimiter`, in-memory `rateLimit()` bucket keyed `cpe-log-export:<userId>`; 11th → 429 + `Retry-After`). Body `{ user_id, period_start, period_end, format: 'pdf'|'json' }` (Zod `.strict()`, `period_start<=period_end`). Generates **both** PDF + JSON synchronously, uploads to Supabase Storage (bucket `EXPORTS_STORAGE_BUCKET`, default `exports`), and returns a signed URL for each (1h TTL) plus `request_id` + `record_count`. SCRUM-2378: response also carries `excluded_count` (in-period rows excluded server-side because not yet SECURED; additive field). The CLE endpoint additionally echoes `jurisdiction_disclaimer` (SCRUM-2379, section 1.5); the org export mirrors `excluded_count`.
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
| `POST /api/v1/anchor/bulk/self-service` | Supabase JWT (any org member; org resolved from `profiles`) |
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

## Silent credit-RPC alerting (revenue-leak pre-mortem)
- `ai-extract.ts` — `deduct_ai_credits` RPC failure (DB error, not insufficient balance) fails OPEN by product decision (RISK-6): the extraction proceeds for FREE. Now calls `captureCreditRpcFailureAlert({ failMode: 'open', ... })` from `utils/sentry.ts` (fatal level, `credit_rpc_fail_mode:open` tag) so the revenue leak pages instead of only logging. Behavior unchanged, observability only.
- `credits.ts` — the dev/test-only `deduct_unified_credits` grant path (no Stripe key, non-prod) alerts (`failMode: 'closed'`) on RPC failure so a real regression in this RPC doesn't hide behind "it's just dev mode."

## 2026-07-28 L3-A6 — CE registry-anchor route (CE Noncredit Data Taxonomy POC)

- `credentials-ctdl-registry-anchor.ts` — `POST /api/v1/credentials/ctdl/registry-anchor`. Given a CTID, REUSES the exact §1.6A-compliant `fetchRegistryGraph`/`buildRegistryGraphUrl`/`mapSafeFetchError`/`RegistryTimeoutError` primitives exported from `credentials-ctdl-import.ts` (no second outbound-fetch implementation), parses with `parseCtdlEnvelope(..., { credentialNodesOnly: true, includeNoncreditProgramClasses: true })` (see `services/worker/src/ctdl/agents.md`), runs `assertNoProhibitedClaimInJsonLd` BEFORE creating the anchor, and inserts an `anchors` row from the in-memory envelope SHA-256 + bounded PII-free metadata (`ce_registry_ctid`/`ce_registry_url`/`ce_envelope_sha256`/`ce_retrieved_at`/`ce_record_type`/`ce_record_name`/`ce_issuer_name`). `credential_type: 'OTHER'` (no dedicated noncredit enum value — see the honest-limits section of `docs/partners/ce-noncredit-anchoring-poc.md`). Idempotent via `sha256(ctid + envelope_sha256)` fingerprint; a staleness guard (`expected_envelope_sha256`) rejects anchoring if the registry record changed since a prior lookup. `credentials-ctdl-import.ts`'s previously-internal fetch helpers (`fetchRegistryGraph`, `buildRegistryGraphUrl`, `mapSafeFetchError`, `RegistryTimeoutError`, `MAX_RESPONSE_BYTES`, `DEFAULT_REGISTRY_TIMEOUT_MS`, `ImportOutcome`) are now exported specifically for this reuse — keep them as the ONE fetch implementation if a third CTDL consumer route is ever added.
- Mounted at `/credentials/ctdl/registry-anchor` in `router.ts` with its own `requireAuth` + a 5 req/min-per-user rate limiter (`ctdlRegistryAnchorRateLimiter`) — tighter than the read-only import route's 10/min, since this leg also writes an anchor + deducts org credit.

## 2026-08-01 SCRUM-2227 — `compliance_controls_note` (claims honesty)

- **`compliance_controls` never travels alone.** `verify.ts`, `ai-accountability-report.ts` and `audit-export.ts` all attach `COMPLIANCE_CONTROLS_NOTE` (from `services/worker/src/utils/complianceMapping.ts`) whenever they surface a non-empty control list, and omit it when there is none. Control IDs are a credential-type *mapping*; without the note they read as an assertion that the record, its issuer, or Arkova has been assessed against the named framework — and for `eIDAS-25`/`eIDAS-35` that misread ("qualified trust service") is direct legal exposure. §1.5 / R-7. **Do not surface `compliance_controls` from a new endpoint without the note.**
- Additive nullable field, no API version bump (§1.8). In `verify.ts` the note is derived from whatever `compliance_controls` the allowlist loop actually placed on the response — keyed off `result`, never off `anchor`, so the two cannot disagree. It is deliberately NOT in `EMPTY_API_RICH_FIELDS`: it is derived, not a column on `AnchorByPublicId`.
- **Retired control IDs are filtered on read.** `sanitizeStoredComplianceControls()` drops `DPF-NOTICE` / `DPF-ACCOUNTABILITY` from stored values. SCRUM-2283 removed the EU-US Data Privacy Framework claim from the frontend as a false external-status claim, but the worker mapping kept emitting it, so ~2.9M SECURED anchors persisted it. No migration can un-say that; the read path is where it is asserted, so that is where it is stopped.
- `compliance_controls` is declared `ComplianceControls = Record<string, unknown> | string[]`. The column has always held an **array**; the object arm survives only because the public type advertised it. The OpenAPI schema documents both arms for the same reason.

## 2026-08-01 BUG-2026-06-24-007 (worker side) — controls are a CURRENCY claim

- `compliance_controls` is withheld entirely once a credential is no longer current. Gate: `controlsApplyForStatus()` in `utils/complianceMapping.ts` (true only for `SECURED` / `ACTIVE`, fails closed on unknown/null). Applied in `verify.ts`, `audit-export.ts` (`getControlIds`), `ai-accountability-report.ts`, and the GRC push.
- **Why suppression and not a "no longer current" marker:** the surfaces that matter most are machine-read. A GRC platform ingesting `controls: [...]`, or a CSV importer, maps them as evidence no matter what prose sits beside them. Suppression is unambiguous to both machines and humans; a qualifier only works for humans who read it. The SCRUM-2227 note disclaims **attestation**, not **currency** — it does not cure this.
- **Matches the frontend**, which has gated its compliance section on `isSecured` since `0c90f881a` (2026-06-24). That fix was explicitly frontend-only, which is why the worker kept serving the full SOC2/HIPAA/eIDAS set next to `status: REVOKED`. Same record must not show none on the page and a full set in the export.
- **The note goes with the list.** No controls ⇒ no `compliance_controls_note`; the note qualifies a list that is not there.
- **The audit PDF says WHY**, with TWO distinct strings — absence alone is ambiguous and could be read as "never had controls". `CONTROLS_WITHHELD_NO_LONGER_CURRENT` (REVOKED/EXPIRED/SUPERSEDED) vs `CONTROLS_WITHHELD_NOT_YET_ANCHORED` (PENDING/SUBMITTED/unknown, and the default). **Do not merge them:** the revoked wording says "its anchor receipt and timestamps above are unchanged", which is FALSE for a record whose `chain_tx_id`/height/timestamp are all null — that would put a false claim on an auditor-facing artifact inside a claims-honesty fix. Machine formats (CSV, JSON, GRC payload) just omit.
- **Batch PDF:** `frameworkSet` can now be EMPTY (the batch endpoint takes a caller-supplied `status`, e.g. `REVOKED`); before the currency gate this was unreachable because `getControlIds` always fell back to the never-empty universal set. Render the withheld explanation in that case — never a blank Framework Coverage line followed by the informational note, which would leave the note qualifying a list that is not there.
- **Any change to the verify response shape MUST bump `KEY_PREFIX` in `utils/verifyCache.ts`.** Hits are served verbatim without re-running `buildVerificationResult`, and `invalidateVerificationCache` does NOT re-fire for an already-revoked/expired anchor, so a stale entry would keep serving the withheld controls for the full TTL.
- **DO NOT** "fix" this by re-adding controls with a disclaimer string. Withholding is silence; a stale control list is an assertion (R-7 / §1.5).

## 2026-08-01 SCRUM-2293 — CTDL academic records emit no issuer free text

- `credentials-ctdl.ts` is unchanged, but the BODY of an academic-record projection is narrower: for `credential_type` in `DEGREE`/`CERTIFICATE`/`TRANSCRIPT`, `ceterms:name` is now controlled vocabulary derived from the CTDL `@type` ("Bachelor Degree", "Academic Transcript") and `ceterms:description` / `ceterms:revocationReason` are omitted. Rationale + the measured reason a name-detection heuristic was rejected: `services/worker/src/ctdl/agents.md` (2026-08-01).
- `ceterms:offeredBy.ceterms:subjectWebpage` now drops the query string and fragment.
- **`safety_blocked` audit volume should NOT rise materially.** The gate fails closed only on high-confidence, format/keyword-anchored PII (email/phone/SSN/DOB/student-ID) reaching the assembled body — deliberately not on name heuristics, so a legitimate credential is not taken offline. If `safety_blocked` does spike, investigate the underlying anchor's free text, not the gate.
## 2026-08-01 SCRUM-2575/2576 — proof availability is stated, not inferred

- `verify.ts` emits `proof_availability` (`per_document` | `root_only`) + `proof_availability_note` on `GET /api/v1/verify/:publicId`. Additive, omit-when-absent, never `null` (Constitution 1.8 / §6). Wording lives in ONE place: `services/worker/src/constants/proofAvailability.ts`.
- **The class is MEASURED, not inferred**, by `hasServableProofBranch()` in `utils/proofBranch.ts` — the SAME predicate `/proof` applies before it will serve a branch, fed BOTH proof locations (the `anchor_proofs` embed and the legacy `anchors.metadata` proof). **DO NOT** write a second predicate: if `/verify` and `/proof` disagree, the API contradicts itself about one record. An EMPTY `proof_path` (`[]`) is a VALID single-leaf branch, not a missing one. **DO NOT** derive the class from `anchors.status`, from `merkle_root` alone, or from `anchor_proofs.proof_completeness_class`: that 0354 column is written by a Carson-gated classifier that has not run in write mode over prod, so it is NULL for essentially the whole catalogue and would report `root_only` for everything.
- **Three conditions gate emission, all required:** the branch was actually measured (`has_stored_proof_branch != null`), the status is settled, and `chain_tx_id != null`. The third is not redundant — `revoke_anchor()` accepts a PENDING, never-broadcast anchor and a SUPERSEDED parent may never have been SECURED, so a status label alone does not establish the on-chain commitment the note asserts.
- **`has_stored_proof_branch` is TRI-STATE.** `null` means NOT MEASURED and must omit both fields. Endpoints that build an `AnchorByPublicId` without loading proof data (`batch.ts`, `oracle.ts`, via `EMPTY_API_RICH_FIELDS`) rely on this: the note opens "Measured:", so reporting `root_only` from a path that measured nothing would make `/verify/batch` assert the opposite of `/verify/:publicId` for the same anchor. **DO NOT** default it to `false`.
- **Emit the pair via `proofAvailabilityFields()`** — never assign the class and look up the note separately. The helper returns both so a class cannot ship without its statement of what it does NOT assert.
- **DO NOT** classify PENDING / SUBMITTED anchors. They have not finished anchoring, so absence of a branch is not yet a measurement; both fields are omitted. REVOKED / EXPIRED / SUPERSEDED **are** classified — they were anchored and the commitment is still on-chain.
- `verify-proof.ts`: the `NO_BATCH_PROOF` 404 body now also carries `proof_availability: root_only` + the note, built by `noBatchProofBody()` so the two emission sites cannot drift. `RECORD_NOT_FOUND` deliberately gets NO class — classifying a record we do not hold would be an assertion about it.
- **The 404 status code is frozen.** `docs/reference/FE_PROOF_GATE_CONTRACT.md` §2.2 and `src/lib/proofAvailability.ts` both route on it. SCRUM-2575's AC asks for root-only to stop being a 404; that flip is a breaking contract change and is NOT done here — the affirmative honest answer lives on the 200 from `/verify/:publicId` instead.
- Any change to the verify response shape MUST bump `KEY_PREFIX` in `utils/verifyCache.ts` — a cache hit is returned verbatim without re-running `buildVerificationResult`.

## 2026-08-02 — Two silent-empty `.in()` reads on the v1 surface (PR #1845, follows #1839)

Both are the defect class documented in `services/worker/src/jobs/agents.md`: an unbounded
PostgREST `.in()` filter takes 400 Bad Request, postgrest-js RESOLVES that as
`{ data: null, error }` rather than throwing, and a call site that discards the error reads it as
"nothing matched" and answers 200. Every id filter on this surface now goes through
`chunkForInFilter` (`utils/postgrest-filter.ts`) — no call site picks a width.

- **`anchor-bulk.ts` — the duplicate check created and BILLED duplicate anchors.** The Zod cap is
  1000 rows of 64-char hex; the URL budget is exhausted at ~122 of them, so any batch past that took
  400 on the one-shot `.in('fingerprint', …)`. The error was discarded, the empty result read as "no
  fingerprint exists yet", every row queued, and `deductOrgCredit` charged the org for the whole
  batch — HTTP 201, duplicates created, invoiced. Now chunked, and the check **fails CLOSED**: any
  chunk error returns **503 `duplicate_check_unavailable`** before quota, credit deduction or any
  insert, rather than the old `logger.warn` + continue. Stricter than `assertNotAllChunksFailed` on
  purpose — a partially-read dedup answer is a wrong one, not a weaker one. Third defect in the same
  six lines: the filter used the caller's casing while the insert path lower-cases, so an upper-case
  resubmission of an existing document matched nothing against `character(64)` and was re-created and
  re-billed. `normalizeFingerprint()` is now the single normalization, and the probe asks about both
  casings (extra values in an existence probe can only find more, never fewer). The failure log
  carries the driver **code only** — a Postgres/PostgREST `.message` routinely echoes the offending
  value, and a fingerprint must not reach the logs (§1.1). **Prod impact: none.** The path has
  created zero anchors in prod (census in the PR body); the fix is pre-emptive.
- **`auditBatchVerify.ts` — the audit sample reported its ENTIRE population as `NOT_FOUND` at 200.**
  1000 public_ids is roughly twice the URL budget; `const { data: anchors } = await …` discarded the
  400, `anchorMap` was empty, and every sampled credential came back `NOT_FOUND` — with an
  `AUDIT_BATCH_VERIFY` event recording the same wrong answer. On an audit surface a confident,
  reproducible, false "none of these exist" finding is worse than an error. Now chunked, and **ANY**
  chunk error throws to the route's 500 handler **before** the audit event is written. Also an
  explicit opt-out from `assertNotAllChunksFailed`, in the strict direction: an ISA 530 sample missing
  one chunk gets signed off as complete.
- **The `sample_percentage` population truncation is fixed in the stacked follow-up below**, not in
  this PR. It was recorded here as "Known, NOT fixed here" while it was still open.

## 2026-08-02 — `auditBatchVerify.ts` sampled a population it did not read (PR #1865, stacked on #1853)

The `sample_percentage` path drew its sample from
`db.from('anchors').select('public_id').eq('org_id', …)` with **no pagination**. PostgREST
answers that with its row maximum and says nothing about the rest, so the "population" was an
arbitrary 1000 rows — while `total_population` was reported from a **separate** exact-`count`
head query over the whole org. On the real DocuSign org (3,151,539 anchors) a 1% request
returned 10 credentials drawn from an arbitrary 1000, presented alongside
`total_population: 3151539`. **The auditor was told the sample came from the full population;
it did not.** An audit-validity defect, not a performance one — the endpoint's entire job is to
support an inference from sample to population, and that inference was unsound.

### The invariant this file now upholds

> Either the endpoint refuses, or `total_population` is the TRUE population and the sample is a
> distinct subset of it of exactly the requested size.

`total_population` is literally `sample.population`, the length of the id list the draw came
from — there is no second query it can disagree with. A 112-case property sweep
(population x server page cap x percentage) asserts the sentence above directly, because both
bugs this endpoint has had were violations of it while every individual response still looked
well-formed.

### Paging

Delegated to `scanAllPages` (`utils/postgrest-filter.ts`) — see `utils/agents.md`. **The first
attempt at this fix hand-rolled the loop and reintroduced the same truncation** via
`if (page.length < POSTGREST_ROW_LIMIT) break`, which is wrong whenever the server's
`db-max-rows` is below that constant: with a 500-row cap it reported a 5,000-anchor org as
holding 500 records, at HTTP 200. That is why the loop is no longer written here.

Ordering is total (`created_at` then `public_id`): offset paging over a non-deterministic order
drops and duplicates rows across page boundaries. `created_at` leads so the scan rides
`idx_anchors_org_deleted_created`; ASC so concurrent inserts append past the cursor instead of
shifting every page under it. Ids are deduped after the scan, so a mid-scan insert cannot
inflate the reported figure.

**Kept as OFFSET paging deliberately.** Keyset would be ~13x less index work at the ceiling,
but the compound `(created_at, public_id)` cursor needs an `.or()` across columns, and HANDOFF
records that exact shape on `anchors` misleading the planner into a seq scan on the DocuSign
org. Do not switch without an `EXPLAIN (ANALYZE)` against org
`40383eb2-f1cd-4a85-8099-afafff95e5cf`.

### Refusals (both 422, distinct from the existing 400 for Zod failures)

- Above `MAX_SAMPLEABLE_POPULATION` (25,000) → `population_too_large`: no sample, **no
  population figure**, no `AUDIT_BATCH_VERIFY` row. Only an honest lower bound, labelled
  `population_at_least`. **The DocuSign org is above this ceiling**, so percentage sampling
  refuses there rather than fabricating; `credential_ids` is unaffected.
- Above `MAX_SAMPLE_SIZE` (1000) → `sample_too_large`, carrying the true `total_population`,
  `requested_sample_size`, and the `max_sample_percentage` that would fit. Trimming to the cap
  would report an N% sample that is not an N% sample. 1000 is the same cap `credential_ids`
  has always had, so both routes bound the downstream chunked `.in()` identically.

Raising the population ceiling means moving sampling into Postgres (a `TABLESAMPLE`/reservoir
RPC returning sample **and** true population in one call). That is a migration, so T3, and a
separate story. Adding pages is not the fix.

### Sampling primitives (both exported for direct unit test)

- **`seededSample(items, count, rng)`** — selection-sampling Fisher-Yates, O(count) not
  O(items): 1,000 draws instead of 25,000 at the ceilings. Replaces
  `[...rows].sort(() => rng() - 0.5)`, which was **not a shuffle**: a comparator returning a
  random sign is not a consistent ordering, so the permutation is a function of the sort
  algorithm's comparison schedule, not of the randomness — **no PRNG quality fixes it**.
  Measured under V8's TimSort, 16 elements, 2000 trials, uniform expectation 125: index 0 was
  selected 340 times, index 1 only 77.
- **`seededRandom`** is now **mulberry32** (the idiom already used in `ctdl-importer.fuzz.test.ts`
  and `ai/eval/pe-synthetic-generator.ts`), not the previous LCG. The LCG's FIRST output is a
  near-linear function of the seed: over seeds 1..2000 on a 16-element population it reached
  only **14 of 16** buckets, so two elements could never be picked first. Auditors pick small
  sequential seeds and `seededSample` takes its first pick from that first output, so this was
  live sampling bias on the exact input pattern the feature invites. The old whole-array
  shuffle masked it by burning thousands of draws first — luck, not design. **If you make this
  cheaper again, keep the count=1 uniformity test: it is the only thing that pins the PRNG's
  first output.** The old divisor `0xffffffff` also made the max draw exactly 1.0, indexing one
  past the end; `seededSample` clamps as well rather than trusting its rng.

### Seed and audit-trail handling

`seed ??`, not `seed ||` — seed 0 is a seed, and `||` sent the likeliest value an auditor would
type down the unseeded path. An unseeded request now generates a seed and **returns** it, so
ISA 530 reproducibility is meetable. The `sampling` block in the audit row is gated on the
branch actually TAKEN (`sample !== null`), not on `sample_percentage` being present: the Zod
refine is an OR, so both params validate, `credential_ids` wins, and gating on presence put a
percentage-sample claim into the permanent audit trail for a run that verified the caller's own
hand-picked list.

The empty-org branch no longer returns a second response shape for the same 200.

**Known, NOT fixed here:** `VerifyResult.fingerprint` is on the §6 banned-field list —
ORG_ADMIN-only and pre-existing, and removing a field from a frozen v1 body is exactly the
breaking change §1.8 governs. Separately, the seed is caller-chosen by design, so an auditee can
shop seeds for a favourable sample; under ISA 530 the seed is meant to be the auditor's to pick.
