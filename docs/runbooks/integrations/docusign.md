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

As of the 2026-05-15 SCRUM-1655 verification pass, production was serving revision `arkova-worker-00559-n9t` with those bindings, flags, and `GCP_KMS_INTEGRATION_TOKEN_KEY=projects/arkova1/locations/global/keyRings/arkova-signing/cryptoKeys/integration-tokens` enabled. This PR makes that state durable for the next GitHub Actions deploy.

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

## Disaster Recovery And Rollback

Story: SCRUM-2071 — DocuSign integration disaster recovery runbook.

Use this section when DocuSign OAuth, Connect intake, document fetch, or
downstream rules processing threatens tenant isolation, sustained retries, or
SOC 2 evidence completeness. Do not delete integration rows, webhook nonce
rows, job rows, or audit evidence during incident response.

### Severity Triggers

| Trigger | Impact | First action |
|---|---|---|
| Invalid or missing `DOCUSIGN_CONNECT_HMAC_SECRET` | Connect deliveries fail or retry. | Rotate/restore the Secret Manager value, redeploy worker, run orphan smoke. |
| HMAC-valid payloads fail validation | Permanent vendor schema mismatch or bad account configuration. | Confirm `webhook_dlq` rows contain only provider, reason, external id, and payload hash; do not persist raw payloads. |
| OAuth token refresh fails for connected accounts | Completed envelopes cannot fetch signed documents. | Pause DocuSign webhook intake if retries accelerate, then validate token secret and OAuth app credentials. |
| eSignature API returns sustained `429` or `5xx` | Document-fetch jobs retry and may park as `dead`. | Keep jobs queued, reduce cron/job concurrency, respect `Retry-After`, and avoid manual replay storms. |
| Same DocuSign account maps to multiple Arkova orgs | Cross-tenant routing risk. | Leave webhook failing closed, page engineering lead, and do not manually choose an org. |
| Bad deploy changes webhook, queue, or rule dispatch behavior | Incorrect rules events or missed reviews. | Roll back Cloud Run to last known-good revision and keep DB state intact. |

### Kill Switches

Prefer feature flags over data mutation. These stop new intake while preserving
queued work and evidence for recovery.

```bash
ENABLE_DOCUSIGN_WEBHOOK=false
ENABLE_DOCUSIGN_OAUTH=false
```

Operational sequence:

1. Announce incident in the engineering channel with timestamp, affected
   environment, suspected trigger, and current PR/revision SHA.
2. Disable `ENABLE_DOCUSIGN_WEBHOOK` first if Connect intake is unsafe.
3. Disable `ENABLE_DOCUSIGN_OAUTH` only if new account connections are unsafe.
4. Redeploy the worker through the human-owned deploy path.
5. Confirm `/health` reports the expected git SHA and the worker revision has
   the new flag state.
6. Run the orphan smoke. Expected result while webhook intake is disabled is a
   controlled rejection, not a DB write.
7. Leave existing `job_queue` rows untouched unless the incident commander
   approves a specific replay or cancellation plan.

### Cloud Run Rollback

Use Cloud Run revision rollback when a deploy regression is suspected and the
previous revision is still known-good.

```bash
gcloud run revisions list \
  --project=arkova1 \
  --region=us-central1 \
  --service=arkova-worker \
  --format='table(metadata.name,status.conditions[0].status,metadata.annotations.client\\.knative\\.dev/user-image)'

gcloud run services update-traffic arkova-worker \
  --project=arkova1 \
  --region=us-central1 \
  --to-revisions=<KNOWN_GOOD_REVISION>=100
```

After rollback:

1. Capture the command output, revision name, image digest, and timestamp.
2. Call `/health` and record `git_sha`.
3. Run safe orphan smoke against production or the affected staging tag.
4. Query recent `job_queue` rows for `type='docusign.envelope_completed'` and
   confirm retries are not accelerating.
5. Post the evidence links in Jira and the incident record.

### Secret Recovery

If a DocuSign secret is suspected invalid, rotate in DocuSign first, then update
Secret Manager. Never paste cleartext secrets into Jira, Confluence, GitHub, or
terminal transcripts copied into evidence.

```bash
gcloud secrets versions add docusign_connect_hmac_secret \
  --project=arkova1 \
  --data-file=/path/to/local-secret-file
```

Then redeploy the worker and run:

```bash
WORKER_URL=https://arkova-worker-270018525501.us-central1.run.app \
DOCUSIGN_CONNECT_HMAC_SECRET="$(gcloud secrets versions access latest --project=arkova1 --secret=docusign_connect_hmac_secret)" \
npm --prefix services/worker run smoke:docusign -- --mode=orphan
```

Delete any local scratch file containing the secret after the new version is
confirmed live.

### Recovery Validation

Recovery is not complete until all applicable checks pass:

1. `invalid_hmac_rejected` returns `401 invalid_signature`.
2. Signed unknown account returns `200 orphaned` and creates no rule event or
   document-fetch job.
3. Known connected account returns accepted response and creates exactly one
   sanitized `ESIGN_COMPLETED` event plus one retryable document-fetch job.
4. Exact replay returns `200 duplicate`.
5. `webhook_dlq` contains only sanitized failure metadata; no raw Connect body,
   signed PDF bytes, refresh tokens, or sender PII beyond approved fields.
6. Queued document-fetch failures either recover or park according to the
   `job_queue` retry policy without manual data deletion.
7. Dashboard/Sentry alerts clear or are explicitly linked to a follow-up Jira
   defect.

### Evidence Checklist

For SOC 2 CC7.3 closeout, attach the following to Jira and Confluence:

- Incident start/end timestamps in UTC.
- Affected environment and Cloud Run service/revision.
- PR head SHA or deployed `/health` `git_sha`.
- Feature-flag or rollback command output.
- Smoke command output with secrets redacted.
- Counts for accepted, orphaned, duplicate, failed, and dead DocuSign jobs.
- Any `webhook_dlq` row ids needed for investigation, with sanitized reasons.
- Owner who approved re-enable/replay.
- Follow-up Jira links for any unresolved defects or policy exceptions.

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
