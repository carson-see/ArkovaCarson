# SEC-HARDEN-02 — Migrate runtime secrets from Cloud Run env vars to GCP Secret Manager

**Jira:** [SCRUM-1055](https://arkova.atlassian.net/browse/SCRUM-1055)
**Parent epic:** [SCRUM-1041 SEC-HARDEN](https://arkova.atlassian.net/browse/SCRUM-1041)
**Executor:** Carson (human — GCP console + CLI). Worker deploys are human-gated per `memory/feedback_worker_hands_off.md`.
**Status:** Runbook + audit plan documented, migration pending.

---

## Goal

Every runtime secret referenced in [`docs/reference/ENV.md`](../../reference/ENV.md) lives in GCP Secret Manager with IAM binding to the worker's service account `270018525501-compute@developer.gserviceaccount.com`. Zero secrets in `--set-env-vars`, zero secrets in committed files, zero secrets in chat.

---

## Audit — current state (2026-04-23)

Snapshot derived from `.github/workflows/deploy-worker.yml` + `docs/reference/ENV.md`. Re-run the audit at rotation time with:

```bash
# List current Cloud Run env vars (filter for anything that smells secret).
gcloud run services describe arkova-worker --region us-central1 \
  --format='yaml(spec.template.spec.containers[0].env)' | \
  egrep -i 'key|secret|token|password|wif|hmac' || echo "clean"

# List current Cloud Run --set-secrets references.
gcloud run services describe arkova-worker --region us-central1 \
  --format='yaml(spec.template.spec.containers[0].env)' | grep -A1 valueFrom
```

### Secrets needing Secret Manager paths (at minimum)

| Env var | Current storage | Target Secret Manager path |
|---|---|---|
| `STRIPE_SECRET_KEY` | Cloud Run env | `stripe-secret-key-live` |
| `STRIPE_WEBHOOK_SECRET` | Cloud Run env | `stripe-webhook-secret-live` |
| `BITCOIN_TREASURY_WIF` | Already in Secret Manager | `bitcoin-treasury-wif-mainnet` — confirm binding |
| `SUPABASE_SERVICE_ROLE_KEY` | Cloud Run env | `supabase-service-role-key` |
| `SUPABASE_JWT_SECRET` | Cloud Run env | `supabase-jwt-secret` |
| `API_KEY_HMAC_SECRET` | Cloud Run env | `api-key-hmac-secret` |
| `CRON_SECRET` | Cloud Run env | `cron-secret` |
| `GEMINI_API_KEY` | Cloud Run env | `google-api-key-general` (after SEC-HARDEN-01) |
| `TOGETHER_API_KEY` | Cloud Run env | `together-api-key` |
| `RUNPOD_API_KEY` | Cloud Run env | `runpod-api-key` |
| `COURTLISTENER_API_TOKEN` | Cloud Run env | `courtlistener-api-token` |
| `OPENSTATES_API_KEY` | Cloud Run env | `openstates-api-key` |
| `SAM_GOV_API_KEY` | Cloud Run env | `sam-gov-api-key` |
| `EDGAR_USER_AGENT` | Cloud Run env (not secret but fingerprints us) | `edgar-user-agent` |
| `RESEND_API_KEY` | Cloud Run env | `resend-api-key` |
| `UPSTASH_REDIS_REST_TOKEN` | Cloud Run env | `upstash-redis-rest-token` |
| `SENTRY_DSN` | Cloud Run env (low sensitivity but consistent policy) | `sentry-dsn-worker` |
| `CLOUDFLARE_API_TOKEN` | Cloud Run env | `cloudflare-api-token` |
| `CLOUDFLARE_TUNNEL_TOKEN` | Cloud Run env | `cloudflare-tunnel-token` |
| `SLACK_TREASURY_WEBHOOK_URL` | Cloud Run env (ARK-103) | `slack-treasury-webhook-url` |

Optional tooling-only secrets:

| Env var | Purpose | Target Secret Manager path |
|---|---|---|
| `ANTHROPIC_API_KEY` | Optional NVI-07 distillation + NVI-12 LLM-judge benchmark only; production worker uses Gemini unless `AI_PROVIDER=anthropic` is explicitly enabled later. | `anthropic-api-key` |

Edge functions (Supabase) + Cloudflare edge workers are in scope:

- **Supabase edge functions:** use `supabase secrets set` — Supabase's secret store is the fixture today. Out of scope for this migration (separate runbook when Supabase gives us Secret Manager sync).
- **Cloudflare edge workers (`services/edge/`):** use `wrangler secret put`. Still stored in Cloudflare's store. Dual-sync to GCP Secret Manager is planned as a follow-up (GCP-MAX epic).

---

## Migration procedure (human-executed per secret)

Repeat for every row in the audit table above. Example using `STRIPE_SECRET_KEY`:

```bash
# 1. Pull the current value out of Cloud Run and stash it locally (shell-only).
CURRENT=$(gcloud run services describe arkova-worker --region us-central1 \
  --format='value(spec.template.spec.containers[0].env)' | \
  awk '/STRIPE_SECRET_KEY/{flag=1; next} flag{print $2; exit}')

# 2. Create the Secret Manager entry.
printf "%s" "$CURRENT" | gcloud secrets create stripe-secret-key-live \
  --replication-policy=automatic --data-file=-

# 3. Bind the worker SA.
gcloud secrets add-iam-policy-binding stripe-secret-key-live \
  --member=serviceAccount:270018525501-compute@developer.gserviceaccount.com \
  --role=roles/secretmanager.secretAccessor

# 4. Update Cloud Run to read from the secret and remove the env-var entry.
gcloud run services update arkova-worker --region us-central1 \
  --remove-env-vars=STRIPE_SECRET_KEY \
  --set-secrets=STRIPE_SECRET_KEY=stripe-secret-key-live:latest

# 5. Verify the service still boots: tail logs for 2 minutes, confirm no
#    "STRIPE_SECRET_KEY is not defined" or similar.
gcloud run logs read arkova-worker --region us-central1 --limit=100
```

**Batch approach:** the deploy workflow uses `--set-secrets` lines already — extend the list to cover every secret. Then every re-deploy uses Secret Manager by default and `--set-env-vars` only carries non-secret config.

---

## Deploy-workflow update

```yaml
# .github/workflows/deploy-worker.yml — add/extend
- name: Deploy worker to Cloud Run
  run: |
    gcloud run deploy arkova-worker \
      --image=$IMAGE \
      --region=us-central1 \
      --set-secrets=$SECRETS \
      --set-env-vars=$ENV_VARS
  env:
    SECRETS: |
      STRIPE_SECRET_KEY=stripe-secret-key-live:latest,
      STRIPE_WEBHOOK_SECRET=stripe-webhook-secret-live:latest,
      SUPABASE_SERVICE_ROLE_KEY=supabase-service-role-key:latest,
      # …repeat for every secret.
    ENV_VARS: |
      FRONTEND_URL=https://arkova.ai,
      ENABLE_RULES_ENGINE=true,
      # …non-secret config only.
```

The CI job `Secret Scanning` (already in `.github/workflows/ci.yml`) will catch any regression that re-introduces a `--set-env-vars` secret.

---

## Cloudflare edge workers — dual-sync approach

The edge worker has ~4 secrets today:

- `EDGE_ANCHOR_VERIFIER_SECRET`
- `EDGE_MCP_CLIENT_ID` / `EDGE_MCP_CLIENT_SECRET`
- `SUPABASE_SERVICE_ROLE_KEY` (read-only subset)

Recommendation: until Cloudflare gives us native Secret-Manager sync, run a monthly script that:

1. Reads each edge secret from `wrangler secret list`.
2. Writes the value into Secret Manager under a parallel path (`cf-edge-*`).
3. Alerts if the two differ.

Script skeleton lives in `services/edge/scripts/dual-sync-secrets.ts` — add in the follow-up PR, out of scope here.

---

## Acceptance (Jira)

- [ ] Zero secrets in `.env.production` or any committed file.
- [ ] Zero secrets in `--set-env-vars` in `.github/workflows/deploy-worker.yml`.
- [ ] Cloud Run SA has `secretmanager.secretAccessor` on every needed secret (binding audit in step 3 for each).
- [ ] Confluence "SEC-HARDEN-02" page shows an inventory table with every secret's Secret Manager path + last rotation date.
- [ ] `gitleaks` scan of the whole repo is clean (already CI-enforced).
