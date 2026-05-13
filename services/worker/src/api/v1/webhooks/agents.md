# services/worker/src/api/v1/webhooks/agents.md

Provider webhook endpoints mounted under the v1 API. These handlers must treat vendor payloads as untrusted input: verify signatures/tokens first, resolve the org integration, enqueue sanitized rule events, and avoid persisting raw provider bodies or documents.

## Files
- `docusign.ts` (SCRUM-1649) — HMAC-verified DocuSign Connect intake. For completed-envelope events, it enqueues an `ESIGN_COMPLETED` rule event plus a retryable `docusign.envelope_completed` job. When DocuSign supplies document SHA-256 values, the rule payload includes `document_hashes` and a single-document `document_sha256` so downstream rule actions can create a pending post-signing anchor without storing the PDF.
- `drive.ts` — Google Drive push notification intake and optional changes runner handoff.
- `adobe-sign.ts`, `microsoft-graph.ts`, `checkr.ts`, `veremark.ts`, `middesk.ts`, `ats.ts` — other provider webhook adapters.

## Conventions
- Signature/channel validation happens before any DB write.
- Unknown external accounts are acknowledged without cross-tenant data leakage.
- Ambiguous account-to-org mappings fail closed.
- Sanitized rule-event payloads may include provider IDs needed for idempotency, but not raw documents or raw webhook bodies.
- Connector payloads that carry PII should hash values before storing long-lived operational metadata.
