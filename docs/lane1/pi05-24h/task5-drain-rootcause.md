# Task 5 — Drain downstream root-cause dig (SCRUM-2620) — initial findings toward the Jul-25 D1 packet

**Mode:** read-only logs/queries + code read. No prod writes. No scheduler/feeder mutation (W6).
**Revised after the architect specialist review** — the original mechanism (throw-after-commit) was refuted by the code; corrected below. Conclusion (money-safe, reporting-only defect, SCRUM-2620 latent) survives.

## 1. Backlog state (read-only, prod `vzwyaatejekddvltxyye`) — live-verified
- **anchors:** most-recent = `ARK-DOC-GHZG6V`, **SUBMITTED**, `2026-07-20T18:12:24Z`; `SUBMITTED` count = 1, `BROADCASTING` = 0. So one anchor **is** mid-flight (not "nothing mid-drain"). SECURED total is a `reltuples` **estimate** (~2.99M; see note); `anchor_proofs` = **6,110 exact**.
- **`0 PENDING` is UNVERIFIED this window** — the exact count seq-scans ~3M rows and times out (no index for that predicate). The earlier "0 PENDING / feeders paused / nothing mid-drain" came from a stale HANDOFF snapshot, not a live query; **do not state it as fact in the D1 packet.** Live feeders are ENABLED (Task 9).
- **Backlog** (last CTO-signed figure, HANDOFF): 255,491 `public_records` with `anchor_id IS NULL`. Given feeders are now enabled, this figure is **stale-risk** — recommend a psql/MCP recount.
- **`job_queue`:** 4 rows, all `pending`, 0 failed / 0 dead. **0 classifier checkpoint rows.**

## 2. Root cause of the run-accounting defect (SCRUM-2620) — CORRECTED
**Location:** `services/worker/src/jobs/org-queue-scheduler.ts:206–264`.

The catch block **does** hardcode `status:'failed', processed:0` (lines 242–263) with no `last_success_at` and no partial state — that quote is accurate. **But the original claim that `processBatchAnchors` throws *after committing on-chain work* is WRONG for the prod path.** The prod drain is deliberately commit-safe (verified against the code):
- `broadcastSignedTx` is **infallible-after-wire** (`signet.ts:868–884`): the only post-send work is a try/caught block-height read that degrades to 0. It does not throw once the tx is broadcast.
- **Phase 3c converts every post-broadcast uncertainty into a graceful `return {processed:0, txId}`**, not a throw (`batch-anchor.ts:1281–1294`) — which the scheduler records as **SUCCEEDED** (lines 209–212).
- **Phase 4 submit errors never throw** — retry then `bulkMarkSubmittedFallback` returns a number (`batch-anchor.ts:1357–1392`, `1525–1569`).
- The one un-try/caught post-broadcast throw (`persistBatchAnchorProofs`) runs **only on the LEGACY path** (`if (!intentPersisted)`); the prod client is intent-capable so it is **skipped**.
- The definitive-reject refund throw (`1305`) is **pre-commit** (tx provably never relayed) → correctly `failed`.

**The actual defect is two-fold:**
1. **`failed/0` mislabel (narrow):** the scheduler's `try` is **too broad** — it wraps `processBatchAnchors` **plus its own `recordOrgQueueRunResult({status:'succeeded'})` (line 213) and `emitOrgAdminNotifications` (line 230)**. If either of *those* throws after a committed batch, the catch writes `failed/0` (and can leave a duplicate row after an already-written succeeded row).
2. **`SUCCEEDED/0` undercount (dominant under load):** Phase 3c's graceful deferred-broadcast `return {processed:0}` is recorded as **succeeded with 0 processed**, while the anchors are actually finalized **later, by the reconcile path, outside run-accounting**. So the common load outcome is not `failed/0` at all — it's a run booked `succeeded/0` whose work lands off-ledger. Both corrupt burndown metrics; neither loses data.

## 3. Severity — DOWNGRADED from the original
"Guaranteed to mislabel finished work as failed the moment the drain opens" is **not supported**. The `failed/0` path requires a throw in the scheduler's own record/emit calls; the routine load failure is the `SUCCEEDED/0` undercount. Prod `organization_queue_runs` = **3 rows, all manual/succeeded/processed:0**, and there is **no prod (non-rig) org-queue-scheduler job** (Task 9) — so this path has **never run under load in prod** and is **latent**. Self-healing further bounds it: `reconcileBroadcastIntents` + `recover_stuck_broadcasts` finalize BROADCASTING rows next tick, and the RACE-1 guard blocks double-broadcast (verified in `batch-drain-reconcile.test.ts`).

## 4. Consequences (feeds the D1 decision)
1. **Burndown-metric corruption** (the real risk): `organization_queue_runs`/`_state` will under-count processed work — `SUCCEEDED/0` runs whose anchors reconcile off-ledger, plus occasional `failed/0` runs — so any dashboard keyed on run status/processed_count **misreports drain progress**. A D1 "how fast is the backlog draining" chart built on this is wrong.
2. **No data loss / no false-SECURED / no double-spend** — the on-chain layer is correct (broadcast infallible-after-wire, reconcile finalizes, RACE-1 guards). **The money/chain side is safe; the reporting side lies.** (Important framing for the founder.)
3. **Occasional duplicate run rows** when the over-broad `try` catches a post-succeeded record/emit throw.

## 5. Recommendation for the D1 packet (Jul-25)
- **Do NOT open the org-queue drain until run-accounting is fixed and soaked under load** (lane item 13). Fix direction: (a) **narrow the scheduler `try`** so `recordOrgQueueRunResult`/`emitOrgAdminNotifications` failures don't turn a committed batch into `failed/0`; (b) record run status from the **actual committed/finalized count**, not the immediate `processed` return — i.e. add a `partial`/`deferred` state and reconcile the deferred-broadcast `return {processed:0}` back into the run once its anchors secure; (c) make burndown metrics derive from anchor state, not run-row status.
- **Safe activation window: Jul 26–29** (D1), gated on: the run-accounting fix soaked under RIG-A load, SCRUM-2900 scheduler reconciliation, and SCRUM-2981 alert-dedupe.
- **Demo fallback holds either way** — the Aug-9 demo uses pre-secured records (Task 1/Task 4), independent of the drain.

## 6. Not asserted (§1.5)
No prod row *exhibiting* the mislabel exists (the scheduler never ran under load in prod). `0 PENDING` and the backlog delta are **unverified this window** (seq-scan timeout). SECURED total is an estimate that drifts ±~20k between reads (Task 2/9/live show 2.99M–3.00M); the exact, stable figure is `anchor_proofs = 6,110`. The corrected mechanism above is from code trace (`org-queue-scheduler.ts`, `batch-anchor.ts`, `signet.ts`), not an observed prod failure.

_Lane 1 (Trust & Chain), 2026-07-20 evening. Revised post architect-review. Full D1 packet is the Jul 22–25 workstream (lane item 12)._
