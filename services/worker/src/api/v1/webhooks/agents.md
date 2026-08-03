# agents.md — services/worker/src/api/v1/webhooks/

_Last updated: 2026-08-03 (GH #1836: legacy org-id channel-token deprecation-window warning)_

## 2026-08-03 — GH #1836 (SECURITY, pen-test scope): legacy org-id Drive channel token — accept-but-warn during the deprecation window

`drive.ts` already did the correct thing on the auth side: constant-time compare `X-Goog-Channel-Token` against the STORED token (never the org id directly), fail-closed 401 on mismatch or missing-stored-token. The vulnerability was upstream — that stored value USED TO BE the org's own UUID (fixed in `api/v1/integrations/agents.md`'s GH #1836 entry) — not a flaw in this comparison itself.

Added: when `lookup.channel_token === lookup.org_id` (the row is definitionally still on the pre-fix scheme — a real random token would essentially never collide with the org's own UUID), the webhook still ACCEPTS the request (backward compat is required — existing channels must keep delivering until GH #1835's renewal sweep rotates them to a real secret) but logs a bounded `logger.warn` naming the channel/org so ops can track deprecation progress. **Never logs the token value itself** — the check compares the ALREADY-VERIFIED stored token against the org id, no secret material touches the log line. Tests: `drive.test.ts` `describe('GH #1836: legacy org-id channel-token deprecation window')` — asserts the warning fires for a legacy token and does NOT fire for a modern random one, and that `"channel_token"` never appears in any `logger.warn` call's serialized arguments.

## What This Folder Contains

Inbound webhook handlers for third-party integrations. Each handler verifies HMAC signatures, normalizes payloads via canonical adapters, and enqueues sanitized events for the rules engine. Raw payloads are never persisted.

| File | Purpose |
|------|---------|
| `adobe-sign.ts` | Adobe Sign `AGREEMENT_WORKFLOW_COMPLETED` handler — HMAC-SHA256 base64, `adaptAdobeSign` normalization |
| `docusign.ts` | DocuSign Connect `envelope-completed` handler — lookup-first HMAC verify (SCRUM-2043), HMAC verified for unknown accounts too (env-var key), dual-table lookup: org_integrations then member_integrations (SCRUM-2044), sanitized event + document-fetch job + SCRUM-1872 notarization detection. SCRUM-1649: carries single-document SHA-256 into rule-event payloads via `document_hashes` / `document_sha256` for downstream post-signing anchor materialization. SCRUM-2362 (DS-02): invalid sig → 401 fail-closed; duplicate signed event → 200 with no duplicate queue materialization (nonce table); orphan → 200 bounded + DLQ-audited; raw-payload PII (sender/notary email, doc fingerprint) never reaches logger/Sentry/Error — pinned by the `no raw-payload PII leak` test suite |
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
- **DO NOT** persist raw webhook payloads — only sanitized canonical events reach the database
- **DO NOT** log webhook bodies that may contain PII (EIN, addresses, etc.)

## Conventions

- Signature/channel validation happens before any DB write.
- Unknown external accounts are acknowledged without cross-tenant data leakage.
- Ambiguous account-to-org mappings fail closed.
- Sanitized rule-event payloads may include provider IDs needed for idempotency, but not raw documents or raw webhook bodies.
- Connector payloads that carry PII must hash values before storing long-lived operational metadata. PII scrubbing is mandatory; do not persist emails, document fingerprints, or API keys.
