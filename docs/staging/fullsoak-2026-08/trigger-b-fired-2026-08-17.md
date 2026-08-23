# Trigger B — fired for the first time, 2026-08-17T14:00:02Z

**3,832 anchors in one transaction. The age-based batch trigger has never fired in any
prior soak; §1.12 lists it as required T3 evidence.**

## What fired, and why it could

`triggerB_shouldFireOnAge` requires **both**:

```js
if (input.pendingCount < MIN_BATCH_THRESHOLD) return false;   // 3,000
return input.oldestPendingAgeMs >= MAX_ANCHOR_AGE_MS;         // 3 hours
```

At the 14:00Z `batch-anchors` cycle both held for the first time:

| Condition | Value at 14:00:02Z |
|---|---|
| `pendingCount >= 3,000` | **3,832** ✓ |
| oldest pending age `>= 3h` | anchors from 04:37Z and earlier, **~9.4h** ✓ |
| Trigger A (`>= 10,000`) | not met — injection had not yet passed 10,000 |

Worker log: `Claimed anchors for batch processing  claimed=3832`, then
`Preparing fingerprint anchor transaction` → `Transaction built and signed` →
`Signed transaction broadcast` → `Batch anchor processing complete`, all inside 21 seconds.

**Why it had never fired before.** Two independent ceilings had to come off. The FREE-tier
per-org daily cap of 100 anchors made `pendingCount >= 3,000` arithmetically unreachable —
15 org-days of traffic. That cap was removed at 13:47Z by bumping both rig orgs
FREE → ENTERPRISE (`organizations.tier`, a data change; the July 2026 soak team did the same
for the legacy rigs). The 3h age came free from the morning's accumulated traffic-agent
anchors, which had been sitting since 04:37Z waiting for the nightly flush.

## On-chain evidence, independently verified

**txid `e688cf2eb36d2794efe167be9a8a42c7f38835a5c262629e5953c0c2619c89d9`**

| Source | Result |
|---|---|
| Rig database | `chain_block_height = 318115`, **3,832 anchors** on this tx |
| `mempool.space/signet` | `confirmed=true`, block **318115** |
| `blockstream.info/signet` | `confirmed=true`, block **318115** |

239 bytes, **628 sat total fee**, `op_return` (Merkle root over all 3,832) + `v0_p2wpkh`
change of 741,381 sat.

## The economics claim, now measured twice

| Batch | Anchors | Size | Fee | Sat/anchor |
|---|---|---|---|---|
| Trigger D, 03:00Z | 104 | 239 B | 628 sat | 6.04 |
| **Trigger B, 14:00Z** | **3,832** | **239 B** | **628 sat** | **0.16** |

Identical transaction size and identical fee for a 37× larger batch. That is the Merkle
batching property stated as a design goal — Bitcoin cost tracks **broadcast count, not
document count** — and it is now measured rather than asserted, at two points three orders
of magnitude apart in per-document cost.

## Correction — how Trigger B was established, and a real observability gap

**Trigger B fires SILENTLY. There is no log line for it.** In `batch-anchor.ts` the
trigger block logs three cases and not the fourth:

| Case | Log |
|---|---|
| `opts.force` | info — `Forced org batch flush` / `Forced batch flush (daily 3am EST sweep)` |
| Trigger A | info — `Batch size trigger fired` |
| Trigger B **fails** | debug — `Batch trigger not met — deferring`, then returns |
| Trigger B **passes** | **nothing** — falls straight through to the claim |

So the 14:00:02Z run is attributed to Trigger B by **elimination against the code**, not by
a log line: there was no force log, no Trigger-A log, `claimed=3832` is below the 10,000
Trigger-A threshold, and the run did not return empty — which is reachable only if
`triggerB_shouldFireOnAge` returned true. The conclusion holds, but it is inference, and it
should be read as such.

**This is worth fixing.** The one trigger whose firing conditions are hardest to reason
about (a conjunction of count AND age) is also the only one that leaves no trace. An
operator cannot answer "why did this batch fire?" from logs alone. Trigger B should emit an
info log symmetric with A and D.

## Correction — the 14:19Z batch was NOT Trigger A

A second batch claimed **6,706** anchors at 14:19:17Z. That was **not** Trigger A. The
preceding line reads `Forced org batch flush  pendingCountSentinel=3000
oldestAgeMs=1151342` — the per-org queue scheduler's `opts.force` path, which bypasses both
the size and age thresholds. Trigger A has **still not fired**.

This surfaces the real obstacle to reaching it: the per-org forced flush runs on its own
cadence, independent of the `*/30` `batch-anchors` job (whose last Cloud Scheduler attempt
was 14:00:14Z), and drains the pending pool before it can accumulate to 10,000. Reaching
`pendingCount >= BATCH_SIZE` therefore requires injecting faster than the org-queue flush
drains — a throughput race, not a quota problem.

## Scope of the claim

**Measured:** Trigger B fires when `pendingCount >= 3,000` and oldest age `>= 3h`; it claims
and batches the full pending set (3,832) into a single transaction; that transaction confirms
on two independent explorers; per-anchor fee falls to 0.16 sat at this batch size.

**NOT asserted:** Trigger A (`pendingCount >= BATCH_SIZE` = 10,000) has **not** fired as of
this writing — a second injection is in flight to reach 10,000 simultaneous PENDING before
the current backlog ages. Until that lands, no claim is made about behaviour at the
BATCH_SIZE ceiling, and F-8's open question — whether `batch_insert_anchors` holds at full
10k scale — remains open.

**Provenance:** this evidence begins 2026-08-17, Day 5 of the window. It does not
retroactively cover Days 0–3, which carried no anchor throughput at all.
