---
name: project-proof-block-height-provenance
description: A published proof's block_height comes from anchors.chain_block_height; anchor_proofs.block_height is the broadcast-time chain tip and was wrong on 99.6% of prod rows (SCRUM-3953)
metadata:
  type: project
---

Arkova has **two** block-height columns. They are not interchangeable.

| Column | What it is | Trust |
|---|---|---|
| `anchors.chain_block_height` | The mined block's height, written at confirmation by `check-confirmations.ts` -> `drain_submitted_to_secured_for_tx` from the tx's real `status.block_height` | **Authoritative** |
| `anchor_proofs.block_height` | The chain **tip at broadcast** (`broadcastSignedTx` -> `getBlockchainInfo().blocks`) | Broadcast-time value until measured confirmation repair or migration `0443`; this PR does not establish production application |

**Measured on prod `vzwyaatejekddvltxyye`, 2026-09-02, read-only:** 711,027 of 713,949
`anchor_proofs` rows disagreed with `anchors.chain_block_height`, **100% of them low**, by exactly
the number of blocks mined between broadcast and confirmation (1: 45%, 2: 36%, 3: 12%, tail to 13,
plus an 89-row cluster at 2,747 from the 2026-04-15 -> 04-29 SECURED gap). Ground truth came from
`getblockheader` over the production GetBlock RPC for all 44 block hashes that carried more than one
recorded height: `anchors.chain_block_height` matched the chain in **44/44**, and in **34** of those
44 groups *neither* `anchor_proofs` value was the real height.

**Why it was invisible.** `ConfirmationProof` carried no height field at all — `blockHeight` existed
only as an *input*, documented "informational" — so the confirmation pass wrote
`anchor.blockHeight ?? null`, the stale value onto itself. `anchors` was corrected; `anchor_proofs`
never was. Because each anchor kept its OWN broadcast tip, several batches landing in one block gave
that block's hash several different heights, which is how the drift surfaced at all.

**Why:** the certificate PDF's embedded machine-readable packet published this height beside a
`block_hash`/`block_header` read from the confirmed chain, and every Arkova verifier binds the height
to the chain and hard-rejects a mismatch (`arkova-py` `_height_binding_failure`,
`packages/verifier/src/independent-node.ts`, `packages/verifier-cli`). A genuine, correctly anchored
document therefore verified as `ok: false, reason_code: HEIGHT_MISMATCH` — a false negative in the
exact shape of the repo's own forgery fixture. `/api/v1/proof`, `audit-export.ts` and the JSON proof
package always read from `anchors` and were never affected.

**How to apply:** source a published `block_height` from `anchors.chain_block_height` only when
its `chain_block_hash` matches the proof's `block_hash`. `proofBlockMetadata.ts`
implements that binding for both certificate readers: known mismatches withhold
the packet; missing identities retain existing proof metadata without claiming
a new measurement. RecordDetailPage carries the anchor block hash through both
reader calls. Only a height
that came back from the chain at confirmation may be written to `anchor_proofs.block_height` —
`undefined` means "leave the column alone", never "rewrite what is already there". CI enforces the
publication order via `scripts/ci/feedback-rules/proof-block-height-source.ts` (override label
`proof-block-height-reviewed`). This defect can make a proof's height and `block_hash` disagree.
Check provenance and reorg state before attributing a particular mismatch to it. See [[project-bitcoin-signing-paths]] and
[[feedback-verification-must-outrank-the-claim]].
