# DocuSign Connector Runbook

Story: SCRUM-1101 — CONN-V2-03 DocuSign connector

Current live close-out story: SCRUM-1655 / parent SCRUM-1648.

## Runtime Shape

- Admin OAuth uses DocuSign Authorization Code Grant with `signature extended openid email`.
- Connect sends completed-envelope notifications to `POST /webhooks/docusign`.
- The worker verifies `X-DocuSign-Signature-1` over the raw request body before parsing.
- Valid completed envelopes enqueue an `ESIGN_COMPLETED` rules event and a retryable `docusign.envelope_completed` job.
- The retry job uses `job_queue` with `max_attempts = 5`; failures back off exponentially and then park as `dead`.

## Secret Manager Values

Provision these as Cloud Run secrets, then redeploy the worker through the human-owned deploy path:

```bash
DOCUSIGN_INTEGRATION_KEY=
DOCUSIGN_CLIENT_SECRET=
DOCUSIGN_CONNECT_HMAC_SECRET=
DOCUSIGN_DEMO=false   # prod: production account.docusign.com auth base (Go-Live approved 2026-07-23). Use "true" only for sandbox/dev.
ENABLE_DOCUSIGN_OAUTH=true
ENABLE_DOCUSIGN_WEBHOOK=true
```

`DOCUSIGN_DEMO` selects the **OAuth account server only** (`account-d.docusign.com` vs
`account.docusign.com`) — see `getAuthBase()` in
`services/worker/src/integrations/oauth/docusign.ts`. The **eSignature REST base** is NOT derived
from this flag: it is the per-connection `base_uri` captured from `/oauth/userinfo` at connect time
and persisted in `org_integrations.base_uri` (migration `0306`) / `member_integrations.base_uri`
(migration `0320`).

**Consequence when flipping `DOCUSIGN_DEMO` true -> false:** connections established while the flag
was `true` keep a sandbox `base_uri` (`https://demo.docusign.net`) and hold a refresh token minted by
`account-d`. After the flip, their token refresh is sent to `account.docusign.com` and will fail, and
any REST call still targets the demo host. Those orgs must **re-run the OAuth connect flow** so a
production `base_uri` (e.g. `https://naN.docusign.net`) and a production refresh token are persisted.
Flipping the env var alone does not migrate an existing connection.

Do not paste refresh tokens into logs, tickets, or Confluence. Refresh tokens are encrypted through `GCP_KMS_INTEGRATION_TOKEN_KEY` before persistence in `org_integrations.encrypted_tokens`.

The worker deploy workflow binds the production Secret Manager resources as:

```bash
DOCUSIGN_INTEGRATION_KEY=docusign_integration_key:latest
DOCUSIGN_CLIENT_SECRET=docusign_client_secret:latest
DOCUSIGN_CONNECT_HMAC_SECRET=docusign_connect_hmac_secret:latest
```

As of the 2026-05-15 SCRUM-1655 verification pass, production was serving revision `arkova-worker-00559-n9t` with those bindings, flags, and `GCP_KMS_INTEGRATION_TOKEN_KEY=projects/arkova1/locations/global/keyRings/arkova-signing/cryptoKeys/integration-tokens` enabled. This PR makes that state durable for the next GitHub Actions deploy.

## DocuSign Admin Setup

1. Create or select the Arkova DocuSign app/integration key.
2. Add the worker OAuth callback URL to allowed redirect URIs.
3. Enable Connect for the account and subscribe to `envelope-completed`.
4. Enable HMAC signing and copy the HMAC key into `DOCUSIGN_CONNECT_HMAC_SECRET`.
5. Set the Connect payload format to JSON.
6. Point Connect to `https://<worker-host>/webhooks/docusign`.

## Required DocuSign-App Redirect URIs (SCRUM-3015) — BOTH are mandatory

Arkova has **two** DocuSign OAuth entry points and they use **different callback
paths**. DocuSign rejects the authorization request (`invalid_redirect_uri`) for any
path not registered on the integration key, so registering only the org-level URI
silently breaks the member-level flow.

Register **both** of these on the production DocuSign app
(DocuSign Admin → Apps and Keys → the Arkova integration key → Redirect URIs):

```
https://arkova-worker-270018525501.us-central1.run.app/api/v1/integrations/docusign/oauth/callback
https://arkova-worker-270018525501.us-central1.run.app/api/v1/integrations/docusign/member/oauth/callback
```

Source of truth in code (do not guess these — re-derive if routes move):

| Flow | Route file | Mount | Callback path |
|---|---|---|---|
| Org-level (admin connects the org) | `services/worker/src/api/v1/integrations/docusign-oauth.ts` (`buildRedirectUri`) | `services/worker/src/index.ts` → `app.use('/api/v1/integrations', … docusignOAuthRouter)` | `/api/v1/integrations/docusign/oauth/callback` |
| Member-level (SCRUM-2044) | `services/worker/src/api/v1/integrations/docusign-member-oauth.ts` (`buildRedirectUri`) | `services/worker/src/index.ts` → `app.use('/api/v1/integrations', … docusignMemberOAuthRouter)` | `/api/v1/integrations/docusign/member/oauth/callback` |

Both builders derive the origin from the **request** (`x-forwarded-proto` /
`x-forwarded-host`, falling back to `Host`), not from an env var. Consequences:

- The registered host must match the host the browser is redirected through. Today
  that is the Cloud Run URL above (`WORKER_PUBLIC_URL` in `deploy-worker.yml`).
- If the worker is ever fronted by another hostname (custom domain, tunnel, staging
  tag URL), **that host's two URIs must be registered as well** — otherwise OAuth
  fails only on that host.
- Demo (`account-d.docusign.com`) and production (`account.docusign.com`) are
  separate DocuSign apps. Registering the URIs on the demo app does **not** register
  them on the production app; `DOCUSIGN_DEMO=false` switches only the OAuth account
  server (`getAuthBase()` in `services/worker/src/integrations/oauth/docusign.ts`).

Note: the eSignature REST base is **not** affected by `DOCUSIGN_DEMO`. It is the
per-connection `base_uri` returned by `/oauth/userinfo` and persisted in
`org_integrations.base_uri` (migration 0306) / `member_integrations.base_uri` (0320).
A connection created while `DOCUSIGN_DEMO=true` keeps `https://demo.docusign.net`
forever until the org re-runs OAuth — see the switch-on checklist below.

## Production Switch-On Checklist (DOCUSIGN_DEMO=false)

Run in this order. Steps 2–5 are the ones that the flag flip alone does **not** do.

1. **Merge + deploy the flag flip.** `DOCUSIGN_DEMO=false` in
   `.github/workflows/deploy-worker.yml` (PR #1668). Confirm the new revision is
   serving: `gcloud run services describe arkova-worker --region us-central1
   --format='value(status.latestReadyRevisionName)'` and `/health` green.
2. **Re-run the org OAuth connect.** Existing production rows still point at the
   demo environment. As of 2026-07-22 prod (`vzwyaatejekddvltxyye`) has exactly one
   active DocuSign connection — org `40383eb2-f1cd-4a85-8099-afafff95e5cf`,
   `base_uri = https://demo.docusign.net` — and zero `member_integrations` DocuSign
   rows. That org **must** re-run the connect flow after the flip so a production
   `base_uri` (`https://<account>.docusign.net`) and a production refresh token are
   persisted. Verify:

   ```sql
   SELECT org_id, account_id, base_uri, connected_at, revoked_at
   FROM org_integrations
   WHERE provider = 'docusign' AND revoked_at IS NULL;
   ```

   `base_uri` must no longer be `https://demo.docusign.net`.
3. **Verify a Connect listener actually exists on the PRODUCTION account.**
   Auto-provisioning is fire-and-forget and has failed in production before (see
   "Connect listener provisioning failures" below). Check
   `integration_events` for `connect_listener_provisioned` (success) vs
   `connect_listener_failed` / `member_connect_listener_failed` (failure), then
   confirm on the DocuSign side.

   If auto-provision failed, create the listener manually:
   DocuSign Admin → **Connect** → Add Configuration → Custom:
   - **URL to publish to:** `https://arkova-worker-270018525501.us-central1.run.app/webhooks/docusign`
     (verified against `services/worker/src/index.ts` `app.use('/webhooks/docusign', …)`
     and `buildArkovaConnectConfig()`, which appends `/webhooks/docusign` to
     `WORKER_PUBLIC_URL`. It is **not** under `/api/v1/…`.)
   - **Enable log**, **Require acknowledgement**, **Send to all users**: on
   - **Envelope events:** `Completed` only
   - **Include HMAC signature:** on, with the key from Secret Manager
     `docusign_connect_hmac_secret` (`gcloud secrets versions access latest
     --project=arkova1 --secret=docusign_connect_hmac_secret`). It must match the
     worker's `DOCUSIGN_CONNECT_HMAC_SECRET` exactly or every delivery 401s.
   - **Payload format:** JSON, version `restv2.1`
4. **Confirm both redirect URIs** from the SCRUM-3015 section above are registered on
   the production integration key.
5. **Send a real test envelope** from the connected production account and confirm,
   end to end: webhook delivered (DocuSign Connect log shows `200`/`202`), an
   `ESIGN_COMPLETED` rule event exists, a `docusign.envelope_completed` job ran, and
   an anchor was created for the envelope.

## Connect listener provisioning failures (SCRUM-3014)

`provisionConnectListener()` runs fire-and-forget from both OAuth callbacks: it must
never break the connect flow, so a failure leaves the org showing "Connected" while
no webhook ever arrives. Until SCRUM-3014 the failure was also undiagnosable — prod
`integration_events` rows carried only
`{"error":"DocuSign Connect create failed"}` (four of them, 2026-06-29 → 2026-07-22),
with no HTTP status and no vendor error code.

The failure path now:

- logs the real DocuSign HTTP status plus a bounded, PII-scrubbed vendor `detail`
  (§1.6A-safe — never a raw response body);
- persists them on the `connect_listener_failed` / `member_connect_listener_failed`
  `integration_events` row as `docusign_status` / `docusign_detail`;
- captures the exception in Sentry (`connector_id=docusign`,
  `stage=connect_provision`, `flow=org|member`, `docusign_status=<code>`);
- flips `connector_alert_state` to `degraded` for the org, which the queue digest
  counts as a failed connector. That state is **sticky**: the 15-min connector-health
  cron classifies from `revoked_at` only, so it deliberately does not reset a
  `degraded` row. A successful (re)provision clears it back to `connected`.

Triage query:

```sql
SELECT created_at, event_type, details
FROM integration_events
WHERE provider = 'docusign' AND event_type LIKE '%connect_listener%'
ORDER BY created_at DESC
LIMIT 20;
```

Read `details->>'docusign_status'` and `details->>'docusign_detail'` first — they
carry DocuSign's own error code. Common causes to check against that code: Connect
not enabled on the account plan, the consenting user lacking account-admin rights,
or an account-level Connect configuration limit. If the listener cannot be created
by API, fall back to the manual Connect configuration in step 3 above; the connector
stays degraded until a reprovision succeeds
(`POST /api/v1/integrations/docusign/connect/reprovision`).

### Known failure signatures

| `docusign_status` / `docusign_detail` | Cause | Fix |
|---|---|---|
| `400` — `INVALID_REQUEST_PARAMETER`, `Unsupported 'events' field. "deliveryMode": "SIM" and "eventData": {"version": "restv2.1"} are required for the 'events' field` | The provisioning payload sent the modern `events` field without the `deliveryMode`/`eventData` pair DocuSign requires alongside it. Every org connect failed; no Connect listener was ever created by API in production. | **Fixed in code** (PR #1690, `bffde484c`, live in prod). Nothing account-side to change — just re-run the connect flow. |
| No `docusign_status` / `docusign_detail` at all, only `{"error":"DocuSign Connect create failed"}` | The worker revision predates the SCRUM-3014 diagnostics. | Redeploy; retry. The status/detail then appear on the row. |
| Listener created, but every delivery returns `401 invalid_signature` | HMAC key mismatch — see below. | Align the account-side key, or enable `integratorManaged`. |

### The HMAC key is ACCOUNT-SIDE, not something provisioning installs

`DOCUSIGN_CONNECT_HMAC_SECRET` is what `/webhooks/docusign` verifies
`X-DocuSign-Signature-1` against. It is **not** pushed to DocuSign by
`provisionConnectListener()`: DocuSign's `ConnectCustomConfiguration` resource has
no `hmacSecret` field, so a payload carrying one is accepted and the field silently
dropped. (The worker sent exactly that until this was corrected — the code read as
though provisioning configured the signing key while DocuSign was signing with a
completely different one.)

`includeHMAC: "true"` only tells DocuSign *to* sign. **Which** key it signs with is
account state, so one of these must be true before deliveries verify:

1. **Per-account (current model, manual).** A DocuSign admin on the *customer's*
   account creates a Connect HMAC key (DocuSign Admin → Connect → Keys) and its
   value is stored in Secret Manager `docusign_connect_hmac_secret_prod`. Works, but
   does not scale past one customer — every new org needs a manual key copy, and a
   mismatch is silent (listener healthy, deliveries 401).
2. **Partner-managed (`integratorManaged`) — the multi-tenant answer, NOT YET BUILT.**
   DocuSign's "HMAC for Partners" flag makes Connect sign every customer account's
   deliveries with the HMAC key registered on the account that owns
   `DOCUSIGN_INTEGRATION_KEY` — i.e. the key the worker already holds. API-only;
   it cannot be set from the DocuSign admin console.

   Deliberately not shipped yet, because turning it on safely needs more than a
   payload field:
   - an HMAC key must first exist on the integration-key account, or deliveries
     flip onto a key nobody configured and every webhook 401s;
   - it is a **one-way door** as the payload is currently shaped — a PUT that
     omits the field cannot turn it back off, so rollback would be a DocuSign
     admin action;
   - `provisionConnectListener()` only runs on OAuth connect and the reprovision
     endpoint, so enabling it does nothing for already-connected orgs, leaving a
     split where some orgs sign with Arkova's key and some do not;
   - the listener-drift checker (`jobs/docusign-listener-drift.ts`) has no notion
     of `integratorManaged`, so it would report **in sync** for every mismatched
     listener — exactly the silent-failure shape this section exists to prevent.

   A story that adds it must cover all four, plus reprovisioning existing
   listeners.

## Verification

1. Run the safe production route smoke. This verifies invalid HMAC rejection and signed unknown-account acknowledgement without creating integration rows, rule events, or jobs.

   ```bash
   WORKER_URL=https://arkova-worker-270018525501.us-central1.run.app \
   DOCUSIGN_CONNECT_HMAC_SECRET="$(gcloud secrets versions access latest --project=arkova1 --secret=docusign_connect_hmac_secret)" \
   npm --prefix services/worker run smoke:docusign -- --mode=orphan
   ```

   Expected result: `invalid_hmac_rejected` passes with HTTP `401 invalid_signature`, `signed_unknown_account_orphaned` passes with HTTP `200 orphaned`, and `duplicate_delivery_deduped` is skipped because unknown accounts return before nonce insert.

2. Connect a sandbox DocuSign account through Arkova OAuth. Production currently has no active `provider=docusign` row to reuse, so prod accepted+duplicate smoke cannot run until this exists.
3. Create or enable one Arkova rule for DocuSign completed envelopes in the connected sandbox org.
4. Configure DocuSign Connect at the account/organization level to `https://arkova-worker-270018525501.us-central1.run.app/webhooks/docusign`, enable JSON payloads, and enable HMAC signing with the same `docusign_connect_hmac_secret` value.
5. Complete sandbox envelopes from two distinct authorized DocuSign senders on that same DocuSign account. Confirm both produce sanitized `ESIGN_COMPLETED` events and retryable `docusign.envelope_completed` jobs.
6. Run the accepted + duplicate smoke only after the connected sandbox account and Arkova rule exist. This mode can enqueue real work, so it requires `--allow-processing`.

   ```bash
   WORKER_URL=https://arkova-worker-270018525501.us-central1.run.app \
   DOCUSIGN_CONNECT_HMAC_SECRET="$(gcloud secrets versions access latest --project=arkova1 --secret=docusign_connect_hmac_secret)" \
   npm --prefix services/worker run smoke:docusign -- \
     --mode=accepted-duplicate \
     --account-id="$DOCUSIGN_SANDBOX_ACCOUNT_ID" \
     --allow-processing
   ```

   Expected result: `invalid_hmac_rejected` passes with HTTP `401`, `signed_known_account_accepted` passes with HTTP `202`, and replaying the exact same payload returns HTTP `200 duplicate`.

   For protected staging Cloud Run targets, set `WORKER_BEARER_TOKEN` from an identity token. Keep it in the environment, not argv.

   ```bash
   WORKER_URL=https://pr-783---arkova-worker-staging-kvojbeutfa-uc.a.run.app \
   WORKER_BEARER_TOKEN="$(gcloud auth print-identity-token --audiences=https://arkova-worker-staging-kvojbeutfa-uc.a.run.app)" \
   DOCUSIGN_CONNECT_HMAC_SECRET="$(gcloud secrets versions access latest --project=arkova1 --secret=docusign-connect-hmac-secret-pr712-staging)" \
   DOCUSIGN_SMOKE_ACCOUNT_ID="$DOCUSIGN_SANDBOX_ACCOUNT_ID" \
   npm --prefix services/worker run smoke:docusign -- \
     --mode=accepted-duplicate \
     --account-id="$DOCUSIGN_SANDBOX_ACCOUNT_ID" \
     --allow-processing
   ```

7. Force the eSignature document fetch to return `503`; the job should retry and eventually move to `dead` after five attempts.
8. Update HANDOFF, Confluence, and Jira with the Cloud Run revision, `/health` git SHA, smoke JSON, two-sender event IDs, job IDs, and any bug-log links. Only then tick SCRUM-1648 AC/DoD.

## 2026-05-27 Evidence Snapshot (Sprint 3 Day 1 re-smoke)

- Production worker SHA `ef58aad029f3ea17a4550ab7c5f7dcb2cec5c18f`, deployed 2026-05-27T16:34Z. `/health` green: database ok, anchoring ok, kms ok.
- DocuSign sandbox OAuth re-provisioned at 2026-05-27T17:35:04Z for org `40383eb2` / account `cf5cfb61-bdd4-4d78-829c-7a3eba8a3e02` / label "Arkova" / `base_uri=https://demo.docusign.net`. Prior rows (revoked 2026-05-20) superseded.
- Orphan smoke PASS: invalid_hmac_rejected 401, signed_unknown_account_orphaned 200.
- Accepted-duplicate smoke PASS: invalid_hmac_rejected 401, signed_known_account_accepted 202, duplicate_delivery_deduped 200.
- Context: 23 PRs merged since prior verification (2026-05-15), including PR #840 (token path changes). No DocuSign regressions detected.

## 2026-05-15 Evidence Snapshot

- Production revision `arkova-worker-00559-n9t` has the DocuSign flags/secrets and `GCP_KMS_INTEGRATION_TOKEN_KEY` bound. `/health` is green with `git_sha=6899f10aba7e233755385edfd2b28112129e41d7`.
- Production DocuSign sandbox OAuth completed for the Arkova org; `org_integrations` has one active `provider=docusign` row with `base_uri=https://demo.docusign.net` and token encryption through `integration-tokens`.
- Production accepted+duplicate smoke passed twice against the connected account: invalid HMAC `401 invalid_signature`, signed known account `202 ok`, replay `200 duplicate`.
- Production SCRUM-1655 sandbox rule `7c440d28-ba2b-4b30-a834-8f0d4df30ac1` processed two `ESIGN_COMPLETED` events from distinct sender emails (`scrum-1655-prod-sandbox-1@arkova.ai`, `scrum-1655-prod-sandbox-2@arkova.ai`) to `PROCESSED`; dispatcher wrote two `SUCCEEDED` executions with `queued_for_review` / `review_queue`.
- Staging Supabase has active DocuSign integrations, enabled `ESIGN_COMPLETED` rules, and one org/account with two distinct sender emails processed in the last 30 days (`PROCESSED`, latest 2026-05-15T07:13:22Z).
- DocuSign-enabled staging tag `pr-783` (`arkova-worker-staging-00087-kim`, health `git_sha=5b4009bd9eebd8e80d8c2991c39066bc9212897c`) passed accepted+duplicate smoke: invalid HMAC `401 invalid_signature`, signed known account `202 ok`, replay `200 duplicate`.
- Shared staging 100% traffic is pinned to older revision `arkova-worker-staging-00043-hk8`, which lacks the DocuSign flag; use the tagged staging URL for this smoke until shared staging is promoted.

## Operational Notes

- Unknown connected accounts return `200 { orphaned: true }` to avoid DocuSign retry storms.
- Missing `DOCUSIGN_CONNECT_HMAC_SECRET` returns `503` so Connect retries after the secret is fixed.
- `WORKER_BEARER_TOKEN` is supported for protected Cloud Run staging targets and is intentionally env-only.
- Raw webhook payloads and signed PDFs are not persisted by the webhook route.
- This story includes additive migration `0306_docusign_org_integrations_base_uri.sql` (`org_integrations.base_uri`); verify it before deployment along with the existing `org_integrations`, `organization_rule_events`, and `job_queue` paths.

## Disaster Recovery (SOC 2 CC7.3)

Story: SCRUM-2071 / DS-DR-01.

### 1. Incident Detection

#### Connector health alerts (SCRUM-2041)

The `connector-health-check` cron runs every 15 minutes via Cloud Scheduler (`POST /jobs/connector-health-check`). It reads every `org_integrations` row and classifies each connector as `connected`, `degraded`, or `disconnected`.

Sentry events fire on state transitions:

| Transition | Sentry level | Example message |
|---|---|---|
| connected -> degraded | `warning` | `Connector docusign degraded: subscription_expiry` |
| connected -> disconnected | `error` | `Connector docusign disconnected: vendor_auth_revoked` |
| degraded/disconnected -> connected | `info` | `Connector docusign recovered: disconnected -> connected` |
| Still degraded/disconnected after 1h | same as current state | `Connector docusign still disconnected: vendor_auth_revoked` |

Sentry tags on every alert: `connector_id`, `connector_state`, `health_reason`. The `org_id` is in `extra` (not tags) to avoid high-cardinality tag explosion. The `last_error` field is redacted in Sentry (`[redacted]`) to prevent PII leakage.

Alert state is persisted in `connector_alert_state` (migration 0317, RLS deny-all for anon/authenticated). The 1-hour cooldown (`RE_FIRE_WINDOW_MS = 60 * 60 * 1000`) prevents alert storms while still re-firing for persistent failures. Demo connectors are excluded.

#### Health state definitions

The `classify()` function in `connector-health.ts` determines state from four inputs:

- **connected**: Integration row exists, `revoked_at` is null, no degraded subscription, no recent failed rule executions.
- **degraded** (reason `subscription_expiry`): `connector_subscriptions.status = 'degraded'` — the vendor watch channel or subscription is past its expiry without successful renewal.
- **degraded** (reason `processing_failure`): Recent `FAILED` or `DLQ` rule executions correlated to this connector's vendor events.
- **disconnected** (reason `vendor_auth_revoked`): `org_integrations.revoked_at` is non-null. The org revoked the connection or the admin disconnected it.
- **disconnected** (reason `null`): No `org_integrations` row exists for this connector at all.

**V1 limitation**: The connector-health-alert cron (SCRUM-2041) classifies health from `revoked_at` only — it does not use the full `classify()` inputs for degraded states (subscription_expiry, processing_failure). This means the cron will catch disconnections but may miss degraded states. The connector health dashboard API (`GET /api/v1/connector-health`) uses the full classify logic.

#### Reconciliation gap alerts (SCRUM-2042)

The `docusign-reconciliation` cron runs daily at 06:00 UTC (`POST /jobs/docusign-reconciliation`). For each active DocuSign integration:

1. Refreshes the OAuth token (prevents 30-day idle expiry as a side effect).
2. Polls the DocuSign Envelopes API for envelopes completed in the last 24 hours (paginated, up to 10 pages of 100).
3. Diffs envelope IDs against `docusign_webhook_nonces` to find envelopes never delivered via Connect.
4. Inserts gap rows into `docusign_reconciliation_gaps` (migration 0318, unique on `(integration_id, envelope_id)`).
5. Fires a Sentry `warning` per newly inserted gap:

   Message: `DocuSign reconciliation gap: envelope {envelopeId} completed but never delivered`

   Tags: `integration_id`, `envelope_status`. Extra: `org_id`, `account_id`, `completed_at`, `detected_at`.

A single gap is usually benign (transient Connect delivery failure that resolved on DocuSign retry). Multiple gaps in one reconciliation run indicate a Connect delivery problem or listener misconfiguration.

#### Listener drift alerts (SCRUM-2098)

The `docusign-listener-drift` cron runs hourly at minute 15 UTC (`POST /jobs/docusign-listener-drift`). It reads DocuSign Connect listener configuration for every active DocuSign integration and compares it with Arkova's expected provisioning payload. Detection is read-only: it does not create, update, or delete DocuSign listeners.

Sentry fires a `warning` when the expected listener is missing or has config drift:

- Missing listener for the expected Arkova webhook URL
- Listener disabled (`allowEnvelopePublish` not true)
- HMAC signing disabled
- Required envelope or Connect events missing
- Wrong payload format or version

Sentry tags: `integration_id`, `org_id`. Extra: `account_id`, `reasons`, `detected_at`.

Normal output: `{ ok: true, integrations_checked: N, drift_detected: 0, in_sync: N, errors: [], drifts: [] }`. If `ok: false`, at least one integration could not be checked, usually due to token refresh or DocuSign Connect API failure. Scheduler retries transient failures with `30s,120s,2`.

#### Nonce sweep interpretation (SCRUM-2040)

The `nonce-sweep` cron runs daily at 04:00 UTC (`POST /jobs/nonce-sweep`). It sweeps all four webhook nonce tables (`docusign_webhook_nonces`, `drive_webhook_nonces`, `ats_webhook_nonces`, `microsoft_graph_webhook_nonces`) via the `sweep_webhook_nonces` RPC (migration 0316, service_role only). Default retention is 14 days.

Normal output: `{ ok: true, swept: { docusign_webhook_nonces: N, ... }, totalDeleted: N, errors: [] }`.

If `ok: false`, at least one table sweep failed (usually an RPC permission or connectivity issue). The `errors` array identifies which table and the error message. Partial failures do not affect healthy tables.

A `docusign_webhook_nonces` row count of zero in the sweep result (after expected webhook traffic) may indicate Connect has stopped delivering — cross-reference with the reconciliation cron output.

### 2. Recovery Procedures

#### 2.1 Token expiry recovery

**Symptom**: Reconciliation cron logs `token_refresh: DocuSign token refresh failed` errors. The connector health dashboard shows the integration as connected (tokens are encrypted at rest; the health check does not probe token validity).

**Root cause**: DocuSign refresh tokens expire after 30 days of non-use. If no envelopes complete and no reconciliation runs for 30+ days, the token becomes invalid. The reconciliation cron's token refresh (via `refreshDocusignAccessToken`) acts as a keep-alive, but if it was disabled or erroring for 30+ days, the token dies.

**Recovery steps**:

1. Confirm the failure. Check the `docusign-reconciliation` cron response or worker logs for `token_refresh` errors on the affected integration.
2. Verify the refresh token exists in Secret Manager:
   ```bash
   gcloud secrets versions access latest \
     --project=arkova1 \
     --secret=arkova-docusign-<ORG_ID>-<ACCOUNT_HASH>-refresh-token
   ```
   The secret name format is `arkova-docusign-{orgId}-{sha256(accountId).slice(0,32)}-refresh-token`.
3. If the token exists but is expired, the org admin must re-authorize. Navigate to the Arkova UI and trigger the DocuSign OAuth flow (`POST /api/v1/integrations/docusign/oauth/start`). This exchanges a fresh authorization code for new access + refresh tokens.
4. After re-authorization, verify the integration row in `org_integrations` has a current `connected_at`, null `revoked_at`, and a valid `token_secret_name`.
5. Manually trigger the reconciliation cron to confirm the new token works:
   ```bash
   curl -X POST https://<WORKER_URL>/jobs/docusign-reconciliation \
     -H "Authorization: Bearer $(gcloud auth print-identity-token --audiences=<CRON_OIDC_AUDIENCE>)"
   ```
6. Check the response for `token_refreshes > 0` and no errors on the affected integration.

#### 2.2 HMAC key mismatch recovery

**Symptom**: All DocuSign webhook deliveries return `401 { error: { code: "invalid_signature" } }`. DocuSign Connect logs show repeated delivery failures. The nonce table stops receiving new entries.

**Root cause**: The HMAC key configured in DocuSign Connect no longer matches the key(s) the worker uses for verification. This can happen after a DocuSign admin rotates the HMAC key in the DocuSign web console without updating the Arkova side.

**How HMAC verification works**: The webhook handler (`docusign.ts`) uses a lookup-first flow (SCRUM-2043). It resolves HMAC keys via `resolveHmacKeys()` from `docusign-hmac-helpers.ts`:
1. If the integration row has a non-empty `hmac_keys` JSONB array, use those keys.
2. Otherwise fall back to the global `DOCUSIGN_CONNECT_HMAC_SECRET` env var.

DocuSign signs payloads with ALL configured account-level HMAC keys and sends `X-DocuSign-Signature-1` through `-N`. The multi-key verifier (`verifyDocusignConnectHmacMultiKey`) accepts if ANY provided signature matches ANY configured key.

**Recovery steps**:

1. Confirm the mismatch. Check worker logs for `401` responses on `/webhooks/docusign`. Verify via the orphan smoke test:
   ```bash
   WORKER_URL=https://<WORKER_URL> \
   DOCUSIGN_CONNECT_HMAC_SECRET="<current_secret>" \
   npm --prefix services/worker run smoke:docusign -- --mode=orphan
   ```
   If `invalid_hmac_rejected` passes (returns 401), the env-var key is working for signing but the actual Connect delivery key differs.
2. Check what key DocuSign is actually using. In the DocuSign admin console, navigate to **Settings > Connect > HMAC** and note the active key(s).
3. **If per-org keys are in use** (`org_integrations.hmac_keys` is non-null): Use the HMAC rotation endpoint to add the correct key:
   ```
   POST /api/v1/integrations/docusign/{integrationId}/hmac/rotate
   ```
   This generates a new key (32 random bytes, base64-encoded) and appends it to the `hmac_keys` array (max 2 keys). Copy the returned `new_key` to the DocuSign Connect HMAC configuration. After DocuSign starts signing with the new key, retire the old one:
   ```
   POST /api/v1/integrations/docusign/{integrationId}/hmac/retire
   Body: { "retire_created_at": "<old_key_created_at>" }
   ```
   The last key cannot be retired (`cannot_retire_last_key`).
4. **If using the global env var**: Update `DOCUSIGN_CONNECT_HMAC_SECRET` in Secret Manager and redeploy the worker:
   ```bash
   echo -n "<new_hmac_key>" | gcloud secrets versions add docusign_connect_hmac_secret \
     --project=arkova1 --data-file=-
   ```
   Then redeploy via the standard deploy workflow. During the window between Secret Manager update and worker redeploy, deliveries will continue to fail.
5. After recovery, re-run the orphan smoke to confirm HMAC verification is green.

#### 2.3 Connect listener recovery

**Symptom**: No new `docusign_webhook_nonces` rows despite active envelope completions. Reconciliation cron detects gaps. DocuSign Connect delivery logs (in DocuSign admin console) show no recent delivery attempts.

**Root cause**: The Connect listener was deleted, disabled, or its URL was changed in the DocuSign admin console. Alternatively, the worker's public URL changed without updating Connect.

**Recovery steps**:

1. Verify the listener exists. In the DocuSign admin console, navigate to **Settings > Connect** and check for an "Arkova Connect" configuration pointing to `https://<WORKER_PUBLIC_URL>/webhooks/docusign`.
2. If the listener is missing or misconfigured, it can be re-provisioned automatically during OAuth re-authorization. The `provisionConnectListener()` function in `docusign.ts` is called during the OAuth callback flow. It:
   - Lists existing Connect configurations for the account.
   - If a configuration with matching `urlToPublishTo` exists, it updates it (PUT).
   - If none exists, it creates one (POST).
   - Sets envelope-completed event subscription, JSON format, HMAC signing enabled, and `requiresAcknowledgement: true`.
3. To re-provision without full re-auth (if tokens are still valid), trigger the OAuth start flow from the Arkova UI. The callback handler will re-provision Connect automatically.
4. Alternatively, manually configure Connect in the DocuSign admin following the DocuSign Admin Setup section above.
5. After re-provisioning, send a test envelope completion and verify a new `docusign_webhook_nonces` row appears and the webhook returns `202`.

#### 2.4 Integration disconnect recovery

**Symptom**: Connector health shows `disconnected` with reason `vendor_auth_revoked`. The `org_integrations` row has a non-null `revoked_at`.

**Root cause**: An org admin disconnected DocuSign through the Arkova UI (`POST /api/v1/integrations/docusign/disconnect`), or the DocuSign admin revoked the Arkova app's access from the DocuSign admin console.

**Recovery steps**:

1. Confirm the disconnect. Query the integration row:
   ```sql
   SELECT id, org_id, account_id, revoked_at, connected_at
   FROM org_integrations
   WHERE provider = 'docusign' AND org_id = '<ORG_ID>';
   ```
2. If `revoked_at` is set, the org must re-connect through the full OAuth flow:
   - Navigate to the Arkova connector setup wizard in the UI.
   - Click "Connect" on the DocuSign connector.
   - Complete the DocuSign OAuth consent flow.
   - The callback handler creates a new integration row (or upserts over the revoked one), provisions Connect, and stores encrypted tokens.
3. After re-connection, verify:
   - `org_integrations` has a new row with null `revoked_at` and current `connected_at`.
   - The connector health dashboard shows `connected`.
   - Run the orphan + accepted-duplicate smoke to confirm end-to-end flow.
4. If the disconnect was caused by DocuSign admin revoking the Arkova app: the DocuSign admin must first re-grant access to the Arkova integration key in the DocuSign Apps and Keys settings before the Arkova OAuth flow will succeed.

#### 2.5 Reconciliation gap spike

**Symptom**: The `docusign-reconciliation` cron reports `gaps_inserted > 5` in a single run. Multiple Sentry warnings fire for undelivered envelopes.

**Root cause options**:
- DocuSign Connect experienced a delivery outage or the worker was unreachable during the lookback window.
- The Connect listener was temporarily misconfigured (wrong URL, disabled HMAC, etc.).
- The worker returned non-2xx responses during a deployment or outage, exhausting DocuSign's 45-attempt retry budget over 7 days.

**Investigation steps**:

1. Check the reconciliation result for error patterns:
   ```bash
   curl -X POST https://<WORKER_URL>/jobs/docusign-reconciliation \
     -H "Authorization: Bearer $(gcloud auth print-identity-token --audiences=<CRON_OIDC_AUDIENCE>)"
   ```
   Look at `integrations_checked`, `envelopes_polled`, `gaps_detected`, `gaps_inserted`, and the `errors` array.
2. Query the gap table for the affected time range:
   ```sql
   SELECT envelope_id, completed_at, detected_at, resolution
   FROM docusign_reconciliation_gaps
   WHERE org_id = '<ORG_ID>' AND resolution = 'pending'
   ORDER BY completed_at DESC;
   ```
3. Check DocuSign Connect delivery logs in the admin console for the affected account. Look for failed delivery attempts and the failure reason (timeout, 401, 500, etc.).
4. Cross-reference with worker deployment history. If a deployment was in progress during the gap window, the worker may have been briefly unreachable.

**Backfill steps**:

1. For each pending gap, determine if the envelope still needs processing:
   - If the envelope data is still needed, manually trigger the document-fetch job by inserting a `docusign.envelope_completed` job into `job_queue` with the envelope details from the gap row.
   - If the gap is stale (envelope no longer relevant), update the resolution:
     ```sql
     UPDATE docusign_reconciliation_gaps
     SET resolution = 'stale', resolved_at = now()
     WHERE id = '<GAP_ID>';
     ```
2. For bulk requeue of pending gaps:
   ```sql
   UPDATE docusign_reconciliation_gaps
   SET resolution = 'requeued', resolved_at = now()
   WHERE resolution = 'pending' AND org_id = '<ORG_ID>';
   ```
   Then enqueue the corresponding jobs. This requires manual scripting against the `submitJob` utility — there is no bulk-requeue cron endpoint yet.
3. After backfill, verify by re-running the reconciliation cron. The duplicates should now be skipped (`duplicates_skipped` counter in the result).

### 3. Escalation Path

#### Internal

- **Engineering lead (Carson)**: First escalation for all DocuSign integration issues. Owns the deploy path, Secret Manager access, and Cloud Run configuration.
- **On-call channel**: Sentry alerts route to the configured alert rules. Connector health alerts (`error` level for `disconnected`) and reconciliation gap warnings should trigger PagerDuty/Slack notifications per the org's Sentry alert configuration.

#### DocuSign Support

- **DocuSign Connect delivery issues**: Open a support case at https://support.docusign.com. Select "Connect" as the product area. Provide the account ID, the Connect configuration name ("Arkova Connect"), and the time range of failed deliveries.
- **OAuth / token issues**: DocuSign developer support at https://developers.docusign.com/support/. Provide the integration key (not the client secret) and the account ID.
- **Connect delivery SLA**: DocuSign retries failed deliveries up to 45 times over approximately 7 days with exponential backoff. After exhaustion, the envelope is dropped from the delivery queue. The reconciliation cron (SCRUM-2042) exists specifically to catch these dropped envelopes.

### 4. Rollback Procedures

#### 4.1 Roll back dual HMAC (`hmac_keys` column)

Migration 0319 added `org_integrations.hmac_keys`. Rolling back removes per-org HMAC key support; all integrations fall back to the global `DOCUSIGN_CONNECT_HMAC_SECRET` env var.

1. Ensure the global env var `DOCUSIGN_CONNECT_HMAC_SECRET` is set and matches the active DocuSign Connect HMAC key.
2. Apply the rollback migration:
   ```sql
   ALTER TABLE public.org_integrations DROP COLUMN IF EXISTS hmac_keys;
   NOTIFY pgrst, 'reload schema';
   ```
3. Redeploy the worker. The `resolveHmacKeys()` function will find no `hmac_keys` and fall back to the env var.
4. Verify webhook HMAC verification still works via the orphan smoke test.

#### 4.2 Roll back reconciliation table

Migration 0318 created `docusign_reconciliation_gaps`. Rolling back removes reconciliation gap tracking; the cron will error on the missing table.

1. Disable the Cloud Scheduler job for `docusign-reconciliation` to prevent cron errors.
2. Apply the rollback:
   ```sql
   DROP TABLE IF EXISTS public.docusign_reconciliation_gaps;
   NOTIFY pgrst, 'reload schema';
   ```
3. Redeploy the worker (or the cron route will 500 when the table is missing). Alternatively, comment out the `/docusign-reconciliation` cron route and deploy.
4. The DocuSign webhook handler itself is unaffected — it does not depend on the reconciliation table.

#### 4.3 Revert lookup-first handler order

SCRUM-2043 changed the webhook handler from verify-first to lookup-first (parse body -> resolve integration + per-org HMAC keys -> verify HMAC). Reverting requires redeploying the prior worker revision.

1. Identify the last known-good revision before the lookup-first change:
   ```bash
   gcloud run revisions list --service=arkova-worker --project=arkova1 \
     --region=us-central1 --sort-by=~CREATED --limit=10
   ```
2. Route traffic to the prior revision:
   ```bash
   gcloud run services update-traffic arkova-worker \
     --project=arkova1 --region=us-central1 \
     --to-revisions=<PRIOR_REVISION>=100
   ```
3. After rollback, per-org HMAC keys will not be used (the old code only reads the env var). Ensure `DOCUSIGN_CONNECT_HMAC_SECRET` is set.
4. Verify with the orphan smoke test to confirm the webhook handler is functional on the old revision.

### 5. RPO / RTO

| Metric | Target | Rationale |
|---|---|---|
| **RPO** (max acceptable gap in envelope processing) | **24 hours** | The reconciliation cron runs daily with a 24h lookback. Any envelope completed and not delivered within that window will be detected on the next run. DocuSign retries deliveries for up to 7 days before exhaustion, so most envelopes self-heal before the reconciliation window. |
| **RTO** (recovery time for a dead DocuSign connection) | **4 hours** (business hours) | Token expiry and HMAC mismatch can be resolved by an engineer with Secret Manager access in under 1 hour. Full re-authorization (org admin action required) may take longer depending on admin availability. The 15-minute health check interval means detection is within 15 minutes; the 4-hour target covers detection + diagnosis + recovery including admin coordination. |

**Worst case**: If the DocuSign integration is fully disconnected (revoked tokens, no Connect listener, org admin unavailable), RPO extends to the duration of the outage. The reconciliation cron will detect all gaps once the connection is restored, but envelopes completed more than 24 hours before the next reconciliation run after restoration require a manual backfill with an extended lookback window:

```bash
# Extended lookback example (7 days):
curl -X POST https://<WORKER_URL>/jobs/docusign-reconciliation \
  -H "Authorization: Bearer $(gcloud auth print-identity-token)" \
  -H "Content-Type: application/json" \
  -d '{"lookback_hours": 168}'
```

Note: The cron route does not currently accept a `lookback_hours` body parameter — the `reconcileDocusignGaps` function defaults to 24 hours. Extending the lookback requires a code change or a manual reconciliation script. This is a known limitation tracked for future work.
