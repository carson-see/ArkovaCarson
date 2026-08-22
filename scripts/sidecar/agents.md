# `scripts/sidecar/` — connector side-rig helpers

Throwaway operator helpers for the **`connector-sidecar-2026-08` side-rig**
(Cloud Run `arkova-worker-connector-sidecar-2026-08-staging`, Supabase `ehqqearcitrgloibtjqx`).

**Nothing here targets production or the 7-day soak rig**, and nothing here is CI-invoked. These
exist because a human has to click something and the thing they must click expires.

| Script | Purpose |
|---|---|
| `drive-authorize-url.sh` | Mint a fresh Google Drive authorize URL for the side-rig. |

## Why `drive-authorize-url.sh` exists rather than a URL in a doc

The Drive OAuth `state` token is HMAC-signed with a **10-minute TTL** (`StateTtlMs` in
`services/worker/src/api/v1/integrations/drive-oauth.ts`). An authorize URL written into a
document is dead long before anyone reads it, so the reproducible artifact is the *generator*, not
the URL.

Two things it encodes that are easy to get wrong by hand:

- **The `-270018525501` hostname spelling is mandatory.** `buildRedirectUri` derives `redirect_uri`
  from the inbound `Host` header, and only that spelling is registered on the Google OAuth client.
  The `-kvojbeutfa-uc` alias that `gcloud run services describe` prints reaches the same service
  but yields `redirect_uri_mismatch`.
- **`org_id` must be sent.** Omitting it takes the personal-connect path, which for a user who
  belongs to an org is a denial (`org_scope_required`; historically the ambiguous `not_admin` —
  see FD-D3 in `services/worker/src/integrations/connectors/agents.md`).

Credentials come from Secret Manager, never from argv or a committed literal:
`supabase-url-…` / `supabase-anon-key-…` / `sidecar-drive-test-user-password`.

## Teardown

Delete this directory along with the rig. `sidecar-drive-test-user-password` is listed in the
teardown block of `docs/staging/fullsoak-2026-08/connector-sidecar-evidence.md` §5.
