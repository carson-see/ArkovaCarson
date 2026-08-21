# FD-TRIGGER-1 — Ambient anchor traffic can never reach Trigger A or B

**Filed:** 2026-08-20
**Severity:** Process / evidence-validity (no production impact)
**Status:** Fixed in-session; recorded here so it stops recurring

## Summary

CLAUDE.md §1.12 lists **"Trigger A fires, Trigger B fires"** among the required T3 soak
evidence. An ambient anchor-traffic generator **structurally cannot produce either**. A T3
soak left on ambient load alone evidences only Trigger D (the daily 03:00Z forced flush)
and is therefore **not merge-grade**, regardless of how long the clock runs.

## Mechanism

Thresholds in `services/worker/src/jobs/batch-anchor.ts`:

| Trigger | Condition |
|---|---|
| A | `BATCH_SIZE` = 10,000 pending |
| B | `MIN_BATCH_THRESHOLD` = 3,000 pending **AND** oldest pending ≥ 3h |
| C | Fee ceiling — never exercised in staging |
| D | Daily 03:00Z forced flush (bypasses thresholds) |

`scripts/staging/fullsoak-anchor-traffic.sh` submits **~36/day**. Reaching 3,000 that way
takes ~83 days. The 2026-08-20 relauncher used for the chain-pair rig drove ~8/hour, which
puts Trigger B ~375 hours out — against a 48-hour T3 window.

With only 12 PENDING rows on the rig, **no trigger firing was correct designed behavior**,
not a stall. The defect was in the load driver, not the worker.

## Two independent preconditions

A trigger fires only when **both** hold:

1. **Threshold crossed** — pending count and age satisfy A or B.
2. **The batch job is actually invoked** — on a rig this is the Cloud Scheduler job
   `<service>-batch-anchors` (`*/30 * * * *`). In-process `node-cron` does **not** fire
   reliably on throttled Cloud Run. Confirm the scheduler job is `ENABLED` before
   concluding a trigger "did not fire":

   ```
   gcloud scheduler jobs list --project arkova1 --location us-central1 \
     --format="value(name,schedule,state)" | grep batch-anchors
   ```

## The fix already existed

`scripts/staging/fullsoak-trigger-b-volume.sh` was written during the 7-day soak for
exactly this problem, and its header states the trap verbatim. Parameters:

| Env | Default | Note |
|---|---|---|
| `TARGET` | 3100 | a little over the 3,000 floor |
| `PACE_PER_SEC` | 8 | observed real rate ~2.9/s |
| `CONCURRENCY` | 8 | |
| `RIG_URL` / `API_KEY_SECRET` / `CLOCK_END` / `EVID_ROOT_ABS` | — | retarget per rig |

~3,100 anchors takes roughly 18 minutes at the observed rate. Note `EVID_ROOT_ABS` must
point somewhere writable — the load harness deliberately refuses `--evidence-out` paths
outside `docs/staging`.

## Why it recurred

The lesson lived **only in that script's header comment**. A later session with no reason
to open the file re-derived it from first principles and spent soak window driving load at
a rate that could never reach the threshold.

**Rule:** before writing a staging load driver, grep `scripts/staging/` for a
purpose-built script. The trigger-reachability problem is solved; the solution is just not
discoverable from where a fresh session starts.

## Related

- `FD-CLOCK-1-instance-uptime-is-the-wrong-soak-clock.md` — the companion clock-definition
  correction from the same soak family.
- CLAUDE.md §1.12 — the tier matrix that makes A/B mandatory for T3.
