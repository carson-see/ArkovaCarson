# E3 — Trigger observation, R1 rig (PR #2524), read 2026-09-02T20:38Z

Source: `gcloud scheduler jobs list --location us-central1` and Cloud Run request logs for `arkova-worker-proof-txincl-0427-staging` (`httpRequest.requestUrl:"/jobs/"`, 8 h window). Read-only.

| Trigger | Schedule | State | Executions (window open → 20:35Z) | Non-2xx |
|---|---|---|---|---|
| `arkova-worker-proof-txincl-0427-staging-populate-confirmation-proofs` → `POST /jobs/populate-confirmation-proofs` | `*/5 * * * *` | ENABLED, last attempt 20:35:00Z, no error code | **122 × HTTP 200** (first 13:37:23Z, last 20:35:00Z) | 0 |

The 122 includes the driver's own ticks against the same endpoint (six per cycle, cycles live-04..07); the scheduler alone accounts for one per five minutes ≈ 84 over the seven hours. Every request answered 200 — no 5xx, no 401 (cron secret), no 403 (IAM). `batch-anchors` is deliberately not wired: nothing on this rig broadcasts.

Interpretation for the T3 fields: **Trigger A** = the scheduled populate sweep — fires and completes on every 5-minute cycle; the sweep advance/wrap behaviour it exercises is asserted by A1–A4 in each driver cycle. **Trigger B** = the driver-initiated re-arm + tick sequence (`counts.rearmedWedge=120` per cycle, `evidence/live-0N.jsonl`). There is no daily-flush cron on this rig by design; per-org behaviour (2 fixture orgs) is asserted by the driver's SQL-side counts, not by a scheduler job.
