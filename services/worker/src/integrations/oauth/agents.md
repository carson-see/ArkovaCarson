# agents.md — services/worker/src/integrations/oauth/

_Last updated: 2026-06-16 (SCRUM-2492 byte-safe error types + bounded `detail` on non-document paths)._

## What This Folder Contains

Shared OAuth infrastructure — token encryption, HMAC webhook verification, and vendor-specific OAuth/API clients.

| File | Purpose |
|------|---------|
| `crypto.ts` | GCP KMS-based OAuth token encryption/decryption — cleartext never lands in Postgres |
| `hmac.ts` | Shared HMAC-SHA256 webhook verifier (timing-safe, supports base64 and hex encoding) |
| `drive.ts` | Google Drive OAuth client — token exchange, refresh, changes.watch, files.get, channels.stop. **DRIVE-02 (S2)**: `createChangesWatch` now returns the `startPageToken` (additive) and accepts an optional `driveId` to scope startPageToken + changes.watch to a shared-drive corpus. |
| `docusign.ts` | DocuSign OAuth client — consent URLs, token refresh, UserInfo discovery, envelope document fetch, Connect HMAC |
| `docusign-rate-limit.ts` | DocuSign outbound API guard — per-account 3,000/hour local slot budget plus Retry-After-aware 429 retry wrapper |
| `adobe-sign.ts` | Adobe Sign webhook HMAC verification helpers |
| `docusign-hmac.ts` | SCRUM-2043: multi-key HMAC verifier + signature header extractor for dual-key rotation |
| `docusign-hmac.test.ts` | Tests for multi-key HMAC verification |

## Do / Don't Rules

- **DO** use `crypto.ts` for all token storage — dedicated symmetric KMS key, not the Bitcoin signing key
- **DO** use `hmac.ts` centralized verifier for all webhook signatures (prevents drift on timing-safe path)
- **DO** route DocuSign cron/job API fetches through `docusign-rate-limit.ts` so refresh/document calls share one per-account budget
- **DO NOT** log response bodies from OAuth token exchanges (contain cleartext tokens)
- **DO NOT** reuse the Bitcoin asymmetric signing key for OAuth token encryption
- **DO NOT** add a `body`/raw-response field to `DocusignApiError` / `DriveApiError` (§1.6A / SCRUM-2492). They carry NO raw response body — a document-bearing response must never ride an error into a logger/Sentry/`last_error`. On `fetchDocusignCombinedDocument`'s non-2xx path (the only document-fetch path), do NOT read the response body and do NOT pass a `detail`; throw status + message only.
- **DO NOT** put `hmacSecret` (or any other secret) on the DocuSign Connect provisioning payload. `hmacSecret` is **not a field on DocuSign's `ConnectCustomConfiguration`** — DocuSign accepts the request and drops it, so it never installed Arkova's signing key while making `buildConnectPayload()` read as though it had. `includeHMAC: 'true'` only asks DocuSign *to* sign; **which** key it signs with is account-side state. Today it is aligned by a DocuSign admin on the customer account; the multi-tenant answer is DocuSign's API-only `integratorManaged` ("HMAC for Partners"), which is **not built** — see the runbook for the four things a story adding it must cover. Runbook: `docs/runbooks/integrations/docusign.md` → "The HMAC key is ACCOUNT-SIDE".
- **DO** keep `deliveryMode: 'SIM'` + `eventData: { version: 'restv2.1' }` riding with the `events` field — DocuSign 400s `INVALID_REQUEST_PARAMETER` on `events` without both (prod failure 2026-07-25, every org connect).
- **DO** use the optional `detail?: string` (3rd ctor arg) ONLY on the NON-document paths (token exchange/refresh, userinfo, DocuSign Connect list/mutation/parse/timeout; Drive token exchange/refresh, startPageToken, changes.watch, channels.stop, token revoke, files.get, changes.list) — whose error body is safe OAuth/API error JSON. Always build it with `boundedErrorDetail(json)` from `utils/byte-safety.ts` (bounded ~500 chars, byte-redacted, PII-scrubbed). Never pass a raw string/body directly.
