# machines/agents.md

TLA+ PreCheck formal verification models for critical state machines.

## 2026-08-01 — `check` is invocation-sensitive, not TS-6-broken (toolchain fix)

The standing claim that `tla-precheck check` "cannot run under the repo's pinned `typescript@6.0.3`" is **WRONG**. It was recorded in a `drainRunAccounting.machine.ts` header comment on 2026-07-20, corrected in `partnerProvisioning.machine.ts` on 2026-07-21, but the stale copy survived and was re-reported during F-3. `check` runs fine on TS 6.0.3. Two unrelated faults were being read as one toolchain break:

- **TS5096** (`allowImportingTsExtensions` requires `noEmit`) — real, and independent of TS version. `tla-precheck` resolves its tsconfig as `resolve(process.cwd(), "tsconfig.json")`: **cwd-relative, no upward search**. It then force-overrides `noEmit: false` (`dist/cli/loadMachine.js:51`) because it must emit JS to import the machine. Run from `machines/`, it reads `machines/tsconfig.json` (no `allowImportingTsExtensions`) and works. Run from the repo root, it reads the root tsconfig, whose `allowImportingTsExtensions: true` then has no `noEmit` to satisfy it → TS5096, before TLC starts. CI was always green because it sets `working-directory: machines`.
- **TS5103** (invalid `--ignoreDeprecations`) — an artifact of running `npx tla-precheck` in a **git worktree with no `node_modules`**. `npx` installs tla-precheck plus its own `typescript@5.9.3` dependency; TS 5.9 rejects `ignoreDeprecations: "6.0"` (valid only from TS 6). So this was an *older* TS, not a stricter one. With `node_modules` present, the repo-pinned TS 6.0.3 is used and it does not fire.

`tla-precheck@0.1.7` is the **latest** published version (npm shows 0.1.0–0.1.7), so there was no version to bump to; and no TypeScript downgrade was needed.

**Fix:** `scripts/verify-machines.sh` + `npm run verify:machines` — cwd-independent, uses the pinned `node_modules/.bin/tla-precheck`, refuses to fall back to `npx`, and **globs `machines/*.machine.ts`** so a new machine cannot silently go unverified. `ci.yml`'s tla-verify job now calls it instead of listing two files by name.

**Two real defects this surfaced in `drainRunAccounting.machine.ts`** (added 2026-07-26 in #1611 as DRAFT/WIP; it had never actually run, so its declared budgets were never validated):

1. `nightly.budgets.maxEstimatedStates: 200_000` exceeded the tool's 100_000 graph-equivalence cap → `Invalid machine DrainRunAccounting`, which aborts **every** tier including `pr`. Both tiers now set `graphEquivalence: false` with budgets against the real raw product (pr: 64 per-run combos ^ 3 runs = 262_144, budget 300_000 — the declared 50_000 was also short; nightly: 64^4 = 16_777_216, budget 20_000_000). Domain sizes are unchanged. Note this trades away graph-equivalence on this machine's tiers; keeping it would require shrinking `Runs` to size 2, which the owner should decide.
2. TLC reported `Deadlock reached` on the by-design terminal state (all runs `RECORDED`). Both tiers now set `checks: { deadlock: false }`, matching `partnerProvisioning`.

**The same defect class was then found in the two other machines' `nightly` tiers** (review follow-up). `calibrationWorkflow` and `partnerProvisioning` each pinned `maxEstimatedStates` AT the 100_000 cap while estimating well above it, so `check --tier nightly` failed on both — `Estimated state count 1_048_576 exceeds budget 100_000` and `512_000 exceeds budget 100_000` respectively. Neither nightly tier had ever run. Both now set `graphEquivalence: false` with budgets against the real product (1_200_000 / 600_000). Domain sizes unchanged, and **both keep graph-equivalence on their `pr` tier** — only nightly is affected. Lesson: a budget pinned exactly at 100_000 is a smell, not a fix; it means the tier is over the cap and was never executed.

**All four machines verified green** via `npm run verify:machines` from the repo root (the invocation that previously failed), TLC2 2026.03.16.234659, `tla2tools.jar` from `~/.tla-precheck/`:

| machine | tier | proofPassed | invariants | states generated / distinct | equivalence | deadlock |
|---|---|---|---|---|---|---|
| `bitcoinAnchor` | pr | true | 14 | 3,221 / 529 | off | checked |
| `calibrationWorkflow` | pr | true | 5 | 2,785 / 704 | equivalent (704/704 states, 2,784/2,784 edges) | checked |
| `drainRunAccounting` | pr | true | 3 | 1,537 / 512 | off | off (terminal by design) |
| `partnerProvisioning` | pr | true | 4 | 157 / 61 | equivalent (121/121 states, 308/308 edges) | off (terminal by design) |

`--tier nightly` is also green on all four after the budget fixes above (`PASSED 4/4`); `bitcoinAnchor` nightly runs 111,091 generated / 12,167 distinct, `drainRunAccounting` 16,385 / 4,096.

All four report TLC `Model checking completed. No error has been found.` with `0 states left on queue`; script output `PASSED 4/4`.

## 2026-07-15 — SCRUM-2692 durable txid journal / HELD protection

`bitcoinAnchor.machine.ts` adds the three-valued conceptual `journalRecovery` state (`NONE | PENDING | HELD`) and explicit persist, HOLD, exact-tx ADOPT, affirmative-absence REVERT, and post-submit PERSISTED actions. Generic broadcast failure, legacy broadcast, submitted-abandon, and revoke edges cannot consume an unresolved journal; intent implies journal protection. PR-tier TLC passes 14 invariants with 3,589 generated / 529 distinct states and no deadlock or error.

## 2026-07-06 — S3-P0 persisted pre-broadcast intent (batch producer)

`bitcoinAnchor.machine.ts` now models the batch producer's no-double-broadcast crash-resume contract:

- New per-anchor bool **`intentPersisted`** (conceptual/derived, like `actor`): TRUE while a signed broadcast intent is durable (DB shape: `anchors.chain_tx_id` set while `status=BROADCASTING` + the `anchor_proofs` intent row carrying the signed tx hex).
- New actions: **`persistBroadcastIntent`** (BROADCASTING, chainTxId null → has_tx + intent), **`broadcastResumeFinalize`** (BROADCASTING+intent → SUBMITTED; models BOTH the happy path and the crash-resume reconcile — identical `submit_batch_anchors` write), **`broadcastIntentReject`** (definitive non-retryable mempool reject → PENDING, chainTxId cleared, intent cleared).
- **`broadcastFail`** and **`workerBroadcast`** gained `not(intentPersisted)` guards — `broadcastFail` now exactly models `recover_stuck_broadcasts()`'s `chain_tx_id IS NULL` filter (intent rows are shielded from the RACE-1 sweep); the legacy direct-broadcast edge applies only to non-intent flows. `supersede` clears the intent (row leaves BROADCASTING; submit/reconcile both skip it).
- **INV-1c REPLACED**: `broadcastingNoChainTx` ("BROADCASTING ⇒ chainTxId null") → **`broadcastingIntentChainTxCoupling`** ("BROADCASTING ⇒ chainTxId=has_tx ⟺ intentPersisted"). New invariants `intentOnlyWhileBroadcasting` + `intentRequiresWorkerActor`.
- Budgets raised (6th per-anchor bool): pr 200k → 1M raw estimate, nightly 50M → 500M. `check` (pr tier): proofPassed=true, 11 invariants, deadlockChecked, 757 states generated / 196 distinct, "No error has been found."

## Files
- **`bitcoinAnchor.machine.ts`** — formal model of the anchor lifecycle (PENDING -> SUBMITTED -> SECURED, plus REVOKED/EXPIRED/legal-hold transitions). Verified with `tla-precheck`. Any anchor lifecycle change must update this machine first and run `check`.
- **`calibrationWorkflow.machine.ts`** — formal model of confidence calibration workflow (IDLE -> EVALUATING -> DERIVING -> VALIDATING -> COMPLETE).
- **`drainRunAccounting.machine.ts`** — formal model of org-queue-run accounting (SCRUM-2620): committed work is never recorded FAILED.
- **`partnerProvisioning.machine.ts`** — formal model of partner provisioning with separation-of-duties.
- **`tsconfig.json`** — TypeScript config for the machines package. **Do not add `allowImportingTsExtensions`** — `check` emits JS and would fail TS5096.

## Conventions
- Edit the machine BEFORE changing production anchor lifecycle code.
- Run `check` after every machine edit to verify invariants hold.
- Uses `tla-precheck` DSL (`defineMachine`, `enumType`, `variable`, `forall`, etc.).

## Running `check`

```bash
npm run verify:machines
```

Run it from anywhere; it handles cwd and the pinned binary for you. Add a name to narrow it (`npm run verify:machines -- bitcoinAnchor`) or pick a tier (`-- --tier nightly`). Both tiers are green on all four machines.

Only `--tier`, `--output-root` and `--tsconfig` are forwarded; anything else is rejected up front rather than passed through. In particular **`--all-tiers` is refused on purpose**: `tla-precheck check` parses that flag but never applies it (`runCheck` receives only the resolved tier), so it would exit 0 having model-checked the default tier alone. Run one tier at a time.

Two traps if you invoke `tla-precheck` by hand instead:

- **Run it from `machines/`, not the repo root.** It reads `tsconfig.json` from the current working directory with no upward search, and the root config's `allowImportingTsExtensions` collides with the emit `check` performs (TS5096).
- **Use `node_modules/.bin/tla-precheck`, not `npx`.** In a worktree without `node_modules`, `npx` pulls its own `typescript@5.9.3`, which rejects the repo's `ignoreDeprecations: "6.0"` (TS5103). Run `npm ci` in the worktree first.

Neither symptom means `tla-precheck` is incompatible with the repo's pinned `typescript@6.0.3` — see the 2026-08-01 entry.

New tiers: `graphEquivalence` defaults to **on** and caps `maxEstimatedStates` at 100_000; above that, set `graphEquivalence: false` explicitly. Do not "fix" an over-cap tier by pinning its budget to exactly 100_000 — the tier then fails its estimate check instead and simply never runs, which is how both nightly tiers sat broken and unnoticed. Machines with terminal end states need `checks: { deadlock: false }` or TLC reports `Deadlock reached`.

The generated `machines/.generated-machines/` tree is build output and is gitignored. Five BitcoinAnchor artifacts were tracked by mistake (ignore rules do not apply to already-tracked files), so every `check` run rewrote a committed certificate with fresh timestamps, pids and absolute local paths; they were `git rm --cached`ed on 2026-08-01. Do not re-add them.
