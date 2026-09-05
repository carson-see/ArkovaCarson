# Finding: `anchor_proofs.block_height` is the chain tip at broadcast, not the inclusion block, on 711,250 prod rows

**Date:** 2026-09-02  **Scope:** prod Supabase `vzwyaatejekddvltxyye`, read-only audit  **Severity:** P1 data integrity (proof surface)
**Companion data:** `blocks.csv` (this directory) — every distinct `(block_hash, block_height)` pair in `anchor_proofs`, the height `anchors` carries for the same hash, and the height blockstream.info and mempool.space return for the hash.

## 1. Summary

`anchor_proofs.block_height` (and `anchor_proofs.block_timestamp`) are stamped at **broadcast time** with the chain **tip** height and the worker's **wall clock**, and are never corrected when the transaction is later mined. The value is therefore always *below* the real inclusion height by the number of blocks the transaction waited in the mempool (1 to 13 blocks in prod; median 2). The confirmation-proof populate job then writes the correct `block_hash` and `block_header` next to the stale height, producing rows that are internally inconsistent: the hash and header describe block N, the height says N-2.

`anchors.chain_block_height` / `chain_block_hash` (written at SECURED time from the mempool.space tx status) are correct, so every public API surface, which reads `anchors`, publishes the right number. The wrong number reaches users through the one surface that reads `anchor_proofs` directly: the downloadable audit certificate (`src/lib/sourceProofInput.ts`), whose embedded proof packet is rejected by the reference verifier with `height_mismatch` when checked against an independent node.

## 2. Numbers (prod, 2026-09-02, all via read-only SQL)

| Measure | Value |
|---|---|
| `anchor_proofs` rows / distinct anchors | 714,129 / 714,129 (1:1) |
| Distinct `block_hash` / distinct `(block_hash, block_height)` pairs | 409 / 463 |
| Rows where `ap.block_height <> anchors.chain_block_height` | **711,250** (99.6%) |
| … distinct block hashes / anchors / orgs | **390** / 711,250 / 1 (`Arkova`, `40383eb2-f1cd-4a85-8099-afafff95e5cf`, the public-records catalogue) |
| … direction | 711,250 below the anchor height, 0 above |
| … delta distribution (rows) | 1: 323,985 · 2: 255,813 · 3: 82,955 · 4: 23,001 · 5: 3,590 · 6: 481 · 7: 20,846 · 8: 336 · 9: 17 · 10: 77 · 11: 53 · 13: 7 · 2,747: 89 |
| Rows where the two agree | 2,877 (29 hashes) — all written by the batch-anchor pre-broadcast intent path (34 `anchor_txid_journal` rows, all `PERSISTED`, 0 wrong) |
| Rows with NULL height | 2 (one REVOKED, one SUBMITTED) |
| `anchor_proofs.block_timestamp` earlier than the real block time | 711,250 of 711,250 wrong rows (same mechanism, see §3) |
| `anchors` with `chain_block_hash` | 714,868 rows, 384 distinct hashes, 384 distinct (hash, height) pairs — no hash at two heights |
| `anchor_chain_index` vs `anchors` (height and hash) | agree on all 712,345 joined rows |
| `attestations.chain_block_height` | 0 rows populated (not affected) |
| SECURED anchors with / without any proof row | 714,128 / 2,972,004 (the known back-catalogue gap, unrelated) |

Producer attribution (from `anchor_proofs.batch_id`):

| Producer | Rows | Txids | Height | Window |
|---|---|---|---|---|
| `pr_batch_*` — `services/worker/src/jobs/publicRecordAnchor.ts` | 709,250 | 508 | **all wrong** | 2026-04-24 → 2026-09-02 |
| `batch_*` — `batch-anchor.ts` legacy post-broadcast path (pre S3-P0) | 2,000 | 2 | **all wrong** | 2026-06-27 → 2026-06-30 |
| `batch_*` — `batch-anchor.ts` pre-broadcast intent path (S3-P0, 2026-07-06+) | 2,878 | 33 | all correct | 2026-08-01 → 2026-09-02 |

Every wrong row belongs to an anchor linked from `public_records`; the 51 customer-record proof rows are all correct.

The two blocks the orchestrator confirmed, with the timeline the data records:

| Block hash | `anchor_proofs` | `anchors` | Chain | Rows / txids | Proof rows created (= broadcast) | Block mined | SECURED |
|---|---|---|---|---|---|---|---|
| `…012d7712c14427a3e06d0f8d4a2b86bf746d4453862045` | 960655 | 960657 | 960657 | 33,476 / 7 | 2026-08-02 01:22–02:22Z | 02:30:48Z | 03:20–03:34Z |
| `…0000f721269f1470d6cc536d5eff969a288df068ea24ffd2` | 962141 | 962144 | 962144 | 2,397 / 4 | 2026-08-12 11:42–12:10Z | 12:40:05Z | 13:00Z |

The `anchor.batch_secured` audit rows for these txids recorded the correct heights (960657, 962144) at SECURED time — the worker knew the right number and wrote it everywhere except `anchor_proofs`.

### 2.1 Chain verification of every block (blockstream.info + mempool.space)

All 423 distinct block hashes referenced by prod (409 in `anchor_proofs` ∪ 384 in `anchors`) were resolved on **both** blockstream.info and mempool.space (`GET /api/block/<hash>`, ≤ 2 req/s); the two explorers agree on the height of every one (0 unresolved, 0 disagreements). Per-block results are in `blocks.csv`: one row per `(block_hash, block_height)` pair stored in `anchor_proofs` (462) plus the 14 hashes present only in `anchors`, each with the `anchors` height for the same hash, both explorer heights, the deltas and correctness flags. The single `(NULL, NULL)` group (2 rows) is excluded.

| Check | Result |
|---|---|
| Blocks checked (distinct hashes) | 423 — 423 resolved on both explorers, 423 agree |
| `anchor_proofs` `(hash, height)` pairs | 462: **433 wrong**, 29 correct |
| `anchor_proofs` rows | **711,250 wrong** (stored height below the chain height), 2,877 correct, 0 above the chain |
| Distinct hashes with at least one wrong stored height | **390**; only 19 hashes are fully correct |
| `anchors.chain_block_height` vs chain | **384 / 384 correct** (0 wrong) |
| Delta (chain − stored) by rows | 1: 323,985 · 2: 255,813 · 3: 82,955 · 4: 23,001 · 5: 3,590 · 6: 481 · 7: 20,846 · 8: 336 · 9: 17 · 10: 77 · 11: 53 · 13: 7 · 2,747: 89 |

The independent chain lookup and the SQL comparison against `anchors` in the table above partition the rows identically: everything `anchors` says is right, and every `anchor_proofs` disagreement is an `anchor_proofs` error. (The orchestrator's two confirmed blocks — deltas −2 and −3 — are two of the 433 wrong pairs.)

### 2.2 Residuals noticed on the way (not this defect)

* 89 rows (created 2026-04-27, hash `…bfe19598f7661d0b`) have `receipt_id` ≠ `anchors.chain_tx_id`: the anchors were re-anchored in a later tx (height 949,620) but the proof row still describes the superseded broadcast (height 946,873; delta 2,747). The height fix below corrects the number; the tx/branch mismatch is a separate integrity question.
* The 44-hashes-at-more-than-one-height observation a peer session is analysing is the same mechanism seen from the other side: several txs mined into one block were broadcast at different tips, so one hash carries several stamped heights. Nothing in `anchors` shows that pattern.
* `services/worker/src/api/proof-packet.ts:149` selects `bitcoin_tx_id, block_height` from `anchors` — neither column exists on `anchors` (`chain_tx_id` / `chain_block_height` do). Out of scope here; flagged for the DI-398 phantom-column ratchet.

## 3. Root cause

The height is produced by one expression and then protected from correction by a second.

1. **Producer — the chain tip at broadcast.** `services/worker/src/chain/signet.ts:859-873`, `broadcastSignedTx`:
   ```ts
   let blockHeight = 0;
   try {
     const blockchainInfo = await this.provider.getBlockchainInfo();
     blockHeight = blockchainInfo.blocks;          // ← current chain tip, not the tx's block
   } catch { … }
   return { receiptId: finalTxId, blockHeight, blockTimestamp: new Date().toISOString(), confirmations: 0, … };
   ```
   The comment above it says exactly what it is: "broadcast-time observability only … the real height is recovered at confirmation time". `submitFingerprint` (`signet.ts:879-917`) returns this receipt unchanged. A transaction cannot be in the tip block that already exists, so the stored value is structurally ≥ 1 below the inclusion height; the delta is the mempool wait.

2. **Persisted as a block height.** `services/worker/src/jobs/publicRecordAnchor.ts:434-441` (`finalizePublicRecordAnchorBatch`), immediately after `chainClient.submitFingerprint` (`:985`):
   ```ts
   await upsertAnchorProofs(client, chunk.map((item) => ({
     anchorId: item.anchor_id, receiptId: receipt.receiptId,
     blockHeight: receipt.blockHeight ?? null,          // ← tip height
     blockTimestamp: receipt.blockTimestamp ?? null,    // ← wall clock
     merkleRoot, proofPath: item.merkle_proof, batchId })));
   ```
   via `services/worker/src/utils/anchorProofs.ts:82` (`block_height: row.blockHeight ?? null`). The same class of write exists at `jobs/anchor.ts:370-371` (single anchor), `jobs/batch-anchor.ts:2149, 2523, 2539` (legacy non-intent paths, the source of the 2,000 June rows) and `jobs/supplementary-proof-anchor.ts:308/333` (SCRUM-3468). The S3-P0 intent path is the one writer that gets it right, by writing `blockHeight: null` before broadcast (`batch-anchor.ts:785`).

3. **Confirmation corrects `anchors`, not `anchor_proofs`.** `services/worker/src/jobs/check-confirmations.ts:988` takes the real height from the mempool.space tx status (`txData.status.block_height`) and passes it to `drain_submitted_to_secured_for_tx` (`:1049`), which updates `anchors.chain_block_height` / `chain_block_hash` and `anchor_chain_index`. `pg_get_functiondef` on prod confirms that function, `submit_batch_anchors` and `finalize_public_record_anchor_batch` never touch `anchor_proofs`.

4. **Populate re-asserts the stale value next to the correct hash.** `services/worker/src/jobs/confirmation-proof-populate.ts`:
   ```ts
   // :281 — scan row → candidate
   blockHeight: row.block_height ?? row.anchors?.chain_block_height ?? null,
   // :146 — confirmed proof → update row
   updates.push({ anchorId, blockHeader: proof.blockHeader, blockHash: proof.blockHash,
                  blockHeight: anchor.blockHeight ?? null });
   ```
   and `services/worker/src/utils/anchorProofs.ts:166`:
   ```ts
   if (row.blockHeight != null) values.block_height = row.blockHeight;   // ← same UPDATE that writes the correct block_hash/block_header
   ```
   `??` only falls through on NULL, so the stale tip height wins over the correct `anchors.chain_block_height` on every row the legacy writers touched, and falls through to the correct value only for intent-path rows (which is why those 2,877 rows are right). `fetchConfirmationProof` (`chain/confirmation-proof.ts:586-748`) fetches `getBlockHeaderHex` (raw 80 bytes, which carry no height) and `gettxoutproof`; it never reads `getBlockHeader(hash).height`, although every provider implements it (`chain/utxo-provider.ts:474, 673, 797, 1095`).

**History (`git log -S`).** The tip-height receipt and the `publicRecordAnchor` upsert both trace to PR #761 (`53f798f56`, merged 2026-05-11); the earliest `anchor_proofs` rows (2026-04-24) already carry the same signature, so the pre-#761 producer behaved the same way. S3-P0 (`b40966290` / `257352c20`, 2026-07-06) kept the expression and added the "observability only" comment. The populate expressions have been unchanged since PR #1320 (`9612e25cf`, 2026-06-28). No commit ever changed the value's meaning — this is a design gap, not a regression.

**Deploys.** Every prod worker revision since the first proof rows has written these values. The 2026-08-02 rows were written under `arkova-worker-00890-8pz` / `01158-rek` (image `sha256:ffcceeff…`, created 2026-08-01T16:17Z/18:45Z; HANDOFF pins the 2026-08-01T14:26Z deploy `01153-lir` at git `c56ceee03`); the 2026-08-12 rows under `arkova-worker-01304-hap` (`sha256:bfb98374…`, 2026-08-11T23:03Z). The current revision `arkova-worker-01327-vok` (`sha256:6c010c7f…`, 2026-08-31T17:12Z, 100 % traffic) still writes them: 36,323 wrong rows were created 2026-09-01/02, the last at 2026-09-02 18:10Z. Current `main` (worktree HEAD `1836bcb4b`) carries every expression quoted above. The revision metadata carries no git SHA env/label, so the SHA→revision mapping beyond HANDOFF's pin is not asserted here.

## 4. Blast radius — "verification fails" vs "wrong number displayed"

| Surface | Reads | Effect on the 711,250 rows |
|---|---|---|
| `GET /api/v1/verify/:id/proof` — top-level `block_height`, `block_timestamp` and `proof_bundle.block_height` (`api/v1/verify-proof.ts:512, 604`) | `anchors.chain_block_height` | **Correct.** (`proof_bundle` is `null` for all affected rows anyway: `op_return_payload` is NULL on all 711,250 and `merkle_index` on 709,250, so `buildProofBundle` returns null.) |
| `GET /api/v1/verify/:id` (`bitcoin_block`), `/anchor/:id/evidence`, audit export CSV/PDF, GRC sync, `get_public_anchor` projection, `anchor.secured` webhooks, `anchor.batch_secured` audit rows, SDKs and the MCP server (all API-backed) | `anchors` | **Correct.** |
| "Download proof JSON" (`src/lib/proofPackage.ts:141`) | `anchors` | Correct. |
| **"Download proof certificate"** — `src/pages/RecordDetailPage.tsx:260` → `src/lib/sourceProofInput.ts:183,190` → `src/lib/generateAuditReport.ts:324-328` | `anchor_proofs.block_height ?? anchors…`, `anchor_proofs.block_timestamp ?? anchors…` | **Wrong number displayed** as "Network Record #N-2", and the embedded machine-readable packet carries the wrong `block_height` and `block_timestamp`. RLS scopes this to members of the owning org (Arkova, the public-records owner), so today the audience is internal, but any such certificate handed to an auditor is a self-contradicting proof. |
| `arkova-verify proof.json` (recompute-only, no `--rpc`) | packet | Merkle recompute passes; report prints "Recorded at block: #N-2" — **wrong number displayed**, verdict unaffected. |
| `arkova-verify proof.json --rpc <esplora>` — `packages/verifier/src/independent-node.ts:219` | packet | **Verification fails**: `height_mismatch` → CLI step "Confirm the receipt is in a real block" fails with reason code `HEIGHT_MISMATCH`, verdict NOT VERIFIED. The timestamp-honesty step (3b) fails too because the packet's `block_timestamp` is the broadcast wall clock, not the header time — fixing the height alone would still leave the packet failing. |

Not affected: `anchors`, `anchor_chain_index`, `attestations`, reorg detection (compares `anchors.chain_block_hash`), confirmation counting (uses the mempool height), billing.

## 5. Fix design (not implemented)

Soak tier: **T3** — migration + data integrity + chain/anchor-lifecycle surfaces (`services/worker/src/chain/`, `supabase/migrations/`). Isolated rig with `clean_mirror` preflight per §1.11A; the rig fixture must reproduce the 463-pair distribution (several txs per block, broadcast at different tips) so the reconcile job and the guard are exercised on the real shape, not on single-tx fixtures. No anchor lifecycle state changes, so `machines/bitcoinAnchor.machine.ts` is untouched (state this in the PR).

### 5.1 Data repair — worker-only, header-derived, batched

New operator job `services/worker/src/jobs/anchor-proof-block-height-reconcile.ts` (`POST /jobs/anchor-proof-block-height-reconcile`, `dryRun` default **true**, live run additionally requires `ANCHOR_PROOF_HEIGHT_RECONCILE_CONFIRM=EXECUTE`; not on any scheduler manifest):

1. `SELECT DISTINCT block_hash FROM anchor_proofs WHERE block_hash IS NOT NULL` (≈409 hashes) — the unit of work is the block, never the stored height.
2. Per hash, via the injected `UtxoProvider` (GetBlock RPC, `getblockheader <hash> true`): take `height` and `time`. Never trust a stored height: cross-check that `sha256d(stored block_header)` of a sample row equals the hash (skip + Sentry alert on mismatch — that row has a different problem), and log, but do not act on, disagreement with `anchors.chain_block_height`.
3. Batched UPDATE through a new service-role RPC `reconcile_anchor_proof_block(p_block_hash text, p_height integer, p_block_time timestamptz, p_anchor_ids uuid[])` — `SECURITY DEFINER`, `SET search_path = public`, chunks of 500 `anchor_id`s (keyset, `ORDER BY anchor_id`), each chunk its own transaction opened with `SET LOCAL lock_timeout = '5s'` and `SET LOCAL statement_timeout = '30s'`, predicate `WHERE block_hash = p_block_hash AND anchor_id = ANY(p_anchor_ids) AND (block_height IS DISTINCT FROM p_height OR block_timestamp IS DISTINCT FROM p_block_time)`. Idempotent and resumable (a corrected row no longer matches).
4. Every hash writes one row to `anchor_proof_block_reconcile_log (run_id, block_hash, old_heights int[], old_timestamps timestamptz[], new_height, new_block_time, rows_updated, header_hash_verified bool, source text default 'getblockheader', created_at)` — the audit trail and the rollback source.
5. Provider budget: ~409 `getblockheader` calls, rate-limited; ~1,430 UPDATE chunks of 500.

Migration `supabase/migrations/NNNN_anchor_proof_block_height_reconcile.sql` (number per the `migration-procedure` skill: max(main head, `agents.md` reservations)+1) creates the RPC and the log table (RLS + `FORCE ROW LEVEL SECURITY`, service_role only, `REVOKE … FROM PUBLIC, anon, authenticated` explicitly — Supabase grants anon/authenticated at CREATE), plus the guard in §5.2(5). `-- ROLLBACK:` restores per-row from the log (`UPDATE anchor_proofs ap SET block_height = l.old_height, block_timestamp = l.old_ts FROM …` keyed on the run_id), then drops the trigger, RPC and table. Apply via `npx supabase db push --linked` on the rig; prod apply by the RTE with the §0-rule-10 ledger reconcile. The alternative — a pure SQL `UPDATE … FROM anchors a SET block_height = a.chain_block_height` — is cheaper but trusts a stored height and is rejected for the repair; it is useful only as the pre/post consistency check in §6.

### 5.2 Source fix

1. `chain/confirmation-proof.ts` — `fetchConfirmationProof` additionally calls `provider.getBlockHeader(blockHash)` and returns `blockHeight` and `blockTime` derived from the header RPC (cross-checked against the 4-byte time in the raw header it already parses).
2. `jobs/confirmation-proof-populate.ts:146` → `blockHeight: proof.blockHeight, blockTimestamp: proof.blockTime` (never `anchor.blockHeight`); `:281` keeps the stored/anchor value only as `expectedBlockHeight` for a mismatch warning + metric. `utils/anchorProofs.ts:166` writes `block_height` and `block_timestamp` unconditionally from the proof (drop the `!= null` guard).
3. Broadcast-time writers stop persisting tip data as block data: `jobs/publicRecordAnchor.ts:439-440`, `jobs/anchor.ts:370-371`, the legacy `persistBatchAnchorProofs` calls in `jobs/batch-anchor.ts:2149, 2523, 2539`, and `jobs/supplementary-proof-anchor.ts:308/333` write `blockHeight: null, blockTimestamp: null` — exactly what the intent path does at `batch-anchor.ts:785-786`, and the data proves that path yields correct rows. In `chain/signet.ts:859-873` rename the receipt field to `tipHeightAtBroadcast` (make `ChainReceipt.blockHeight` nullable) so a tip value can no longer be passed where an inclusion height is expected; the same receipt also feeds `anchors.chain_block_height` at SUBMITTED time through `finalize_public_record_anchor_batch` / `submit_batch_anchors` `p_block_height` (display-only while SUBMITTED, overwritten at SECURED) — pass NULL there too.
4. Frontend `src/lib/sourceProofInput.ts:183,190` prefers `anchors.chain_block_height` / `chain_timestamp`, and when the proof row disagrees with the anchor it returns `complete: false` and refuses to embed the packet (fail closed, §1.5) instead of shipping a self-contradicting proof.
5. Guards so it cannot recur: (a) `BEFORE INSERT OR UPDATE` trigger on `anchor_proofs`: when `NEW.block_hash IS NOT NULL` and the parent anchor is SECURED with `chain_block_hash = NEW.block_hash`, `NEW.block_height` must be NULL or equal `anchors.chain_block_height` (raise otherwise); (b) `jobs/auditSecuredChainIntegrity.ts` gains a `proof_height_mismatch` violation (`anchor_proofs.block_height <> anchors.chain_block_height` on SECURED anchors) so the nightly audit would have caught this; (c) tests: populate writes the RPC-derived height even when the row already has a non-null one; `publicRecordAnchor` persists NULL height/timestamp at broadcast; a fixture where tip ≠ inclusion height; verifier-cli end-to-end: a certificate packet for a SECURED record passes `--rpc` against a mock esplora.
6. Related tickets to link, not duplicate: SCRUM-3468 (supplementary path, same mechanism, DI-731), SCRUM-3442 (`confirmed:true` with zero height), SCRUM-2590 (same-height reorg hash), SCRUM-2336 (PROOF-03 populate).

## 6. Verification commands

Before/after the repair (expected 0 after):

```sql
SELECT count(*) AS mismatched_rows, count(DISTINCT ap.block_hash) AS hashes
FROM anchor_proofs ap JOIN anchors a ON a.id = ap.anchor_id
WHERE ap.block_height IS NOT NULL AND a.chain_block_height IS NOT NULL
  AND (ap.block_height <> a.chain_block_height OR ap.block_timestamp <> a.chain_timestamp);
```

Header-derived spot check (independent of every stored height):

```sh
curl -s https://blockstream.info/api/block/000000000000000000012d7712c14427a3e06d0f8d4a2b86bf746d4453862045 | jq '.height,.timestamp'   # 960657
curl -s https://mempool.space/api/block/00000000000000000000f721269f1470d6cc536d5eff969a288df068ea24ffd2 | jq '.height,.timestamp'     # 962144
```

```sql
SELECT block_hash, block_height, block_timestamp, count(*) FROM anchor_proofs
WHERE block_hash IN ('000000000000000000012d7712c14427a3e06d0f8d4a2b86bf746d4453862045','00000000000000000000f721269f1470d6cc536d5eff969a288df068ea24ffd2')
GROUP BY 1,2,3;   -- must read 960657 / 962144 and the header timestamps after the repair
```

Full re-run of this audit: `python3 fetch_explorers.py <dir>` then `python3 build_csv.py <dir>` in this directory regenerate `blocks.csv` from a fresh `anchor_proofs` group-by (the `prod_pairs.json` / `anchors_pairs.json` inputs are the two GROUP BY queries in §2).

End-to-end: download the certificate for a public-record anchor from Record Detail, save the embedded packet as `proof.json`, run `arkova-verify proof.json --rpc https://blockstream.info/api` — must report VERIFIED with the block-inclusion and timestamp steps passing.

## 7. What was not verified

* The git SHA of the exact worker build for each affected date (revision metadata carries no SHA; only HANDOFF's `01153-lir` = `c56ceee03` pin is cited).
* Whether any affected certificate has already been shared outside the org (no telemetry for certificate downloads was checked).
* Behaviour of the pre-PR-#761 producer for the April rows was inferred from the data signature, not from reading that code.

**Jira:** [SCRUM-3953](https://arkova.atlassian.net/browse/SCRUM-3953) (Bug, To Do, labels chain-safety / prod / anchor-lifecycle / data-integrity / tier-t3 / prio-p1).
