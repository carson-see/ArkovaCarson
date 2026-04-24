# GCP-MAX setup runbook

Covers what `scripts/gcp-setup/provision.sh` does, what it deliberately doesn't, and the manual follow-up each customer environment needs.

Status: authored 2026-04-23 alongside the audit-pipe code in PR stacking on CIBA. Refresh the exact gcloud invocations as GCP CLI shape drifts.

---

## What gets provisioned automatically

```bash
cd /Users/carson/Desktop/arkova-mvpcopy-main
gcloud auth login                         # must be a user account, not an SA
gcloud config set project arkova1
bash scripts/gcp-setup/provision.sh
```

Idempotent — safe to re-run. Each step uses `describe || create` so repeats don't error.

| GCP-MAX- | Resource | Notes |
|---|---|---|
| 01 | Service account `gemini-golden-sa@arkova1.iam.gserviceaccount.com` with `roles/aiplatform.user` + `roles/secretmanager.secretAccessor` | Bind to the worker Cloud Run service when we migrate the Gemini calls. |
| 03 | Log bucket `arkova-audit` in `us-central1`, 2555-day retention | Pass `LOCK_LOG_BUCKET=true` to lock the retention policy (irreversible). |
| 03 | Service account `audit-logging-writer-sa@arkova1.iam.gserviceaccount.com` with `roles/logging.logWriter` | The worker uses this SA to write audit entries. |
| 02 | BigQuery dataset `arkova_analytics` in `us-central1` | Starter tables `anchors`, `verifications`, `audit_events`, day-partitioned on `created_at`. |
| 04 | Monitoring service `arkova-worker` + 3 SLOs | Availability 99.9/28d, p95 latency ≤ 500ms / 95% / 7d, batch-anchor success 99% / 24h. |

---

## What this runbook doesn't do — and why

### GCP-MAX-01: Actually migrate `services/worker/src/ai/gemini.ts` off `GEMINI_API_KEY`

The SA exists after provisioning, but the 611-line `GeminiProvider` is still calling `https://generativelanguage.googleapis.com/...` (Developer API). That's a code refactor, not infrastructure.

**Concrete path** (filed under SCRUM-1061):

1. Add a `GEMINI_USE_VERTEX=true` feature flag.
2. In `GeminiProvider`, switch the model endpoint from `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}` to `https://${REGION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${REGION}/publishers/google/models/${MODEL}:generateContent` with `Authorization: Bearer ${getGcpAccessToken()}`.
3. `services/worker/src/utils/gcp-auth.ts` (shipped in this PR) provides the token helper — no SDK install needed.
4. Run the existing `src/ai/eval/` harness against both paths + compare F1.
5. Flip the flag in prod after parity is confirmed.
6. Retire `GEMINI_API_KEY` in a follow-up.

### GCP-MAX-04: Alert policies

SLOs are declarative; alert policies need a **notification channel ID** per environment (PagerDuty integration, Slack webhook channel, email list). Creating them automatically requires values we don't hardcode.

**Do this manually after provision.sh runs:**

```bash
# One-time: create a Slack notification channel
gcloud monitoring channels create \
  --display-name="Arkova ops Slack" \
  --type=slack \
  --channel-labels=channel_name=#ops-alerts \
  --channel-labels=auth_token=$(gcloud secrets versions access latest --secret=slack-ops-webhook)

# List channels to grab the ID (projects/arkova1/notificationChannels/XXXX)
gcloud monitoring channels list

# Then for each SLO, create an alert policy with burn-rate threshold 2x
# (details in Cloud Monitoring → SLOs → <slo> → Create alerting policy)
```

### GCP-MAX-05: VPC Service Controls + CMEK

Org-level policy. Requires:
- An access policy ID at the org (not project) level.
- A perimeter wrapping the arkova1 project.
- CMEK keyrings in KMS (we already have `arkova-signing` for Bitcoin; add `arkova-data` for CMEK on BigQuery + Logging).

Filed as SCRUM-1065. Do this after CIBA + PR #476 merge so we're not reshaping infra under an in-flight release.

### GCP-MAX-06: Security Command Center Standard

One-click enable in the console: `console.cloud.google.com/security/command-center`. Don't script — the product onboarding UI asks enterprise-contract questions that differ by customer. Filed as SCRUM-1066.

---

## Wiring the worker to use the new infra

After running `provision.sh`:

```bash
# 1. Bind the writer SA to Cloud Run worker
gcloud run services update arkova-worker \
  --service-account=audit-logging-writer-sa@arkova1.iam.gserviceaccount.com \
  --region=us-central1

# 2. Set env vars (via --set-secrets and --set-env-vars)
gcloud run services update arkova-worker \
  --set-env-vars="GCP_PROJECT_ID=arkova1,GCP_LOGGING_LOG_NAME=projects/arkova1/logs/arkova-audit-events,ENABLE_CLOUD_LOGGING_SINK=true" \
  --region=us-central1

# 3. Apply the Postgres migration
npx supabase db push  # applies 0235_cloud_logging_queue.sql

# 4. Wire the drain cron in services/worker/src/routes/cron.ts:
#    router.post('/cloud-logging-drain', requireCron, async (req, res) => {
#      const r = await runCloudLoggingDrain();
#      res.json(r);
#    });

# 5. Create the Cloud Scheduler job
gcloud scheduler jobs create http cloud-logging-drain \
  --location=us-central1 \
  --schedule="*/1 * * * *" \
  --uri="https://arkova-worker-270018525501.us-central1.run.app/cron/cloud-logging-drain" \
  --http-method=POST \
  --oidc-service-account-email=270018525501-compute@developer.gserviceaccount.com \
  --oidc-token-audience="https://arkova-worker-270018525501.us-central1.run.app"
```

---

## Verifying the audit pipe end-to-end

```bash
# Generate a test audit event (trigger an anchor revocation, say)
# Then:
gcloud logging read 'logName="projects/arkova1/logs/arkova-audit-events"' \
  --freshness=5m --format=json --limit=5

# Check the queue drained to zero:
psql "$DATABASE_URL" -c "SELECT count(*), max(retry_count) FROM cloud_logging_queue;"
# Expected: count = 0 or a small number that's draining.
```

If `count > 10` persistently, the drain cron isn't firing or Cloud Logging is rejecting writes. Check:

1. Cloud Scheduler job status (`gcloud scheduler jobs describe cloud-logging-drain`)
2. Worker logs for the string "Cloud Logging drain: batch threw"
3. IAM: `gcloud projects get-iam-policy arkova1 | grep audit-logging-writer`

---

## SOC 2 CC7.1 evidence export

Weekly cron that dumps the audit log bucket to BigQuery for long-term querying:

```bash
gcloud logging sinks create soc2-audit-bq-sink \
  bigquery.googleapis.com/projects/arkova1/datasets/arkova_analytics \
  --log-filter='logName="projects/arkova1/logs/arkova-audit-events"' \
  --description="SOC 2 CC7.1 — weekly replication to BigQuery for long-term SQL queries"
```

Grant the sink's writer identity BigQuery dataEditor on `arkova_analytics` (the command prints the identity).

---

## Rollback

```bash
# Kill the drain
gcloud scheduler jobs delete cloud-logging-drain --location=us-central1

# Migration rollback
psql "$DATABASE_URL" -c "DROP TRIGGER IF EXISTS audit_events_to_cloud_logging_queue ON audit_events; DROP FUNCTION IF EXISTS enqueue_audit_for_cloud_logging(); DROP TABLE IF EXISTS cloud_logging_queue;"

# BQ dataset (ONLY if no prod data — this drops history)
bq rm -r -f -d arkova1:arkova_analytics

# Log bucket (blocked if --locked was used)
gcloud logging buckets delete arkova-audit --location=us-central1
```

Note: if you `LOCK_LOG_BUCKET=true` during provisioning, the log bucket can NOT be deleted until the retention window (7 years) expires. That's the point — SOC 2 immutability — but the first few runs on a sandbox project should stay unlocked.

---

## Related Jira + Confluence

- Epic [SCRUM-1042 GCP-MAX](https://arkova.atlassian.net/browse/SCRUM-1042)
- Children: [SCRUM-1061](https://arkova.atlassian.net/browse/SCRUM-1061) (Vertex SA), [SCRUM-1062](https://arkova.atlassian.net/browse/SCRUM-1062) (BigQuery), [SCRUM-1063](https://arkova.atlassian.net/browse/SCRUM-1063) (Cloud Logging), [SCRUM-1064](https://arkova.atlassian.net/browse/SCRUM-1064) (Monitoring SLOs), [SCRUM-1065](https://arkova.atlassian.net/browse/SCRUM-1065) (VPC-SC + CMEK), [SCRUM-1066](https://arkova.atlassian.net/browse/SCRUM-1066) (SCC)
- Release: v1.0.0 — Platform v2 + Enterprise Hardening (Jira fixVersion 10266)
