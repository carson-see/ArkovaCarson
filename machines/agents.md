# machines/agents.md

TLA+ PreCheck formal verification models for critical state machines.

## 2026-07-15 — SCRUM-2692 durable txid journal / HELD protection

`bitcoinAnchor.machine.ts` adds the three-valued conceptual `journalRecovery` state (`NONE | PENDING | HELD`) and explicit persist, HOLD, exact-tx ADOPT, affirmative-absence REVERT, and post-submit PERSISTED actions. Generic broadcast failure, legacy broadcast, submitted-abandon, and revoke edges cannot consume an unresolved journal; intent implies journal protection. PR-tier TLC passes 14 invariants with 3,589 generated / 529 distinct states and no deadlock or error.

## 2026-07-06 — S3-P0 persisted pre-broadcast intent (batch producer)

`bitcoinAnchor.machine.ts` now models the batch producer's no-double-broadcast crash-resume contract:

- New per-anchor bool **`intentPersisted`** (conceptual/derived, like `actor`): TRUE while a signed broadcast intent is durable (DB shape: `anchors.chain_tx_id` set while `status=BROADCASTING` + the `anchor_proofs` intent row carrying the signed tx hex).
- New actions: **`persistBroadcastIntent`** (BROADCASTING, chainTxId null → has_tx + intent), **`broadcastResumeFinalize`** (BROADCASTING+intent → SUBMITTED; models BOTH the happy path and the crash-resume reconcile — identical `submit_batch_anchors` write), **`broadcastIntentReject`** (definitive non-retryable mempool reject → PENDING, chainTxId cleared, intent cleared).
- **`broadcastFail`** and **`workerBroadcast`** gained `not(intentPersisted)` guards — `broadcastFail` now exactly models `recover_stuck_broadcasts()`'s `chain_tx_id IS NULL` filter (intent rows are shielded from the RACE-1 sweep); the legacy direct-broadcast edge applies only to non-intent flows. `supersede` clears the intent (row leaves BROADCASTING; submit/reconcile both skip it).
- **INV-1c REPLACED**: `broadcastingNoChainTx` ("BROADCASTING ⇒ chainTxId null") → **`broadcastingIntentChainTxCoupling`** ("BROADCASTING ⇒ chainTxId=has_tx ⟺ intentPersisted"). New invariants `intentOnlyWhileBroadcasting` + `intentRequiresWorkerActor`.
- Budgets raised (6th per-anchor bool): pr 200k → 1M raw estimate, nightly 50M → 500M. `check` (pr tier): proofPassed=true, 11 invariants, deadlockChecked, 757 states generated / 196 distinct, "No error has been found."

## 2026-08-01 — how to invoke `check` (and the real coverage gap)

**`tla-precheck check` works.** Run it the way CI does: from **inside this
directory**, with a **bare filename**, using the resolved local binary.

```bash
cd machines
../node_modules/.bin/tla-precheck check bitcoinAnchor.machine.ts
```

Verified 2026-08-01: `Model checking completed. No error has been found.`
(529 distinct states, depth 15).

Invoking it from the repo root with a path prefix
(`tla-precheck check machines/foo.machine.ts`) aborts at the typecheck phase
with TS5096 / TS5103 against the pinned `typescript@6.0.3`. That is an
**invocation-path artifact, not a broken gate** — a 2026-07-20 note previously
recorded it as "cannot run for every machine / gate non-functional", which is
incorrect and has been withdrawn. If you hit those two errors, check your cwd
before concluding the toolchain is broken.

**The real gap — CI verifies 2 of the 4 machines.** `.github/workflows/ci.yml`
(TLA+ Verification job) runs `check` on `bitcoinAnchor.machine.ts` and
`partnerProvisioning.machine.ts` only. `calibrationWorkflow.machine.ts` and
`drainRunAccounting.machine.ts` are covered by **no gate** — editing either
passes CI with no formal verification at all.

Actual state of all four, run by hand 2026-08-01:

| Machine | `check` result | In CI? |
|---|---|---|
| `bitcoinAnchor` | PASS (529 states, depth 15) | yes |
| `partnerProvisioning` | PASS | yes |
| `calibrationWorkflow` | PASS | **no** |
| `drainRunAccounting` | **INVALID — will not run** | **no** |

`drainRunAccounting` fails validation, not safety:

```
Invalid machine DrainRunAccounting
[equivalence-budget-cap-exceeded] proof.tiers.nightly.budgets.maxEstimatedStates:
Graph-equivalence tiers may not declare maxEstimatedStates above 100000
```

The `nightly` tier declares `maxEstimatedStates: 200_000` (line ~253) against a
100,000 cap. So this machine has **never been model-checked** — it is not that
it fails an invariant, it is that TLC never gets to run. Because CI does not
check it, nothing surfaced that. Fix the budget (or split the tier), then run
`check` before trusting anything the spec claims.

Until both machines are added to the CI job, treat CLAUDE.md §4's "re-verify
with `check`" as a manual step for them.

## Files

| File | Models | Runtime adapter |
|---|---|---|
| `bitcoinAnchor.machine.ts` | Anchor lifecycle: PENDING → SUBMITTED → SECURED plus REVOKED/EXPIRED/legal-hold, the persisted pre-broadcast intent, and the SCRUM-2692 durable txid journal (`NONE \| PENDING \| HELD`). | yes — `ownedTables: ["anchors"]` |
| `calibrationWorkflow.machine.ts` | Confidence-calibration workflow: IDLE → EVALUATING → DERIVING → VALIDATING → COMPLETE. | no (documentation-only) |
| `drainRunAccounting.machine.ts` | SCRUM-2620 org-queue-run accounting: how the scheduler records the OUTCOME of a `processBatchAnchors` drain. Proves committed work is only ever SUCCEEDED or PARTIAL (never FAILED) and that a PARTIAL run can reconcile to SUCCEEDED. The defective `recordFailCommitted` edge is deliberately ABSENT — re-adding it makes `committedNeverFailed` fail. | no — accounting spans `organization_queue_runs` + `_state`, not one adapter-owned table |
| `partnerProvisioning.machine.ts` | SCRUM-2990 partner-account lifecycle: NONE → REQUESTED → APPROVED → PROVISIONED, with reject/cancel edges into REJECTED. Proves separation of duties (an account's approver is never its requester), no provision without prior approval, and that PROVISIONED/REJECTED are terminal. | no — `partner_accounts` table is deferred post-train work |
| `tsconfig.json` | TypeScript config for the machines package. | — |

## Conventions
- Edit the machine BEFORE changing production anchor lifecycle code.
- Run `check` after every machine edit to verify invariants hold — but see the toolchain finding above; `check` does not currently run.
- Uses `tla-precheck` DSL (`defineMachine`, `enumType`, `variable`, `forall`, etc.).
- A machine without a `runtimeAdapter` is documentation-only. When its backing table lands, add `runtimeAdapter`/`ownedTables`/`ownedColumns` and `build`.
