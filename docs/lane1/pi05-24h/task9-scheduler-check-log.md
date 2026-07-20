# Task 9 — Daily scheduler check log (rider on SCRUM-2900) — Lane 1

Read-only `gcloud scheduler jobs list --location=us-central1` (`CLOUDSDK_PYTHON=/opt/homebrew/bin/python3.14` workaround for the gcloud Python 3.9 warning). **No scheduler mutations (W6).**

## Entry 1 — 2026-07-20 ~18:26Z (evening)

### Feeder / anchoring pipeline states (prod, us-central1)
| Job | State | Schedule |
|---|---|---|
| `process-anchors` | **ENABLED** | */30 |
| `anchor-public-records` | **ENABLED** | */10 |
| `batch-anchors` | **ENABLED** | */30 |
| `daily-anchor-flush` | ENABLED | 0 3 (3am) |
| `embed-public-records` | ENABLED | */2 |
| `recover-broadcasts` | ENABLED | */15 |
| `check-confirmations` / `populate-confirmation-proofs` | ENABLED | */30, */15 |
| `refresh-stats` | **ENABLED** | */5 |
| `process-revocations` / `process-anchors` | ENABLED | */5, */30 |

### ⚠ DIVERGENCE FROM HANDOFF (07-17) — flag for RTE, do NOT touch (W6)
HANDOFF (verified 2026-07-17) states `process-anchors` + `anchor-public-records` are **PAUSED** (backlog frozen) and `refresh-stats` PAUSED (stale monitors). **As of 2026-07-20 18:26Z all three are ENABLED**, and prod shows **live anchoring activity**: most-recent anchor `ARK-DOC-GHZG6V`, status **SUBMITTED**, `created_at=2026-07-20T18:12:24Z`, block 958922 — ~14 min before this check. **Prod anchoring pipeline is operational and producing anchors right now.** This contradicts the "feeders paused / backlog frozen" snapshot. Likely the pipeline was resumed between 07-17 and 07-20 (possibly the parallel release-ops session). **Action: RTE to reconcile HANDOFF's feeder-state claim with live state; Lane 1 only observed.** Bearing on Task 5: the drain/backlog narrative must be re-checked against live feeder state before the D1 packet is finalized.

### Soak rigs (ENABLED, running — DO NOT TOUCH, W6)
- `arkova-worker-s33-rig-b1-staging-*` (B1 chain rig): check-confirmations / org-queue-scheduler / batch-anchors / populate-confirmation-proofs / recover-broadcasts all ENABLED */5; `...batch-anchors-forced-flush` PAUSED. **Active B1 soak.**
- `arkova-worker-railb220260719-staging-*` (chain rail #1552 soak, matures 17:13Z Jul 21): batch-anchors / org-queue-scheduler / check-confirmations / populate-confirmation-proofs ENABLED */5.
- Soak runners ENABLED every minute: `soak-railb220260719-runner`, `soak-rcb20260719-runner`, `soak-rcd20260719-runner`. Consistent with the active rails (deps matures ~01:36Z, chain 17:13Z Jul 21).

### SCRUM-2620 relevance (Task 5)
**No prod (non-rig) `org-queue-scheduler` job exists** — only the two rig-scoped ones (`...s33-rig-b1-staging-org-queue-scheduler`, `...railb220260719-staging-org-queue-scheduler`). The SCRUM-2620 mislabel path is therefore still **unscheduled in prod** — the latent-defect conclusion in Task 5 holds. (Note: the live `process-anchors`/`batch-anchors` path that produced the 18:12Z SUBMITTED anchor is the direct-anchor pipeline, distinct from the org-queue-scheduler drain.)

### Notably PAUSED (informational)
`fetch-state-courts-{tx,ca,ny}`, `fetch-openalex`, `openalex-bulk`, `edgar-bulk`, `bq-export-incremental`, `anchor-attestations`, `workspace-subscription-renewal`, `chaindump-desk-daily`.

### Metrics
- lastSecured/last-activity age: **live** — a SUBMITTED anchor 14 min old (18:12Z).
- SECURED total (estimated): 2,992,652.
- backlog delta: `public_records` with `anchor_id IS NULL` not re-countable read-only (seq-scan timeout, no supporting index) — HANDOFF's 255,491 is the last CTO-signed figure; **stale risk given feeders now enabled** — recommend a psql/MCP recount.

## Entry 2 — morning (pending)
The plan requires a second check (morning of Jul 21). To be logged in the next session pass; the evening entry above is complete.

_Lane 1, 2026-07-20 evening. Read-only; no scheduler/rig/flag mutations (W6)._
