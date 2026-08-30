# agents.md — services/worker/src/api/v1/webhooks/

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
| `docusign.ts` | DocuSign Connect `envelope-completed` handler — lookup-first HMAC verify (SCRUM-2043), HMAC verified for unknown accounts too (env-var key), dual-table lookup: org_integrations then member_integrations (SCRUM-2044), sanitized event + document-fetch job + SCRUM-1872 notarization detection. SCRUM-1649: carries single-document SHA-256 into rule-event payloads via `document_hashes` / `document_sha256` for downstream post-signing anchor materialization. SCRUM-2362 (DS-02): invalid sig → 401 fail-closed; duplicate signed event → 200 with no duplicate queue materialization (nonce table); orphan → 200 bounded + DLQ-audited; raw-payload PII (sender/notary email, doc fingerprint) never reaches logger/Sentry/Error — pinned by the `no raw-payload PII leak` test suite. **2026-08-30:** `classifyDirection()` (R4) routes outbound (unchanged) vs inbound/Recipient Connect — see the dated entry above; flag `ENABLE_DOCUSIGN_INBOUND` default off |
| `docusign-hmac-helpers.ts` | SCRUM-2043: resolves HMAC keys from per-org `hmac_keys` JSONB or env-var fallback |
| `docusign-hmac-rotation.test.ts` | Tests for multi-key HMAC verification flow and key resolution |
| `drive.ts` | Google Drive push notification handler — headers-only signal, channel-token verification |
| `ats.ts` | ATS webhook handler (Greenhouse, Lever) — HMAC verify, attestation verification response |
| `checkr.ts` | Checkr `report.completed` handler — HMAC-SHA256 hex, nonce replay protection, DLQ on failure |
| `middesk.ts` | Middesk KYB handler — `business.updated/verified/rejected` events, org verification status transitions |
| `microsoft-graph.ts` | Microsoft Graph change-notifications — `clientState` verification, validation handshake echo |
| `veremark.ts` | Veremark stub — gated behind `ENABLE_VEREMARK_WEBHOOK`, returns 503 until vendor docs confirmed |

## Do / Don't Rules

- **DO** verify HMAC signatures before processing any webhook payload
- **DO** use nonce/idempotency tables to prevent replay attacks
- **DO** release the nonce before returning any post-nonce 5xx (AUDIT-0424-10). The nonce is committed before the downstream writes, so an un-compensated failure is unrecoverable, not retryable: the provider re-presents the same event id, hits the UNIQUE violation, and is answered `200 {duplicate:true}` — the event is dropped *and* the provider is told it succeeded. `middesk.ts::releaseNonce` is the reference implementation (mirrors the `webhook_event_claims` compensating delete in `stripe/handlers.ts`). Never release on the success path.
- **DO** keep the set of status literals a handler writes in parity with the DB CHECK constraint that admits them. `middesk.ts` wrote `'REJECTED'`/`'REQUIRES_INPUT'` into `organizations.verification_status` for months while the constraint admitted only `UNVERIFIED/PENDING/VERIFIED`, so every KYB rejection raised SQLSTATE 23514 and was silently lost. Mocked-DB unit tests cannot catch this — `middesk.test.ts` carries a parity test that reads the migration set directly.
- **DO NOT** persist raw webhook payloads — only sanitized canonical events reach the database
- **DO NOT** log webhook bodies that may contain PII (EIN, addresses, etc.)

## Conventions

- Signature/channel validation happens before any DB write.
- Unknown external accounts are acknowledged without cross-tenant data leakage.
- Ambiguous account-to-org mappings fail closed.
- Sanitized rule-event payloads may include provider IDs needed for idempotency, but not raw documents or raw webhook bodies.
- Connector payloads that carry PII must hash values before storing long-lived operational metadata. PII scrubbing is mandatory; do not persist emails, document fingerprints, or API keys.
