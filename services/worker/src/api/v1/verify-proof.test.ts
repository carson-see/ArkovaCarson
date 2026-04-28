/**
 * SCRUM-900 PROOF-SIG-01 — verify-proof route integration.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express, { type Request } from 'express';
import request from 'supertest';
import { generateKeyPairSync } from 'node:crypto';
import { verifyProofRouter, type ProofLookup, type ProofAnchorData, __resetSignerCacheForTests } from './verify-proof.js';
import { verifySignedBundle } from '../../proof/signed-bundle.js';

function buildApp(lookup: ProofLookup) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as Request & { _testLookup: ProofLookup })._testLookup = lookup;
    next();
  });
  app.use('/api/v1/verify', verifyProofRouter);
  return app;
}

const ANCHOR: ProofAnchorData = {
  public_id: 'abc123',
  fingerprint: 'deadbeef',
  status: 'SECURED',
  chain_tx_id: 'tx-999',
  chain_block_height: 800_000,
  chain_timestamp: '2026-04-18T10:00:00Z',
  metadata: {
    merkle_root: 'root-hash',
    merkle_proof: [{ hash: 'sibling-1', position: 'left' }],
    batch_id: 'batch-1',
  },
};

describe('SCRUM-900 signed proof bundle route', () => {
  let privatePem: string;
  let publicPem: string;

  beforeEach(() => {
    // Defensive: ensure no KMS path bleed-in from environment.
    delete process.env.PROOF_SIGNING_KMS_KEY;
    const kp = generateKeyPairSync('ed25519');
    privatePem = kp.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    publicPem = kp.publicKey.export({ format: 'pem', type: 'spki' }).toString();
    process.env.PROOF_SIGNING_KEY_PEM = privatePem;
    process.env.PROOF_SIGNING_KEY_ID = 'arkova-proof-test';
    // resolveSigner() memoizes the resolved signer at module scope; per-
    // test env-var swaps require explicit cache reset.
    __resetSignerCacheForTests();
  });

  afterEach(() => {
    delete process.env.PROOF_SIGNING_KEY_PEM;
    delete process.env.PROOF_SIGNING_KEY_ID;
    delete process.env.PROOF_SIGNING_KMS_KEY;
    __resetSignerCacheForTests();
  });

  it('returns legacy unsigned JSON when ?format is omitted (backwards compat)', async () => {
    const app = buildApp({ lookupByPublicId: async () => ANCHOR });
    const res = await request(app).get('/api/v1/verify/abc123/proof');
    expect(res.status).toBe(200);
    expect(res.body.merkle_root).toBe('root-hash');
    expect(res.body.signature).toBeUndefined();
    expect(res.body.bundle_version).toBeUndefined();
  });

  it('returns a signed bundle when ?format=signed is set', async () => {
    const app = buildApp({ lookupByPublicId: async () => ANCHOR });
    const res = await request(app).get('/api/v1/verify/abc123/proof?format=signed');
    expect(res.status).toBe(200);
    expect(res.body.bundle_version).toBe('1.0.0');
    expect(res.body.signature.alg).toBe('Ed25519');
    expect(res.body.signing_key_id).toBe('arkova-proof-test');
    expect(res.body.payload.merkle_root).toBe('root-hash');
  });

  it('signed bundle verifies against the published public key', async () => {
    const app = buildApp({ lookupByPublicId: async () => ANCHOR });
    const res = await request(app).get('/api/v1/verify/abc123/proof?format=signed');
    const verification = verifySignedBundle({ bundle: res.body, publicKeyPem: publicPem });
    expect(verification.valid).toBe(true);
  });

  it('returns 503 when the signer env vars are not configured', async () => {
    delete process.env.PROOF_SIGNING_KEY_PEM;
    delete process.env.PROOF_SIGNING_KEY_ID;
    __resetSignerCacheForTests();
    const app = buildApp({ lookupByPublicId: async () => ANCHOR });
    const res = await request(app).get('/api/v1/verify/abc123/proof?format=signed');
    expect(res.status).toBe(503);
    expect(res.body.error).toContain('Signed proof bundle is not configured');
  });

  it('returns 404 when no merkle proof is available regardless of format', async () => {
    const anchorNoProof: ProofAnchorData = { ...ANCHOR, metadata: null };
    const app = buildApp({ lookupByPublicId: async () => anchorNoProof });
    const res = await request(app).get('/api/v1/verify/abc123/proof?format=signed');
    expect(res.status).toBe(404);
  });
});
