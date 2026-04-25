# Google Drive integration runbook

**Stories:** [SCRUM-1168](https://arkova.atlassian.net/browse/SCRUM-1168)
(OAuth + webhook activation), [SCRUM-1169](https://arkova.atlassian.net/browse/SCRUM-1169)
(folder-path resolver — closes CIBA-HARDEN-05)

**Owners:** Platform engineering

**Last updated:** 2026-04-24

Drive is the first integration provider Arkova wires. DocuSign / Adobe Sign /
Microsoft Graph follow the same pattern in sibling runbooks (coming in
Phase 2b).

## Capabilities

| Feature | Supported | Notes |
|---|---|---|
| OAuth consent flow | ✓ | `drive.file` default scope (skips verification queue) |
| Push notifications on change | ✓ | `changes.watch` channel, 7-day lifetime |
| Webhook ingress | ⚠ stub | `POST /api/v1/webhooks/drive` validates X-Goog-Channel-ID + X-Goog-Channel-Token; calls `enqueue_rule_event` with empty `parent_ids`. Resolving file_id + parent_ids per change via `changes.list` is SCRUM-1099 follow-up. Folder-bound rules do **not** fire today; non-folder-bound WORKSPACE_FILE_MODIFIED rules do. |
| Folder-path resolution | ✓ | `drive-folder-resolver` (SCRUM-1169) |
| Shared drives | ✓ | Resolver labels root with `drives.get(name)` |
| Admin disconnect | ✓ | Revokes the access_token (per-grant) so other orgs sharing the same end-user keep their refresh_tokens. |

## OAuth app registration

1. In GCP Console → **APIs & Services → OAuth consent screen**:
   - User type: External (public) or Internal (workspace-only).
   - Scopes: add `openid`, `email`, `https://www.googleapis.com/auth/drive.file`.
2. **Credentials → Create OAuth client ID**:
   - Application type: Web application.
   - Authorized redirect URI:
     `https://<arkova-worker>/api/v1/integrations/google_drive/oauth/callback`.
3. Copy the client ID + client secret into Secret Manager as
   `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`.
4. Keep the `drive.file` scope until we need folder-wide watching; upgrading
   to `drive.readonly` puts you into Google's 4–12 week verification queue.

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
   If unset, the code falls back to `GCP_KMS_KEY_RESOURCE_NAME`; using a
   dedicated key is preferred so a chain-signing key compromise does not
   leak OAuth tokens.

## Channel renewal cadence

Drive push-notification channels expire **7 days** after creation. Arkova
schedules renewal every 6 days via the `integration-subscription-renewal`
cron (lands in Phase 2b). Missed renewals show up on
`/api/v1/org-integrations` with `last_renewal_error` set.

## Env vars

See `docs/reference/ENV.md`. Key ones:

| Name | Notes |
|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | From GCP OAuth app |
| `GOOGLE_OAUTH_CLIENT_SECRET` | From GCP OAuth app |
| `GCP_KMS_INTEGRATION_TOKEN_KEY` | Dedicated KMS key for OAuth tokens |
| `GCP_KMS_KEY_RESOURCE_NAME` | Fallback (chain signing key — not recommended) |

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `DriveConfigError: GOOGLE_OAUTH_CLIENT_ID ... not set` | Secrets missing | Provision in Secret Manager + redeploy. |
| `DriveApiError (401)` after days of success | Refresh token revoked (admin removed Arkova from their Google account) | Surface "reconnect" CTA in OrgProfile settings. |
| `folder_path` is `null` for all Drive events | Token scope insufficient (`drive.file` only sees files the user opened in Arkova) | Upgrade scope in the consent screen to `drive.readonly`, go through Google verification. |
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
