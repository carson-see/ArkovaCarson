# agents.md — services/worker/src/integrations/oauth/

_Last updated: 2026-08-30 (`adobe-sign.ts` gained the OAuth + webhook-provisioning client)._

## 2026-08-30 — `adobe-sign.ts` is now provider client + webhook helpers, like `docusign.ts`

The file used to hold only HMAC verification and payload parsing for inbound notifications. It now
also carries the OAuth v2 + REST v6 webhook client the connect flow needs
(`buildAdobeSignAuthorizationUrl`, `exchangeAdobeSignCode`, `refreshAdobeSignAccessToken`,
`revokeAdobeSignToken`, `fetchAdobeSignUserInfo`, `createAdobeSignWebhook`,
`deleteAdobeSignWebhook`), matching how `docusign.ts` holds OAuth + Connect provisioning together.

Contract points that are easy to get wrong and are pinned by `adobe-sign.test.ts`:

* **The webhook create id can arrive two ways.** Adobe documents both a body carrying the
  identifier and a `Location` header pointing at the created resource. Reading only the body is how
  a create that actually succeeded still yields a NULL `webhook_id` — the precise failure this
  connector was stuck in — so `extractWebhookId()` checks body then header and **throws** rather
  than returning an empty id. A loud failure beats a silently-null id whose only symptom is every
  future delivery orphaning with no explanation.
* **Credentials are FORM FIELDS, not Basic auth.** This is where Adobe differs from DocuSign; a
  copy-pasted `Authorization: Basic` header fails the token exchange.
* **`api_access_point` from the token response is the shard.** Every REST helper takes it as a
  required argument rather than reading a host from env — a hardcoded shard works for exactly one
  account and 404s/401s for every other.
* **`revokeAdobeSignToken` swallows 400/401/404 by design.** Disconnect calls it, and a token Adobe
  already considers dead must not strand an org in a connected state. 5xx still throws.
* **`deleteAdobeSignWebhook` treats 404 as success** — "Adobe is no longer delivering to us" is the
  desired end state and an already-deleted webhook satisfies it. Any other status throws so
  disconnect can report a webhook it failed to remove.
* **`AdobeSignApiError` follows the SCRUM-2492 shape**: no `body` field at all, and `detail` is
  bounded/PII-scrubbed by construction via `boundedErrorDetail`. Every path here is a non-document
  path (OAuth + webhook metadata), which is what makes attaching a detail safe — and it is what
  makes "the account tier lacks `webhook_write`" legible instead of a mystery 403.
* **`includeSignedDocuments` / `includeDocumentsInfo` are FALSE** on the webhook config, pinned by
  test. §1.6A permits a server-side fingerprint on a deliberate fetch path; it does not permit
  document bytes riding in on a notification body.

**Pre-existing oddity, still deliberately left alone:** `signatureHeader()` in
`api/v1/webhooks/adobe-sign.ts` falls back to `X-AdobeSign-ClientId` as a *signature*. On a
notification that header carries the client id, not an HMAC, so the fallback always fails the
compare and 401s — fail-closed, not exploitable. Do not "fix" it by comparing the client id
instead: that turns a public identifier into the auth check and is a straight auth bypass.

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
- **DO NOT** re-add `include_granted_scopes` to `buildAuthorizationUrl` (drive.ts). With the shared Google OAuth client it made one Drive connect inherit EVERY scope that client was ever granted by the account — a 33-scope grant (full `drive`, `gmail.modify`, `calendar`, `contacts`, `classroom.*`, `chat.*`) was observed during FULLSOAK 2026-08 (shared-resource register #9). Absent, Google defaults it to false. Pinned by tests in `drive.test.ts`, `googleDrive.test.ts`, and `drive-oauth.test.ts`.
- **DO NOT** widen `DRIVE_DEFAULT_SCOPES` without a security review — it is the complete allowlist of what a leaked refresh token can reach. Current set: `drive.file` (all Drive API calls), `drive.activity.readonly` (declared Activity surface), `userinfo.email` (the callback's `oauth2/v3/userinfo` identity lookup; without it `account_id` degrades to a constant and collapses the `org_integrations` upsert key).
