# E3 — Trigger observation, RC batch rig, read 2026-09-02T20:38Z

Source: `gcloud scheduler jobs list --location us-central1` and Cloud Run request logs for `arkova-worker-rc-batch-0902-staging` (`httpRequest.requestUrl:"/jobs/"`). Read-only.

| Trigger | Schedule | State | Executions (19:49Z → 20:35Z) | Non-2xx |
|---|---|---|---|---|
| `…-populate-confirmation-proofs` → `POST /jobs/populate-confirmation-proofs` | `*/5` | ENABLED, last 20:35:03Z | 10 × 200 | 0 |
| `…-check-confirmations` → `POST /jobs/check-confirmations` | `*/5` | ENABLED, last 20:35:07Z | 10 × 200 | 0 |
| driver → `POST /jobs/detect-reorgs` (A26_3, PR #2526) | per driver cycle | n/a | 2 × 200 (`{"checked":0,"reorgsDetected":0,"reverted":0}`) | 0 |

`batch-anchors` is not wired; nothing broadcasts. The fixture anchors are already SECURED on real receipts, so the two cron jobs exercise the worker's steady-state cron path on the RC build (auth, rate-limit bucket, DB round trip) rather than state transitions; the PR-specific behaviour is asserted by the driver cycles (`rc-live-NN.jsonl`).
