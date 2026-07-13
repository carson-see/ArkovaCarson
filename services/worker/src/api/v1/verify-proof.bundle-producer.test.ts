/**
 * S3-P0 (batch producer) — /proof completeness contract.
 *
 * Pins that a row written EXACTLY the way the S3-P0 producer writes it
 * (app-tree branch + merkle_index + batch_id + op_return_payload = "ARKV"‖root
 * with NO version byte, bytea `\x` wire shape) plus the PROOF-03 confirmation
 * columns (block_header/block_hash) yields a COMPLETE, non-null `proof_bundle`
 * from buildProofResponse — i.e. "/proof stops being empty" once the producer
 * + confirmation-proof backfill have both run.
 */

import { describe, it, expect } from 'vitest';
import { buildMerkleTree } from '../../utils/merkle.js';
import { buildProofResponse, type MerkleProofResponse } from './verify-proof.js';

const FP_A = 'aa'.repeat(32);
const FP_B = 'bb'.repeat(32);
const FP_C = 'cc'.repeat(32);

// Bitcoin genesis block header — a REAL 80-byte header (160 hex).
const GENESIS_HEADER =
  '0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c';
const GENESIS_HASH = '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f';

describe('S3-P0 — producer-written rows produce a COMPLETE proof_bundle', () => {
  const tree = buildMerkleTree([FP_A, FP_B, FP_C]);

  const anchor = {
    public_id: 'ARK-2026-S3P0',
    fingerprint: FP_A,
    status: 'SECURED',
    chain_tx_id: 'f1'.repeat(32),
    chain_block_height: 800100,
    chain_timestamp: '2026-07-06T00:00:00.000Z',
    metadata: null,
  };

  // EXACT producer write shape after PROOF-03 confirmation populate:
  // op_return_payload/block_header read back from PostgREST as \x-prefixed hex.
  const producerRow = {
    merkle_root: tree.root,
    proof_path: tree.proofs.get(FP_A),
    batch_id: 'batch_1751760000000_3',
    merkle_index: 0,
    block_header: `\\x${GENESIS_HEADER}`,
    block_hash: GENESIS_HASH,
    op_return_payload: `\\x41524b56${tree.root}`,
    proof_schema_version: 1,
  };

  it('returns verified=true with a non-null, fully-populated proof_bundle', () => {
    const result = buildProofResponse(anchor, producerRow, 3, false) as MerkleProofResponse;

    expect(result).not.toBeNull();
    expect('error' in result).toBe(false);
    expect(result.verified).toBe(true);
    expect(result.proof_bundle).not.toBeNull();
    expect(result.proof_bundle).toMatchObject({
      fingerprint: FP_A,
      merkle_root: tree.root,
      merkle_index: 0,
      leaf_count: 3,
      tx_id: anchor.chain_tx_id,
      block_hash: GENESIS_HASH,
      block_header: GENESIS_HEADER,
      op_return_payload: `41524b56${tree.root}`,
      proof_schema_version: 1,
      signature: null,
    });
  });

  it('bundle is null when the producer has written the app-tree but confirmation has not landed yet (honest incompleteness)', () => {
    const preConfirmation = { ...producerRow, block_header: null, block_hash: null };
    const result = buildProofResponse(anchor, preConfirmation, 3, false) as MerkleProofResponse;

    expect(result.verified).toBe(true); // app-tree recompute still passes
    expect(result.proof_bundle).toBeNull(); // never a fabricated header
  });
});
