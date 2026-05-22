# scripts/gcp-setup/slos/agents.md

Cloud Monitoring SLO definitions for GCP-MAX-04. Applied via `scripts/gcp-setup/apply-monitoring.sh`.

## Files
- **`worker-availability.yaml`** — 99.9% availability over 28-day rolling window. Alerts at 2x error-budget burn rate.
- **`worker-p95-latency.yaml`** — p95 latency SLO for the arkova-worker Cloud Run service.
- **`batch-anchor-success.yaml`** — success rate SLO for batch anchor processing.
- **`verification-api-p95-latency.yaml`** — Verification API p95 latency under 200ms over a rolling 7-day window.

## Conventions
- Worker SLOs target `cloud_run_revision` resource type, service `arkova-worker`; custom SLOs target `custom.googleapis.com/arkova/*` metrics declared under `scripts/gcp-setup/metrics/`.
- Alert policies fire at burn-rate thresholds, not raw error counts.
