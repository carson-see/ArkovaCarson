# ComputeID activation runbook (internal, operator-only)

_SCRUM-4495. Internal engineering notes, not the documentation record — the durable spec is the Confluence page for SCRUM-4495 (CLAUDE.md §4)._

Everything below the code is already merged and dark. This is the ordered list of things only an operator can do. **Nothing here is automated, and no value in it belongs in git.**

## Before you start

- Confirm `ENABLE_COMPUTEID_INTEGRATION` is still `false` in prod: `gcloud run services describe arkova-worker --region us-central1 --project arkova1 --format='value(spec.template.spec.containers[0].env)' | tr ',' '\n' | grep COMPUTEID`
- Values for both secrets come from Praveen (ComputeID). The CA PEM is `GET https://api.aicomputeid.com/v1/ca/cert`; it must be the X.509 **certificate** PEM — `config.ts` refuses a bare public-key pin in production.

## 1. Create the two Secret Manager entries

`deploy-worker.yml` names both in `--set-secrets`, and Cloud Run rejects the whole revision if either is missing. The workflow's **Preflight required Secret Manager entries** step fails fast and prints these commands, so a deploy cannot get half-way before discovering the gap.

```bash
printf %s "<webhook HMAC secret from Praveen>" \
  | gcloud secrets create computeid-webhook-secret \
      --project=arkova1 --replication-policy=automatic --data-file=-

gcloud secrets create computeid-ca-cert-pem \
  --project=arkova1 --replication-policy=automatic --data-file=/path/to/ca.pem
```

`COMPUTEID_WEBHOOK_SECRET` accepts a comma-separated list, so rotation is add-new → tell ComputeID → retire-old with no window where deliveries 401.

## 2. Deploy

Merging this PR deploys the worker (still dark — `ENABLE_COMPUTEID_INTEGRATION=false`). Confirm the preflight step passed and the serving revision carries both names.

## 3. Register the prod webhook with ComputeID

```bash
curl -sS -X POST https://api.aicomputeid.com/v1/webhooks/register \
  -H 'Content-Type: application/json' -H "X-API-Key: <Arkova's ComputeID key>" \
  -d '{"url":"https://api.arkova.ai/api/v1/webhooks/computeid","events":["passport.revoked","passport.suspended","passport.reinstated"]}'
```

Then ask Praveen to fire `POST /v1/webhooks/test`; the receiver answers `200 {ok:true,ignored:true}` for the `test` event **only once the flag is on** — before that it answers `503 vendor_gated`, which is the expected pre-activation response, not a failure.

> `/v1/webhooks/register` has no auth, no URL validation and no delete path (verified 2026-09-07). Treat the registration as one-way until ComputeID ships a delete/rotate route (SCRUM-4498).

## 4. Run the golden test

```bash
cd services/worker && npx vitest run src/integrations/computeid/receipt-verifier.golden.test.ts
```

This verifies the two REAL partner-signed receipts against the committed CA fixture. It is the hard gate in front of step 5 and needs no network and no secrets. If the CA you loaded into Secret Manager differs from `__fixtures__/computeid-ca.pem`, ComputeID has rotated and this PR's pin is stale — stop and re-capture before flipping anything.

## 5. Flip the flag

Change the single `ENABLE_COMPUTEID_INTEGRATION=false` to `true` in `.github/workflows/deploy-worker.yml`'s `--set-env-vars` and merge. Boot-time validation refuses to start the worker if either secret is missing or the CA pin is unusable, so a wrong secret fails loudly at deploy rather than silently at request time.

## 6. Verify

- `curl -s https://api.arkova.ai/api/health` → healthy, and the revision is the new SHA.
- An unsigned POST to `/api/v1/webhooks/computeid` → `401 invalid_signature` (was `503 vendor_gated`).
- One real admission: `POST /api/v1/agents/computeid/admit` with a fresh receipt (fetch and admit inside five minutes), using an org API key with `agents:manage`. Expect `201` with a binding and a one-time agent key.

## 7. Bind the re-check (do this in the same motion as step 5)

The hourly re-check is the ONLY safety net for a lost revocation — ComputeID has no webhook retry — and Carson committed to Praveen that a lost delivery is caught within the hour. It needs one more secret and one Scheduler job:

```bash
# a) the partner API key the re-check authenticates with
printf %s "<Arkova's ComputeID API key>" \
  | gcloud secrets create computeid-api-key --project=arkova1 \
      --replication-policy=automatic --data-file=-
# b) add to deploy-worker.yml --set-secrets (and to the preflight list):
#      COMPUTEID_API_KEY=computeid-api-key:latest
# c) the trigger
gcloud scheduler jobs create http computeid-passport-recheck \
  --project=arkova1 --location=us-central1 --schedule='17 * * * *' --time-zone=UTC \
  --uri='https://arkova-worker-270018525501.us-central1.run.app/jobs/computeid-passport-recheck' \
  --http-method=POST --attempt-deadline=600s \
  --oidc-service-account-email=270018525501-compute@developer.gserviceaccount.com \
  --oidc-token-audience='https://arkova-worker-270018525501.us-central1.run.app'
```

`17 * * * *`, not `0 * * * *`: every `/jobs/*` route shares one per-IP rate limiter and the top-of-hour pile-up already costs other jobs 429s. Until (a) and (b) are done the route answers `200 {"skipped":true,"reason":"api_key_unconfigured"}` — harmless, but it is not protecting anything.

## Rollback

Set `ENABLE_COMPUTEID_INTEGRATION=false` and deploy. Both surfaces answer `503 vendor_gated` at the middleware before any parsing or auth work, and the re-check returns `{skipped:true}`. No data migration, nothing to undo. Agents already admitted keep their keys — the flag gates admission and revocation processing, not existing authentication — so if the reason for rolling back is a compromised passport, **also** deactivate that agent's keys directly.
