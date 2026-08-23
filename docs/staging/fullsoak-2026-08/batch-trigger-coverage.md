# Batch triggers — what this soak can and cannot evidence

**Written 2026-08-16 (Day 4), after two of my own wrong conclusions. Both are recorded
below rather than quietly fixed, because the wrong version is the one that would have
shipped into the evidence pack.**

## The actual design

From `services/worker/src/jobs/batch-anchor.ts`:

| Constant | Value |
|---|---|
| `BATCH_SIZE` | 10,000 |
| `MIN_BATCH_THRESHOLD` | 3,000 |
| `MAX_ANCHOR_AGE_MS` | 3 hours |

| Trigger | Fires when |
|---|---|
| **A** — size | `pendingCount >= 10,000` |
| **B** — age | `pendingCount >= 3,000` **AND** oldest age `>= 3h` |
| **C** — fee | *defers* the batch when the live fee rate exceeds a backlog-scaled ceiling |
| **D** — daily flush | 03:00 forced sweep; fires whatever is queued, bypassing A and B |

`MIN_BATCH_THRESHOLD` is explicitly **not** a fire trigger — it is the "start watching the
clock" threshold. Firing on age alone was removed by PR #627 because a 1-anchor backlog at
3h would burn a UTXO on a single-leaf transaction. The code says it plainly:

> 1 anchor sitting 6h with no queue growth → does NOT fire (sub-3k). The daily 3am EST
> scheduled flush handles long-tail micro-queues.

## Correction 1 — "the drain is stalled" was wrong

After the FD-CHAIN-3 node fix, `Treasury pre-flight check passed, utxoCount=1,
totalSats=742637` at 16:00:00Z, and the 12 PENDING anchors still did not move. I read that
as a third fault. It is not. With 12 pending, Trigger A (10,000) and Trigger B (3,000)
are both unreachable, so the run correctly deferred and logged
`'Batch trigger not met — deferring'` at **debug** level — which is why the cycle looked
silent. **The system was behaving exactly as designed.** Those anchors drain at the 03:00
flush.

The FD-CHAIN-1 outage before it was real and is unaffected by this correction: `hasFunds()`
returned false and forced an early `return emptyResult()` **before** any trigger logic ran.
Different code path, genuine defect.

## Correction 2 — my own A17 health assertion was wrong

I added A17 (drain liveness) the same day, failing on any PENDING older than **75 minutes**,
reasoning that `batch-anchors` runs `*/30`. That encodes an assumption the system does not
hold, and it would have raised a **false FAIL every single day** — precisely the "green
signal that means nothing" failure it was written to prevent, inverted.

Corrected threshold: **26 hours**, which allows one full daily cycle plus margin. The real
failure signal for a micro-queue is a **missed daily flush**, not an anchor waiting a few
hours.

## Coverage gap — Triggers A and B are structurally unreachable at soak volume

The anchor-traffic generator submits 3 anchors every 2 hours ≈ **36/day**. Against a 3,000
floor and a 10,000 ceiling, neither A nor B can ever fire. §1.12 lists "Trigger A fires,
Trigger B fires, Daily flush observation" as required **T3** evidence.

**Therefore, at current volume this soak can evidence Trigger D only.** Any claim that the
window exercised Trigger A or Trigger B would be false. To evidence them the rig needs a
backlog of 3,000+ (B, with a 3h age) and 10,000 (A) — which is a deliberate volume
injection, not something continuous low-rate traffic will ever produce.

**CORRECTION (same day, after attempting it):** the rate was never the binding constraint.
The per-org **daily quota** caps a FREE-tier org at **100 anchors/day**
(`perOrgRateLimit.ts`, `TIER_QUOTAS.FREE.anchors_created`), and both rig orgs are FREE.
An attempt to inject 3,100 anchors returned **3,030 x HTTP 429 `ORG_QUOTA_EXCEEDED`**.
So 3,000 pending is ~15 org-days away and Trigger B is unreachable inside this window
without moving an org to `PAID`. See `FD-RL-quota-headers-and-counter.md`, which also
records two real defects found by that attempt.

## SUPERSEDED 2026-08-17 — A and B were both reached and both fired

Everything above describes the state on Day 4 and is kept for provenance. It is no longer
the coverage position. The binding constraint (the FREE-tier 100/day per-org cap) was
removed by moving both rig orgs to `ENTERPRISE` at 13:47Z, volume was injected, and:

| Trigger | Fired | Anchors | Block | txid |
|---|---|---|---|---|
| **A** size (`>= 10,000`) | 2026-08-17T14:40Z | **10,000** | 318117 | `c70d1662…` |
| **B** age (`>= 3,000` AND `>= 3h`) | 2026-08-17T14:00Z | **3,832** | 318115 | `e688cf2e…` |
| **D** daily flush | 2026-08-17T03:00Z | 104 | 318046 | `fba08120…` |

Both verified on `mempool.space/signet` and `blockstream.info/signet`. Full evidence in
`trigger-a-fired-2026-08-17.md` and `trigger-b-fired-2026-08-17.md`.

**Measured:** Triggers A, B and D all fire and drive a batch end-to-end to SECURED with
1:1 80-byte-header proof coverage.

**NOT asserted:** **Trigger C** (fee-aware deferral) has still not fired — signet fee rates
never approached `ABSOLUTE_FEE_CAP_SAT_PER_VB`, so the deferral path remains untested.
Also NOT asserted: FREE-tier quota behaviour, which stopped being exercised the moment both
orgs were moved to ENTERPRISE.
