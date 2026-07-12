# S3.3 L1-5 — Pre-broadcast txid journal: design + wiring plan

_Lane 1 (Trust & Chain), 2026-07-10. This PR ships ONLY the pure decision core (`services/worker/src/jobs/txid-journal.ts` + red-first tests). Everything below marked WIRING or MIGRATION is design for a post-2026-07-12 PR — `batch-anchor.ts` and the reconcile path collide with soaking #1417 and must not be touched this wave (CTO R9)._

---

## 1. The gap (crash boundary analysis)

`processBatchAnchors` (`services/worker/src/jobs/batch-anchor.ts`):

```
Phase 1  claim_pending_anchors (chunked)      PENDING → BROADCASTING
Phase 2  buildMerkleTree(fingerprints)
Phase 3  chainClient.submitFingerprint(root)  ← sign + broadcast INSIDE one call (:741-745)
Phase 4  submit_batch_anchors RPC             BROADCASTING → SUBMITTED + chain_tx_id (:763+)
```

Crash boundaries vs today's reconcile (`recover_stuck_broadcasts` reverts stale BROADCASTING rows **iff `chain_tx_id IS NULL`**; behavior pinned by `batch-drain-reconcile.test.ts:484-558`):

| # | Crash point | DB state | Today's reconcile | Verdict |
|---|---|---|---|---|
| B1 | after claim, before sign | BROADCASTING, tx_id NULL | revert → PENDING → re-drain | SAFE (no tx exists) |
| B2 | after sign, before network accept | BROADCASTING, tx_id NULL | revert → re-drain | SAFE (tx never left the box) |
| **B3** | **after network accept, before Phase 4 persist** | **BROADCASTING, tx_id NULL** | **revert → re-drain → SECOND tx for the same fingerprints** | **DOUBLE-BROADCAST** |
| B4 | after Phase 4 (incl. `bulkMarkSubmittedFallback`) | SUBMITTED (or BROADCASTING) with tx_id | guard leaves rows alone | SAFE (pinned by #1417 tests) |

B3 is the ambiguous window: from the DB's view B2 and B3 are **indistinguishable** — both leave BROADCASTING + NULL `chain_tx_id`. The 2026-04-24 incident class (`submit_batch_anchors` failing post-broadcast) was fixed by retry + `bulkMarkSubmittedFallback`, but that fix only covers a LIVE worker seeing the RPC fail. A hard crash (SIGKILL, OOM, Cloud Run preemption) between Phase 3's network accept and Phase 4's first write has no living process to run the fallback. L1-5's SIGKILL matrix will hit this window deliberately; without the journal, the rig would prove a double-broadcast.

Cost of a B3 double-broadcast: two on-chain receipts for one logical batch, double treasury spend, and two competing `chain_tx_id` candidates for the same fingerprints — plus a conflicting-UTXO rejection only if the second drain happens to select the same treasury UTXO (it usually won't; the first tx's change is now spendable).

## 2. The fix: journal the txid BEFORE broadcast

The txid of a signed tx is computable pre-broadcast (`signet.ts` `psbt.extractTransaction()` → `tx.getId()`, :510-514 / :612-614) and cannot change once we broadcast that exact hex (we always broadcast our own serialization; see §6 malleability note).

**Write point (WIRING):** after signing, before `provider.broadcastTx(txHex)`, persist:

```
{ batch_id, txid, fingerprint_root, signed_at }
```

**Reconcile (WIRING):** before reverting any stale BROADCASTING/NULL-tx_id cohort, look up the journal; if an entry exists, check `getrawtransaction(journaled_txid)` and decide via the pure core (§3). B2/B3 stop being indistinguishable because the network is consulted before any revert.

Failure-mode bias (load-bearing): **the only path to `revert` is affirmative evidence of absence.** Journal-write failure aborts the batch pre-broadcast (safe — nothing on the network; claims revert as in B1/B2 today). Lookup failure/holds page an operator; a wrong revert double-spends on-chain, which no operator can undo.

## 3. Shipped in this PR — the pure decision core

`services/worker/src/jobs/txid-journal.ts` (no I/O, clock injected; 34 red-first vitest cases in `txid-journal.test.ts`):

- `buildJournalEntry({batchId, txid, fingerprintRoot, signedAt})` — Zod-validated + normalized (64-hex lowercase txid/root, bounded batchId, parsable ISO `signed_at`). THROWS: an unjournalable batch must not broadcast.
- `shouldConsultJournal(row)` — B4 exclusion: only `BROADCASTING` + `chain_tx_id IS NULL` rows enter the decision path.
- `decideReconcileAction(entry | null, chainLookupResult | null, {nowMs?, ambiguityWindowMs?})` → `{action: revert | adopt-txid | hold, reason, txid?}`:

| entry | lookup | decision |
|---|---|---|
| null | any | **revert** (B1 — nothing was signed) |
| present | `found` same txid, conf ≥ 0 | **adopt-txid** (B3 — stamp journaled txid; idempotent with Phase 4) |
| present | `found` different txid | **hold** (never adopt unverified, never revert) |
| present | `found` conf < 0 | **hold** (bitcoind conflicted sentinel) |
| present | `not_found`, inside window | **hold** (may still be propagating / broadcast in flight) |
| present | `not_found`, window elapsed | **revert** (B2 — provably never accepted) |
| present | `lookup_failed` / no lookup | **hold** (elapsed time is not evidence) |
| present | `not_found`, unparsable/future `signed_at` | **hold** (never revert on an untrusted clock) |

`DEFAULT_AMBIGUITY_WINDOW_MS = 30 min` — two prod `recover-broadcasts` cycles (every 15 min, see `docs/lane1/s33-prod-drain-topology.md`), far below Trigger B's 3h so a genuinely dead batch re-drains same-day. Rig runs inject shorter windows.

## 4. MIGRATION design (0355+ — number reserved per `feedback_migration_number_vs_reservations`; NO file this wave)

`NNNN_anchor_txid_journal.sql` (post-07-12; actual number = max(main head, agents.md reservations, open-PR migrations)+1 at filing time):

```sql
CREATE TABLE anchor_txid_journal (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id          text NOT NULL UNIQUE,
  txid              text NOT NULL UNIQUE CHECK (txid ~ '^[0-9a-f]{64}$'),
  fingerprint_root  text NOT NULL CHECK (fingerprint_root ~ '^[0-9a-f]{64}$'),
  leaf_order        jsonb NOT NULL,             -- ordered claimed fingerprints (see below)
  signed_at         timestamptz NOT NULL,
  resolved_at       timestamptz,                -- set on adopt/revert/persist-confirmed
  resolution        text CHECK (resolution IN ('persisted','adopted','reverted')),
  created_at        timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE anchor_txid_journal ENABLE ROW LEVEL SECURITY;
ALTER TABLE anchor_txid_journal FORCE ROW LEVEL SECURITY;
-- deny-all: no anon/authenticated policies; service_role only (§1.4).
-- ROLLBACK: DROP TABLE anchor_txid_journal;
```

Design choices:

- **`leaf_order` jsonb (ordered fingerprint array).** Correlation is the hard part: BROADCASTING rows don't carry `batch_id` (it's assigned at Phase 4), and the Merkle root is order-sensitive with the claim order lost on crash. Storing the ordered leaves makes the journal row self-contained: reconcile matches the stuck cohort set-wise against `leaf_order`, and on ADOPT can also recompute the exact tree → correct per-leaf `merkle_index` + branches into `anchor_proofs` (closing the SCRUM-2471 "merkle_index never reconstructable" gap **for crash batches**). Size: 10k × 64-hex ≈ 650 KB jsonb for a row that exists per-broadcast and is pruned after resolution — acceptable. Rejected alternative: stamping `anchors.batch_id` at claim time (schema change on the 2.97M-row hot table + a second write in the claim RPC).
- **Journal rows are resolved, then pruned.** Phase 4 success marks `resolution='persisted'`; adopt/revert mark theirs. A sweep deletes resolved rows older than 30 days. Unresolved rows older than the ambiguity window with no matching stuck cohort are an alert condition (orphaned journal = broadcast we lost track of entirely).
- Raw signed hex deliberately NOT stored (considered: would enable re-broadcast recovery; rejected: duplicates what the network already has once accepted, and a stored-but-never-broadcast hex is a footgun — rebroadcasting it after a revert would double-anchor).

## 5. WIRING plan (post-07-12 PR, T3 — migrations + anchor lifecycle + chain)

1. **Expose the sign/broadcast seam.** `submitFingerprint` signs and broadcasts inside one call. Add an optional `preBroadcastHook?: (info: {txId: string}) => Promise<void>` to `SubmitFingerprintRequest` (additive, mock-compatible), invoked between `extractTransaction()` and `provider.broadcastTx()` on BOTH the single-input and multi-input paths. Hook throw = abort before broadcast (safe).
2. **batch-anchor.ts Phase 3**: generate `batchId` BEFORE broadcast (today `batch_${Date.now()}_${n}` is built in Phase 4 — move it up; same format), pass the hook: `buildJournalEntry(...)` → INSERT journal row → broadcast. Phase 4 success → mark journal `persisted`.
3. **Reconcile**: in `broadcast-recovery.ts` (or a sibling), before `recover_stuck_broadcasts` reverts: load unresolved journal entries; match stuck cohort ↔ `leaf_order`; `getrawtransaction(journaled_txid)` via the existing `ConfirmationProofProvider` slice (`utxo-provider.ts` — GetBlock RPC, same sovereign node as broadcast); `decideReconcileAction(...)`; ADOPT = stamp `chain_tx_id` + SUBMITTED (reuse `bulkMarkSubmittedFallback` shape) + recompute proofs; REVERT = today's path; HOLD = log + Sentry breadcrumb (`chain_rpc_fallback` field-shape per `utils/sentry.ts::emitRpcFallback`), leave rows for next pass. `recover_stuck_broadcasts` itself needs a guard so it never reverts a cohort that journal-matching has HELD — either run journal reconcile first in the same pass, or add a `p_exclude_fingerprints`/hold-marker. Exact mechanism decided at wiring time against post-07-12 `main`.
4. **TLA**: `machines/bitcoinAnchor.machine.ts` gains the journaled-broadcast intermediate state + adopt transition; `tla-precheck check` must pass before the wiring PR opens (§4 Doc Update Matrix: anchor lifecycle).
5. **L1-5 rig matrix** (SIGKILL at B1–B4 on the signet rig) runs ONLY after this wiring lands — the journal must exist before the crash matrix, or the matrix proves the bug instead of the fix (lane1-report pre-mortem #4). #1461 dead-man's-switch firings during deliberate crashes are pre-declared expected evidence.

## 6. Residual risks / notes for the Bitcoin protocol specialist review

- **Malleability: structurally closed.** Treasury spends are P2WPKH (`wallet.ts:40`, `signet.ts:456/578`) — the txid excludes witness data, so a third party cannot malleate the txid of a relayed segwit tx. The journaled txid is therefore exactly the txid that can confirm. (If the treasury ever adds non-segwit inputs, revisit: a reconcile-side `gettxout` spend-status check on the journaled outpoints before any revert would be the guard — needs input outpoints in the journal row.)
- **RBF interaction (real, but out-of-window):** anchor txs DO signal BIP125 RBF (`signet.ts` `RBF_SEQUENCE = 0xfffffffd`, CRIT-3 — fee-bumping stuck txs). A fee-bump replacement changes the txid, which would strand a journaled txid as `not_found`. However, fee-bumping (NET-1/NET-3 stuck-tx paths in `chain-maintenance.ts`) operates only on PERSISTED rows (`chain_tx_id` set) — and during the ambiguous window the worker is dead, so nothing can replace the tx before reconcile runs. Wiring rule to keep it that way: any future fee-bump path must mark the journal row (`resolution` update) when it replaces a tx. Flag for specialist sign-off.
- **Adopt with 0 confirmations** is correct: the tx is in the network's custody; SUBMITTED (not SECURED) is exactly the state Phase 4 would have written; `check-confirmations` promotes as normal, and existing reorg handling (0347) covers eviction after adoption. A mempool eviction after adopt equals eviction after a normal Phase 4 persist — handled by NET-1/NET-3, not a journal concern.

## 7. Test evidence (this PR)

`npx vitest run src/jobs/txid-journal.test.ts` — 34/34 green; seen RED first (module absent). Boundaries B1–B4 + ambiguous-window edges (boundary-exact elapse, injected window, zero window, future `signed_at`, corrupt `signed_at`, mismatch, negative confirmations, lookup-failed, no-lookup) all covered. `npm run typecheck` green.
