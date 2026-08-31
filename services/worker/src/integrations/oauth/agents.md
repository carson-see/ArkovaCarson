# agents.md — services/worker/src/integrations/oauth/

_Last updated: 2026-08-30 (signer-backfill follow-on to docusign-bilateral PR-2: `fetchDocusignEnvelopeRecipients` + `extractCapturedSigners`)._

## What This Folder Contains

Shared OAuth infrastructure — token encryption, HMAC webhook verification, and vendor-specific OAuth/API clients.

| File | Purpose |
|------|---------|
| `crypto.ts` | GCP KMS-based OAuth token encryption/decryption — cleartext never lands in Postgres |
| `hmac.ts` | Shared HMAC-SHA256 webhook verifier (timing-safe, supports base64 and hex encoding) |
| `drive.ts` | Google Drive OAuth client — token exchange, refresh, changes.watch, files.get, channels.stop. **DRIVE-02 (S2)**: `createChangesWatch` now returns the `startPageToken` (additive) and accepts an optional `driveId` to scope startPageToken + changes.watch to a shared-drive corpus. |
| `docusign.ts` | DocuSign OAuth client — consent URLs, token refresh, UserInfo discovery, envelope document fetch, Connect HMAC. **2026-08-29 (R7):** `resolveDocusignEnvironment(baseUri, env?)` — `'prod'\|'demo'` from the connection's `base_uri` (`demo.docusign.net` vs any other `*.docusign.net`), falling back to the existing `DOCUSIGN_DEMO` convention only when `base_uri` doesn't identify an environment. **2026-08-30 (signer backfill):** `fetchDocusignEnvelopeRecipients(args)` — GET `.../envelopes/{id}/recipients`, mapped through the new `extractCapturedSigners(signers)`, which reuses the SAME `DocusignCapturedSigner` Zod gate + `MAX_CAPTURED_DOCUSIGN_SIGNERS` cap PR #2474's webhook-side `extractSigners` (`api/v1/webhooks/docusign.ts`) validates against — GUID-shape-pinned, deduped by `recipient_id_guid`, fail-soft skip on invalid/partial entries, never name/email. Used only by `jobs/docusign-signer-backfill-deps.ts` |
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
- **DO NOT** re-add `include_granted_scopes` to `buildAuthorizationUrl` (drive.ts). With the shared Google OAuth client it made one Drive connect inherit EVERY scope that client was ever granted by the account — a 33-scope grant (full `drive`, `gmail.modify`, `calendar`, `contacts`, `classroom.*`, `chat.*`) was observed during FULLSOAK 2026-08 (shared-resource register #9). Absent, Google defaults it to false. Pinned by tests in `drive.test.ts`, `googleDrive.test.ts`, and `drive-oauth.test.ts`.
- **DO NOT** widen `DRIVE_DEFAULT_SCOPES` without a security review — it is the complete allowlist of what a leaked refresh token can reach. Current set: `drive.file` (all Drive API calls), `drive.activity.readonly` (declared Activity surface), `userinfo.email` (the callback's `oauth2/v3/userinfo` identity lookup; without it `account_id` degrades to a constant and collapses the `org_integrations` upsert key).
