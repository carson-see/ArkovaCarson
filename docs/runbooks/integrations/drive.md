# Google Drive integration runbook

**Stories:** [SCRUM-1168](https://arkova.atlassian.net/browse/SCRUM-1168)
(OAuth + webhook activation), [SCRUM-1169](https://arkova.atlassian.net/browse/SCRUM-1169)
(folder-path resolver — closes CIBA-HARDEN-05)

**Owners:** Platform engineering

**Last updated:** 2026-09-21 (SCRUM-5287/SCRUM-2903/SCRUM-2330 drive.readonly
cutover — see below; earlier content below this notice may still be stale,
verify against `services/worker/src/integrations/oauth/drive.ts` before
relying on it operationally)

Drive is the first integration provider Arkova wires. DocuSign / Adobe Sign /
Microsoft Graph follow the same pattern in sibling runbooks (coming in
Phase 2b).

## 2026-09-21 scope cutover (SCRUM-5287 / SCRUM-2903 / SCRUM-2330)

Arkova now requests `https://www.googleapis.com/auth/drive.readonly` +
`userinfo.email` (see `DRIVE_DEFAULT_SCOPES` in
`services/worker/src/integrations/oauth/drive.ts`) — **not** `drive.file`.
`drive.file` only grants per-file access for a file the app itself created
or one the user picked through Google's real Picker widget; Arkova's
Connectors-page folder browser is a custom `files.list` component, not the
Picker, so files another person later adds to a watched folder were
invisible to `drive.file` and 403'd on byte fetch. The rest of this document
below "OAuth app registration" may still describe the pre-cutover
`drive.file` setup for a row that has not yet re-consented — see
`DRIVE_LEGACY_REQUESTED_SCOPES` and `isDriveLegacyGrant()` in the same file
for how an existing connection is classified, and the
`reconnect_required_scope_change` connector-health reason for how it
surfaces to an admin.

Because `drive.readonly` is a Google RESTRICTED scope, this request now goes
through a NEW, dedicated GCP project + OAuth client (`arkova-connectors`) so
Google's restricted-scope verification doesn't gate every OTHER integration
riding the original shared client. See "Two OAuth clients" below.

## Capabilities

| Feature | Supported | Notes |
|---|---|---|
| OAuth consent flow | ✓ | `drive.readonly` default scope (RESTRICTED — Google verification required; see cutover note above) |
| Push notifications on change | ✓ | `changes.watch` channel, 7-day lifetime |
| Webhook ingress | ⚠ stub | `POST /api/v1/webhooks/drive` validates X-Goog-Channel-ID + X-Goog-Channel-Token; calls `enqueue_rule_event` with empty `parent_ids`. Resolving file_id + parent_ids per change via `changes.list` is SCRUM-1099 follow-up. Folder-bound rules do **not** fire today; non-folder-bound WORKSPACE_FILE_MODIFIED rules do. |
| Folder-path resolution | ✓ | `drive-folder-resolver` (SCRUM-1169) |
| Shared drives | ✓ | Resolver labels root with `drives.get(name)` |
| Admin disconnect | ✓ | Revokes the access_token (per-grant) so other orgs sharing the same end-user keep their refresh_tokens. |

## OAuth app registration

1. In GCP Console → **APIs & Services → OAuth consent screen**:
   - User type: External (public) or Internal (workspace-only).
   - Scopes: add `openid`, `email`, `https://www.googleapis.com/auth/drive.readonly`.
2. **Credentials → Create OAuth client ID**:
   - Application type: Web application.
   - Authorized redirect URI:
     `https://<arkova-worker>/api/v1/integrations/google_drive/oauth/callback`.
3. Copy the client ID + client secret into Secret Manager. See "Two OAuth
   clients" below for which env var pair to use.
4. `drive.readonly` is a Google RESTRICTED scope — budget 4-12 weeks for
   Google's verification queue on the client that requests it. This is why
   the cutover uses a NEW dedicated client rather than widening the scope on
   the original shared one (see below).

## Two OAuth clients (2026-09-21 cutover)

Two client credential pairs are supported so Drive keeps working during the
verification window:

| Env var pair | Client | Status |
|---|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` | Original shared client (also used by other historical consents) | Live. Fallback when the new pair is unset. The ONLY valid client for refreshing a token issued before the cutover — a refresh token is bound to the client that issued it. |
| `GOOGLE_DRIVE_OAUTH_CLIENT_ID` / `GOOGLE_DRIVE_OAUTH_CLIENT_SECRET` | New, dedicated `arkova-connectors` GCP project + OAuth client, requesting ONLY `drive.readonly` + `userinfo.email` | NOT PROVISIONED as of the SCRUM-5287 PR that added this row — a human must create the GCP project/client and set these in Secret Manager. Preferred for new consent and for refreshing rows connected under it once configured. |

`requireClient()` in `services/worker/src/integrations/oauth/drive.ts`
resolves which pair a given call uses; see its doc comment for the full
rationale. A row's stored `scope` (or the decrypted token's cached `scope`
for the refresh path) determines whether it is classified as
pre-cutover ("legacy" — always refreshed against the original client,
surfaced as `reconnect_required_scope_change` until it re-consents) or
current.

## KMS key for token encryption

OAuth tokens are encrypted via GCP KMS before they touch Postgres (the
`encrypted_tokens bytea` column). Reuse the existing `arkova-prod-keyring`
if possible:

1. In GCP Console → **Security → Cryptographic keys** → choose
   `arkova-prod-keyring`.
2. Create a new key `integration-tokens`:
   - Purpose: **Symmetric encrypt/decrypt**.
   - Protection: **Software** (sufficient) or **HSM** (if compliance
     mandates).
   - Rotation: 90 days (automatic).
3. Grant the worker service account
   `roles/cloudkms.cryptoKeyEncrypterDecrypter` on the key.
4. Set `GCP_KMS_INTEGRATION_TOKEN_KEY` to the full resource name
   (`projects/<p>/locations/<l>/keyRings/arkova-prod-keyring/cryptoKeys/integration-tokens`).
   This must be a symmetric encrypt/decrypt key. The worker fails closed when
   production OAuth integrations are enabled without this setting; do not reuse
   `GCP_KMS_KEY_RESOURCE_NAME`, which is reserved for Bitcoin signing.

## Channel renewal cadence

Drive push-notification channels expire **7 days** after creation. Arkova
schedules renewal every 6 days via the `integration-subscription-renewal`
cron (lands in Phase 2b). Missed renewals show up on
`/api/v1/org-integrations` with `last_renewal_error` set.

## Env vars

See `docs/reference/ENV.md`. Key ones:

| Name | Notes |
|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | Original shared OAuth app. Required to refresh any pre-cutover connection. |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Original shared OAuth app. See above. |
| `GOOGLE_DRIVE_OAUTH_CLIENT_ID` | New dedicated `arkova-connectors` OAuth app (2026-09-21 cutover). Not provisioned yet — see "Two OAuth clients" above. Must be set together with the secret below, never alone. |
| `GOOGLE_DRIVE_OAUTH_CLIENT_SECRET` | See above. |
| `GCP_KMS_INTEGRATION_TOKEN_KEY` | Dedicated KMS key for OAuth tokens |
| `GCP_KMS_KEY_RESOURCE_NAME` | Bitcoin signing key only; not valid for OAuth token encryption |

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `DriveConfigError: GOOGLE_OAUTH_CLIENT_ID ... not set` | Secrets missing | Provision in Secret Manager + redeploy. |
| `DriveApiError (401)` after days of success | Refresh token revoked (admin removed Arkova from their Google account) | Surface "reconnect" CTA in OrgProfile settings. |
| `folder_path` is `null` for all Drive events | Pre-cutover connection holding only the legacy `drive.file`/`drive.metadata.readonly`/`drive.activity.readonly` set — `drive.file` only sees files the user opened in Arkova | Reconnect (admin clicks "Connect"/"Reconnect" in the Connectors page — `prompt=consent` forces a fresh Google consent screen requesting the current `drive.readonly` scope). Surfaces as `reconnect_required_scope_change` on `/api/v1/org-integrations`. |
| Rule `folder_path_starts_with: "/HR/"` never fires | Admin uses shared drive; resolver labels it `/<DriveName>/HR/...`, not `/HR/...` | Include shared-drive name in the rule prefix, OR use `folder_path_contains`. |
| `drive_folder_path_cache` row has `folder_path = null` and fresh `cached_at` | Resolver hit a `DriveApiError` (permission / deleted parent) — negative cache | Expected; ages out in 15 min. If persistent, check the integration's scope. |

## PII handling

- Tokens: NEVER logged. Encrypted via KMS before touching Postgres.
  `decryptTokens` only runs in-memory in the worker.
- Folder paths: may contain sensitive substrings (employee names, project
  codenames). The cache is partitioned by `org_id` so another tenant
  cannot see them even via a compromised service account.
- Webhook payloads from Drive are not persisted — only the `file_id` and
  the resolved `folder_path` reach `organization_rules` evaluation.

## References

- Client: `services/worker/src/integrations/oauth/drive.ts`
- Resolver: `services/worker/src/integrations/connectors/drive-folder-resolver.ts`
- Crypto helpers: `services/worker/src/integrations/oauth/crypto.ts`
- Schema: `supabase/migrations/0251_org_integrations.sql`
- Plan doc: <https://arkova.atlassian.net/wiki/spaces/A/pages/25952257>
- Story (SCRUM-1168): <https://arkova.atlassian.net/wiki/spaces/A/pages/25591990>
- Story (SCRUM-1169): <https://arkova.atlassian.net/wiki/spaces/A/pages/26148909>
