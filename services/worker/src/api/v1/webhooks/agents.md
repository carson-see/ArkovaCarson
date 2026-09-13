# agents.md — services/worker/src/api/v1/webhooks/

_Last updated: 2026-09-07 (SCRUM-4493: ComputeID AgentPassport revocation receiver)_

## 2026-09-07 — SCRUM-4493: `computeid.ts` — ComputeID AgentPassport revocation receiver (flag-gated dark)

Forked from `checkr.ts`. Three things are deliberately different and are the first places to look when this handler behaves unlike its siblings:

1. **One Arkova-global registration, not per-org.** ComputeID signs every delivery with the single secret we handed them at `POST /v1/webhooks/register`; the org is resolved from the passport → agent binding (`agents.metadata.computeid.passport_id`, jsonb `@>` lookup), not from an account header. `COMPUTEID_WEBHOOK_SECRET` may be a comma-separated list (current,next) because ComputeID has **no deregister/rotate endpoint** (verified live 2026-09-07) — rotation is register-new → ask the partner to retire old.
2. **No nonce table.** A per-provider nonce table needs a migration, which is PR-B (SCRUM-4497). Replay safety comes from the ordering FLOOR on the SIGNED payload timestamp in `integrations/computeid/binding.ts` (last applied event, else the admitting receipt's `issued_at`, else `bound_at`): older events and exact replays are no-ops, a late `passport.reinstated` can never undo a later `passport.revoked`, a pre-admission replay cannot revoke a fresh agent, and `revoked` is terminal. Do not "fix" a duplicate delivery by adding a nonce here.
4. **Keys first, then a compare-and-set.** The auth path reads only `api_keys.is_active`, so keys are deactivated BEFORE the row flips (and reactivated after, only the ones we suspended); the `agents` update is a CAS on `(status, metadata->computeid->>last_event_at)` with `.select('id')`, and zero rows → `409 conflict_retry` + DLQ. `passport.reinstated` lifts only a suspension carrying `suspended_by: 'computeid'`.
5. **Its own limiter bucket, content-type-agnostic raw parsing, real 413.** `rateLimiters.computeidWebhook` (not the shared Stripe bucket); `express.raw({ type: () => true, limit })` because the HMAC is the authentication and a `text/plain` default must not become a 500; body-parser's `entity.too.large` is mapped to `413 payload_too_large` at the mount (it is not an `AppError`, so the global handler would have returned 500). `middleware/computeidGate.ts` runs first at the mount.
3. **Ack semantics.** `test` and unknown event names → `200 ignored`. Unbound passport → `200 orphaned` + `webhook_dlq` row (reason `unbound_passport`). A DB failure mid-apply → `500` + DLQ so the partner can retry — but their delivery is `node-fetch` fire-and-forget with undocumented retry, so treat every 5xx as a probable loss until SCRUM-4497's re-verify cron exists.

Signature contract verified against a real delivery (`integrations/computeid/__fixtures__/golden-test-delivery.json`): `X-ComputeID-Signature: sha256=<hex HMAC-SHA256(secret, raw body)>`, no timestamp header. The `sha256=` prefix is required; a bare hex digest is rejected. Body cap 64 KiB, checked before signature verification. The partner-supplied free-text `reason` is never logged, never written to `audit_events.details`, never written to the DLQ — `computeid.test.ts` pins that with a serialized-args assertion.

## 2026-09-13 — `docusign.test.ts`: PR #2485's comments re-landed onto the already-present max-cardinality test (SCRUM-3843)

PR #2485 ("DocuSign rule-event payload 16KB CHECK overflow at max cardinality", bilateral Finding 7)
closed unmerged. Checked before redoing the work: the SUBSTANTIVE fix (`document_ids` moved off the
capped `organization_rule_events.payload` onto the uncapped job payload — `docusign.ts` around
`_signers`/`document_hashes` construction and the `submitJob` call) and the full 100-document /
20-signer max-cardinality test asserting it were already on `main`, landed independently of #2485.
The ONLY thing #2485 carried that `main` did not was two explanatory comments on the existing
`expect()` calls (`gh pr diff 2485` — 24 lines, comments only, zero new assertions). Those two
comments are now applied verbatim. No behavior changed; the invariant (rule-event payload
`pg_column_size <= 16384` at 100 docs / 20 signers, `document_ids` absent from that payload,
`document_hashes` and `document_ids` both present at full cardinality on the two uncapped
surfaces) was already pinned and stays pinned.

_Last updated: 2026-08-30 (`adobe-sign.ts`: registration challenge + DLQ the orphaned-webhook_id path)_

## 2026-08-30 — `adobe-sign.ts` now answers Adobe's webhook REGISTRATION challenge (`GET /`)

**This is why `org_integrations.webhook_id` was never populated anywhere — the column being
missing (migration `0426`) was the second problem, not the first.** Adobe will not create a
webhook until the target URL answers a registration challenge: an HTTPS GET carrying
`X-AdobeSign-ClientId`, which must return 2XX **and** echo the same client id back in a response
header of that name ([Adobe docs](https://helpx.adobe.com/sign/developer/webhook/create.html)).
This router had **only** `.post('/')` — verified by test: all four new challenge cases returned
`404` before the fix. So `POST /api/rest/v6/webhooks` would have failed Adobe-side, and manual
registration through Adobe's admin console would have failed too. No webhook id could be minted
by any route, which is the upstream cause of the always-null `webhook_id`.

**Security shape — do not "simplify" this into a blind echo.** Adobe's guidance is explicit that
an endpoint which does not recognize the presented client id "MUST NOT respond with the success
response." Blindly echoing whatever arrives would let any third party register *our* endpoint
against *their* Adobe application and start delivering us their agreements. So: `503` when
`ADOBE_SIGN_CLIENT_ID` is unset (never echo an unconfigured value), `403` on absent/mismatched id,
`200` + echo only on a constant-time match. The presented value is never logged — it identifies a
third party's Adobe app. Tests: `describe('GET /webhooks/adobe-sign — Adobe registration
challenge')` pins all four cases.

**Still not sufficient for a working connector.** This makes a webhook id *obtainable*; nothing
yet *obtains* one. See the entry below — there is still no `adobe-sign-oauth.ts` connect flow, and
prod has no Adobe credential at all.

**Related pre-existing oddity, deliberately left alone:** `signatureHeader()` falls back to
`X-AdobeSign-ClientId` as a *signature* when the SHA256 header is absent. On a notification that
header carries the client id, not an HMAC, so the fallback always fails the HMAC compare and 401s
— fail-closed, not exploitable. Do not "fix" it by comparing the client id instead: that would
turn a public identifier into the auth check and is a straight auth bypass.

## 2026-08-30 — `adobe-sign.ts` orphaned-webhook_id path now DLQs (companion to migration `0426`)

Migration `0426` (PR #2519) adds `org_integrations.webhook_id`, fixing the `42703` SQL error
`findIntegration()` has always hit. **That alone does not restore Adobe Sign functionality**: no
`adobe-sign-oauth.ts` connect flow exists anywhere in this repo (unlike `docusign-oauth.ts` /
`drive-oauth.ts` in `api/v1/integrations/`), so nothing writes `org_integrations.webhook_id` for a
real integration. Every real delivery therefore still hits the `if (!integration)` branch — same
as before the migration, just without the SQL error. Before `0426`, that branch's SQL error was
caught and DLQ'd (a record existed); after `0426`, the same branch resolves cleanly to `null` and
was responding `200 {orphaned:true}` with **no DLQ insert at all** — a silent regression from "loud
failure, recorded" to "quiet failure, unrecorded." Per the "webhook_dlq row is not a mitigation"
note two sections below: this is explicitly not a fix for the underlying gap (Adobe Sign is still
non-functional until a connect flow lands), it only restores the pre-existing record-of-loss this
folder already treats as the baseline expectation for every handler. Test:
`describe('POST /webhooks/adobe-sign')` → `'orphaned webhook_id is recorded to the DLQ, not
silently dropped'` in `adobe-sign.test.ts`. **A real fix still needs its own ticket**: an Adobe
Sign OAuth/connect flow that populates `webhook_id` at integration-connect time.
## 2026-09-05 — oldest DocuSign release candidate integration

PRs #2472/#2474/#2476 are tested together. The shared artifact materializer requires an explicit fingerprint evidence class: fetched outbound documents use `document_bytes`; inbound declared fingerprints use `issuer_record_attestation`. Combined tests retain signer capture, inbound flag control, both insert classifications, and rejection of missing classifications. This integration is staging preparation, not production or completed soak evidence.

_Last updated: 2026-08-29 (docusign-bilateral PR-2: outbound signer capture)_

## 2026-08-29 — CTO Decision Record (docusign-bilateral-2026-08, PR-2): outbound signer capture (R6/R7)

`docusign.ts` gained `extractSigners(rawBody)` — mirrors `extractNotaryData`'s raw-body access pattern (`envelopeSummary ?? data ?? root`, then `recipients.signers[]`; deliberately does NOT read `recipients.carbonCopies[]`, matching `findNotaryRecipient`), then hands the raw `signers[]` array to the shared `captureDocusignSigners` mapper (`integrations/connectors/schemas.ts`, factored out 2026-08-31 so this file and the signer-backfill job's `extractCapturedSigners` (`integrations/oauth/docusign.ts`) can't drift). Produces `_signers`: an array (capped at `MAX_CAPTURED_DOCUSIGN_SIGNERS` = 20, truncates rather than rejecting the envelope) of `{recipient_id_guid, user_id?, status, signed_at?}` — **pseudonymous GUIDs only, never name/email**. Two independent strip gates, both inside the shared mapper: it only ever copies four named fields into a fresh literal (never spreads the raw recipient), and `DocusignCapturedSigner` (`integrations/connectors/schemas.ts`) is a non-`.passthrough()` Zod object that strips any other key by construction. A third gate lives in `jobs/docusign-envelope-completed.ts` at the actual DB-write boundary (see that folder's agents.md).

`_signers` is threaded into the `docusign.envelope_completed` job payload (`enqueueFetchJob`) but is deliberately **kept OFF** `enqueue_rule_event`'s `p_payload` — `organization_rule_events.payload` has a DB CHECK `pg_column_size(payload) <= 16384`, and at the schema's max cardinality (100 `envelopeDocuments`) `document_ids`/`document_hashes` alone already sit close to that ceiling (measured: ~7.5KB at 100 realistic-length document ids). `_signers` only rides the job → `connector_artifact.metadata` → `anchors.metadata` path, which has no size cap. See `jobs/agents.md` for the metadata-side half and the `_docusign_env` companion field.

This is the outbound (own-account envelope-completed) path only. Inbound (Recipient Connect / received envelopes) is a separate, later, flag-OFF PR (F1 in the CTO Decision Record) — not touched here.
_Last updated: 2026-08-30 (docusign-bilateral-2026-08 feasibility spike: inbound/Recipient Connect classification, flag-off)_

## 2026-08-30 — CTO Decision Record (docusign-bilateral-2026-08): inbound (Recipient Connect) classification + declared-hash anchoring — flag OFF, not going live this cycle

`docusign.ts` gained a SECOND webhook direction. Until now every `envelope-completed` delivery was implicitly OUTBOUND (an envelope the resolving org's own connected DocuSign account sent). This PR adds INBOUND: an envelope a DIFFERENT DocuSign account owns, where the resolving org is a recipient. Gated end-to-end by `ENABLE_DOCUSIGN_INBOUND` (default false; config.ts cross-validation requires `ENABLE_DOCUSIGN_WEBHOOK` + `ENABLE_CONNECTOR_ARTIFACT_ENQUEUE` + `ENABLE_CONNECTOR_ARTIFACT_DRAIN` all on too, mirroring the existing `enableDocusignQueueReconciliation` guard).

**Threat model this exists to close:** the DocuSign Connect HMAC key is customer-side console state — every connected org holds a valid key for its OWN deliveries. A declared-hash inbound path that skipped re-verification would let any connected org self-POST a self-signed "inbound" event about someone else's envelope and anchor a forged provenance record. Mitigation: `classifyDirection()` runs AFTER HMAC + integration resolution (unchanged) and decides outbound-vs-inbound from SERVER-STORED state only — the envelope's declared owning account (`event.senderAccountId ?? event.accountId`, new optional field, see `integrations/oauth/docusign.ts` / `integrations/connectors/schemas.ts`) compared against the resolving org's OWN connected-account set (`org_integrations` UNION `member_integrations`). The `?customrecipient` query marker is read for logging ONLY — it can never upgrade an envelope to outbound trust; a fast path (`sendingAccountId === integration.account_id`, true for every payload shape that predates this PR) skips the extra DB round-trip entirely, which is what keeps the existing outbound flow reaching the database exactly as many times as before (byte-for-byte backward-compat, tested explicitly).

**Inbound + flag ON** bypasses the OUTBOUND fetch-job pathway (`docusign-envelope-completed.ts` → `fetchDocusignCombinedDocument`) entirely — it NEVER calls a DocuSign document-fetch API for a foreign-owned envelope. Instead it takes the DocuSign-DECLARED per-document `sha256` (single-document only in this v1; multi/zero-hash envelopes orphan-drop, a documented scope limit, not a silent gap) and enqueues a `connector_artifact` row directly via the same `enqueue_connector_artifact` RPC (migration 0343) the outbound job uses, with `_direction: 'inbound'` / `_sending_account_id` metadata (underscore-prefixed, in the write-authority guard's key family from PR #2472). `connector-artifact-drain.ts`'s `defaultMaterializeAnchor` reads that marker and sets `anchors.fingerprint_source = 'issuer_record_attestation'` (migration 0376 CHECK enum) on the resulting anchor — never `document_bytes`, since no fetch ever happened. `constants/connectorFingerprint.ts` gained a new additive `FINGERPRINT_REDERIVABILITY.DECLARED_UNVERIFIED` class (keyed off that same `fingerprint_source` value at emission, see `api/v1/verify.ts`) so the public verify response never overclaims a measurement Arkova never took (§1.5 / R-7).

**Inbound + flag OFF** acknowledges HTTP 200 with NO nonce consumed and NO durable write — avoids DocuSign retry storms on a path this deploy can't process, and preserves recoverability (a later flip-on + DocuSign resend is what actually anchors it; consuming the nonce now would permanently discard it).

**R5 observability:** a DISTINCT inbound-orphan-drop structured-log signal (`docusign_inbound_orphan_drop: true`) fires when flag-ON inbound processing cannot materialize an artifact (no usable single declared hash, including the fail-safe case where the own-account lookup itself errors) — separate from the pre-existing, deliberately silent unknown-integration orphan path. `pathScopedKillSwitch` cannot gate inbound alone (both directions share the one mounted `/webhooks/docusign` path), so the flag check is inlined post-classification instead.

**Migration 0424** tenant-scopes `docusign_webhook_nonces`' uniqueness key by adding `account_id` (resolved before every nonce write, both directions) — a cross-tenant nonce collision the inbound path widens from theoretical to real (two different accounts can legitimately deliver the same vendor-declared `(envelope_id, event_id, generated_at)` tuple).

**Own bucket:** `/webhooks/docusign` no longer shares `rateLimiters.stripeWebhook`'s global 100/min key — see `utils/agents.md` (or `rateLimit.ts`'s own doc comment) for `rateLimiters.docusignWebhook`.

TLA: `machines/docusignInboundDedup.machine.ts` models the dedup invariant (at most one anchored connector_artifact per envelope under concurrent outbound+inbound delivery) that `findExistingEnvelopeAnchor` (`jobs/docusign-anchor-reconciliation.ts`) and the migration-0343 unique index jointly implement.
_Last updated: 2026-08-23 (SCRUM-3479: Checkr + ATS nonce release on post-nonce 5xx)_
_Last updated: 2026-08-30 (DocuSign bilateral Finding 7: rule-event payload 16KB CHECK guard)_

## 2026-08-30 — DocuSign bilateral 2026-08 (Finding 7): `docusign.ts` rule-event payload now records `document_count`, not the unbounded `document_ids` array

`organization_rule_events.payload` carries a hard DB CHECK from the baseline migration (`organization_rule_events_payload_size`): **`pg_column_size(payload) <= 16384`**. `enqueueRuleEvent` builds that payload from EVERY envelope document, and it wrote `document_ids: envelopeDocuments.map(d => d.documentId)` — an array whose size scales with document count × documentId length. At the schema-permitted maximum (`DocusignEnvelopeCompleted.envelopeDocuments` is `.max(100)`; `documentId` is `.max(100)` at the Connect raw-parse gate and `.max(500)` in the completed-envelope schema), that array alone pushed the payload **over 16KB** — measured at ~17.5KB for 100 documents with 100-char ids (conservative jsonb model; the empirical figure in the decision record is ~17.1–17.3KB).

**Why that was a live availability gap, not a hypothetical.** On overflow the `enqueue_rule_event` RPC raises a `check_violation`, `enqueueRuleEvent` throws `rule_event_enqueue_failed`, the handler's catch rolls the nonce back and returns 500, and DocuSign retries the identical payload — which fails identically, forever. That envelope's `ESIGN_COMPLETED` event and everything downstream (document fetch, notarization, anchor) never succeed. Nothing in the schema prevents the documentId lengths that trigger it.

**Fix (own scoped change — NOT introduced by the signer-capture PR).** `buildDocusignRuleEventPayload()` (now an exported pure function, so the payload shape is unit-testable in isolation) replaces `document_ids` with `document_count` — a fixed-size integer. Post-fix the payload is ~7.1KB at 100 unique documents and is **invariant to documentId length**. This was safe to remove because `document_ids` is **write-only on this payload**: the rules engine's `sanitizeExecutionProviderPayload` allowlist (`jobs/rules-engine.ts`) and the action dispatcher (`jobs/rule-action-dispatcher.ts`) read only `document_hashes` / `document_sha256`; the fetch job (`jobs/docusign-envelope-completed.ts`) never references it; `docusign-queue-reconciliation-deps.ts` rebuilds its re-drive job with `document_ids: []`; and `proof-packet.ts` forwards the whole payload but no consumer/test depends on the key. The **uncapped** `job_queue` fetch payload (`enqueueFetchJob`) keeps `document_ids` unchanged — `MaterializeJobPayloadSchema` still expects it there. `document_hashes` stays on the rule-event payload (≤100 unique 64-char digests ≈ 6.9KB, comfortably bounded).

**Tests:** `describe('rule-event payload 16KB guard (DocuSign Finding 7)')` in `docusign.test.ts` — a `jsonbColumnSize()` helper models `pg_column_size(jsonb)` as a conservative UPPER bound (so `model ≤ 16384 ⟹ DB CHECK passes`), and three cases pin: 100 docs × 100-char ids through the real webhook ingress stays under budget (this fails on the pre-fix code at ~17.5KB), the payload carries `document_count` and no longer has a `document_ids` property, and the extracted builder holds at the outer `.max(500)` documentId bound the ingress gate cannot even reach today.

**Parallel latent risk, NOT fixed here — `adobe-sign.ts` (line ~98).** It builds the same `document_ids: args.event.documents.map(d => d.id)` onto its own rule-event payload, which hits the identical 16KB CHECK. Deliberately left to its own ticket + soak rather than widening this DocuSign-scoped change to a second handler. (This is a distinct defect from the SCRUM-3479 adobe nonce-release gap already tracked below.)
## 2026-09-05 — PR #2496: Adobe integration lookup matches the schema

Adobe webhook registrations resolve through `org_integrations.subscription_id` with `provider = 'adobe_sign'` and `revoked_at IS NULL`. The previously queried `webhook_id` column never existed on this table; it belongs to the nonce/DLQ tables. The lookup now uses the generated database types rather than an `any` cast, selects only the identity fields it needs, and fails closed on ambiguous registrations. Register the vendor webhook ID in `subscription_id`; no schema migration is needed. The bounded payload and retry-compensation changes retain their targeted coverage.

_Last updated: 2026-09-02 (Adobe Sign Finding 7: rule-event payload 16KB CHECK guard + input/constraint parity + AUDIT-0424-10 nonce release — parallel to DocuSign PR #2485)_

## 2026-08-30 — Adobe Sign bilateral 2026-08 (Finding 7): `adobe-sign.ts` rule-event payload now records `document_count`, not the unbounded `document_ids` array — FIXED

`organization_rule_events.payload` carries a hard DB CHECK from the baseline migration (`organization_rule_events_payload_size`): **`pg_column_size(payload) <= 16384`**. `enqueueRuleEvent` built that payload from EVERY agreement document and wrote `document_ids: args.event.documents.map(d => d.id)` — an array whose size scales with document count × id length. Adobe's `documents` array is `.max(100)` and each document `id` is `z.string().trim().min(1)` with **NO `.max()` length cap** (`integrations/oauth/adobe-sign.ts`), so this was *less* bounded than the DocuSign case (which at least had a 100-char documentId gate): at 100 documents with 500-char ids the built payload measured **~50KB** (conservative jsonb model — 50,647 bytes in the guard test), far over the 16KB budget.

**Why it was a live availability gap, not a hypothetical — and the failure mode is worse than "retries forever."** On overflow the `enqueue_rule_event` RPC raises a `check_violation`, `enqueueRuleEvent` throws `rule_event_enqueue_failed`, the handler's catch writes a `webhook_dlq` row and returns 500. The event is then **lost after ONE retry, not retried forever**: the nonce row was committed *before* the enqueue, so Adobe's retry carries the identical body, hashes to the identical `payload_hash`, hits the `(agreement_id, payload_hash)` UNIQUE violation and is answered `200 {duplicate:true}` — the `ESIGN_COMPLETED` event is dropped **and the vendor is told it succeeded**. That is why this PR also lands the nonce release below. Nothing in the schema prevents the id lengths that trigger it, and the DLQ row is a record of loss, not a recovery path (nobody drains `webhook_dlq`).

**Fix (own scoped change; T2, no migration).** `buildAdobeSignRuleEventPayload()` (now an exported pure function, so the payload shape is unit-testable in isolation) replaces `document_ids` with `document_count` — a fixed-size integer. Post-fix the payload is a few hundred bytes and **invariant to document-id length**. Safe to drop `document_ids` because it was **write-only on this payload**: the rules engine's `sanitizeExecutionProviderPayload` allowlist (`jobs/rules-engine.ts`) and the action dispatcher (`jobs/rule-action-dispatcher.ts`) read only `document_hashes` / `document_sha256` (which this handler never even set), and there is **no Adobe fetch/materialization job** that references it — verified: `ls services/worker/src/jobs | grep -i adobe` → none; `grep -rn document_ids services/worker/src` → only the two DocuSign paths plus this one line. If a per-document-id consumer is ever added, carry the ids on the UNCAPPED `job_queue` payload of that job, never back onto this capped payload.

**Tests:** `describe('rule-event payload 16KB guard (Adobe Sign Finding 7)')` in `adobe-sign.test.ts` — a `jsonbColumnSize()` helper models `pg_column_size(jsonb)` as a conservative UPPER bound (so `model ≤ limit ⟹ DB CHECK passes`), and three cases pin: 100 docs × 500-char ids through the real webhook ingress stays under budget (this fails on the pre-fix code at ~50KB), the payload carries `document_count` and no longer has a `document_ids` property, and the extracted builder holds under budget even at 100 × 2000-char ids (proving id-length invariance beyond anything ingress can reach). `describe('code/constraint parity: ...')` pins the length bounds at the exact boundary (N accepted, N+1 → 400 + DLQ, never a 5xx) and that the oversize value never reaches the DLQ `reason`. `describe('AUDIT-0424-10: ...')` pins the nonce release, the no-release-on-success case, and the two never-delete-an-uncommitted-nonce cases.

**Every bound in these tests is READ FROM `supabase/migrations/`, never hardcoded** (`effectiveCheckMaxima`, one pass over the migration set, with an anchor test that fails if the regex stops matching). A literal `16384` in the test would keep passing if a later migration narrowed the CHECK, while production started raising 23514 — the exact drift the `middesk.ts` status/constraint parity test exists to prevent. Mocked-DB unit tests cannot see a constraint; asserting against the migration set is how you get parity coverage without one.

**Bounding `document_ids` was only half the enqueue (review addition, 2026-09-02).** The SAME `enqueue_rule_event` INSERT carries `agreement.id` (into `payload.agreement_id` *and* `external_file_id`, CHECK `<= 500`) and `senderInfo.email` (into `sender_email`, CHECK `<= 320`), and `RawAdobeWebhookPayload` capped **neither**. The two then failed differently, and the difference is the lesson:

* `agreement.id` *was* rejected — late and in the wrong place. `NonEmptyString` in `connectors/schemas.ts` is `.max(500)`, so `adaptAdobeSign` throws — but that throw is **inside `enqueueRuleEvent`, after the replay nonce is committed**, so the handler DLQs and returns **500**, and Adobe's retry is answered `200 {duplicate:true}`. A value we always intended to reject cost us the event and told the vendor it succeeded. It also meant this payload's size bound was **incidental** — a consequence of where something happened to throw, not a stated invariant.
* `senderInfo.email` was not bounded anywhere. `MaybeEmail` is `z.string().trim().toLowerCase().email()` with **no length cap**, so a >320-char address passes both parse layers, reaches Postgres, and raises **SQLSTATE 23514** inside the RPC — same 500, same swallowed retry, same silent loss. This one was live.

Both are now `.max()`-bounded in `integrations/oauth/adobe-sign.ts` to the exact constraint values, which moves the rejection **before the nonce insert** and into the handler's existing bounded **400 + DLQ-audit** branch. Same principle as the `middesk.ts` status/CHECK parity rule below, applied to lengths: **whatever the parse layer admits, the row must be able to store — and it must say so where the input enters, not wherever a downstream throw happens to land.**

**NOT fixed here — `MaybeEmail` is shared.** The DocuSign (`sender.email`) and Checkr (`candidate.email`) adapters feed the same unbounded address into the same 320-char `sender_email` column, so both handlers retain this defect. Bounding `MaybeEmail` itself is the real fix and is one line, but it changes three handlers' ingress behaviour at once — it needs its own ticket and a soak that covers all three, not a quiet widening of this one.

**AUDIT-0424-10 nonce release, now landed for `adobe-sign.ts` (review addition, 2026-09-02).** SCRUM-3479 fixed `checkr.ts` + `ats.ts` and explicitly deferred this handler ("Third instance, NOT fixed here", below). It is fixed here because it is *this handler's own* availability ticket and the same T2 soak covers it — deferring it again would mean paying a second 12h soak on the same file to make the failure mode this PR documents actually true. `releaseNonce` mirrors `checkr.ts` exactly: armed only by a nonce THIS delivery committed (`nonceCommitted`), filters on BOTH columns of the `(agreement_id, payload_hash)` UNIQUE key, best-effort and swallows its own throw, never called on the success path. The same at-least-once residual risk stated in the SCRUM-3479 entry applies verbatim. **Cleanly separable** if a reviewer wants it split: the `releaseNonce` block + its two call-site lines + `describe('AUDIT-0424-10: ...')`.

**Precedent + merge note.** Mirrors the DocuSign Finding 7 fix (**PR #2485**, `fix/docusign-rule-event-payload-16kb`), which fixed `docusign.ts` and explicitly flagged this Adobe handler as the parallel latent risk left to its own ticket + soak. Both PRs add a `## 2026-08-30 … Finding 7` section here and the same "keep every rule-event payload bounded" rule below; if they land on different days, resolve the overlap as a **doc-only union (no re-soak)**. Note for whoever lands #2485: `docusign.ts` has the SAME unbounded-input parity gap — `envelopeId` / `accountId` / recipient email flow into the same length-CHECKed columns — and the two builders are now near-identical, so a shared `buildRuleEventPayload` helper is worth considering once both have soaked (deliberately NOT done here: it would drag `docusign.ts` into this PR's soak).

## 2026-08-23 — SCRUM-3479 (AUDIT-0424-10): `checkr.ts` and `ats.ts` now release the replay nonce on post-nonce 5xx

Both handlers committed their replay nonce BEFORE the downstream write and never compensated it, so the "DO release the nonce before returning any post-nonce 5xx" rule below was documented but unenforced in two of the four nonce-using handlers. `middesk.ts` was the only correct implementation.

**`checkr.ts`** was the live defect: the `checkr_webhook_nonces` insert ran before `enqueue_rule_event`, and the enqueue-failure branch returned `500` without deleting it. One transient Postgres blip therefore dropped a `report.completed` **permanently** — Checkr's retry hit the `(report_id, payload_hash)` UNIQUE violation and got `200 {duplicate:true}`, so the background check was lost *and* the vendor was told it succeeded. Both post-nonce 5xx paths (enqueue failure + the catch-all) now call `releaseNonce`.

**`ats.ts`** carried the same defect on its catch-all path: the nonce is committed before the attestation lookup, so a throw there permanently lost the verification response the webhook exists to produce.

**The `webhook_dlq` row is not a mitigation.** Nothing under `services/worker/src/jobs/` reads that table — `webhook_dlq` is written by three handlers (`checkr.ts`, `docusign.ts`, `adobe-sign.ts` — verified with `grep -rn "from('webhook_dlq')" services/worker/src`) and drained by nobody. Treat a DLQ insert as a record of the loss, never as a recovery path, and do not let its presence justify skipping the nonce release.

**Residual risk you are accepting when you copy this (review addition).** The release is an at-least-once trade, not a free win. If the downstream call *throws* after Postgres committed it, "did it happen" is unknowable, and releasing the nonce lets the retry enqueue a second time. Nothing de-dupes that: `enqueue_rule_event` is a bare INSERT with no `ON CONFLICT`, and the executions idempotency index is `UNIQUE(rule_id, trigger_event_id)` where `trigger_event_id` is the per-enqueue rule-event id — two enqueues are two distinct keys, not one. A rare duplicate execution is the right trade against guaranteed silent loss, but state it rather than implying the delete is consequence-free. Closing the window properly needs an idempotency key threaded into `enqueue_rule_event`; that is a separate change.

**Guard that matters when copying this pattern:** release ONLY a nonce the current delivery actually committed (`checkr.ts` uses a `nonceCommitted` flag, `ats.ts` a `committedNonce` claim object). Both handlers wrap work that runs *before* the insert in the same `try`, and `checkr.ts` additionally fails open on a non-23505 insert error — in those cases a row matching the key belongs to an EARLIER delivery, and deleting it would silently re-open that delivery to replay. Filter on every column of the UNIQUE key for the same reason (`checkr`: `report_id` + `payload_hash`; `ats`: `provider` + `integration_id` + `signature`). The release is best-effort and swallows its own throw so it can never mask the original failure. Tests: `describe('SCRUM-3479: ...')` in `checkr.test.ts` and `ats.test.ts` pin the release, the no-release-on-success case, and the never-delete-an-uncommitted-nonce case.

**Third instance, deferred here — `adobe-sign.ts` (verified by review). RESOLVED 2026-09-02 in the Finding 7 PR above.** It had the same defect: the `adobe_sign_webhook_nonces` insert runs before `enqueueRuleEvent`, and the catch-all returned `500` with no release, so a transient failure permanently dropped the agreement event behind a `200 {duplicate:true}`. Its UNIQUE key is `(agreement_id, payload_hash)`, so the release filters on both. It was deliberately left out of *this* change rather than silently widening a T2 package to a third handler; it landed with its own ticket and its own soak, in the Adobe handler's Finding 7 PR. **All four nonce-using handlers now release.**

**Known gap, NOT fixed here (needs a migration, so it is out of this change's tier):** `checkr_webhook_nonces` and `kyb_webhook_nonces` are absent from both `jobs/nonce-sweep.ts`'s `NONCE_TABLES` and the `sweep_webhook_nonces` RPC allowlist in migration `0316`. Both table comments promise a 14-day sweep that never runs, so their rows accumulate forever. Adding the table name to `NONCE_TABLES` alone would fail at runtime — the RPC raises `table "%" not in allowlist` — so this needs a compensating migration alongside the code change.

## 2026-08-03 — GH #1836 (SECURITY, pen-test scope): legacy org-id Drive channel token — accept-with-warning by default, code-flagged hard cutoff available

`drive.ts` already did the correct thing on the auth side: constant-time compare `X-Goog-Channel-Token` against the STORED token (never the org id directly), fail-closed 401 on mismatch or missing-stored-token. The vulnerability was upstream — that stored value USED TO BE the org's own UUID (fixed in `api/v1/integrations/agents.md`'s GH #1836 entry) — not a flaw in this comparison itself.

Added: when `lookup.channel_token === lookup.org_id` (the row is definitionally still on the pre-fix scheme — a real random token would essentially never collide with the org's own UUID), the webhook by default still ACCEPTS the request (backward compat is required — existing channels must keep delivering until GH #1835's renewal sweep rotates them to a real secret) but logs a bounded `logger.warn` naming the channel/org so ops can track deprecation progress. **Never logs the token value itself** — the check compares the ALREADY-VERIFIED stored token against the org id, no secret material touches the log line. Tests: `drive.test.ts` `describe('GH #1836: legacy org-id channel-token deprecation window')` — asserts the warning fires for a legacy token and does NOT fire for a modern random one, and that `"channel_token"` never appears in any `logger.warn` call's serialized arguments.

**Round-3 correction: the 7-day Drive channel expiry does NOT bound this vulnerability.** This check authenticates against the STORED token only — it never asks Google whether the channel is still live — so a forged POST carrying a known/guessed org UUID keeps authenticating regardless of Drive-side expiry, indefinitely, if the renewal cron is never deployed. See `api/v1/integrations/agents.md`'s corrected "Live-window honesty" note for the full writeup.

**Backstop**: `config.enableDriveLegacyChannelTokenRejection` (default off). When true, the branch above REJECTS (401 `legacy_channel_token_rejected`) instead of accept-and-warn — a hard cutoff for the case where the renewal cron was never deployed and legacy-token exposure would otherwise persist indefinitely. Tests: `describe('enableDriveLegacyChannelTokenRejection backstop (default OFF)')` — rejects when on, still accepts a MODERN random token when on (only the legacy scheme is cut off), and confirms default-off behavior is unchanged.

**Parser convergence**: `resolveDriveChannel`'s `account_label` parse now routes through the canonical `parseDriveAccountLabel()` (`integrations/connectors/drive-account-label.ts`) instead of its own inline `JSON.parse` — see that file's doc comment for the other 3 sites it replaced.

## What This Folder Contains

Inbound webhook handlers for third-party integrations. Each handler verifies HMAC signatures, normalizes payloads via canonical adapters, and enqueues sanitized events for the rules engine. Raw payloads are never persisted.

| File | Purpose |
|------|---------|
| `adobe-sign.ts` | Adobe Sign `AGREEMENT_WORKFLOW_COMPLETED` handler — HMAC-SHA256 base64, `adaptAdobeSign` normalization |
| `docusign.ts` | DocuSign Connect `envelope-completed` handler — lookup-first HMAC verify (SCRUM-2043), HMAC verified for unknown accounts too (env-var key), dual-table lookup: org_integrations then member_integrations (SCRUM-2044), sanitized event + document-fetch job + SCRUM-1872 notarization detection. SCRUM-1649: carries single-document SHA-256 into rule-event payloads via `document_hashes` / `document_sha256` for downstream post-signing anchor materialization. SCRUM-2362 (DS-02): invalid sig → 401 fail-closed; duplicate signed event → 200 with no duplicate queue materialization (nonce table); orphan → 200 bounded + DLQ-audited; raw-payload PII (sender/notary email, doc fingerprint) never reaches logger/Sentry/Error — pinned by the `no raw-payload PII leak` test suite. **2026-08-29 (R6):** `extractSigners()` captures pseudonymous `_signers` GUIDs (capped 20, never name/email) into the `docusign.envelope_completed` job payload only — kept off the size-capped rule-event payload, see the dated entry above |
| `docusign.ts` | DocuSign Connect `envelope-completed` handler — lookup-first HMAC verify (SCRUM-2043), HMAC verified for unknown accounts too (env-var key), dual-table lookup: org_integrations then member_integrations (SCRUM-2044), sanitized event + document-fetch job + SCRUM-1872 notarization detection. SCRUM-1649: carries single-document SHA-256 into rule-event payloads via `document_hashes` / `document_sha256` for downstream post-signing anchor materialization. SCRUM-2362 (DS-02): invalid sig → 401 fail-closed; duplicate signed event → 200 with no duplicate queue materialization (nonce table); orphan → 200 bounded + DLQ-audited; raw-payload PII (sender/notary email, doc fingerprint) never reaches logger/Sentry/Error — pinned by the `no raw-payload PII leak` test suite. **2026-08-30:** `classifyDirection()` (R4) routes outbound (unchanged) vs inbound/Recipient Connect — see the dated entry above; flag `ENABLE_DOCUSIGN_INBOUND` default off |
| `docusign.ts` | DocuSign Connect `envelope-completed` handler — lookup-first HMAC verify (SCRUM-2043), HMAC verified for unknown accounts too (env-var key), dual-table lookup: org_integrations then member_integrations (SCRUM-2044), sanitized event + document-fetch job + SCRUM-1872 notarization detection. SCRUM-1649: carries single-document SHA-256 into rule-event payloads via `document_hashes` / `document_sha256` for downstream post-signing anchor materialization. DocuSign bilateral Finding 7: the rule-event payload records `document_count` (not the unbounded `document_ids` array) so it stays under the `organization_rule_events` 16KB `pg_column_size` CHECK at max cardinality — shape built by the exported `buildDocusignRuleEventPayload`. SCRUM-2362 (DS-02): invalid sig → 401 fail-closed; duplicate signed event → 200 with no duplicate queue materialization (nonce table); orphan → 200 bounded + DLQ-audited; raw-payload PII (sender/notary email, doc fingerprint) never reaches logger/Sentry/Error — pinned by the `no raw-payload PII leak` test suite |
| `adobe-sign.ts` | Adobe Sign `AGREEMENT_WORKFLOW_COMPLETED` handler — HMAC-SHA256 base64, `adaptAdobeSign` normalization. Finding 7: the rule-event payload records `document_count` (not the unbounded `document_ids` array) so it stays under the `organization_rule_events` 16KB `pg_column_size` CHECK at max cardinality — shape built by the exported `buildAdobeSignRuleEventPayload`; `agreement.id` / `senderInfo.email` are `.max()`-bounded in `integrations/oauth/adobe-sign.ts` to the `external_file_id` (500) / `sender_email` (320) CHECKs so an oversize value is a 400, not a 23514. AUDIT-0424-10: releases the `(agreement_id, payload_hash)` nonce on every post-nonce 5xx |
| `docusign.ts` | DocuSign Connect `envelope-completed` handler — lookup-first HMAC verify (SCRUM-2043), HMAC verified for unknown accounts too (env-var key), dual-table lookup: org_integrations then member_integrations (SCRUM-2044), sanitized event + document-fetch job + SCRUM-1872 notarization detection. SCRUM-1649: carries single-document SHA-256 into rule-event payloads via `document_hashes` / `document_sha256` for downstream post-signing anchor materialization. SCRUM-2362 (DS-02): invalid sig → 401 fail-closed; duplicate signed event → 200 with no duplicate queue materialization (nonce table); orphan → 200 bounded + DLQ-audited; raw-payload PII (sender/notary email, doc fingerprint) never reaches logger/Sentry/Error — pinned by the `no raw-payload PII leak` test suite |
| `docusign-hmac-helpers.ts` | SCRUM-2043: resolves HMAC keys from per-org `hmac_keys` JSONB or env-var fallback |
| `docusign-hmac-rotation.test.ts` | Tests for multi-key HMAC verification flow and key resolution |
| `drive.ts` | Google Drive push notification handler — headers-only signal, channel-token verification |
| `ats.ts` | ATS webhook handler (Greenhouse, Lever) — HMAC verify, attestation verification response. SCRUM-3479: releases the nonce on the catch-all 5xx path |
| `computeid.ts` | ComputeID AgentPassport `passport.revoked` / `.suspended` / `.reinstated` receiver — HMAC-SHA256 hex with `sha256=` prefix, comma-separated secrets for rotation, ordering floor instead of a nonce table (SCRUM-4493), keys deactivated BEFORE the row flips (suspend and revoke), compare-and-set on the agent row (409 on a lost race), ownership-aware reinstate, DLQ on orphan/failure. Gated by `ENABLE_COMPUTEID_INTEGRATION` via `computeidGate` |
| `checkr.ts` | Checkr `report.completed` handler — HMAC-SHA256 hex, nonce replay protection, DLQ on failure. SCRUM-3479: releases the nonce on both post-nonce 5xx paths so a transient enqueue failure stays retryable |
| `middesk.ts` | Middesk KYB handler — `business.updated/verified/rejected` events, org verification status transitions |
| `microsoft-graph.ts` | Microsoft Graph change-notifications — `clientState` verification, validation handshake echo |
| `veremark.ts` | Veremark stub — gated behind `ENABLE_VEREMARK_WEBHOOK`, returns 503 until vendor docs confirmed |

## Do / Don't Rules

- **DO** verify HMAC signatures before processing any webhook payload
- **DO** use nonce/idempotency tables to prevent replay attacks
- **DO** release the nonce before returning any post-nonce 5xx (AUDIT-0424-10). The nonce is committed before the downstream writes, so an un-compensated failure is unrecoverable, not retryable: the provider re-presents the same event id, hits the UNIQUE violation, and is answered `200 {duplicate:true}` — the event is dropped *and* the provider is told it succeeded. `middesk.ts::releaseNonce` is the reference implementation (mirrors the `webhook_event_claims` compensating delete in `stripe/handlers.ts`). Never release on the success path.
- **DO** keep the set of status literals a handler writes in parity with the DB CHECK constraint that admits them. `middesk.ts` wrote `'REJECTED'`/`'REQUIRES_INPUT'` into `organizations.verification_status` for months while the constraint admitted only `UNVERIFIED/PENDING/VERIFIED`, so every KYB rejection raised SQLSTATE 23514 and was silently lost. Mocked-DB unit tests cannot catch this — `middesk.test.ts` carries a parity test that reads the migration set directly.
- **DO** keep every rule-event payload bounded — `organization_rule_events.payload` has a hard `pg_column_size(payload) <= 16384` CHECK. Never put a field on it whose size scales with attacker- or vendor-controlled cardinality/length (per-document id arrays, recipient lists, raw metadata). An overflow is a `check_violation` at enqueue time → 500 → provider retries the identical failing payload forever → the event and its whole downstream chain are lost. Record a `_count` instead of the array, or move the unbounded data onto the UNCAPPED `job_queue` payload. See the DocuSign Finding 7 entry above. `adobe-sign.ts` still carries this latent risk (`document_ids` array) pending its own ticket.
- **DO** bound EVERY vendor-controlled value a handler writes, at the parse layer, to what the target column can actually store. `organization_rule_events` caps `payload` at `pg_column_size <= 16384`, `external_file_id` at 500 chars, `folder_path` at 2000, `subject` at 500, `sender_email` at 320 — and a webhook body is attacker-shaped input, not a promise. Any overflow is a `check_violation` at enqueue time → the handler DLQs and 500s → **the event is lost on the provider's first retry** (identical body ⇒ identical `payload_hash` ⇒ nonce UNIQUE violation ⇒ `200 {duplicate:true}`), and its whole downstream chain with it. Concretely: never put a field on the payload whose size scales with vendor-controlled cardinality/length (per-document id arrays, recipient lists, raw metadata) — record a `_count`, or move the unbounded data onto the UNCAPPED `job_queue` payload — and put a `.max()` on every scalar that reaches a length-CHECKed column, so an oversize value is a bounded 400 instead of a 5xx. Assert those bounds in tests by **reading the constraint out of `supabase/migrations/`**, never by hardcoding the number. See the Adobe Sign Finding 7 entry above; `docusign.ts` gets the payload half of this in PR #2485 and still needs the scalar half.
- **DO NOT** persist raw webhook payloads — only sanitized canonical events reach the database
- **DO NOT** log webhook bodies that may contain PII (EIN, addresses, etc.)

## Conventions

- Signature/channel validation happens before any DB write.
- Unknown external accounts are acknowledged without cross-tenant data leakage.
- Ambiguous account-to-org mappings fail closed.
- Sanitized rule-event payloads may include provider IDs needed for idempotency, but not raw documents or raw webhook bodies.
- Connector payloads that carry PII must hash values before storing long-lived operational metadata. PII scrubbing is mandatory; do not persist emails, document fingerprints, or API keys.

## 2026-09-10 — ComputeID atomic agent/key transition (SCRUM-4535 / SCRUM-4536)

The earlier separate-key-write / status-clock CAS notes above describe the original receiver. They are superseded for ComputeID by migration `0448` and the single `apply_computeid_agent_transition` RPC: lock the agent, compare org/binding/status/full metadata, then commit both agent and key changes in one transaction. A key-write failure rolls back the event clock too; identical redelivery remains actionable. A stale snapshot returns false and the receiver requests 409 redelivery. Transport or database failures return 500, never a successful audit/ack. Terminal revocation and ComputeID-owned suspension/key filters are preserved. The flag remains off; the new RPC must be staged/applied before enabling this receiver.

`computeid.test.ts` exercises real signed HTTP delivery against the RPC boundary. `scripts/ops/repro-computeid-agent-key-atomic.py` reproduces both old defects and verifies rollback, overlapping SQL sessions, CAS, service-only execution and rollback/reapply in a disposable PostgreSQL container. The fixture is targeted, not a full production schema replay. The concurrency DSL is `machines/agentPassportAtomic.machine.ts`.
## 2026-09-05 — PR 2519 orphan durability and schema integration

An orphan response may acknowledge 200 only after webhook_dlq persistence succeeds.
Returned DB errors and thrown transport errors both reproduced false 200 before
the fix; they now produce 500 for provider retry. Other failure branches already
return 500 and keep DLQ recording best effort. This candidate uses the dedicated
webhook_id introduced by its 0426 migration, matching the dependent OAuth writer
in PR 2529; PR 2496's earlier subscription_id repair is interim. Production was
queried read-only: subscription_id exists, webhook_id and migration 0426 do not.
Schema application and isolated verification remain required before deployment.

## 2026-09-05 — Adobe registration challenge reads validated configuration

The GET challenge uses config.adobeSignClientId, populated by the existing Zod configuration loader. Request-time process.env reads can diverge from the validated startup configuration. Regressions prove the configured ID remains authoritative after raw environment mutation and an absent configured ID still returns 503 without echo. Constant-time comparison and notification HMAC behavior are unchanged.


## 2026-09-10 — ComputeID historical review closure

Historical review repairs reject provider timestamps beyond five minutes, canonicalize accepted timestamps, preserve terminal revocation regardless of ordering floors, and prevent equal-time reinstatement (SCRUM-4567 / SCRUM-4571). Revocation records service-owned passport authority before enumerating agents, including orphans; retries still enforce agents after partially completed tenant updates. Transition audits commit inside the RPC. `enqueue_computeid_failure` serializes duplicate payload/reason diagnostics without deleting historical evidence. Production and handler tests share `computeidWebhookBody`, including 413, suffix 404 and disabled-gate 503 behavior. Free-text reasons and their lengths are not persisted.


## 2026-09-10 — Cross-organization revocation pagination

A single PostgREST select silently stops at the configured 1000-row cap. The receiver now streams ID-ordered keyset pages of 200 and requires an empty page before success. A shorter hosted cap cannot cause early completion; deleting earlier rows cannot shift later rows out of the scan. A failed later page returns 500 so the provider retries, and the terminal authority write still runs on that retry. Signed HTTP regressions reproduce the old 1001-binding truncation and verify page failure, smaller caps and deletion between pages. Concurrent new suspension-time admissions remain a separate activation concern; terminal revocation blocks new admission through its authority sentinel.

## 2026-09-12 — SCRUM-4495: `computeid.ts` no longer owns the transition

The receiver kept its authentication, parsing, privacy and HTTP behaviour, but `findBoundAgents`, the `apply_computeid_agent_transition` call, the DLQ insert and the terminal revocation write now live in `integrations/computeid/passport-transition.ts`. The scheduled re-check (`jobs/computeid-passport-recheck.ts`, added the same day) is a SECOND producer of `passport.*` events, and two copies of the lifecycle would drift in exactly one direction — keys staying live on a revoked passport.

What stays here is only the HTTP mapping: a `conflict` outcome becomes `409 conflict_retry` so ComputeID redelivers, a `failed` outcome becomes `500`. If you change the receiver's behaviour, change `passport-transition.ts` — otherwise the cron path keeps the old behaviour and nothing tells you.
