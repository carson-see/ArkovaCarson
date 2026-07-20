# Task 5 — Drain downstream root-cause dig (SCRUM-2620) — initial findings toward the Jul-25 D1 packet

**Mode:** read-only logs/queries + code read. No prod writes. No scheduler/feeder mutation (W6).

## 1. Backlog state (read-only, prod `vzwyaatejekddvltxyye`)
- **anchors:** 2,972,268 SECURED + 1 REVOKED, **0 PENDING / 0 stuck** (HANDOFF, CTO-signed read-only). Nothing is mid-drain.
- **Backlog = 255,491 `public_records` with `anchor_id IS NULL`** — ingested, never enqueued, because feeder Scheduler jobs `process-anchors` + `anchor-public-records` are **PAUSED** (SCRUM-2900, P1). The dashboard "259k Pending Anchoring" is this, not stuck anchors.
- **`job_queue`:** 4 rows, all `pending`, 0 failed / 0 dead. **0 classifier checkpoint rows** (the back-catalog classifier has never run against prod — corroborates Task 2).

## 2. Root cause of the "load mislabels finished work" bug (SCRUM-2620)
**Location:** `services/worker/src/jobs/org-queue-scheduler.ts:242–263` (the per-org `catch`).

```
} catch (err) {
  result.failed += 1;
  ...
  status: 'failed',
  processed: 0,          // <-- HARDCODED; discards real progress
  ...
}
```

**The defect:** the scheduler treats `processBatchAnchors({force,orgId})` as **atomic all-or-nothing**, but it is a **staged, partial-commit pipeline** (`batch-anchor.ts`): it claims `PENDING→BROADCASTING`, broadcasts a real tx (sets `chain_tx_id`), then `submit_batch_anchors` flips rows `→SUBMITTED`, with proof-persist / credit-refund / chunked-submit / reconcile steps that **can throw AFTER on-chain work is already committed** (the file's own reconcile comments at lines ~580–608 describe rows deliberately left `SUBMITTED` or `BROADCASTING+intent` on error, to be finished by the next reconcile pass). When any late phase throws, the scheduler records the whole run **`status:'failed'`, `processed_count:0`**, does **not** set `last_success_at`, and sets `last_error` — even though anchors were actually secured on-chain.

**Why "under load":** late-phase throws are load-correlated — PostgREST 1000-row chunk boundaries, credit-refund contention, proof-persist failures, and reconcile races all get more likely as batch size / concurrency rise. At 10k-anchor drain scale the probability of a post-broadcast throw is materially higher than in a single small manual run.

**Corroboration, not assumption:**
- The status vocabulary is binary `succeeded|failed` (`QueueRunStatus`) with **no partial/deferred state** to represent "work done but an error occurred."
- `batch-drain-reconcile.test.ts` (the CRASH test) proves partial-commit is real: a crash after broadcast leaves `chain_tx_id` set and rows `BROADCASTING`; the design *relies* on a later reconcile — i.e., a throw mid-run with real committed work is an expected, handled state at the anchor layer, but the **scheduler layer erases it** to failed/0.

## 3. Why prod shows no mislabel yet (latency = the trap)
`organization_queue_runs` in prod = **exactly 3 rows, all `trigger=manual`, `status=succeeded`, `processed_count=0`** (2026-05-20, 06-29, 07-06). The org-queue **scheduler has never run under load in prod** (no prod org-queue-scheduler job; feeders paused). So SCRUM-2620 is **latent** — unobservable today, guaranteed to fire the moment the drain is activated under load. This is precisely the founder's F6 "drain trap": **activate before SCRUM-2620 is fixed → load mislabels finished work.**

## 4. Downstream consequences (feeds the D1 decision)
1. **Burndown metric corruption:** `organization_queue_run_state.last_success_at` stays stale and `last_error` is set for runs that actually secured anchors → any dashboard/monitor keyed on run status **over-counts failures and under-counts finished work**. A D1 "how fast is the backlog draining" chart built on this will be wrong.
2. **Re-drive risk:** a `failed` run whose work completed may be re-claimed/re-run; the anchor-layer reconcile prevents double-broadcast (RACE-1 guard, verified in test), so this is **not a double-spend risk** — but it wastes a drain cycle and further muddies the metrics.
3. **No data loss / no false-SECURED:** the on-chain work is correct; the bug is purely in the **run-accounting label**, not the anchor state. (Important for the founder: the money/chain side is safe; the reporting side lies.)

## 5. Recommendation for the D1 packet (Jul-25)
- **Do NOT activate the drain until SCRUM-2620 is fixed and green under RIG-A load** (lane item 13). Fix direction: have `processBatchAnchors` return partial progress and record run status from **actual committed count** — add a `partial`/`succeeded_with_deferrals` state (or at minimum record `processed_count = batch.processed` and set `last_success_at` when >0) instead of hardcoding `failed/0` on any throw.
- **Safe activation window: Jul 26–29** (D1), gated on: (a) SCRUM-2620 fix soaked under load, (b) SCRUM-2900 scheduler reconciliation, (c) SCRUM-2981 alert-dedupe so mislabeled/duplicate signals don't drown a real alarm.
- **Demo fallback holds either way:** the Aug-9 demo uses pre-secured records (Task 1/Task 4), so it does not depend on the drain being open.

## 6. Not asserted (§1.5)
No prod row *exhibiting* the mislabel exists to show (the scheduler never ran under load in prod) — the finding is a code-level latent defect corroborated by the partial-commit design + empty prod run history, not an observed prod failure. The exact `secured_without_tx` figure (Task 2 A1) remains unconfirmed read-only.

_Lane 1 (Trust & Chain), 2026-07-20 evening. Initial findings; full D1 packet is the Jul 22–25 workstream (lane item 12)._
