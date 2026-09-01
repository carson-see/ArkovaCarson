# machines/agents.md

TLA+ PreCheck formal verification models for critical state machines.

## 2026-09-01 — `docusignInboundDedup.machine.ts`: the claim-to-mint TOCTOU is CLOSED (invariant now passes, unweakened)

Context: the TOCTOU extension added to this machine earlier the same day deliberately shipped RED. It split the drain's single atomic `materializeAnchorFromArtifact` into `captureArtifactFingerprint` (models `claimRow`'s CAS `RETURNING`) + `mintAnchorFromCapture` (models the link, using the CAPTURED value), which made a real residual bug in `services/worker/src/jobs/connector-artifact-drain.ts` expressible for the first time. TLC found it: `forgeInbound` → `capture` (FORGED) → `outboundHealsForgery` (live class becomes REAL) → `mint` (anchor holds FORGED). The new invariant `anchorNeverMintedFromSupersededFingerprint` was left FAILING and documented rather than weakened.

**The code changed; the invariant did not.** `linkMaterializedAnchor` now fuses the freshness assertion into the CAS that sets `anchor_id` — the very column `docusign-envelope-completed.ts`'s F1-heal guards on:

```sql
UPDATE connector_artifact
   SET status='materialized', anchor_id=:anchorId, updated_at=now()
 WHERE id=:id AND org_id=:org AND status='processing'
   AND fingerprint_sha256 = :fingerprintCapturedAtClaimTime   -- the gate
RETURNING id
```

One statement closes the window from both directions. A heal anywhere between claim and link makes the predicate false → zero rows → nothing linked, nothing debited, nothing anchored, row requeued to re-drain against the healed value (the heal WINS, per the CTO precedence ruling). The link landing first sets `anchor_id` non-null → the heal's pre-existing `anchor_id IS NULL` guard locks it out and it takes its documented "already materialized" branch. **No migration, no new status value, and NO change to `docusign-envelope-completed.ts`.**

Why a re-read before the INSERT was rejected as the fix: it is one more read-then-act — the heal can land between the re-read and the INSERT and nothing notices. Why a single claim+materialize+mark RPC was rejected: it needs a migration, and this achieves the same guarantee with an existing statement. The freshness predicate has to be evaluated by Postgres *in the same statement that publishes the anchor*, or it is not a gate.

Model deltas (both minimal, both faithful):
- `mintAnchorFromCapture` gains the guard `capturedFingerprintClass[e] = fingerprintClass[e]`. Modeled as a GUARD, not a check-then-act pair, because in the real code it is a WHERE-clause predicate on the same atomic UPDATE (row lock + EvalPlanQual on a post-commit re-evaluation). A two-action model would be a FALSE positive.
- New `abortSupersededMint` covers the zero-row outcome: resets `capturedFingerprintClass[e]` to `NONE`, which re-enables `captureArtifactFingerprint` — that reset IS the requeue.
- `outboundHealsForgery` / `outboundLosesRaceUnhealed` / all three invariants UNCHANGED.

**Mutation-tested, not just asserted:** deleting the guard from `mintAnchorFromCapture` reproduces the header's counterexample verbatim (`proofPassed: false`, `Invariant anchorNeverMintedFromSupersededFingerprint is violated`); restoring it returns `proofPassed: true`. That is the regression test for the fix.

| tier | proofPassed | invariants | generated / distinct | queue | depth | deadlock |
|---|---|---|---|---|---|---|
| pr (2 envelopes) | true | 3 | 865 / 256 | 0 | 9 | checked |
| nightly (4 envelopes) | true | 3 | 442,369 / 65,536 | 0 | 17 | checked |

`machineSha256 927a4177973a5a6f8aca4c05c9d70910d1f8b54b9ae3265233abd99987068f9e` (stable across comment-only edits — the hash covers the semantic machine, not the file). `npm run verify:machines` from the repo root: **PASSED 5/5**.

**Deliberately NOT modeled — read this before assuming the machine covers it.** `connector_artifact.anchor_id` is a NOT-DEFERRABLE FK to `anchors(id)` (migration 0343), so the anchor id cannot be reserved before the `anchors` row exists: the INSERT must precede the gate, and a rejected gate therefore leaves an **inserted-but-unlinked orphan anchor**. That row is never LINKED — which is what `anchorMaterialized` models — so it is outside this machine's state entirely. The real code neutralizes it with a guarded soft-delete (`deleted_at`, the filter BOTH `claim_pending_anchors` and `findExistingEnvelopeAnchor` already apply) and alerts `orphan_anchor_neutralize_failed` when that guard matches zero rows. **That behaviour is pinned by unit tests in `connector-artifact-drain.test.ts`, not by TLC.** Do not cite this machine as proof the orphan path is correct.

## 2026-09-01 — TOCTOU extension (superseded by the entry above; kept for the reasoning)

The extension that made the claim-to-mint window modelable, and shipped RED on purpose. Its counterexample trace and certificate live in `docusignInboundDedup.machine.ts`'s own header, which now records both the failing revision's finding and the fix. `machineSha256` of the failing revision was `e4b22f11a4d55979d3ad977964738d78b80b06c8d6c167513eeff7846cd9ff47` (506 generated / 200 distinct, halted on first violation at depth 8). The lesson worth keeping: a 121-state, fully-verified proof missed a real bug for months because the model collapsed *read current state* and *act on it* into one atomic action. When the code does `capture → await → act`, the model must have a variable for the captured value, or the proof is answering an easier question than the one you asked.


## 2026-09-01 — TOCTOU extension: `docusignInboundDedup.machine.ts` splits materialization into capture+mint and FAILS a new invariant (code review of `jobs/connector-artifact-drain.ts`) — real, disclosed, UNRESOLVED finding

Code review found `jobs/connector-artifact-drain.ts` materializing an anchor from a STALE in-memory row snapshot: `drainConnectorArtifactsForOrg`'s batch `SELECT` read row content once, then handed it unchanged through `resolveOrgActorUserId`/`findExistingEnvelopeAnchor` (real awaited DB round trips, plus every earlier row in the batch) into the `anchors` INSERT — a window `docusign-envelope-completed.ts`'s F1-heal (PR #2520, gated only on `connector_artifact.anchor_id IS NULL`) could land inside of, healing the persisted row while the drain still minted the anchor from the pre-heal (forged) value. Fixed in code: `claimRow`'s CAS `UPDATE` now `RETURNING`s the row's fresh content and the caller passes THAT into `drainOneClaimedRow`/`materializeAnchor` — the batch `SELECT` is now id-only, a pure candidate list.

The PRE-fix machine could not express this bug at all: `materializeAnchorFromArtifact` was ONE atomic action reading `fingerprintClass[e]` at the instant it fired — no snapshot, no gap, so a 121-state fully-verified proof was silent on a real vulnerability. This extension REPLACES that action with two — `captureArtifactFingerprint` (models `claimRow`'s `RETURNING`) and `mintAnchorFromCapture` (models the `anchors` INSERT, using the CAPTURED value, never a fresh read) — with two new per-envelope 3-valued variables (`capturedFingerprintClass`, `anchorFingerprintClass`) and a new invariant `anchorNeverMintedFromSupersededFingerprint`: once an anchor is materialized, its baked-in fingerprint class must equal the artifact's CURRENT fingerprint class (deliberately NOT "never forged" — that would wrongly flag the pre-existing, accepted "attacker's row wins outright, materializes before the heal ever runs" case, which is `outboundLosesRaceUnhealed`'s documented operator-reconciliation exception, not this bug).

**Result: FAILS, on purpose left failing.** `npx tla-precheck check docusignInboundDedup.machine.ts` (from `machines/`): `proofPassed: false`. TLC finds a genuine counterexample in 8 steps / 506 states generated / 200 distinct (halts on first violation, not full exploration): `materializeOutbound(e1)` [unrelated envelope] → `forgeInbound(e2)` [attacker wins, `fingerprintClass=FORGED`] → `captureArtifactFingerprint(e2)` [captures FORGED] → `outboundHealsForgery(e2)` [heal fires — its guard is only `not(anchorMaterialized[e2])`, which is still true — `fingerprintClass:=REAL`] → `mintAnchorFromCapture(e2)` [mints from the STALE capture: `anchorFingerprintClass:=FORGED`] — now `fingerprintClass[e2]=REAL` but `anchorFingerprintClass[e2]=FORGED`. `machineSha256 e4b22f11a4d55979d3ad977964738d78b80b06c8d6c167513eeff7846cd9ff47`. Full trace + certificate summary in the machine file's header.

**Why this is expected, not a bug in the proof.** The code fix (`claimRow` now reads fresh AT CLAIM TIME) closes the LARGEST instance of the window — the batch-order-dependent one, up to `DRAIN_LIMIT_MAX`=200 earlier rows' worth of awaited work. It does NOT make materialization atomic end-to-end: `claimRow`'s capture and the `anchors` INSERT are still two separate statements separated by `resolveOrgActorUserId` + `findExistingEnvelopeAnchor`, and the heal's guard has no notion of "this row was already claimed." TLC proves that SMALLER residual window is still formally sufficient to reproduce the bug. This was reported to the operator as a genuine follow-up rather than silently fixed further (out of the reviewed PR's stated scope) or masked by weakening the invariant — per explicit instruction, the invariant is NOT softened to force a pass. `pr` tier budget: 100_000 → 2_000_000, `graphEquivalence` now OFF on `pr` too (raw product 1,296² = 1,679,616 exceeds the 100k equivalence cap — a real, disclosed regression from the previous 121/121-equivalent proof, not incidental). `nightly` budget: 100_000_000 → 3_000_000_000_000.

## 2026-08-31 — F1-heal extension: `docusignInboundDedup.machine.ts` gains the auto-heal transition (SCRUM-3818 go-live gate, follow-up to PR #2476)

PR #2476 shipped DETECTION only — its own header named the follow-up work explicitly: "automatic outbound-supersedes-inbound reconciliation is separate, go-live-gated follow-up." This closes that item. New variable `anchorMaterialized` (per envelope, models `connector_artifact.anchor_id` becoming non-null — the drain has materialized a live anchor). New actions: `materializeAnchorFromArtifact` (the drain's own independently-timed step) and a SPLIT of the old bare `outboundLosesRace` into two mutually-exclusive-on-`anchorMaterialized[e]` variants — `outboundHealsForgery` (not yet materialized: atomically supersedes, `fingerprintClass := REAL`, `artifactOwner := OUTBOUND`, mirroring the real code's ONE atomic `UPDATE ... WHERE anchor_id IS NULL`) and `outboundLosesRaceUnhealed` (already materialized: unchanged from PR #2476's original floor — flags only, never rewrites). Deliberately modeled as ONE atomic decision point, not two separately-schedulable steps (a `reconcileForgery`-as-separate-action design, as this file's own pre-heal header speculated, would introduce a state the real code never has — detection and heal-or-refuse happen inside the same synchronous `enqueueSignedDocument` call).

Invariant `outboundNeverSilentlyAcceptsForgery` STRENGTHENED in place (same name, real guarantee upgraded): the old bare `conflictDetected[e]` disjunct — true the instant a conflict was merely noticed, regardless of outcome — is NARROWED to `conflictDetected[e] AND anchorMaterialized[e]`. The PR #2476 header speculated the follow-up could "drop the disjunct" entirely (real fingerprint always wins, full stop); this file does NOT go that far, because the CTO ruling carves out a real, deliberate exception — an already-materialized declared row must NOT be silently rewritten (a separate integrity event, not an auto-heal target). Narrowing the disjunct (rather than dropping it) is what expresses that exception formally: a forged fingerprint may now permanently stand ONLY when explained by a live anchor already existing, never merely because nothing followed up on the detection.

**Verified** (`npx tla-precheck check`, from `machines/`): proofPassed true, BOTH invariants checked, graph-equivalent (121/121 states, 374/374 edges — up from the F1 extension's 36/36 states, 96/96 edges), deadlock checked, "Model checking completed. No error has been found." on both proof and equivalence runs. `pr` tier budget raised 30_000 → 100_000 (third per-envelope boolean); `nightly` budget raised to 100_000_000 (same graph-equivalence-off shape as every other machine's nightly tier). `machineSha256 f56a95d54929e4525c51751b18547b935752ed65d5cde2ddaa2e467b1841edec`; `graphHash 2341f3943367221a90f3dc11b0a4d34acc2b61528ddad04c74633e6926eb2d47`.

## 2026-08-30 — F1 extension: `docusignInboundDedup.machine.ts` gains an adversarial action + a second invariant (security review of PR #2476)

Security review of the machine's own PR found the ORIGINAL `atMostOneArtifactOwner` invariant necessary-but-not-sufficient: it proves one `connector_artifact` exists, not that the VERIFIED one wins. `enqueue_connector_artifact` is `ON CONFLICT DO NOTHING`, so a same-tenant attacker who self-POSTs a forged INBOUND event with an attacker-chosen fingerprint, racing the real outbound fetch, can win the INSERT — and the outbound job's real, server-measured write is then silently discarded UNLESS something checks the persisted row before trusting the RPC's returned id as success.

Added: `fingerprintClass` (NONE/REAL/FORGED per envelope), `conflictDetected`, `outboundHasActed`; a new ADVERSARIAL action `forgeInbound` (same guard as legitimate `materializeInbound`, distinguishable only by `fingerprintClass := FORGED` — mirrors the real bug: ON CONFLICT DO NOTHING cannot tell a legitimate writer from a forger); `outboundLosesRace` (models `enqueueSignedDocument`'s unconditional read-back-and-compare) and `outboundRedeliversOwnSuccess` (harmless own-retry case) replacing the old generic `redeliverWhenAnchored`. New invariant `outboundNeverSilentlyAcceptsForgery`: once the outbound side has acted for an envelope, its own real fingerprint persisted OR the conflict was flagged — never neither. Deliberately gated on `outboundHasActed[e]`, NOT a bare "fingerprintClass is never FORGED": a real, legitimate window exists between `forgeInbound` landing and the outbound side's own later, independently-scheduled action running (the async fetch takes real wall-clock time) — an ungated invariant would incorrectly flag that window as a violation. This encodes the code's actual DETECTION-FLOOR guarantee (the fix scope: loud alert + distinct signal), not an auto-heal claim — `ON CONFLICT DO NOTHING` means the RPC structurally cannot UPDATE-supersede a pre-existing forged row from inside that code path; automatic reconciliation is separate, go-live-gated follow-up (noted in the machine's own header as future work, with the `reconcileForgery` action shape it would need).

**Verified** (`npx tla-precheck check`, from `machines/`): proofPassed true, BOTH invariants checked, graph-equivalent (36/36 states, 96/96 edges — up from 9/9 states, 24/24 edges pre-extension), deadlock checked. `pr` tier budget raised 10_000 → 30_000 (richer per-envelope state space); `nightly` tier's raw product at 4 envelopes now exceeds the 100_000 graph-equivalence cap (same shape as every other machine's nightly-tier fix documented below), so `nightly` sets `graphEquivalence: false` with budget 30_000_000.

## 2026-08-30 — new machine: `docusignInboundDedup.machine.ts` (docusign-bilateral-2026-08, flag-off spike)

Fifth machine. Models the CTO Decision Record's required invariant for the INBOUND (Recipient Connect) DocuSign webhook path — flag `ENABLE_DOCUSIGN_INBOUND`, default off, not going live this cycle: under concurrent OUTBOUND + INBOUND delivery for the same envelope, AT MOST ONE anchored `connector_artifact` is ever created. Two guarded "first" actions (`materializeOutbound` / `materializeInbound`) share the identical `not(artifactCreated)` guard — mutual exclusion is proven structurally, since once either fires the shared guard permanently disables the other for that envelope — plus one no-op `redeliverWhenAnchored` action collapsing every subsequent redelivery (either direction, or a DocuSign retry) into "finds the existing row, changes nothing." Small proof domain (2 envelopes, per the "keep proof domains tiny" DSL rule) since this is one narrow property, not the whole webhook flow. Documentation-only — no runtimeAdapter (connector_artifact rows are created via the migration-0343 RPC's `ON CONFLICT DO NOTHING`, not a plain insert, so the action shape doesn't fit the adapter subset). See the machine file's own header for what it does and does NOT model (single-org-scoped "Envelopes" domain; feature-flag admission is HTTP-layer, covered by `docusign.test.ts` instead), and its VERIFICATION STATUS comment for the passing certificate. `pr` tier: proofPassed true, 1 invariant (`atMostOneArtifactOwner`), graph-equivalent (9/9 states, 24/24 edges), deadlock checked (not terminal-by-design, unlike `partnerProvisioning`/`drainRunAccounting` — `redeliverWhenAnchored` keeps every state live).

## 2026-08-01 — F-3 recovery for SUBMITTED+NULL-chain_tx_id (docs/staging/SOAK-FINDINGS-2026-08.md, migration 0379)

`bitcoinAnchor.machine.ts` is documentation-only changed: a comment on `submittedRequiresChainTx` (INV-1b) records that a live anchor was observed SUBMITTED with a NULL `chain_tx_id` — a real violation of this invariant, caught during the 2026-08 launch-72h soak. Every current write site that sets `status='SUBMITTED'` (`workerBroadcast`, `journalAdopt`, `broadcastResumeFinalize`) was re-audited and each is a single-statement atomic UPDATE — no *modeled* transition can produce the violation, so **no variables, actions, or invariants changed**; this is a pure `git diff` comment-only edit. Migration 0379 (`supabase/migrations/0379_f3_recover_submitted_null_txid.sql`) extends `recover_stuck_broadcasts()` with a second branch alongside its existing BROADCASTING one, purely as a DB-level self-healing safety net for a state the design still correctly says must never happen — deliberately NOT modeled as a new action (that would require weakening INV-1b, legitimizing a state that shouldn't occur). Root-causing the actual producer is out of scope for this fix and tracked separately.

**`check` NOT run — pre-existing, repo-wide toolchain break, unrelated to this edit.** `npx tla-precheck check <any-machine>.machine.ts` (verified against BOTH the edited `bitcoinAnchor.machine.ts` and the untouched `calibrationWorkflow.machine.ts`, so it is not specific to this change) fails identically with `TS5096: Option 'allowImportingTsExtensions' can only be used when either 'noEmit' or 'emitDeclarationOnly' is set` + `TS5103: Invalid value for '--ignoreDeprecations'`, before TLC ever runs — root package.json pins `typescript@6.0.3`, and tla-precheck v0.1.7's internal compile step appears to pass a `--ignoreDeprecations` value incompatible with that TS version. `tla-precheck doctor` reports Java/TLC/skills all OK; the break is TS-flag-only. Since this edit is provably comment-only (see the `git diff` in the F-3 PR), the machine's proven state graph (14 invariants, 3,589 generated / 529 distinct states per the 2026-07-15 SCRUM-2692 entry below) is unaffected — but the `check` command itself could not be re-run to confirm mechanically. Flagged as a standalone toolchain-fix item, not folded into the F-3 PR.
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
- **`bitcoinAnchor.machine.ts`** — formal model of the anchor lifecycle (PENDING -> SUBMITTED -> SECURED, plus REVOKED/EXPIRED/legal-hold transitions). Verified with `tla-precheck`. Any anchor lifecycle change must update this machine first and run `check`.
- **`calibrationWorkflow.machine.ts`** — formal model of confidence calibration workflow (IDLE -> EVALUATING -> DERIVING -> VALIDATING -> COMPLETE).
- **`drainRunAccounting.machine.ts`** — formal model of org-queue-run accounting (SCRUM-2620): committed work is never recorded FAILED.
- **`partnerProvisioning.machine.ts`** — formal model of partner provisioning with separation-of-duties.
- **`tsconfig.json`** — TypeScript config for the machines package. **Do not add `allowImportingTsExtensions`** — `check` emits JS and would fail TS5096.

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
- A machine without a `runtimeAdapter` is documentation-only. When its backing table lands, add `runtimeAdapter`/`ownedTables`/`ownedColumns` and `build`.

## `.generated-machines/` is NOT tracked — do not re-add it (2026-08-02)

`.gitignore:59` ignores `.generated-machines/`, but five BitcoinAnchor artifacts were tracked anyway
(gitignore does not apply to already-tracked paths). They are now untracked. **Do not `git add` them
back.**

Why they must not be committed:
- `BitcoinAnchor.pr.certificate.json` is rewritten whenever `tla-precheck check bitcoinAnchor.machine.ts`
  detects a `machineSha256` mismatch. The rewritten fields are pure run metadata — `checkedAt`, the TLC
  version banner, pid, RNG seed, and the **absolute path of whoever's checkout ran it**. The copy that
  was committed embedded `/Volumes/Extreme/Arkova/.codex-worktrees/s33-w2-l1-t0-gate-audit/...`, i.e.
  one machine's filesystem layout, published in the repo.
- That made it a live trap for `git add -A`: any engineer or agent running the mandated
  `verify:machines` left a modified tracked file, and committing it would assert a proof carrying
  another machine's paths.
- It was also **stale and silently so**: on `fix/f3-submitted-null-txid-recovery` (PR #1784) the
  committed certificate recorded `machineSha256 3878b35b…` while `bitcoinAnchor.machine.ts` hashed to
  `591d2836…`. A committed artifact asserted a proof for a machine version not in the tree.

Why untracking is safe (verified, not assumed): `.github/workflows/ci.yml`'s TLA+ job runs
`tla-precheck check bitcoinAnchor.machine.ts` (and `partnerProvisioning.machine.ts`) and **regenerates**
these artifacts. Nothing in CI or any script reads a committed certificate — `grep` for `certificate`
across `.github/` returns nothing. The sibling machines (`CalibrationWorkflow`, `PartnerProvisioning`)
were never tracked, so BitcoinAnchor's tracking was an accident, not a policy.

If a checked-in proof artifact is ever wanted, tracking alone is not enough: it must first be made
deterministic (strip `checkedAt`, pid, seed, TLC banner, absolute paths) **and** paired with a CI check
that fails when a certificate's `machineSha256` does not match its machine file. Without that check the
staleness above simply recurs, invisibly. The TLA+ verification itself is unchanged and still mandatory.

## 2026-08-11 — SCRUM-3188 supplementary proof anchor

`bitcoinAnchor.machine.ts` gains the three-valued per-anchor `supplementaryProof` state (`NONE | JOURNALED | ANCHORED`) modelling a SECOND, additive Bitcoin transaction that gives an already-SECURED anchor a per-document Merkle branch it could never have against its ORIGINAL transaction (the Mar/Apr producer never persisted the committed leaf order; unrecoverable above 8 leaves).

New actions: **`supplementaryJournal`** (SECURED + worker + has_tx + no live primary journal → JOURNALED; models persisting the signed txid/cohort/leaf-order barrier BEFORE broadcast), **`supplementaryAnchorConfirm`** (JOURNALED → ANCHORED, admitted from SECURED/REVOKED/SUPERSEDED because a broadcast fee is already spent and revocation does not un-commit bytes), **`supplementaryRevert`** (JOURNALED → NONE on affirmative absence). None of the three writes `status`, `chainTxId`, or `metadataLocked` — that absence is the backdate-shift protection expressed as a transition.

New invariants: **`supplementaryRequiresOriginalAttestation`** (supp ≠ NONE ⇒ chainTxId = has_tx), `supplementaryRequiresWorkerActor`, `supplementaryNeverOnPreBroadcastAnchor`.

**The model earned its keep.** TLC found a real counterexample: a SECURED+ANCHORED anchor can reach SUBMITTED via `reorgDetected` and then PENDING via `chainSubmitFail`/`chainSubmitAbandon`, which CLEAR `chain_tx_id` — orphaning the supplementary proof so it would silently become the record's only chain evidence, i.e. exactly the backdate-shift the design forbids. Fixed by clearing `supplementaryProof` on both abandon edges. Confirmed load-bearing by negative control: removing the clear from `chainSubmitAbandon` reproduces `Invariant supplementaryRequiresOriginalAttestation is violated`; restoring it passes.

Budgets raised for the added 3-valued variable: pr `2,304 × 3 = 6,912` per-anchor combos → `6,912² = 47,775,744` raw (budget 50M, was 6M); nightly `6,912³ = 330,225,942,528` (budget 350B, was 15B). `graphEquivalence` stays off on both (pre-existing — over the 100k cap).

`check` results (`npm run verify:machines`, TLC2 2026.03.16.234659): **pr** proofPassed=true, **17 invariants** (was 14), **8,363 generated / 1,369 distinct** (was 3,221 / 529), deadlock checked, "No error has been found". **nightly** proofPassed=true, 464,092 / 50,653 distinct. `PASSED 4/4` across all machines.
