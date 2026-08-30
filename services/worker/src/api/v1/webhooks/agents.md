# agents.md — services/worker/src/api/v1/webhooks/

_Last updated: 2026-08-29 (docusign-bilateral PR-2: outbound signer capture)_

## 2026-08-29 — CTO Decision Record (docusign-bilateral-2026-08, PR-2): outbound signer capture (R6/R7)

`docusign.ts` gained `extractSigners(rawBody)` — mirrors `extractNotaryData`'s raw-body access pattern (`envelopeSummary ?? data ?? root`, then `recipients.signers[]`; deliberately does NOT read `recipients.carbonCopies[]`, matching `findNotaryRecipient`). Produces `_signers`: an array (capped at `MAX_CAPTURED_DOCUSIGN_SIGNERS` = 20, truncates rather than rejecting the envelope) of `{recipient_id_guid, user_id?, status, signed_at?}` — **pseudonymous GUIDs only, never name/email**. Two independent strip gates: the extraction function only ever copies four named fields into a fresh literal (never spreads the raw recipient), and `DocusignCapturedSigner` (`integrations/connectors/schemas.ts`) is a non-`.passthrough()` Zod object that strips any other key by construction. A third gate lives in `jobs/docusign-envelope-completed.ts` at the actual DB-write boundary (see that folder's agents.md).

`_signers` is threaded into the `docusign.envelope_completed` job payload (`enqueueFetchJob`) but is deliberately **kept OFF** `enqueue_rule_event`'s `p_payload` — `organization_rule_events.payload` has a DB CHECK `pg_column_size(payload) <= 16384`, and at the schema's max cardinality (100 `envelopeDocuments`) `document_ids`/`document_hashes` alone already sit close to that ceiling (measured: ~7.5KB at 100 realistic-length document ids). `_signers` only rides the job → `connector_artifact.metadata` → `anchors.metadata` path, which has no size cap. See `jobs/agents.md` for the metadata-side half and the `_docusign_env` companion field.

This is the outbound (own-account envelope-completed) path only. Inbound (Recipient Connect / received envelopes) is a separate, later, flag-OFF PR (F1 in the CTO Decision Record) — not touched here.

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
