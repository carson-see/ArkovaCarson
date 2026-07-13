# S3.3 L1-0 — Prod batch-drain trigger topology (read-only audit)

_Audited 2026-07-10 by Lane 1 (Trust & Chain), Sprint 3.3. Read-only: `gcloud scheduler jobs list/describe` against project `arkova1`, region `us-central1`, authenticated as `270018525501-compute@developer.gserviceaccount.com`. Zero mutations. This is an internal engineering note (Constitution §0.4) — the audit summary also lands on the sprint Confluence page._

**Status: co-signed L1-0/L2-S6 — pending L2 ack.**

---

## 1. What prod ACTUALLY runs (verified, not asserted)

Scheduler project/region: `projects/arkova1/locations/us-central1`. Prod worker: `https://arkova-worker-270018525501.us-central1.run.app`. All jobs POST with OIDC (`270018525501-compute@developer.gserviceaccount.com`). Sweep of `us-east1`, `us-east4`, `us-west1`: **empty** — us-central1 is the only Scheduler location in use.

### Drain-relevant jobs (the topology the rig must mirror)

| Job | Schedule | TZ | URI (path + params) | Deadline | Retry | State | In `cloud-scheduler.sh`? |
|---|---|---|---|---|---|---|---|
| `batch-anchors` | `*/30 * * * *` | Etc/UTC | `/jobs/batch-anchors` — **no `force`, no `org_id`** | 120s | 5s→3600s, maxDoublings 5 | **ENABLED** | **NO — out-of-band** |
| `daily-anchor-flush` | `0 3 * * *` | **America/New_York** | `/jobs/batch-anchors?force=true` — **no `org_id`** | 600s | 5s→3600s, maxDoublings 5 | **ENABLED** | **NO — out-of-band** |
| `check-confirmations` | `*/30 * * * *` | Etc/UTC | `/jobs/check-confirmations` | 300s | 5s→3600s, maxDoublings 5 | **ENABLED** | **NO — out-of-band** |
| `recover-broadcasts` | `*/15 * * * *` | Etc/UTC | `/jobs/recover-broadcasts` | 120s | 5s→3600s, maxDoublings 5 | **ENABLED** | **NO — out-of-band** |
| `process-anchors` | `*/30 * * * *` | UTC | `/jobs/process-anchors` (legacy per-anchor path) | 300s | default | **PAUSED** | NO |
| `org-queue-scheduler` | — | — | — | — | — | **DOES NOT EXIST** | NO |

Other anchor-adjacent jobs for completeness: `process-revocations` (`*/5`, ENABLED), `anchor-attestations` (PAUSED), `anchor-public-records` (PAUSED), `refresh-treasury-cache` (`*/10`, ENABLED). None broadcasts a customer batch tx.

### Headline findings

1. **The org-scoped drain path is code-live but trigger-dead in prod.** `POST /jobs/org-queue-scheduler` exists (`services/worker/src/routes/cron.ts:470` → `runOrgQueueScheduler` → `processBatchAnchors({force:true, orgId})` per claimed org, `org-queue-scheduler.ts:209`), but **no Cloud Scheduler job targets it in any location**. Prod's only drain triggers are the GLOBAL cross-org path.
2. **All four live drain triggers are out-of-band.** `scripts/gcp-setup/cloud-scheduler.sh` contains NONE of `batch-anchors`, `daily-anchor-flush`, `check-confirmations`, `recover-broadcasts` — they were created manually. Confirms lane1-report §2.7 and CTO R3 ("prod 3am job is out-of-band"). Anyone rebuilding prod (or a prod-faithful rig) from the in-tree script gets a system that **never drains**.
3. **`daily-anchor-flush` runs on America/New_York**, not UTC — "3am EST sweep" is literal (03:00 ET = 07:00/08:00 UTC depending on DST). Rig cadence math must use ET, or declare an explicit override.
4. **`batch-anchors` every 30 min is a POLICY CHECK, not a broadcast** — unforced `processBatchAnchors()` fires only on Trigger A (pending ≥ `BATCH_SIZE` 10,000), Trigger B (pending ≥ 3,000 AND oldest ≥ 3h), and is deferred by Trigger C (fee ceiling). Trigger D is exclusively the daily flush. The healthy prod signature is ≈1 broadcast/day (nightly flush) + occasional intraday Trigger A/B broadcasts under volume.
5. **Attempt deadlines differ meaningfully**: 120s for the 30-min policy check vs 600s for the forced daily flush (a real 10k drain takes minutes). A rig arming a forced flush with a 120s deadline would see Scheduler-side timeouts + retries that prod's flush never sees — mirror the deadlines, not just the paths.
6. Secondary drift observed in passing (NOT drain scope, logged for the bug tracker): `db-health-monitor` targets `/cron/db-health` in prod vs `/jobs/db-health` in `cloud-scheduler.sh`; the script's `nonce-sweep`, `connector-health-check`, `docusign-reconciliation`, `docusign-connect-failures-poll`, `docusign-listener-drift`, `drain-connector-artifacts` jobs do **not** exist against the prod worker; `bq-export-incremental` is PAUSED. Prod worker also has no `populate-confirmation-proofs` Scheduler job (backfill currently driven only on the s0e4 soak rig).

### The in-process third trigger

`routes/scheduled.ts` also schedules an **in-process node-cron** `process-batch-anchors` every `config.batchAnchorIntervalMinutes ?? 10` minutes (global, unforced) when the chain client is initialized. On prod Cloud Run (min-instances=0, CPU throttled) this is dormant — Scheduler HTTP posts are the real triggers. **On a rig with CPU allocated it WILL fire** and can race/interleave with the armed Scheduler paths (lane1-report §1).

---

## 2. Canonical per-trigger invariant (CTO R3 — adopted verbatim)

> Invariant = per-trigger PAIR (L1 formulation, adopted verbatim; L2-S6 co-signs): **org-scheduler pass → exactly 1 tx per claimed org, per-org ceil(pending/BATCH_SIZE) across passes; global flush → one mixed-org tx ≤10k, remainder next tick.**

Spelled out per trigger:

| Trigger | Healthy signature | Violation signature |
|---|---|---|
| Org-scheduler pass (`/jobs/org-queue-scheduler` → per-org `processBatchAnchors({force:true, orgId})`) | Exactly **1 tx per claimed org** per pass; an org with pending > 10,000 drains across passes as **ceil(pending/BATCH_SIZE)** txs total, never two txs for one org in one pass | 2+ txs for one org in one pass; cross-org fingerprints in an org-scoped tx; ledger/credit deltas on a non-claimed org |
| Global flush (`/jobs/batch-anchors?force=true` daily, or unforced Trigger A/B) | **One mixed-org tx ≤ 10,000 leaves**; remainder stays PENDING for the next tick | A second tx in the same run; >10,000 leaves under one root; remainder lost/reverted |

A "1 org, 2 txs" observation is a violation **per org-scheduler pass**, not per day; a mixed-org tx is the HEALTHY signature of the global path and a violation of the org-scoped path. Every evidence window must therefore declare which trigger was armed (R3).

---

## 3. Rig-topology requirement (binding for L1-2 / rig-day)

Per CTO R3 — arm BOTH paths **explicitly**, and account for the third:

1. **Global path**: Scheduler jobs `batch-anchors` (unforced, 30-min cadence, 120s deadline) + a forced-flush job (`/jobs/batch-anchors?force=true`, 600s deadline; cadence accelerated for the soak window ONLY with the acceleration declared in the evidence block). Mirror `check-confirmations` + `recover-broadcasts` — reconcile evidence is meaningless if recovery never runs.
2. **Org-scoped path**: a Scheduler job for `/jobs/org-queue-scheduler` — **absent from prod AND absent from the provision script's chain-profile `SCHEDULER_JOBS` (`provision-isolated-rig.sh:323`: `batch-anchors`, `check-confirmations`, `populate-confirmation-proofs` only)**. Landing this is **L2-S2a-FIX** (recorded decision, CTO R3: "add OR harness decision" resolved as ADD). Lane 1 does not touch the provision script this wave; our signet parameters go in a follow-up PR after L2-S2a-FIX merges (see `docs/lane1/s33-multiorg-harness-design.md` §5).
3. **In-process node-cron**: `disabled or logged+attributed` (R3 verbatim). On a CPU-allocated rig the 10-min in-process global drain WILL fire and can steal an org-scoped soak's pending rows mid-window. Either disable it for the rig (env: raise `batchAnchorIntervalMinutes` beyond the window, or a rig-only flag) or leave it armed and log every firing so each broadcast in the evidence pack is attributed to exactly one declared trigger.
4. **Every evidence window declares its armed trigger(s)** and asserts the corresponding invariant column from §2 — plus deadlines/timezones consistent with §1.5 so Scheduler retry behavior matches prod.

### Why this is the whole ballgame for L1-3/L1-4

The rig as provisioned today arms ONLY the global path. An org-scoped-drain soak on that topology **false-fails on trigger topology alone**: the global 10-min/30-min drains sweep the multi-org backlog into mixed-org txs before the org scheduler ever claims, "violating" the per-org invariant without any code being wrong (lane1-report pre-mortem #1 — H likelihood, whole-narrative blast radius).

---

## 4. Raw evidence

- `gcloud scheduler jobs list --location=us-central1 --project=arkova1` — 59 jobs returned, 2026-07-10 ~15:57Z (session transcript; full table includes soak-rig drivers `soak-1455-health-driver`, `soak-pr1461-runner`, `process-anchors-q0667-t3` etc. targeting `*-staging` services — none targets the prod worker's drain paths beyond §1).
- `gcloud scheduler jobs describe {batch-anchors,daily-anchor-flush,check-confirmations,recover-broadcasts,process-anchors} --location=us-central1 --project=arkova1` — schedules/TZs/URIs/deadlines/retryConfig as tabled in §1.
- `gcloud scheduler jobs list --location={us-east1,us-east4,us-west1} --project=arkova1` — all empty.
- In-tree comparison: `scripts/gcp-setup/cloud-scheduler.sh` JOBS array (10 jobs, none drain-related); `services/worker/src/routes/cron.ts:256-280` (`/batch-anchors` param parsing: `force` query, `org_id` query/body, Zod UUID), `:470` (`/org-queue-scheduler`); `services/worker/src/routes/scheduled.ts:106-116` (in-process cron).

_Last refreshed: 2026-07-10 by Lane 1 (Trust & Chain) — claims verified against gcloud output in-session._
