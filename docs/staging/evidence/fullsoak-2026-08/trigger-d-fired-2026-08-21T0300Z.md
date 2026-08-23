# Trigger D fired — chain-pair T3 soak, 2026-08-21T03:00:28Z

**Rig:** `arkova-worker-fullsoak-2026-08-staging`, revision `00022-suy`
(clock start 2026-08-19T16:51:23Z, T3 window ends 2026-08-21T16:51:23Z)
**Supabase project:** `gnkuaywlpmsaezwvlvhk`

Trigger D is the daily 03:00Z forced flush (`opts.force`), which bypasses the size and age
checks and broadcasts whatever is queued. §1.12 lists a **daily flush observation** among
the T3 evidence requirements.

## Why this firing is unambiguously Trigger D

At 02:39:37Z the queue held **2,614 PENDING**, oldest **70 minutes**:

- below `MIN_BATCH_THRESHOLD` (3,000) → Trigger B ineligible on count
- oldest well under 3 h → Trigger B ineligible on age
- far below `BATCH_SIZE` (10,000) → Trigger A ineligible

So no threshold trigger could fire. Confirmed by the scheduler pair one second apart:

| Time (UTC) | Endpoint | Status |
|---|---|---|
| 03:00:27.911 | `/jobs/batch-anchors` (regular `*/30`) | 200 — **deferred**, thresholds unmet |
| 03:00:28.650 | `/jobs/batch-anchors?force=true` (daily flush) | 200 — **fired** |

The regular run at 03:00:27.9 evaluated the same queue and did nothing. The forced run
0.7 s later drained it. That pairing isolates Trigger D as the cause.

## The firing

```
2026-08-21T03:00:28.994272Z   Forced batch flush (daily 3am EST sweep)
  pendingCountSentinel = 1
  batchSizeCrossed     = False
  oldestAgeMs          = 5433612        (90.6 min)
```

The message is the `opts.force` branch of `batch-anchor.ts:1746-1750`, named distinctly
from Trigger A's `'Batch size trigger fired'` and from the deferral path.

**Note on `pendingCountSentinel = 1`:** this is the fallback default from
`batch-anchor.ts:1726-1732` (`countsRes.data ?? { pendingCountSentinel: 1, … }`), not a
real count of 1 — the forced path does not depend on the threshold probe, so the probe
value carries no meaning here. `batchSizeCrossed = False` likewise reflects the fallback,
and is consistent with a queue of 2,614 being well under `BATCH_SIZE`. Do not read either
field as a measurement on this code path.

## Result

| status | anchors | distinct txs | orgs | window |
|---|---|---|---|---|
| SUBMITTED | **2,614** | **1** | 1 | 03:00:37.711Z → 03:00:39.744Z |

Transaction:

```
011a88f254189cea7bbbbfca999a238a5e754f3672b3b4f9a3e3e6088896ab81
```

The entire remaining queue — the 2,610 surplus left unclaimed by the Trigger A run plus
4 ambient anchors — drained in **2.0 seconds** into a single transaction, with no size or
age precondition met. That is the forced-flush behaviour Trigger D exists to provide.

## What this evidences — and what it does NOT

**Measured:** the daily forced flush fires on schedule, bypasses both threshold triggers,
and drains a sub-threshold queue that the regular run had just declined to touch.

**Confirmation — CONFIRMED at 03:13:33.317Z.** All **2,614** anchors carrying tx
`011a88f2…` reached `SECURED`, in a single transaction:

| status | anchors | distinct txs | confirmed at |
|---|---|---|---|
| SECURED | **2,614** | **1** | 2026-08-21T03:13:33.317Z |

End-to-end **03:00:28Z (forced flush) → 03:13:33Z (all SECURED) — 13 min 5 s**. No anchor
was lost and none stalled in `SUBMITTED`.

(An earlier revision of this document recorded the cohort only as far as broadcast, since
at 03:05:45Z they were still `SUBMITTED`. This section supersedes that.)

All three exercised triggers now have a complete PENDING → SECURED chain:

| Trigger | Fired | Anchors | Tx | All SECURED |
|---|---|---|---|---|
| B | 2026-08-20T22:00:43Z | 3,116 | `f9ddf989…` | 22:08:38Z (8 min 11 s) |
| A | 2026-08-21T01:30:00Z | 10,000 | `8962f944…` | 01:40:14Z (9 min 46 s) |
| D | 2026-08-21T03:00:28Z | 2,614 | `011a88f2…` | 03:13:33Z (13 min 5 s) |

**NOT asserted:** cross-org behaviour (`orgs = 1`).

## T3 trigger coverage for this window

| Trigger | Status |
|---|---|
| A — size (10,000) | Fired 2026-08-21T01:30:00Z |
| B — age (3,000 + 3 h) | Fired 2026-08-20T22:00:43Z |
| C — fee ceiling | **Not exercised** — cannot be forced on demand; not simulated |
| D — daily 03:00Z forced flush | **Fired 2026-08-21T03:00:28Z** (this document) |

## Load-continuity note affecting this window

The load relauncher's LaunchAgent (`ai.arkova.soak.wave-load`) failed to re-fire on its
30-minute schedule after the 02:15:57Z cycle ended at 02:41:16Z. No load ran on wave2,
migration or wave3 between **02:41Z and 03:07Z (~26 minutes)** until the agent was
restarted with `launchctl kickstart`. The chain-pair rig's own Cloud Scheduler crons were
unaffected — they are server-side — so this Trigger D observation is untouched by the gap.
The gap is recorded here because it bears on the wave2/migration/wave3 load records for the
same interval.
