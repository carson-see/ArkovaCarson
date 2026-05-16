# scripts/gcp-setup/agents.md

One-shot GCP infrastructure provisioning scripts. Idempotent; safe to re-run.

## Files
- **`provision.sh`** — provisions GCP infra: Vertex AI service account, BigQuery dataset, Cloud Logging bucket (7-year retention), monitoring SLOs. Addresses GCP-MAX-01 through GCP-MAX-04.
- **`cloud-scheduler.sh`** — creates/updates Cloud Scheduler jobs for worker cron endpoints (monthly rollover, vacuum, etc.). Idempotent via update-on-duplicate.
- **`schemas/`** — BigQuery table schemas (anchors.json, audit_events.json, verifications.json).
- **`slos/`** — Cloud Monitoring SLO definitions (YAML).

## Conventions
- Requires `gcloud auth login` with project-admin role on `arkova1`.
- BigQuery location is `US` (multi-region), not `us-central1`.
- VPC Service Controls and SCC are documented but NOT auto-provisioned.
