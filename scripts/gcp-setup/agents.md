# scripts/gcp-setup/agents.md

One-shot GCP infrastructure provisioning scripts. Idempotent; safe to re-run.

## Files
- **`provision.sh`** — provisions GCP infra: Vertex AI service account, BigQuery dataset, Cloud Logging bucket (7-year retention), and points operators to `apply-monitoring.sh` for GCP-MAX-04. Addresses GCP-MAX-01 through GCP-MAX-04.
- **`apply-monitoring.sh`** — applies SCRUM-1064 monitoring-as-code: metric descriptors, Cloud Monitoring service/SLOs, dashboard, and SLO burn alert policies once notification channel IDs are known.
- **`synthetic-burn.sh`** — operator-gated synthetic Cloud Monitoring metric injector for SCRUM-1064 alert-path proof. Requires `ALLOW_SYNTHETIC_SLO_BURN=true`.
- **`cloud-scheduler.sh`** — creates/updates Cloud Scheduler jobs for worker cron endpoints (monthly rollover, vacuum, etc.). Idempotent via update-on-duplicate.
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
