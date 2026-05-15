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
DOCUSIGN_DEMO=true
ENABLE_DOCUSIGN_OAUTH=true
ENABLE_DOCUSIGN_WEBHOOK=true
```

Do not paste refresh tokens into logs, tickets, or Confluence. Refresh tokens are encrypted through `GCP_KMS_INTEGRATION_TOKEN_KEY` before persistence in `org_integrations.encrypted_tokens`.

The worker deploy workflow binds the production Secret Manager resources as:

```bash
DOCUSIGN_INTEGRATION_KEY=docusign_integration_key:latest
DOCUSIGN_CLIENT_SECRET=docusign_client_secret:latest
DOCUSIGN_CONNECT_HMAC_SECRET=docusign_connect_hmac_secret:latest
```

As of the 2026-05-14 SCRUM-1655 verification pass, production was manually updated to serving revision `arkova-worker-00556-m5l` with those bindings and flags enabled. This PR makes that state durable for the next GitHub Actions deploy.

## DocuSign Admin Setup

1. Create or select the Arkova DocuSign app/integration key.
2. Add the worker OAuth callback URL to allowed redirect URIs.
3. Enable Connect for the account and subscribe to `envelope-completed`.
4. Enable HMAC signing and copy the HMAC key into `DOCUSIGN_CONNECT_HMAC_SECRET`.
5. Set the Connect payload format to JSON.
6. Point Connect to `https://<worker-host>/webhooks/docusign`.

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

## 2026-05-15 Evidence Snapshot

- Production revision `arkova-worker-00556-m5l` has the DocuSign flags/secrets bound and safe orphan smoke passed: invalid HMAC `401 invalid_signature`, signed unknown account `200 orphaned`.
- Production Supabase currently has 0 active `provider=docusign` integrations and 0 `ESIGN_COMPLETED` rules, so prod accepted+duplicate smoke is intentionally not run there.
- Staging Supabase has active DocuSign integrations, enabled `ESIGN_COMPLETED` rules, and one org/account with two distinct sender emails processed in the last 30 days (`PROCESSED`, latest 2026-05-15T07:13:22Z).
- DocuSign-enabled staging tag `pr-783` (`arkova-worker-staging-00087-kim`, health `git_sha=5b4009bd9eebd8e80d8c2991c39066bc9212897c`) passed accepted+duplicate smoke: invalid HMAC `401 invalid_signature`, signed known account `202 ok`, replay `200 duplicate`.
- Shared staging 100% traffic is pinned to older revision `arkova-worker-staging-00043-hk8`, which lacks the DocuSign flag; use the tagged staging URL for this smoke until shared staging is promoted.

## Operational Notes

- Unknown connected accounts return `200 { orphaned: true }` to avoid DocuSign retry storms.
- Missing `DOCUSIGN_CONNECT_HMAC_SECRET` returns `503` so Connect retries after the secret is fixed.
- `WORKER_BEARER_TOKEN` is supported for protected Cloud Run staging targets and is intentionally env-only.
- Raw webhook payloads and signed PDFs are not persisted by the webhook route.
- New migrations were not required for this story; it uses `org_integrations`, `organization_rule_events`, and `job_queue`.
