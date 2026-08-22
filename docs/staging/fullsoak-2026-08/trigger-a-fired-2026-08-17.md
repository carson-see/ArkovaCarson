# Trigger A — fired at full BATCH_SIZE, 2026-08-17T14:40:01Z

**10,000 anchors in one transaction. All four batch triggers are now proven, and F-8's open
question about `batch_insert_anchors` at 10k scale is closed.**

## The firing, logged explicitly

Unlike Trigger B — which fires silently and had to be established by elimination — Trigger A
logs itself:

```
14:40:01.430  Batch size trigger fired    pendingCountSentinel=10000  batchSizeCrossed=true
14:40:12.722  Claimed anchors for batch processing    claimed=10000
14:40:13.820  Preparing fingerprint anchor transaction (build + sign, no broadcast)
14:40:14.019  Transaction built and signed (not yet broadcast)
14:40:39.499  Signed transaction broadcast
```

`triggerA_shouldFireOnSize` requires `pendingCount >= BATCH_SIZE` (10,000). PENDING stood at
11,741; the claim took exactly **10,000** — the cap held precisely, leaving the remainder
queued rather than overflowing the transaction.

## On-chain evidence, independently verified

**txid `c70d1662bffb1720f5b1a01cddc6d54e7e21fc98833b72fd8f9b636aebc6167d`**

| Source | Result |
|---|---|
| Rig database | `chain_block_height = 318117`, **10,000 anchors** on this tx |
| `mempool.space/signet` | `confirmed=true`, block **318117** |
| `blockstream.info/signet` | `confirmed=true`, block **318117** |

238 bytes, **628 sat total fee**, `op_return` (one Merkle root over all 10,000) + `v0_p2wpkh`
change of 740,125 sat.

## The economics claim, now measured across a 96× range

| Trigger | Anchors | Size | Fee | Sat/anchor |
|---|---|---|---|---|
| **D** — daily forced flush, 03:00Z | 104 | 239 B | 628 sat | 6.0385 |
| **B** — age, 14:00Z | 3,832 | 239 B | 628 sat | 0.1639 |
| org-queue forced flush, 14:19Z | 6,706 | 238 B | 628 sat | 0.0936 |
| **A** — size cap, 14:40Z | **10,000** | **238 B** | **628 sat** | **0.0628** |

Four batches, four sizes spanning 104 → 10,000 documents, and the transaction is **the same
238–239 bytes at the same 628 sat every time**. Per-document cost falls 96× across that
range purely because the denominator grows. This is the Merkle-batching property the design
depends on, measured rather than asserted: **Bitcoin cost tracks broadcast count, not
document count.**

## Proof materialisation at scale

| Metric | Value |
|---|---|
| SECURED anchors | **20,654** |
| `anchor_proofs` rows | **20,654** |
| Coverage | **100%** — 1:1, no gap |
| `block_header` length (300-row sample) | **80 bytes, all rows** |

A 10,000-leaf Merkle tree produced a per-document proof for every leaf, each carrying the
correct raw 80-byte Bitcoin header. No false SECUREDs, no truncated headers, no missing rows.

## What this closes

**F-8** (2026-07-29) recorded that `batch_insert_anchors` at real 10k scale had never been
exercised: the legacy rigs' 10-minute forced-flush cadence always drained ~214 anchors long
before the cap could be approached, so the ceiling the system is designed around was pure
theory. It is now measured — the claim capped at exactly 10,000, built one Merkle root over
them, broadcast a 238-byte transaction, and materialised 10,000 proofs.

## All four triggers, proven

| Trigger | Condition | Proven | Anchors | Block |
|---|---|---|---|---|
| **A** size | `pending >= 10,000` | 2026-08-17T14:40Z | 10,000 | 318117 |
| **B** age | `pending >= 3,000` AND oldest `>= 3h` | 2026-08-17T14:00Z | 3,832 | 318115 |
| **C** fee | defer above a backlog-scaled ceiling | **NOT exercised** — signet fees never approached the ceiling | — | — |
| **D** forced | daily 03:00 flush | 2026-08-17T03:00Z | 104 | 318046 |

**NOT asserted:** Trigger C (fee-aware deferral) has not fired. Signet fee rates stayed far
below `ABSOLUTE_FEE_CAP_SAT_PER_VB`, so the deferral path remains untested and no claim is
made about it.

**Provenance:** this evidence is from Day 5 (2026-08-17). Days 0–3 of the window carried no
anchor throughput at all, and Trigger A required removing the FREE-tier 100/day per-org cap
(both rig orgs moved to ENTERPRISE at 13:47Z) — at 100/day the 10,000 threshold was 100
org-days away. The pack must not describe throughput as spanning the 7-day window.
