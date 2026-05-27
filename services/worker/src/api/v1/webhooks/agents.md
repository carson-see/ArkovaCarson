# agents.md — services/worker/src/api/v1/webhooks/

_Last updated: 2026-05-27_

## What This Folder Contains

Inbound webhook handlers for third-party integrations. Each handler verifies HMAC signatures, normalizes payloads via canonical adapters, and enqueues sanitized events for the rules engine. Raw payloads are never persisted.

| File | Purpose |
|------|---------|
| `adobe-sign.ts` | Adobe Sign `AGREEMENT_WORKFLOW_COMPLETED` handler — HMAC-SHA256 base64, `adaptAdobeSign` normalization |
| `docusign.ts` | DocuSign Connect `envelope-completed` handler — lookup-first HMAC verify (SCRUM-2043), dual-table lookup: org_integrations then member_integrations (SCRUM-2044), sanitized event + document-fetch job + SCRUM-1872 notarization detection |
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
