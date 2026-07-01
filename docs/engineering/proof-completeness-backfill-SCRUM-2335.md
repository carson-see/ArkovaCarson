# Back-catalogue proof-completeness backfill — design note (SCRUM-2335 / SCRUM-2471)

> Internal engineering note (§4). **Canonical doc is Confluence** — the PROOF-01/02
> page (81330178) + the SCRUM-2335 story page must carry this classification before
> the story can transition Done. This file is the durable in-repo record of the
> reconstructability analysis that drove `services/worker/src/jobs/backfillProofCompleteness.ts`.

## Why this job exists

Migration `0340_scrum2335_proof_completeness_columns_and_trigger.sql` adds five
proof-completeness columns to `anchor_proofs` and a **GUC-gated, default-inert**
constraint trigger `trg_anchors_proof_complete_on_secured`. When the GUC
`arkova.proof_enforce_secured_complete` is flipped to `'on'` (Phase 2, no further
migration), an anchor may only reach `SECURED` if its `anchor_proofs` row has
`merkle_root` **and** `proof_path`.

The ~2.97M anchors that are **already** `SECURED` predate FIX-1 (SCRUM-2471) and have
no app-tree branch persisted. Enabling the trigger before the back catalogue is
filled would reject legitimate historical rows on any status touch. This job is the
backfill that 0340's Phase-2 comment is waiting on.

## Per-column reconstructability (the crux)

For an EXISTING `SECURED` batch anchor, what can each 0340 column be populated from?

| 0340 column | Source | Classification |
|---|---|---|
| `proof_schema_version` | constant `PROOF_SCHEMA_VERSION = 1` (mirrors the 0340 DEFAULT) | **reconstructable (trivial)** |
| `op_return_payload` | stored `anchor_proofs.merkle_root` → `ARKV`(4B) + root(32B) | **reconstructable from stored data** ¹ |
| `block_hash` | injected `ChainHeaderSource.getBlockHeaderForTx(anchors.chain_tx_id)` | **reconstructable via chain fetch** ² |
| `block_header` | same chain fetch (raw 80-byte header) | **reconstructable via chain fetch** ² |
| `merkle_index` | — (leaf index in the original batch tree) | **NOT reconstructable** ³ |

¹ **`op_return_payload` caveat — historical vs. forward shape.** The batch path
submits the *batch Merkle root* to the chain (`submitFingerprint({ fingerprint: tree.root })`
in `batch-anchor.ts`), and `signet.ts` builds the OP_RETURN as `ARKV` + the submitted
32-byte value, with **no version byte**. So the *historical* on-chain payload we can
reconstruct is `ARKV + merkle_root`. 0340's column comment describes the *forward*
PROOF-01 target `ARKV + version(1B) + app_merkle_root(32B)`, which differs by the
version byte. The backfill writes the **honest historical bytes**, not the forward
shape. If Phase-2 verification requires the version-byte form for back-catalogue rows,
that is a separate decision (it would mean asserting bytes that were never on-chain).

² **`block_hash` / `block_header` via chain fetch.** Keyed on the already-stored
`anchors.chain_tx_id`. mempool.space exposes `GET /tx/:txid` (→ `status.block_hash`)
and `GET /block/:hash/header` (→ raw 80-byte header) — see `chain/utxo-provider.ts`,
which already reads `status.block_hash`. The job takes a narrow injected
`ChainHeaderSource` rather than the full `ChainClient` (the base interface has no
header method) so it stays decoupled from the provider. **No real chain calls in this
build or its tests — the source is mocked.** A real implementation is wired only at
execute time (out of scope for this PR).

³ **`merkle_index` is the SCRUM-2471 gap and is NOT reconstructable.** Two independent
reasons, both confirmed by reading the code:
   - `batch-anchor.ts` builds `tree = buildMerkleTree(fingerprints)` but **discards
     `tree.proofs`** — the per-leaf branch + position map is never persisted. Only
     `tree.root` is stored (in `submit_batch_anchors`' `p_merkle_root`).
   - `submit_batch_anchors` (SQL) writes only `chain_tx_id`, `chain_block_height`,
     `chain_timestamp` to `anchors` — **no leaf ordering**. The leaf index was the
     in-memory claim order (`broadcastAnchors.map(a => a.fingerprint)`), which is gone
     once the process exits.

   The leaf index (and the inclusion branch that depends on it) can only be recovered
   by **re-deriving the original ordered batch tree** — i.e. reconstructing the exact
   set *and order* of fingerprints that went into each `batch_id`. We have batch
   *membership* (rows share `batch_id`) but **not the order**, and the tree is
   order-sensitive (sibling pairing is positional). So `merkle_index` cannot be filled
   for the back catalogue without information we do not have.

## What the job does with the unreconstructable column

It **never writes a guessed `merkle_index`.** Rows missing it are tallied under
`summary.unreconstructable.merkleIndex` and counted in
`summary.rowsBlockedOnScrum2471`, and that column is skipped while the
reconstructable columns are still filled. The headline count is logged loudly at the
end of every run (dry-run included).

## Verdict — can the 0340 trigger be enabled by backfill alone?

**No — not by this backfill alone, given the current trigger predicate is
`merkle_root + proof_path`.** `proof_path` (the inclusion branch) is exactly the
data SCRUM-2471 discarded; it is gone for the back catalogue for the same reason
`merkle_index` is. This backfill can make the *chain-derived* half of the bundle
(`block_hash`, `block_header`, `op_return_payload`) and `proof_schema_version`
complete, but it **cannot** synthesize `proof_path`/`merkle_index` for pre-FIX-1
batches.

To turn enforcement ON for the whole table, one of:

1. **SCRUM-2471 forward-fix + re-derivation** — if a future change persists batch
   leaf ordering (e.g. `submit_batch_anchors` records each anchor's index, or
   `anchor_proofs.merkle_index` is written at submit time going forward) AND we can
   re-derive historical batches from an authoritative ordered source, the branch +
   index become reconstructable and this backfill can be extended to fill them. Absent
   a stored order, historical re-derivation is not possible.
2. **Re-anchor path** for the unreconstructable back catalogue (new batch, new branch
   persisted) — heavyweight; treasury + lifecycle implications.
3. **Scope the GUC to a cohort** — enable enforcement only for anchors created at/after
   the FIX-1 cutover (where `proof_path` is persisted), leaving the pre-FIX-1 cohort
   exempt. This needs a trigger-predicate change (a follow-up migration), not just the
   GUC flip 0340 advertises.

The decision among these is a Carson/architecture call and is **out of scope for this
build** — this job surfaces the exact `rowsBlockedOnScrum2471` count that informs it.

## Safety + rollout

- **Dry-run by default**; writes require BOTH `options.execute === true` AND
  `PROOF_BACKFILL_CONFIRM=EXECUTE`.
- **Idempotent** (only NULL completeness columns are touched) + **resumable**
  (created_at cursor advances per batch).
- **Gated behind #1255-on-main** (the 0340 columns must exist in prod) **+ a staging
  rehearsal** on a clean 0340 mirror before any prod execute. This PR **builds + tests
  only** — it is never run here, and it never connects to prod or a real chain.
- T3 (touches data integrity + anchor lifecycle adjacency).
