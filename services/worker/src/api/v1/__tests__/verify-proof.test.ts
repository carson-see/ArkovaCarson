/**
 * BTC-003: Merkle Proof Verification Endpoint Tests
 *
 * SCRUM-2490 (PROOF-VERIFY): `verified` is now the result of cryptographically
 * recomputing the Merkle root from the stored branch, NEVER derived from
 * `anchors.status`. Fixtures use REAL fingerprints/branches/roots produced by
 * buildMerkleTree so the verdict is genuine.
 */

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { buildProofResponse, verifyProofRouter } from '../verify-proof.js';
import type { ProofLookup, ProofAnchorData, MerkleProofResponse } from '../verify-proof.js';
import { buildMerkleTree } from '../../../utils/merkle.js';

/** Build a test app with injected lookup */
function buildApp(lookup: ProofLookup) {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { _testLookup: ProofLookup })._testLookup = lookup;
    next();
  });
  app.use('/', verifyProofRouter);
  return app;
}

const fp = (seed: string) => createHash('sha256').update(seed).digest('hex');

// A real 3-leaf batch tree so the recompute-and-compare verdict is genuine.
const LEAVES = [fp('rec-a'), fp('rec-b'), fp('rec-c')];
const TREE = buildMerkleTree(LEAVES);
const REC_FP = LEAVES[0];
const REC_BRANCH = TREE.proofs.get(REC_FP)!;
const MOCK_PROOF = REC_BRANCH;

const ANCHORED_RECORD: ProofAnchorData = {
  public_id: 'ARK-2026-TEST-001',
  fingerprint: REC_FP,
  status: 'SECURED',
  chain_tx_id: 'tx_abc123',
  chain_block_height: 12345,
  chain_timestamp: '2026-03-24T00:00:00Z',
  metadata: {
    merkle_proof: MOCK_PROOF,
    merkle_root: TREE.root,
    merkle_index: 0,
    batch_id: 'batch_1711234567890_5',
  },
};

describe('BTC-003: GET /verify/:publicId/proof', () => {
  it('returns merkle proof for a batch-anchored record (verified by recomputation)', async () => {
    const lookup: ProofLookup = {
      lookupByPublicId: vi.fn().mockResolvedValue(ANCHORED_RECORD),
    };
    const app = buildApp(lookup);

    const res = await request(app).get('/ARK-2026-TEST-001/proof');

    expect(res.status).toBe(200);
    const body = res.body as MerkleProofResponse;
    expect(body.public_id).toBe('ARK-2026-TEST-001');
    expect(body.fingerprint).toBe(REC_FP);
    expect(body.merkle_root).toBe(TREE.root);
    expect(body.merkle_proof).toEqual(MOCK_PROOF);
    expect(body.tx_id).toBe('tx_abc123');
    expect(body.block_height).toBe(12345);
    expect(body.batch_id).toBe('batch_1711234567890_5');
    expect(body.verified).toBe(true); // cryptographic — branch recomputes to root
  });

  it('SCRUM-2490: verified is cryptographic — a SUBMITTED anchor with a recomputing branch is verified=true; status alone never drives it', async () => {
    // Same valid proof, status SUBMITTED — verdict comes from the branch, not status.
    const submitted: ProofAnchorData = { ...ANCHORED_RECORD, status: 'SUBMITTED' };
    const lookup: ProofLookup = {
      lookupByPublicId: vi.fn().mockResolvedValue(submitted),
    };
    const app = buildApp(lookup);

    const res = await request(app).get('/ARK-2026-TEST-001/proof');
    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);

    // And a SECURED anchor whose branch does NOT recompute is verified=FALSE,
    // proving status is not the driver (the K1 kill-shot is closed).
    const securedBadProof: ProofAnchorData = {
      ...ANCHORED_RECORD,
      status: 'SECURED',
      metadata: { merkle_proof: MOCK_PROOF, merkle_root: fp('unrelated'), merkle_index: 0 },
    };
    const lookup2: ProofLookup = { lookupByPublicId: vi.fn().mockResolvedValue(securedBadProof) };
    const res2 = await request(buildApp(lookup2)).get('/ARK-2026-TEST-001/proof');
    expect(res2.status).toBe(200);
    expect(res2.body.verified).toBe(false);
  });

  it('returns verified=false for PENDING status', async () => {
    const pending: ProofAnchorData = {
      ...ANCHORED_RECORD,
      status: 'PENDING',
      chain_tx_id: null,
      chain_block_height: null,
      // PENDING anchors carry no real proof — branch does not recompute.
      metadata: { merkle_proof: MOCK_PROOF, merkle_root: fp('pending-root'), merkle_index: 0 },
    };
    const lookup: ProofLookup = {
      lookupByPublicId: vi.fn().mockResolvedValue(pending),
    };
    const app = buildApp(lookup);

    const res = await request(app).get('/ARK-2026-TEST-001/proof');
    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(false);
    expect(res.body.tx_id).toBeNull();
  });

  it('returns 404 for non-existent record', async () => {
    const lookup: ProofLookup = {
      lookupByPublicId: vi.fn().mockResolvedValue(null),
    };
    const app = buildApp(lookup);

    const res = await request(app).get('/ARK-NONEXIST/proof');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Record not found');
    // Additive machine-readable discriminator (§1.8) — a stale/unknown publicId.
    expect(res.body.proof_error_code).toBe('RECORD_NOT_FOUND');
  });

  it('returns 404 when record has no merkle proof', async () => {
    const noProof: ProofAnchorData = {
      ...ANCHORED_RECORD,
      metadata: {},
    };
    const lookup: ProofLookup = {
      lookupByPublicId: vi.fn().mockResolvedValue(noProof),
    };
    const app = buildApp(lookup);

    const res = await request(app).get('/ARK-2026-TEST-001/proof');
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('No Merkle proof available');
    // Additive machine-readable discriminator (§1.8) — the honest state-2 signal.
    expect(res.body.proof_error_code).toBe('NO_BATCH_PROOF');
  });

  it('returns 404 when metadata is null', async () => {
    const nullMeta: ProofAnchorData = {
      ...ANCHORED_RECORD,
      metadata: null,
    };
    const lookup: ProofLookup = {
      lookupByPublicId: vi.fn().mockResolvedValue(nullMeta),
    };
    const app = buildApp(lookup);

    const res = await request(app).get('/ARK-2026-TEST-001/proof');
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('No Merkle proof available');
    // Additive machine-readable discriminator (§1.8) — the honest state-2 signal.
    expect(res.body.proof_error_code).toBe('NO_BATCH_PROOF');
  });

  it('returns 500 for malformed proof data', async () => {
    const badProof: ProofAnchorData = {
      ...ANCHORED_RECORD,
      metadata: {
        merkle_proof: [{ invalid: true }],
        merkle_root: 'rootabc',
      },
    };
    const lookup: ProofLookup = {
      lookupByPublicId: vi.fn().mockResolvedValue(badProof),
    };
    const app = buildApp(lookup);

    const res = await request(app).get('/ARK-2026-TEST-001/proof');
    expect(res.status).toBe(500);
    expect(res.body.error).toContain('malformed');
    expect(res.body.proof_error_code).toBeUndefined();
  });

  it('returns 400 for short publicId', async () => {
    const lookup: ProofLookup = {
      lookupByPublicId: vi.fn().mockResolvedValue(null),
    };
    const app = buildApp(lookup);

    const res = await request(app).get('/ab/proof');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid publicId');
    expect(res.body.proof_error_code).toBeUndefined();
  });

  it('handles lookup errors gracefully', async () => {
    const lookup: ProofLookup = {
      lookupByPublicId: vi.fn().mockRejectedValue(new Error('DB down')),
    };
    const app = buildApp(lookup);

    const res = await request(app).get('/ARK-2026-TEST-001/proof');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Internal server error');
    expect(res.body.proof_error_code).toBeUndefined();
  });

  it('returns null batch_id when not in metadata', async () => {
    const noBatch: ProofAnchorData = {
      ...ANCHORED_RECORD,
      metadata: {
        merkle_proof: MOCK_PROOF,
        merkle_root: 'rootabcdef123456',
      },
    };
    const lookup: ProofLookup = {
      lookupByPublicId: vi.fn().mockResolvedValue(noBatch),
    };
    const app = buildApp(lookup);

    const res = await request(app).get('/ARK-2026-TEST-001/proof');
    expect(res.status).toBe(200);
    expect(res.body.batch_id).toBeNull();
  });

  it('prefers proof rows over legacy metadata when both exist', () => {
    const result = buildProofResponse(
      ANCHORED_RECORD,
      {
        merkle_root: 'row-root',
        proof_path: [{ hash: 'row-proof', position: 'left' }],
        batch_id: 'row-batch',
      },
    );

    expect(result).toMatchObject({
      merkle_root: 'row-root',
      merkle_proof: [{ hash: 'row-proof', position: 'left' }],
      batch_id: 'row-batch',
    });
  });
});
