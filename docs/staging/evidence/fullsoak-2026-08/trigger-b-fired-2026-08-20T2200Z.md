# Trigger B fired — chain-pair T3 soak, 2026-08-20T22:00:43Z

**Rig:** `arkova-worker-fullsoak-2026-08-staging`, revision `00022-suy`
(clock start 2026-08-19T16:51:23Z, T3 window ends 2026-08-21T16:51:23Z)
**Supabase project:** `gnkuaywlpmsaezwvlvhk`

CLAUDE.md §1.12 lists **"Trigger B fires"** as required T3 evidence. Before today the rig
had no path to satisfy it — see `../../findings/FD-TRIGGER-1-ambient-load-cannot-reach-triggers-a-b.md`.
This records the first genuine firing.

## Preconditions established

Trigger B requires **both** `MIN_BATCH_THRESHOLD` (3,000 pending) **and** oldest pending
≥ 3h (`services/worker/src/jobs/batch-anchor.ts`).

| Time (UTC) | PENDING | Oldest age | Note |
|---|---|---|---|
| 21:42 | 672 | 167 min | injection in progress |
| 21:53:02 | 2,674 | 178 min | |
| 21:54:36 | 2,992 | 180 min | 3h clock met |
| 21:55:42 | 3,116 | 181 min | **both conditions met** |

Composition at fire time reconciles exactly: **3,104** anchors created in the preceding
45 minutes (3,100 injected + 4 from the ambient traffic generator) plus **12**
genuinely-old PENDING rows dating to 18:55:04Z. The 12 old rows supply the ≥3h age; the
injection supplies the ≥3,000 count.

## Injection method

`scripts/staging/fullsoak-trigger-b-volume.sh`, `TARGET=3100 PACE_PER_SEC=8 CONCURRENCY=8`.

All 3,100 submitted through the **real product API** — `POST /api/v1/anchor`, API-key
auth, `anchor:write` scope — returning **3100 × HTTP 201**. No direct database writes; no
status was set by the instrument. Trigger evaluation and broadcast were performed entirely
by the rig's own bound cron.

## The firing

Cloud Scheduler job `arkova-worker-fullsoak-2026-08-staging-batch-anchors` (`*/30 * * * *`)
fired at **22:00:27.310599Z**; the worker received `/jobs/batch-anchors` at
**22:00:27.351771Z**.

| Time (UTC) | PENDING | BROADCASTING |
|---|---|---|
| 22:00:12 | 3,116 | 0 |
| 22:00:43 | 116 | **3,000** |
| 22:00:52 | 0 | 3,116 |

The first pass took **exactly 3,000** — precisely `MIN_BATCH_THRESHOLD`. That exact number
is what identifies this as **Trigger B** rather than Trigger A (`BATCH_SIZE` = 10,000,
never reached) or Trigger D (the 03:00Z forced flush, which did not run at this hour). A
follow-on pass swept the remaining 116.

Drain of all 3,116: **22:00:24.903Z → 22:00:51.951Z, 27 seconds.**

## What this evidences — and what it does NOT

**Measured:** Trigger B evaluates and fires correctly at its documented threshold; the
batch path drains 3,116 anchors in 27s under the rig's own cron with no manual invocation.

**NOT asserted:** this does **not** satisfy the T3 "per-org isolation check". Every
injected anchor belongs to a **single org** (`orgs = 1`), so no cross-org batching
behaviour was exercised. That remains outstanding for this soak.

## Broadcast leg (completed 22:03:22.9Z)

The batch broadcast into a **single Bitcoin transaction**:

```
f9ddf989003f820d7bb624634e353ddc7bec0595258cc123840234a67def3d00
```

| Time (UTC) | anchors with `chain_tx_id` | distinct txs |
|---|---|---|
| 22:02:42 | 1,200 | 1 |
| 22:02:49 | 1,800 | 1 |
| 22:03:22 | **3,116** | **1** |

All 3,116 anchors resolved to that one transaction — consistent with the batching
economics (one on-chain write amortised across the whole batch) rather than per-anchor
broadcast. Wall clock from trigger fire to fully-broadcast batch: **22:00:27Z → 22:03:23Z,
under 3 minutes.**

**NOT asserted:** on-chain confirmation. At capture the anchors were `BROADCASTING` with
the tx id assigned but not yet confirmed into a block, so none had transitioned to
`SECURED`. Confirmation follows block inclusion and is a separate observation.

**NOT asserted:** Trigger A. `BATCH_SIZE` = 10,000 was never approached and remains
un-evidenced for this window.
