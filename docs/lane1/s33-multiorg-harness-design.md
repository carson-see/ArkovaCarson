# S3.3 — Multi-org batch-drain harness extension (design vs merged #1463)

_Lane 1 (Trust & Chain), 2026-07-10. Design only — implementation lands as its own T0 PR (harness = tooling/tests). Written against the MERGED `scripts/staging/batch-drain-harness-lib.ts` / `batch-drain-harness.ts` on `origin/main` (`ad1d2487`; #1463, hardened by `7cb629b1`)._

---

## 1. What the merged harness does today (and the gap)

- **Lib** (`batch-drain-harness-lib.ts`) exports: `PROD_PROJECT_REF` hard-block, `resolveRigTarget(url, allowedRefs)` (prod-ref refusal + `<20-letter-ref>.supabase.co` format + allow-list), and `runOrgId(runId)` — **one deterministic synthetic org per run**. That single-org shape is the gap (lane1-report §1: multi-org invariant = net-new).
- **Entrypoint** (`batch-drain-harness.ts`) phases: `seed | drain | proofs | crash | cleanup | all`; fixture via `ensureRunFixture`, seeding via `seedPending(client, orgId, count)`, drain via `postDrain(apiBase, orgId)` + `pollDrained`, assertions `assertSingleBatch`, `distinctMerkleRoots`, `assertPositionalProofs`, `assertReconcileNoDoubleBroadcast`, teardown `cleanup(client, orgId)`. Evidence JSON per phase.
- Everything asserts against ONE org and the org-scoped drain route. No trigger-topology awareness, no adversarial orgs, no distribution shape.

## 2. Org population: Zipf distribution spec (≥30 orgs)

Deterministic, run-scoped, replayable:

- `runOrgIdN(runId, i)` — extend `runOrgId` with an index-salted digest (`batch-drain-${runId}-org-${i}`), same v4-shaped UUID trick; `i ∈ [0, orgCount)`. `runOrgId(runId) === runOrgIdN(runId, 0)` for backward compatibility.
- **Distribution:** org `i` (1-based rank) receives weight `w_i = i^(-s) / H(orgCount, s)` of `--count` total anchors (H = generalized harmonic number). Defaults: `--orgs 30`, `--zipf-s 1.0`, `--count 10000`.
  - At s=1.0, N=30: rank 1 ≈ 25% (~2,500 of 10k), top 3 ≈ 46%, bottom 15 orgs ≈ 13% — a realistic whale + long-tail shape.
- **Whale/long-tail knobs:** `--whales W` (default 3) pins ranks 1..W to a combined `--whale-share` (default 0.5) before Zipf-distributing the remainder across the tail — so "3 whales hold half the backlog" is assertable independent of s.
- **Floor:** every org gets ≥1 anchor (`max(1, round(w_i × count))`, remainder trimmed from rank 1) so "org claimed but produced no tx" can never be a distribution artifact.
- Distribution is computed by a PURE exported function `zipfOrgPlan({runId, orgs, count, s, whales, whaleShare})` → `Array<{orgId, rank, anchors}>` — unit-tested in `batch-drain-harness-lib.test.ts` (sums to count, monotone in rank, floor holds, deterministic for a runId).

## 3. Poison-pill org set

Adversarial orgs that must NOT break their neighbors (org-queue-scheduler drains per-org inside try/catch — isolation is the claim under test):

| Pill | Seeding | Expected behavior |
|---|---|---|
| **Credit-starved** (`--poison-credit K`, default 2 orgs) | Fixture org with zero/insufficient org credits so `applyQueueRunCreditGate` excludes its rows (and `refundQueueRunCredits` fires on partial paths) | Its anchors stay PENDING (never SUBMITTED, never charged); ALL other orgs drain normally in the same pass; zero credit deltas on healthy orgs |
| **Bad-fingerprint** (`--poison-fingerprint K`, default 1 org) | Service-role direct INSERT of rows whose `fingerprint` is malformed (odd-length / non-hex) — bypassing app validation the way real corruption would | Per-org failure contained: the poisoned org errors (recorded in evidence), does not abort the scheduler pass, does not appear as a leaf in any OTHER org's tree |

Per-pill assertions ride the per-trigger matrix below; pills are tagged in the evidence JSON (`poison: 'credit' | 'fingerprint'`) so the assertion pass can enumerate them.

## 4. Per-trigger assertions (the R3 invariant pair, mechanized)

Every harness run declares `--trigger org-scheduler | global-flush | global-policy` and the assertion set switches with it (prod topology + invariant wording: `docs/lane1/s33-prod-drain-topology.md`):

**org-scheduler** (drive `POST /jobs/org-queue-scheduler`):
1. Exactly **1 distinct `chain_tx_id` per claimed org per pass**; an org with pending > BATCH_SIZE accumulates `ceil(pending/10000)` txs across passes, never 2 in one pass.
2. No tx's leaf set spans two orgs (per-org `distinctMerkleRoots` extended to join tx → leaf orgs).
3. Per-org `anchor_proofs`: every drained leaf verifies against ITS org's root (`assertPositionalProofs` per org, distinct `merkle_index` within each org's batch).
4. Zero ledger/credit deltas on any org not claimed in the pass; poison-pill isolation per §3.
5. In-process node-cron: disabled, or every firing logged + attributed (a broadcast with no declaring trigger fails the run — R3 "every evidence window declares armed trigger").

**global-flush** (drive `POST /jobs/batch-anchors?force=true`):
1. Exactly **one mixed-org tx ≤ 10,000 leaves** per run; a >10k backlog leaves a remainder that drains on the NEXT tick (assert remainder count = backlog − 10,000 and second-tick tx covers it).
2. One Merkle root over the mixed leaf set; positional proofs verify for every leaf across orgs.
3. Credit gate: charged orgs = orgs with leaves in the tx, exactly once each.

**global-policy** (unforced `POST /jobs/batch-anchors`): Trigger A fires at ≥10k; below 3k nothing fires; 3k–10k fires only when oldest ≥3h (Trigger B — harness back-dates `created_at`); Trigger C deferral only via fee-injection stub (fee estimation is static off-mainnet — `client.ts:245-247`; a stub must drive `estimateCurrentFee()` past the ceiling, lane1-report §2.2).

Crash phase (`--phase crash`) composes with `--trigger`: the existing `assertReconcileNoDoubleBroadcast` extends to per-org cohorts, and once the L1-5 txid journal lands, the SIGKILL matrix asserts journal decisions (`adopt-txid` on boundary B3) instead of tolerating reverts (see `docs/lane1/s33-txid-journal-design.md` §5.5).

## 5. L1-2 signet parameters for `provision-isolated-rig.sh` — FOLLOW-UP PR ONLY

**Blocked behind L2-S2a-FIX** (Lane 2 owns the provision script this wave; our change stacks after theirs merges — this section is the design we'll implement then, per CTO R9 landing order):

1. **Network:** chain profile sets `BITCOIN_NETWORK_VALUE=signet` (today `STAGING_BITCOIN_NETWORK` defaults to `mainnet`, script :97). Signet keeps the full behavioral path (real broadcasts, real confirmations) at zero mainnet treasury risk.
2. **Net-new signet secret NAMES** (values operator-provisioned, never in-tree; today's defaults point at MAINNET staging secrets, :85-86):
   - `bitcoin-rpc-url-signet-staging` (GetBlock signet RPC endpoint)
   - `bitcoin-rpc-auth-signet-staging`
   - `bitcoin-treasury-wif-signet-staging` (funded signet treasury; P2WPKH per `wallet.ts`)
   Wired via the existing `STAGING_GETBLOCK_RPC_URL_SECRET` / `STAGING_GETBLOCK_RPC_AUTH_SECRET` / `STAGING_TREASURY_WIF_SECRET` overrides — the follow-up changes chain-profile DEFAULTS, no new mechanism.
3. **Scheduler jobs:** L2-S2a-FIX adds `org-queue-scheduler` to chain-profile `SCHEDULER_JOBS` (:323) — recorded R3 decision (ADD, not harness-driven). Our follow-up additionally mirrors prod's forced-flush job (`batch-anchors?force=true`, 600s deadline) and `recover-broadcasts`, so the rig runs the full §4 trigger set with prod-faithful deadlines.
4. **Pre-clock readiness probe** (runs BEFORE any soak clock starts; failure = window slips, not evidence):
   - `getblockchaininfo` via the rig's configured RPC returns `chain == "signet"` (hard assert — catches a mainnet secret pasted into a signet name);
   - ONE funded real broadcast (dust-level self-spend or 1-leaf anchor) confirms end-to-end sign→broadcast→`getrawtransaction` visibility on the SAME node the soak will use;
   - probe artifact (txid + chain + block height) attached to the evidence pack.
5. **mempool.space-signet fallback (pre-approved wording for RTE):** if the GetBlock signet endpoint is unavailable/unfundable at rig-day, the rig may fall back to `BITCOIN_UTXO_PROVIDER=mempool` against `https://mempool.space/signet/api` (the `MempoolUtxoProvider` path, `utxo-provider.ts:396`) **with this downgrade declared in the evidence block**: "UTXO listing/broadcast via public mempool.space-signet (fallback); GetBlock-sovereign path NOT exercised — broadcast/UTXO parity with prod is asserted, not measured; confirmation-proof fetch (`getTxOutProof`) unavailable on this provider, proofs report `pending` by design." RTE pre-approval of this wording is requested via L1-2's Jira story so a rig-day fallback is a decision already made, not a scramble.

## 6. Implementation shape (the future T0 PR)

- Lib: `zipfOrgPlan`, `runOrgIdN`, poison-pill seeding helpers + unit tests (pure; no network).
- Entrypoint: `--orgs/--zipf-s/--whales/--whale-share/--poison-credit/--poison-fingerprint/--trigger` flags; per-trigger assertion dispatch; per-org evidence JSON (`phases.drain.orgs[]` with rank, seeded, drained, txId, poison tag).
- All existing single-org invocations remain valid (defaults `--orgs 1` reproduce today's behavior — #1463's evidence stays comparable).
- Shared with L2-S3 per R8: the performance-test engineer consumes `zipfOrgPlan` as the single org-distribution spec for load generation (one spec, two harnesses).
