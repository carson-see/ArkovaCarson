# Trigger D — daily forced flush, proven end-to-end 2026-08-17T03:00Z

**The one batch trigger this window can reach, and it is now proven at 104-anchor scale
with independent on-chain verification.**

## What was proven

The Cloud Scheduler job `…-batch-anchors-forced-flush` (`0 3 * * *`, **UTC** — the log
string says "3am EST" but the schedule is UTC) fired at **03:00:30Z**. Within 12 minutes
the entire backlog drained:

| Before (02:32Z) | After (03:14Z) |
|---|---|
| 101 PENDING / 12 SECURED | **0 PENDING / 116 SECURED** |

104 anchors advanced `PENDING → SUBMITTED → SECURED` in a single transaction. Worker logs
at 03:12:04: `Bulk confirmed anchor group (shared tx)`, `Confirmed anchors`.

## On-chain evidence, verified independently

**txid `fba08120d3fe8be73bdccdfbf857e320c5012db0857c979a6bbe5fa6b87403cc`**

| Source | Result |
|---|---|
| Rig database | `chain_block_height = 318046`, 104 anchors on this tx |
| `mempool.space/signet` | `confirmed=true`, block **318046**, hash `00000004d32dd3d4560b…` |
| `blockstream.info/signet` | `confirmed=true`, block **318046** |

Transaction shape: 239 bytes, **628 sat total fee**, two outputs —
`op_return` (0 sat, the Merkle root covering all 104 anchors) and `v0_p2wpkh` change of
**742,009 sat**, which reconciles exactly against the pre-spend balance
(742,637 − 628 = 742,009 ✓).

**One Merkle root, 104 documents, 628 sat.** That is the batching economics working as
designed — Bitcoin cost tracks broadcast count, not document count.

## Proof materialisation — complete

| Metric | Value |
|---|---|
| `anchor_proofs` rows | **116** |
| Rows with `block_header` at **80 raw bytes** | **116 / 116** |
| SECURED anchors | **116** |
| Coverage | **100%** — every SECURED anchor has a per-document proof |

No false SECUREDs, no missing proofs, no truncated headers.

## A recurrence of FD-CHAIN-1 during the flush — worth recording

At 03:10:01, between broadcast and confirmation, the worker logged again:

```
Treasury has no UTXOs — batch processing will be skipped until funded
Treasury empty — skipping batch anchor processing until funded
```

The treasury was not empty. It held the **unconfirmed change output** of the batch it had
just broadcast. The RPC path calls `listunspent 1 9999999` — **minconf=1** — which excludes
unconfirmed outputs by definition, and the FD-CHAIN-1 `length >= 0` guard then prevents
falling through to the mempool.space provider, whose code comment says explicitly that it
includes unconfirmed UTXOs precisely so "the treasury [does not get] stuck waiting for
confirmations between batches."

So FD-CHAIN-1 (SCRUM-3151) is worse than first characterised. It does not only fail on an
unwatched address — **it also blocks back-to-back batches**, because a node cannot spend
its own unconfirmed change under minconf=1 and the fallback that would handle it is
unreachable. On this rig it self-cleared when the change confirmed (the UTXO now reads
`fba08120…:1, 742,009 sat, confirmed=true`), but under sustained load the window between
batches is exactly when this bites.

This does not affect the result above — the flush completed before the condition appeared.

## Scope of the claim

**Measured:** Trigger D fires on schedule; drains a 104-anchor backlog end-to-end to
SECURED; produces one real signet transaction confirmed at block 318046 on two independent
explorers; materialises a per-document 80-byte-header proof for every anchor.

**NOT asserted:** Trigger A (needs 10,000 pending) and Trigger B (needs 3,000) did **not**
fire and cannot fire this window — the FREE-tier per-org daily cap of 100 anchors makes
those thresholds unreachable. See `batch-trigger-coverage.md` and
`FD-RL-quota-headers-and-counter.md`.
