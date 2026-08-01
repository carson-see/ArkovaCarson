# machines/agents.md

TLA+ PreCheck formal verification models for critical state machines.

## 2026-08-01 — F-3 recovery for SUBMITTED+NULL-chain_tx_id (docs/staging/SOAK-FINDINGS-2026-08.md, migration 0379)

`bitcoinAnchor.machine.ts` is documentation-only changed: a comment on `submittedRequiresChainTx` (INV-1b) records that a live anchor was observed SUBMITTED with a NULL `chain_tx_id` — a real violation of this invariant, caught during the 2026-08 launch-72h soak. Every current write site that sets `status='SUBMITTED'` (`workerBroadcast`, `journalAdopt`, `broadcastResumeFinalize`) was re-audited and each is a single-statement atomic UPDATE — no *modeled* transition can produce the violation, so **no variables, actions, or invariants changed**; this is a pure `git diff` comment-only edit. Migration 0379 (`supabase/migrations/0379_f3_recover_submitted_null_txid.sql`) extends `recover_stuck_broadcasts()` with a second branch alongside its existing BROADCASTING one, purely as a DB-level self-healing safety net for a state the design still correctly says must never happen — deliberately NOT modeled as a new action (that would require weakening INV-1b, legitimizing a state that shouldn't occur). Root-causing the actual producer is out of scope for this fix and tracked separately.

**`check` NOT run — pre-existing, repo-wide toolchain break, unrelated to this edit.** `npx tla-precheck check <any-machine>.machine.ts` (verified against BOTH the edited `bitcoinAnchor.machine.ts` and the untouched `calibrationWorkflow.machine.ts`, so it is not specific to this change) fails identically with `TS5096: Option 'allowImportingTsExtensions' can only be used when either 'noEmit' or 'emitDeclarationOnly' is set` + `TS5103: Invalid value for '--ignoreDeprecations'`, before TLC ever runs — root package.json pins `typescript@6.0.3`, and tla-precheck v0.1.7's internal compile step appears to pass a `--ignoreDeprecations` value incompatible with that TS version. `tla-precheck doctor` reports Java/TLC/skills all OK; the break is TS-flag-only. Since this edit is provably comment-only (see the `git diff` in the F-3 PR), the machine's proven state graph (14 invariants, 3,589 generated / 529 distinct states per the 2026-07-15 SCRUM-2692 entry below) is unaffected — but the `check` command itself could not be re-run to confirm mechanically. Flagged as a standalone toolchain-fix item, not folded into the F-3 PR.

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
