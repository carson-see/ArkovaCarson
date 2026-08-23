# FD-CHAIN-1 caps anchoring throughput at one batch per block — observed live

**SCRUM-3151 is not only a silent-halt bug. Under sustained load it imposes a hard
throughput ceiling of one batch per confirmed block, and it is currently blocking this
soak's own Trigger A evidence.**

## What is happening right now (2026-08-17T14:37Z)

| Fact | Value |
|---|---|
| Anchors PENDING | **10,570** — above `BATCH_SIZE` (10,000), Trigger A is armed |
| Last batch tx `2492ab25…` (6,706 anchors, broadcast 14:19:31Z) | **unconfirmed**, still in mempool |
| Treasury UTXO set | **1 UTXO, `confirmed=false`**, 740,753 sat (that batch's change) |
| Signet tip | 318115 — unchanged since the 14:00 batch confirmed |
| 14:30Z batch run | `Treasury has no UTXOs — batch processing will be skipped until funded` |

The treasury is not empty. It holds 740,753 sat. But every satoshi of it sits in the
**unconfirmed change output** of the batch broadcast eleven minutes earlier.

## The mechanism, end to end

1. `listUnspent` calls `rpcCall(..., 'listunspent', [1, 9999999, [address]])` — **minconf=1**.
   Bitcoin Core excludes unconfirmed outputs, so it returns `[]`.
2. The `rpcUtxos.length >= 0` guard is true for every array, so `[]` is returned verbatim
   and the mempool.space fallback — which deliberately includes unconfirmed UTXOs, with the
   comment *"prevents the treasury from getting stuck waiting for confirmations between
   batches"* — is never reached.
3. `hasFunds()` sees length 0, logs `Treasury has no UTXOs`, and `processBatchAnchors`
   returns `emptyResult()` before any trigger is evaluated.

**The trigger logic never runs.** Trigger A cannot fire, no matter how many anchors are
queued, until a block confirms the previous batch's change.

## The consequence: throughput is capped by block time, not by batch cadence

The system is designed to evaluate batching every 30 minutes and to carry up to 10,000
anchors per transaction. With this defect, a second batch can only proceed once the previous
one confirms — so **maximum throughput is one batch per block**, roughly one per 10 minutes
on signet and the same order on mainnet, and it degrades further whenever a block is slow.

The fallback provider exists precisely to remove this coupling. The `>= 0` guard makes it
unreachable, which converts a designed-for-continuous pipeline into a block-synchronous one.

## Why this matters more than the original write-up said

The finding was first characterised as "silent halt when the treasury address is not in the
node's wallet" (SCRUM-3151, BUG-2026-08-16-001) — a configuration-dependent failure. It is
broader than that:

- It fires on a **correctly configured** node. The rig's watch-only wallet *does* track the
  treasury (FD-CHAIN-3 was fixed on 2026-08-16). The address is imported, the balance is
  visible, and it still reports "no UTXOs".
- It fires on the **normal** operating shape of a batching treasury: one unconfirmed change
  output between batches is not an edge case, it is what the system looks like every time it
  has just done its job.
- It is **self-inflicting under load**: the more successfully the system batches, the more
  reliably it blocks its own next batch.

## Evidence status

**Measured:** with 10,570 anchors pending and a funded treasury, the 14:30Z batch run
skipped with `Treasury has no UTXOs` because the sole UTXO was unconfirmed.

**NOT asserted:** Trigger A has still not fired. It is expected to fire on the first `*/30`
cycle after signet block 318116 confirms the change output. That delay is caused by this
defect, and the eventual Trigger A evidence should be read with that caveat — the trigger
works, but reaching it required waiting on a block that the fallback was designed to make
irrelevant.

**Fix:** PR #2250 (head `3d8851463`) replaces the fall-through with a union of the RPC and
mempool legs deduped by `(txid, vout)`, so an unconfirmed change output is visible to the
batcher through the mempool leg even when `minconf=1` hides it from the RPC leg. That PR
closes this ceiling; it is draft and unsoaked.
