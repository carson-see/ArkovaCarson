-- 0427_proof_tx_inclusion_branch.sql
-- R1 — persist the BITCOIN-tree inclusion branch (tx -> block merkleroot) and
-- the transaction's index within its block on anchor_proofs.
--
-- `services/worker/src/chain/confirmation-proof.ts` already fetches, parses and
-- VALIDATES both values (`ConfirmationProof.merkleBranch` / `.txIndex`) on every
-- confirmation pass, and `confirmation-proof-populate.ts` then persisted only
-- `block_header` + `block_hash` and dropped them. A census of prod
-- `anchor_proofs.raw_response` found 0 rows carrying either, and there was no
-- column for them: the evidence was recomputed and thrown away every run.
--
-- WHY IT MATTERS: without the branch, a holder's verifier can prove the app-tree
-- half offline (`merkle_root` + `proof_path` + `merkle_index`, migration 0340)
-- but must ask a Bitcoin node for an inclusion proof to close the second half —
-- tx committed by the block's merkleroot. That is precisely the third-party
-- dependency the self-contained PROOF-05 bundle exists to remove. Storing what
-- we already fetched makes transaction-inclusion checkable LOCALLY.
--
-- TWO TREES, TWO CONVENTIONS — the reason for the names.
--   Layer 1, APP tree:     proof_path / merkle_index  (existing, migration 0340)
--   Layer 2, BITCOIN tree: tx_inclusion_branch / tx_block_index  (this file)
-- Both are `{hash, position}[]`, but they are NOT interchangeable: the bitcoin
-- tree hashes with Bitcoin's double-SHA256 over BYTE-REVERSED (display) hex and
-- duplicates the last node on odd rows. Naming this column `merkle_proof` would
-- invite a verifier to fold one tree with the other's rule and silently check
-- nothing. The names are deliberately distinct, and the byte orientation is
-- stated in the column comments below.
--
-- ADDITIVE + NULLABLE (Constitution §1.8): no rewrite of the ~existing rows, no
-- `proof_schema_version` bump, and the verify API keeps its frozen shape — the
-- two new bundle fields are nullable additions that are NEVER fabricated when
-- absent. Back-catalogue rows simply carry NULL until the populate pass fills
-- them in.
--
-- NO CHECK CONSTRAINT, deliberately: a validating CHECK on `tx_block_index`
-- would take ACCESS EXCLUSIVE and scan every existing row to prove a property
-- that is vacuously true (all existing values are NULL). That is the same
-- barrier-forming shape §1.2 exists to prevent, bought for nothing. The writer
-- (`utils/anchorProofs.ts` — `isCoherentInclusionPair`) and the reader
-- (`api/v1/verify-proof.ts` — `readTxInclusionEvidence`) both validate the pair
-- and reject anything malformed as NULL, applying the IDENTICAL rules: both
-- halves present or neither, every sibling exactly 64 hex characters,
-- 0 <= index < 2^branch_length, and each level's sibling side matching that
-- level's bit of the index. That sentence was aspirational when this file was
-- first written — the writer validated nothing at all — and is now true on both
-- sides; if either check is removed, this paragraph has to go with it.
--
-- ROLLBACK:
--   ALTER TABLE public.anchor_proofs
--     DROP COLUMN IF EXISTS tx_inclusion_branch,
--     DROP COLUMN IF EXISTS tx_block_index;
--   NOTIFY pgrst, 'reload schema';

BEGIN;

-- §1.2 / K5: bound the lock wait. Postgres lock queues are FIFO, so an
-- unbounded ALTER that blocks on a long reader parks itself at the head of the
-- queue and every later lock request — including PostgREST's schema-cache
-- introspection — queues behind it. That is the 2026-08-11 P0 mechanism
-- (11m39s of service_unavailable on /api/v1/verify from one ALTER TABLE).
-- `anchor_proofs` is not one of the three tables the CI linter treats as hot,
-- but it is written by every anchoring batch and read by every /proof call, so
-- it gets the same one-line guard rather than an argument about the list.
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Bitcoin-tree inclusion columns (additive, nullable).
-- ---------------------------------------------------------------------------
-- ADD COLUMN of a nullable column with no default is metadata-only in Postgres
-- 11+ — no table rewrite, so the ACCESS EXCLUSIVE lock is held only long enough
-- to update the catalog.
ALTER TABLE public.anchor_proofs
  ADD COLUMN IF NOT EXISTS tx_inclusion_branch jsonb,
  ADD COLUMN IF NOT EXISTS tx_block_index integer;

COMMENT ON COLUMN public.anchor_proofs.tx_inclusion_branch IS
  'Layer-2 BITCOIN-tree inclusion branch: the sibling path proving this anchor''s transaction is committed by the merkleroot inside block_header. Shape matches proof_path — [{"hash": <64-hex>, "position": "left"|"right"}, ...] ordered leaf->root — but the CONVENTION DIFFERS and the two are not interchangeable. Hashes are BYTE-REVERSED (display/big-endian) hex, the same orientation as a txid or a block hash on an explorer. To verify: reverse the txid and each sibling to internal little-endian bytes, then fold leaf->root with node = SHA256(SHA256(position="right" ? node||sibling : sibling||node)); reverse the final 32 bytes back to display hex and compare to the merkleroot at block_header bytes [36,68) (also byte-reversed). An empty array is a COMPLETE branch, not a missing one: a block whose only transaction is this one has no siblings. NULL = not yet populated; never fabricated (Constitution §1.5). Contrast proof_path, which is the layer-1 APP tree over document fingerprints in their stored orientation.';

COMMENT ON COLUMN public.anchor_proofs.tx_block_index IS
  'Layer-2 BITCOIN-tree: 0-based index of this anchor''s transaction within its block, as recovered from the partial merkle tree (gettxoutproof / Electrum position). Pairs INDIVISIBLY with tx_inclusion_branch — the writer refuses to persist either half alone, and the reader publishes both or neither. The index supplies the left/right bit at each level, so a verifier can re-derive the fold order independently of the stored positions and reject a branch that disagrees; the API runs exactly that cross-check before publishing the pair. It does NOT arm the CVE-2012-2459 duplicate-node guard: deciding whether a self-pairing sibling sits at a legitimate rightmost-odd position needs the block''s TOTAL TRANSACTION COUNT (row width = ceil(totalTx / 2^height)), which is parsed at fetch time but neither returned from parseTxOutProof nor stored here — so no read-side consumer can run that guard from this column. It is enforced on the WRITE side instead, where the count is in hand. 0 is a real value (the coinbase position), not a blank. NULL = not yet populated. Contrast merkle_index, which is the leaf index in the layer-1 APP tree.';

-- Reload PostgREST schema cache so the new columns are visible to the API.
NOTIFY pgrst, 'reload schema';

COMMIT;
