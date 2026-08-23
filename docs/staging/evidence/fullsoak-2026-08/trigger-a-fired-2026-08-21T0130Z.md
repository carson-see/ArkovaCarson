# Trigger A fired — chain-pair T3 soak, 2026-08-21T01:30:00Z

**Rig:** `arkova-worker-fullsoak-2026-08-staging`, revision `00022-suy`
(clock start 2026-08-19T16:51:23Z, T3 window ends 2026-08-21T16:51:23Z)
**Supabase project:** `gnkuaywlpmsaezwvlvhk`

CLAUDE.md §1.12 requires **"Trigger A fires, Trigger B fires"** as T3 evidence. Trigger B
was recorded in `trigger-b-fired-2026-08-20T2200Z.md`. This closes Trigger A, the last
outstanding trigger requirement for this window.

## Threshold in force on this rig

`BATCH_ANCHOR_MAX_SIZE=10000` is set on revision `00022-suy`, and

```ts
export const BATCH_SIZE = Math.min(
  Math.max(parseInt(process.env.BATCH_ANCHOR_MAX_SIZE ?? '10000', 10) || 10000, 100),
  10000,
);
```

so **`BATCH_SIZE` = 10,000** (the env override is clamped lower-only, never above 10,000).

## How Trigger A is distinguished from Trigger B — read from the code, not inferred

`batch-anchor.ts:1746-1762` is an **if / else-if chain**:

```ts
if (opts.force)                                   → 'Forced batch flush'        (Trigger D)
else if (triggerA_shouldFireOnSize(pendingCount)) → 'Batch size trigger fired'  (Trigger A)
else if (!triggerB_shouldFireOnAge({...}))        → 'Batch trigger not met — deferring'
```

Trigger A is evaluated **before** Trigger B, so a size-based fire logs Trigger A by name and
B is never consulted. The log line is therefore self-disambiguating even when B's
conditions happen to hold concurrently.

**Precision note:** the call passes `pendingCount`, although the parameter and the doc
comment at `batch-anchor.ts:413-419` both say *"claimed count"*. Trigger A therefore fires
on **pending ≥ 10,000**, not on claim size. The comment and the call site disagree; this
evidence describes the behaviour, not the comment.

## The firing

Cloud Scheduler `…-batch-anchors` (`*/30`) invoked `/jobs/batch-anchors` at
**01:30:28.910Z** (HTTP 200). The worker emitted:

```
2026-08-21T01:30:00.506760Z   Batch size trigger fired
  pendingCountSentinel = 10000
  batchSizeCrossed     = True
  pendingThresholdCrossed = True
  oldestAgeMs          = 10503027
```

**`oldestAgeMs` = 10,503,027 ms = 175.05 minutes = 2 h 55 m.** Trigger B requires the
oldest pending anchor to be **≥ 3 h**. At fire time the oldest was **5 minutes short of
that threshold**, so Trigger B was *ineligible*. This firing is unambiguous on two
independent grounds:

1. the worker names Trigger A in the log, and
2. Trigger B's age condition was provably unmet.

## Result — claim capped at exactly BATCH_SIZE

| status | anchors | distinct txs | orgs | window |
|---|---|---|---|---|
| **SECURED** | **10,000** | **1** | 1 | 01:40:01.533Z → 01:40:14.212Z |
| PENDING (remainder) | **2,610** | 0 | 1 | left unclaimed |

Transaction:

```
8962f944c99c46b34ef8dd43adbca2277fb701f20b7441d9101e39a9923fce46
```

The pool was deliberately overshot (12,610 submitted) so the clamp would be observable.
The run claimed **exactly 10,000** — not the full pool — and left **2,610 PENDING**. That
is `BATCH_SIZE` clamping evidenced directly rather than argued from the constant.

All 10,000 anchors landed in a **single** transaction and reached SECURED **13 seconds**
after broadcast began. End-to-end from scheduler invocation to all-SECURED:
**01:30:28Z → 01:40:14Z, under 10 minutes for 10,000 anchors.**

## Method

12,610 anchors submitted as org `bbbbbbbb-0000-4000-8000-000000000001` through the **real
product API** — `POST /api/v1/anchor`, API-key auth
(`arkova-fullsoak-2026-08-apikey-soak-sdk-write`, `anchor:write` scope) — across two
concurrent injector runs (`TARGET=10100` at 00:47Z, `TARGET=2500` at 01:03Z). No direct
database writes; no status set by the instrument. Trigger evaluation, claiming, signing and
broadcast were performed entirely by the rig's own bound cron.

## What this evidences — and what it does NOT

**Measured:** Trigger A evaluates and fires at its documented threshold; the claim is
clamped to exactly `BATCH_SIZE`; the surplus is correctly left PENDING for a later run;
10,000 anchors batch into one transaction and reach SECURED in under 10 minutes.

**NOT asserted:** cross-org behaviour. All 10,000 belong to a single org (`orgs = 1`);
per-org isolation is evidenced separately in
`per-org-isolation-2026-08-20T2346Z.md`.

**NOT asserted:** Trigger C (fee ceiling) remains un-exercised, as it has been for the
whole window.

## T3 trigger coverage for this window

| Trigger | Status |
|---|---|
| A — size (10,000) | **Fired 2026-08-21T01:30:00Z** (this document) |
| B — age (3,000 + 3 h) | Fired 2026-08-20T22:00:43Z |
| C — fee ceiling | Not exercised |
| D — daily 03:00Z forced flush | Scheduler enabled; observed as a separate daily event |
