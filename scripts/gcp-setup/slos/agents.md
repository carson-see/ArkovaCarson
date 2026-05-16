# scripts/gcp-setup/slos/agents.md

Cloud Monitoring SLO definitions for GCP-MAX-04. Applied via `provision.sh`.

## Files
- **`worker-availability.yaml`** — 99.9% availability over 28-day rolling window. Alerts at 2x error-budget burn rate.
- **`worker-p95-latency.yaml`** — p95 latency SLO for the arkova-worker Cloud Run service.
- **`batch-anchor-success.yaml`** — success rate SLO for batch anchor processing.

## Conventions
- SLOs target `cloud_run_revision` resource type, service `arkova-worker`.
- Alert policies fire at burn-rate thresholds, not raw error counts.
