# Supplementary proof anchor — operator runbook

**Story:** SCRUM-3188 · **Tier:** T3 (migration + chain + treasury) · **Numbers measured against prod `vzwyaatejekddvltxyye` and Bitcoin mainnet on 2026-08-11.**

> Internal engineering notes. The auditor-facing page is the Confluence On-Chain
> Policy page; update it from here (CLAUDE.md §0 rule 4).

> **Nothing in this PR runs against prod, and nothing broadcasts.** The job
> defaults to dry run. The operator executes; the code refuses to act on its own.

---

## 1. What this is, and what it deliberately is not

2,969,630 SECURED anchors hold a **real** first attestation on Bitcoin but no
per-document Merkle branch, because the Mar/Apr producer never persisted the
committed leaf order. For batches larger than 8 leaves that order is
unrecoverable, so those records can never be given an offline branch against
their **original** transaction. PR #2130 recovers the 608 records where the
order *is* searchable and honestly classes the rest `unreconstructible_order`.
This is the complementary path for the remainder.

**It is a SECOND transaction, not a re-attestation.** The original
`chain_tx_id`, `chain_timestamp`, `chain_block_height` and `chain_block_hash`
are never written. HakiChain's `ARK-2026-8F862179` keeps
`05dd1f1dfea903f469533ce2ebaa12a630fd034751d87452e4f617b1ed379656`, block
955,960, 2026-06-29 — and gains a verifiable branch from a new 2026-08
transaction. The public record must state **both**:

> First committed 2026-06-29 (block 955,960). Per-document proof available from
> \<supplementary tx\>, \<date\>.

Presenting the supplementary transaction as the first commitment would
backdate-shift the record and destroy the evidence the product sells. That is a
worse defect than the missing proof, which is why it is prevented in four
independent places (§5).

---

## 2. Treasury: can we afford it? **Yes.**

Read live on 2026-08-11 from the treasury address
`bc1qtm2kk33k6ht4agt48kh7rfkmmhfkapqn4zwerc` (derived from a real anchoring
transaction's input — no key material was accessed):

| Measure | Value |
|---|---|
| Confirmed balance | **413,658 sats** (0.00413658 BTC) |
| Confirmed UTXOs | 2 (326,890 + 86,140 sats) |
| Measured tx vsize | **156.25 vB** (1-in, 2-out: OP_RETURN `ARKV`+root, P2WPKH change) |
| Current fees | 1 sat/vB economy · 3 sat/vB fastest |

At batches of 10,000 the backlog is **297 transactions**. Cost is per
**transaction** — one Merkle root commits unlimited leaves — so batch size drives
cost, not document count.

| Fee rate | sats/tx | Total | % of treasury | Left over |
|---|---|---|---|---|
| 1 sat/vB | 157 | **46,629** | 11.3% | 367,029 |
| 2 sat/vB | 313 | 92,961 | 22.5% | 320,697 |
| **3 sat/vB** | **469** | **139,293** | **33.7%** | **274,365** |
| 5 sat/vB | 782 | 232,254 | 56.1% | 181,404 |
| 10 sat/vB | 1,563 | 464,211 | **112.2%** | **-50,553** |

**Verdict: affordable at current fees.** A full run at 3 sat/vB costs 139,293
sats (~$153 at $110k/BTC) and leaves 274,365 sats. **Break-even is ~8.9 sat/vB** —
above that the treasury cannot fund the whole backlog, which is why the job
carries a fee ceiling (default 5 sat/vB) and a treasury reserve (default 100,000
sats) and re-checks both before **every** batch. It halts at the reserve floor
with partial progress rather than draining the wallet production anchoring
shares.

### Why 10,000 and not 50,000

50k batches would need 60 transactions instead of 297, saving ~111,000 sats
(~$120) across the entire backlog. Getting there means widening **both**
`config.ts:247` `batchAnchorMaxSize` (a Zod `.max(10000)` — exceeding it makes
the worker **refuse to boot in production**) and the `Math.min(…, 10000)` clamp
at `batch-anchor.ts:46`. That is a change to the live money path to save ~$120,
with coarser crash-resume granularity. **Not worth it.** This job carries its
own independent batch cap and does not touch the production constant.

---

## 3. Preconditions

1. Migration `0408_supplementary_proof_anchor.sql` applied to **staging first**,
   then prod, then the ledger reconciled to the numeric prefix (CLAUDE.md §0
   rule 10).
2. Worker deployed at or after the merge commit — confirm via `/health`
   `git_sha`, and check `gh variable get DEPLOY_WORKER_PAUSED` is not `true`.
3. Treasury confirmed balance re-read at run time (§2 numbers are from
   2026-08-11 and go stale).
4. No production anchoring drain in flight — the nightly 3am batch spends from
   the same wallet and the same UTXO set.
5. Mempool ancestry: Bitcoin Core's default limit is **25 unconfirmed
   ancestors/descendants**. A self-chaining run must not exceed ~20 unconfirmed
   transactions; keep `pauseBetweenBatchesMs` at its default and cap
   `maxBatches` per session, or let confirmations land between sessions.

---

## 4. Running it

### 4.1 Dry run first — always

Dry run signs nothing, broadcasts nothing, journals nothing and writes nothing.
It reports exactly what a real run would spend and commit.

```bash
curl -s -X POST "$WORKER_URL/jobs/supplementary-proof-anchor" \
  -H "X-Cron-Secret: $CRON_SECRET" \
  -H 'content-type: application/json' \
  -d '{"dryRun": true, "batchSize": 20000}' | jq
```

Expected output shape:

```json
{
  "dryRun": true,
  "remaining": 2969630,
  "estimate": {
    "anchorCount": 2969630,
    "batchSize": 20000,
    "transactions": 149,
    "feeRateSatVb": 3,
    "satsPerTx": 469,
    "totalSats": 69881,
    "totalBtc": 0.00069881
  },
  "previewRoot": "<the root batch 1 WOULD commit>",
  "batchesCompleted": 0,
  "anchorsProven": 0,
  "satsSpent": 0,
  "stoppedReason": "dry run — nothing signed, nothing broadcast, nothing written"
}
```

Check before going live: `transactions` × `satsPerTx` == `totalSats`;
`totalSats` is well under the confirmed balance minus the reserve;
`feeRateSatVb` is at or below the ceiling.

### 4.2 Real run — customers first

Prioritisation is operator-supplied, not hardcoded. HakiChain first, then other
paying orgs, and the bulk public-records ingestion (`PUBLICATION`, `SEC_FILING`
— the great majority of the backlog) last.

```bash
curl -s -X POST "$WORKER_URL/jobs/supplementary-proof-anchor" \
  -H "X-Cron-Secret: $CRON_SECRET" \
  -H 'content-type: application/json' \
  -d '{
        "dryRun": false,
        "batchSize": 20000,
        "maxBatches": 5,
        "feeCeilingSatVb": 5,
        "treasuryReserveSats": 100000,
        "priorityOrgIds": ["f52cd07a-6d8a-4387-9346-23babec84e5c"],
        "deprioritizedCredentialTypes": ["PUBLICATION", "SEC_FILING"]
      }' | jq
```

Start with `maxBatches: 1`. Verify that batch by hand (§6) before widening.

### 4.3 Resuming

The job is resumable and idempotent by construction: `claim_supplementary_proof_cohort`
only returns SECURED anchors that have **no** proof row **and** no live journal,
so a completed batch is never re-served. Re-issue the same call to continue.

---

## 5. How the four hazards are prevented

**Never overwrites the original attestation.**
- The job's `SupplementaryPorts` interface contains no capability to write to
  `anchors` (`jobs/supplementary-proof-anchor.ts`); a test asserts the absence.
- `insert_supplementary_proofs` only INSERTs into `anchor_proofs`, and
  **re-derives** `supplements_chain_tx_id` from `anchors.chain_tx_id` instead of
  trusting the caller.
- `supplementary_anchor_journal` is a **separate table** from
  `anchor_txid_journal` precisely because the latter's recovery sweep writes
  `anchors.chain_tx_id` on ADOPT — pointing supplementary runs at it would let
  that sweep overwrite 2.97M original attestations.
- TLA invariant `supplementaryRequiresOriginalAttestation`.

**Never broadcasts twice.** Sign → journal → broadcast, never reordered.
`supp_journal_live_txid_unique` and `supp_journal_live_batch_unique` make a live
txid or batch unrepeatable. A crash between sign and broadcast is resolved by
exact-txid replay detection (`EXACT_REPLAY` ⇒ defer, do **not** broadcast). An
ambiguous broadcast (timeout/5xx) **HOLDs and stops the run** — it never REVERTs,
because "we do not know" is not "it did not happen".

**Never writes an unverified proof.** The committed root is read back from the
transaction's OP_RETURN **on-chain** (`extractAnchorFingerprint` semantics), and
`buildVerifiedSupplementaryProofRows` re-verifies **every** branch against that
root before any row is constructed. No best-effort mode, no skip flag. Batch-of-1
is not exempt.

**Never drains the treasury.** Fee ceiling + treasury reserve, re-evaluated
before every batch.

---

## 6. Verifying a generated proof by hand

```bash
TX=<supplementary tx id>
curl -s "https://mempool.space/api/tx/$TX" \
  | python3 -c "import json,sys; [print(v['scriptpubkey'][12:]) for v in json.load(sys.stdin)['vout'] if v['scriptpubkey'].startswith('6a')]"
# OP_RETURN = 'ARKV'(41524b56) + the 32-byte root.
```

That root must equal `anchor_proofs.merkle_root`, and
`verifyMerkleProof(anchors.fingerprint, proof_path, root)` must be true.

Then confirm the original attestation is intact — this is the check that matters
most:

```sql
SELECT a.public_id,
       a.chain_tx_id        AS original_attestation,   -- MUST be unchanged
       a.chain_block_height AS original_block,
       a.chain_timestamp    AS first_committed,
       p.receipt_id         AS supplementary_tx,
       p.is_supplementary,
       p.supplements_chain_tx_id,
       p.proof_completeness_class
FROM anchors a JOIN anchor_proofs p ON p.anchor_id = a.id
WHERE p.is_supplementary = true
LIMIT 20;
```

`original_attestation` must equal `supplements_chain_tx_id` and must **differ**
from `supplementary_tx`. If they are ever equal, stop the run.

---

## 7. Rollback

The migration's `-- ROLLBACK:` block drops the functions, the two new tables and
the two `anchor_proofs` columns. Note what rollback does **not** undo: Bitcoin
transactions already broadcast are permanent. That is acceptable — they are
additive commitments that harm nothing — but it means **the migration is
reversible and the spend is not**. Rehearse on staging, and start prod with
`maxBatches: 1`.

To retract proofs written by a run without dropping the columns:

```sql
DELETE FROM anchor_proofs WHERE is_supplementary = true AND batch_id = '<journal id>';
```

---

## 8. Known follow-ups

1. The verify API must render both facts (§1). Until it does, the data is
   correct and honest but the public surface does not yet express it — do not
   claim per-document verification for these records before that ships.
2. `proof-backcatalog-classifier.ts:4-6` still asserts the back-catalogue is
   "DIRECT-anchored … there is NO Merkle tree", which is false (measured: 2,054
   transactions carry >8 leaves). Inherited from PR #2130's findings; unchanged
   here.
3. Class C records remain `unreconstructible_order` until a supplementary run
   covers them. That state is truthful and must stay visible.
