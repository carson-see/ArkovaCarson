# FD-PROD-2 — 11 Cloud Scheduler jobs are defined on `main` but were never provisioned in prod

**Found:** 2026-08-22, chasing FD-REORG-1 into production.
**Severity:** high. Three of the eleven are chain-safety jobs on the anchor lifecycle. The repo
asserts they run; production has never scheduled them.

## The gap

`scripts/gcp-setup/cloud-scheduler.sh` on `origin/main` defines **70** scheduler jobs. Production
(`arkova1` / `us-central1`) has **60**, and eleven of the script's definitions have no job at all:

```
ai-credit-reconcile          detect-reorgs                proof-coverage-monitor
ce-registry-drift-check      docusign-notarization-completed   rebroadcast-txs
cleanup-retention            monitor-stuck-txs            reconcile-stripe
                             smoke-test                   treasury-alert-check
```

The three chain-maintenance entries were added on **2026-08-10** in `f4dfb60d9`
(`fix(gcp-setup): review-round fixes — audit cadences, durable NO_RETRY, manifest parity`), with a
comment at `scripts/gcp-setup/cloud-scheduler.sh:186` that states the problem outright:

> in-process schedules are dormant on Cloud Run, so these never ran in prod; 0347 reorg handling
> shipped with no detector running

The definition landed. The script was never run against prod. The most recently provisioned prod
jobs carry `userUpdateTime` of 2026-08-01 (`check-stuck-anchors`) and 2026-07-17
(`populate-confirmation-proofs`) — both predate the 08-10 commit.

## Why this is worse than a missing cron

For the chain-maintenance three, the in-process `node-cron` fallback exists but does not work
reliably on a CPU-throttled Cloud Run instance. FD-REORG-1 measures the consequence: **313**
`Reorg detection cron failed` `TimeoutError`s on `arkova-worker` between 2026-07-22 and
2026-08-21, on the only reorg-detection path prod has. Migration **0347** (chain reorg, same-height
detection) is live in prod per `memory/project_migration_0347_prod_ahead.md` — the schema for
correct reorg handling shipped, and the detector that uses it is unscheduled.

`monitor-stuck-txs` and `rebroadcast-txs` are in the same position. `treasury-alert-check`,
`reconcile-stripe`, `proof-coverage-monitor`, `smoke-test` and `cleanup-retention` are unverified
here beyond being absent — each needs its own check for whether an in-process path covers it.

## Evidence (2026-08-22)

- Script job list: `git show origin/main:scripts/gcp-setup/cloud-scheduler.sh` → 70 entries.
- Provisioned: `gcloud scheduler jobs list --project=arkova1 --location=us-central1` → 60 prod jobs
  (plus 26 `arkova-worker-fullsoak-2026-08-staging-*` rig jobs). `us-east1` and `us-west1` are empty.
- No prod scheduler job targets any chain-maintenance endpoint — grepping every non-rig job's
  `httpTarget.uri` for `reorg|stuck-tx|rebroadcast|consolidate|monitor-fee` returns nothing.
- `arkova-worker` served **0** requests to `/jobs/detect-reorgs`, `/jobs/monitor-stuck-txs`,
  `/jobs/rebroadcast-txs`, `/jobs/consolidate-utxos`, `/jobs/monitor-fees` in 30 days.
- The rig has all of them: e.g. `arkova-worker-fullsoak-2026-08-staging-detect-reorgs`, `3-59/10`,
  ENABLED, 288 × HTTP 200 over the 48 h chain-pair window.

## Recommended

1. Run `scripts/gcp-setup/cloud-scheduler.sh` against prod, or provision at minimum
   `detect-reorgs`, `monitor-stuck-txs`, `rebroadcast-txs`. Founder/operator action — this is a
   prod infrastructure change, not a merge.
2. Add a drift check that fails when a job defined in the script has no corresponding prod
   scheduler job. The script already carries a "manifest parity" intent in `f4dfb60d9`; nothing
   enforces it against running prod. Per CLAUDE.md §1.13, `check-config-drift.ts` compares asserted
   config against *committed snapshots*, not live prod — this gap is exactly the class it cannot
   currently catch.
3. Triage the remaining eight for whether their absence has a live consequence.

## The rule this is a case of

A definition in the repo is not a deployment. `cloud-scheduler.sh` documented, in a code comment,
that these jobs had never run in prod — and adding the definition read as fixing it. The
provisioning step is a separate action with a separate verification, and only `gcloud scheduler
jobs list` answers whether it happened.
