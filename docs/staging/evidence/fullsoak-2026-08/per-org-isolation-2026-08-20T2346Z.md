# Per-org isolation check — chain-pair T3 soak, 2026-08-20T23:46Z

**Rig:** `arkova-worker-fullsoak-2026-08-staging`, revision `00022-suy`
(clock start 2026-08-19T16:51:23Z, T3 window ends 2026-08-21T16:51:23Z)
**Supabase project:** `gnkuaywlpmsaezwvlvhk`

CLAUDE.md §1.12 lists a **per-org isolation check** among the required T3 evidence. The
Trigger B firing recorded in `trigger-b-fired-2026-08-20T2200Z.md` could not satisfy it —
all 3,116 anchors in that batch belonged to a single org (`orgs = 1`). This closes it.

## What "isolation" actually means here

Read from the implementation rather than assumed. `batch-anchor.ts:636-640` states the run
lease is **GLOBAL, not per-org**, because the treasury is shared:

> "The lease is GLOBAL, not per-org, even though `orgId` runs claim only their own org's
> anchors: the treasury is shared, so org scoping does not make two runs independent…
> A skipped org run leaves its anchors PENDING for the next tick."

So isolation is **not** transaction separation enforced by the lease. The invariants that
actually must hold are:

1. **Claim isolation** — an org-scoped run claims only its own org's anchors.
2. **Credit isolation** — `deductOrgCredit(db, anchor.org_id, …)` (`batch-anchor.ts:365`)
   charges each anchor to *its own* org, never another's.

## Method

Two orgs exist on the rig. 120 anchors were submitted as the second org through the **real
product API** — `POST /api/v1/anchor`, API-key auth (`arkova-fullsoak-2026-08-apikey-orgb-crosstenant`,
`anchor:write` scope), **120 × HTTP 201**. No direct DB writes, no rig config mutated, no
credential created. Org B's ambient traffic was left exactly as it was.

Resulting cross-org pending state at 23:41Z:

| org | PENDING | source |
|---|---|---|
| `aaaaaaaa-0000-4000-8000-000000000001` | **120** | injected 23:39:21 → 23:40:33 |
| `bbbbbbbb-0000-4000-8000-000000000001` | **4** | ambient, untouched since 23:30:27 |

124 total — far below `MIN_BATCH_THRESHOLD` (3,000) and `BATCH_SIZE` (10,000), so neither
Trigger A nor B could fire. The drain therefore had to come from
`org-queue-scheduler` (`4-59/5`), whose forced flush bypasses the thresholds. Scheduler
invocations observed: 23:34:07Z, 23:39:07Z, **23:44:06Z**, 23:49:03Z — all HTTP 200.

## Result — both invariants hold exactly

**Claim isolation.** After the 23:44:06Z org-queue run:

| org | status | anchors | distinct txs | last update |
|---|---|---|---|---|
| `aaaaaaaa…` | **SECURED** | **120** | **1** | 2026-08-20T23:46:16.124Z |
| `bbbbbbbb…` | **PENDING** | **4** | 0 | 2026-08-20T23:30:27.583Z (unchanged) |

Org A's run claimed **only** org A's 120 anchors and drained them to SECURED in a single
transaction. **Org B's 4 pending anchors were not claimed, not batched, and not touched** —
their `updated_at` is still the pre-injection value. That is claim isolation demonstrated
against a live concurrent second tenant, not inferred.

Org B's anchors remaining PENDING is correct: nothing had triggered for them, which is
precisely the documented "a skipped org run leaves its anchors PENDING for the next tick."

**Credit isolation.** `org_credit_deductions`, baseline vs after:

| org | rows before | rows after | delta | rows since 23:39:00Z |
|---|---|---|---|---|
| `aaaaaaaa…` | 9 | **129** | **+120** | **120** |
| `bbbbbbbb…` | 29,024 | **29,024** | **+0** | **0** |

120 anchors submitted to org A produced **exactly 120** credit deductions on org A and
**exactly zero** on org B. No cross-tenant charge in either direction.

Supporting: org B independently shows **29,024 deduction rows against 29,024 anchors** — a
clean 1:1 across the whole soak, including the 3,116-anchor Trigger B batch.

## Precision note on when credits are charged

Org A's last deduction timestamp is **23:40:33.360Z**, which matches the end of the
*injection* window (23:40:33.207Z), **not** the drain at 23:46:16Z. Credits are therefore
deducted at **anchor submission**, not at batch/broadcast time. The isolation invariant
holds either way, but do not describe this evidence as "credits charged at anchoring" — it
is charged on submit.

## What this evidences — and what it does NOT

**Measured:** claim isolation and credit isolation across two concurrent tenants on one
rig, driven entirely by the rig's own bound cron.

**NOT asserted:** this does not test isolation under *simultaneous* org-queue runs for both
orgs; org B never crossed its own flush threshold during the window. The global run lease
(`batch-anchor.ts:636`) is the mechanism intended to make that case safe, and it remains
un-exercised here.

**NOT asserted:** Trigger A (`BATCH_SIZE` = 10,000) remains un-evidenced for this window.
