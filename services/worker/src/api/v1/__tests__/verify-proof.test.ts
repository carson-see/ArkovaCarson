/**
 * BTC-003: Merkle Proof Verification Endpoint Tests
 */

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { verifyProofRouter } from '../verify-proof.js';
import type { ProofLookup, ProofAnchorData, MerkleProofResponse } from '../verify-proof.js';

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

const MOCK_PROOF = [
  { hash: 'abc123def456', position: 'right' as const },
  { hash: '789012345678', position: 'left' as const },
];

const ANCHORED_RECORD: ProofAnchorData = {
  public_id: 'ARK-2026-TEST-001',
  fingerprint: 'aabbccdd11223344',
  status: 'SECURED',
  chain_tx_id: 'tx_abc123',
  chain_block_height: 12345,
  chain_timestamp: '2026-03-24T00:00:00Z',
  metadata: {
    merkle_proof: MOCK_PROOF,
    merkle_root: 'rootabcdef123456',
    batch_id: 'batch_1711234567890_5',
  },
};

describe('BTC-003: GET /verify/:publicId/proof', () => {
  it('returns merkle proof for a batch-anchored record', async () => {
    const lookup: ProofLookup = {
      lookupByPublicId: vi.fn().mockResolvedValue(ANCHORED_RECORD),
    };
    const app = buildApp(lookup);

    const res = await request(app).get('/ARK-2026-TEST-001/proof');

    expect(res.status).toBe(200);
    const body = res.body as MerkleProofResponse;
    expect(body.public_id).toBe('ARK-2026-TEST-001');
    expect(body.fingerprint).toBe('aabbccdd11223344');
    expect(body.merkle_root).toBe('rootabcdef123456');
    expect(body.merkle_proof).toEqual(MOCK_PROOF);
    expect(body.tx_id).toBe('tx_abc123');
    expect(body.block_height).toBe(12345);
    expect(body.batch_id).toBe('batch_1711234567890_5');
    expect(body.verified).toBe(true);
  });

  it('returns verified=true for SUBMITTED status', async () => {
    const submitted: ProofAnchorData = { ...ANCHORED_RECORD, status: 'SUBMITTED' };
    const lookup: ProofLookup = {
      lookupByPublicId: vi.fn().mockResolvedValue(submitted),
    };
    const app = buildApp(lookup);

    const res = await request(app).get('/ARK-2026-TEST-001/proof');
    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);
  });

  it('returns verified=false for PENDING status', async () => {
    const pending: ProofAnchorData = {
      ...ANCHORED_RECORD,
      status: 'PENDING',
      chain_tx_id: null,
      chain_block_height: null,
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
  });

  it('returns 400 for short publicId', async () => {
    const lookup: ProofLookup = {
      lookupByPublicId: vi.fn().mockResolvedValue(null),
    };
    const app = buildApp(lookup);

    const res = await request(app).get('/ab/proof');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid publicId');
  });

  it('handles lookup errors gracefully', async () => {
    const lookup: ProofLookup = {
      lookupByPublicId: vi.fn().mockRejectedValue(new Error('DB down')),
    };
    const app = buildApp(lookup);

    const res = await request(app).get('/ARK-2026-TEST-001/proof');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Internal server error');
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
});
