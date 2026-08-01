# scripts/gcp-setup/agents.md

One-shot GCP infrastructure provisioning scripts. Idempotent; safe to re-run.

## Files

- **`provision.sh`** — provisions GCP infra: Vertex AI service account, BigQuery dataset, Cloud Logging bucket (7-year retention), and points operators to `apply-monitoring.sh` for GCP-MAX-04. Addresses GCP-MAX-01 through GCP-MAX-04.
- **`apply-monitoring.sh`** — applies SCRUM-1064 monitoring-as-code: metric descriptors, Cloud Monitoring service/SLOs, dashboard, and SLO burn alert policies once notification channel IDs are known.
- **`synthetic-burn.sh`** — operator-gated synthetic Cloud Monitoring metric injector for SCRUM-1064 alert-path proof. Requires `ALLOW_SYNTHETIC_SLO_BURN=true`.
- **`cloud-scheduler.sh`** — creates/updates Cloud Scheduler jobs for worker cron endpoints (monthly rollover, vacuum, etc.). Idempotent via update-on-duplicate.
  - **This file is NOT a complete inventory of prod's scheduler jobs.** As of 2026-08-01 it declares ~14 of the ~45 jobs live in `arkova1/us-central1`; `batch-anchors`, `daily-anchor-flush`, `check-confirmations`, `recover-broadcasts`, the `fetch-*` feeders and others were created out of band and exist only in GCP. Running this script rebuilds only what it declares — it does **not** reconstruct prod. Reconciling the remainder is tracked as SCRUM-2900.
  - Consequence, and the reason this warning is here: `org-queue-scheduler` was absent from **both** this script and prod for months while every isolated soak rig had one, so the 72h soaks validated a job production did not run and two customer anchors sat PENDING for three days. Added 2026-08-01. **When you create a scheduler job in prod, add it here in the same change.**
  - Three declared-but-never-created jobs were found missing from prod by the same 2026-08-01 reconciliation and created there: `ce-key-expiry-check` and `connector-health-check` (both already declared in this script — the script had simply never been run against prod), and `check-stuck-anchors` (route shipped, never declared anywhere — added to this script in the same change). Effect was verified per job, not assumed from an HTTP 200: `ce-key-expiry-check` fired its real alarm on first run (`CE_API_KEY_EXPIRES_AT` unset), and `check-stuck-anchors` returned a correct `healthy` verdict against a live-queried oldest-PENDING age. Still missing from prod and **deliberately not created** pending a CTO call: `nonce-sweep` (deletes data), `docusign-reconciliation`, `docusign-connect-failures-poll`, `docusign-listener-drift` (all three would run against `DOCUSIGN_DEMO=true`).
  - Auth pattern for prod jobs is **OIDC only** — do not add an `X-Cron-Secret` header. `verifyCronAuth` (`services/worker/src/routes/cron.ts`) returns *false* on a present-but-mismatched `X-Cron-Secret` instead of falling through to the OIDC path, so copying a rig's hardcoded secret header into a prod job produces a hard 401.
- **`schemas/`** — BigQuery table schemas (anchors.json, audit_events.json, verifications.json).
- **`slos/`** — Cloud Monitoring SLO definitions (YAML).
- **`slos-json/`** — REST API SLO payloads consumed by `apply-monitoring.sh` because the installed stable gcloud CLI does not expose services/SLO commands.
- **`metrics/`** — Cloud Monitoring custom metric descriptor JSON for batch-anchor, Gemini token burn, and Verification API latency telemetry.
- **`dashboards/`** — Cloud Monitoring dashboard JSON.
- **`alert-policies/`** — Cloud Monitoring SLO burn alert policy templates. `${SLACK_OPS_ALERTS_CHANNEL}` is rendered by `apply-monitoring.sh`.

## Conventions

- Requires `gcloud auth login` with project-admin role on `arkova1`.
- BigQuery location is `US` (multi-region), not `us-central1`.
- VPC Service Controls and SCC are documented but NOT auto-provisioned.
- Do not hardcode notification channel IDs or Slack/PagerDuty secrets in repo. Pass channel resource names via environment variables.
