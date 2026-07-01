/**
 * SCRUM-900 PROOF-SIG-01 — verify-proof route integration.
 *
 * SCRUM-2490 (PROOF-VERIFY): `verified` is now set by RECOMPUTING the
 * Merkle root from the stored branch and comparing it to `merkle_root`,
 * NEVER from `anchors.status`. The fixtures below therefore use REAL
 * fingerprints/branches/roots produced by `buildMerkleTree` so the
 * cryptographic verdict can pass; the adversarial cases tamper with them.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express, { type Request } from 'express';
import request from 'supertest';
import { createHash, generateKeyPairSync } from 'node:crypto';
import {
  verifyProofRouter,
  buildProofResponse,
  type ProofLookup,
  type ProofAnchorData,
  type ProofRecordData,
  __resetSignerCacheForTests,
} from './verify-proof.js';
import { verifySignedBundle } from '../../proof/signed-bundle.js';
import { verifyDidBinding } from '../../proof/did-binding.js';
import { buildArkovaDidDocument, ARKOVA_DID } from '../did-web.js';
import type { ProofKey } from '../proof-keys.js';
import { buildMerkleTree } from '../../utils/merkle.js';

const fp = (seed: string) => createHash('sha256').update(seed).digest('hex');

// A real 4-leaf batch tree so the recompute-and-compare verdict is genuine.
const LEAVES = [fp('doc-a'), fp('doc-b'), fp('doc-c'), fp('doc-d')];
const TREE = buildMerkleTree(LEAVES);
const DOC_FP = LEAVES[0];
const DOC_INDEX = 0;
const DOC_BRANCH = TREE.proofs.get(DOC_FP)!;

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

// Cryptographically valid SECURED anchor (proof recomputes to merkle_root).
const ANCHOR: ProofAnchorData = {
  public_id: 'abc123',
  fingerprint: DOC_FP,
  status: 'SECURED',
  chain_tx_id: 'tx-999',
  chain_block_height: 800_000,
  chain_timestamp: '2026-04-18T10:00:00Z',
  metadata: {
    merkle_root: TREE.root,
    merkle_proof: DOC_BRANCH,
    merkle_index: DOC_INDEX,
    batch_id: 'batch-1',
  },
};

describe('SCRUM-900 signed proof bundle route', () => {
  let privatePem: string;
  let publicPem: string;

  beforeEach(() => {
    delete process.env.PROOF_SIGNING_KMS_KEY;
    const kp = generateKeyPairSync('ed25519');
    privatePem = kp.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    publicPem = kp.publicKey.export({ format: 'pem', type: 'spki' }).toString();
    process.env.PROOF_SIGNING_KEY_PEM = privatePem;
    process.env.PROOF_SIGNING_KEY_ID = 'arkova-proof-test';
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
    expect(res.body.merkle_root).toBe(TREE.root);
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
    expect(res.body.payload.merkle_root).toBe(TREE.root);
  });

  it('signed bundle verifies against the published public key', async () => {
    const app = buildApp({ lookupByPublicId: async () => ANCHOR });
    const res = await request(app).get('/api/v1/verify/abc123/proof?format=signed');
    const verification = verifySignedBundle({ bundle: res.body, publicKeyPem: publicPem });
    expect(verification.valid).toBe(true);
  });

  it('PROOF-06: signed bundle binds the issuer DID and verifies as one chain', async () => {
    const app = buildApp({ lookupByPublicId: async () => ANCHOR });
    const res = await request(app).get('/api/v1/verify/abc123/proof?format=signed');
    expect(res.status).toBe(200);

    // The payload carries the issuer binding pointing at the DID's
    // assertionMethod vm-id derived from the signing key id.
    expect(res.body.payload.issuer.did).toBe(ARKOVA_DID);
    expect(res.body.payload.issuer.assertion_method).toBe(`${ARKOVA_DID}#arkova-proof-test`);
    expect(res.body.payload.issuer.anchoring.chain).toBe('bitcoin');
    expect(res.body.payload.assertions.not_asserted.length).toBeGreaterThan(0);

    // Build the DID document from the SAME key the route signed with, then
    // walk the single trust chain: issuer DID → assertionMethod key → sig.
    const didKey: ProofKey = {
      id: 'arkova-proof-test',
      alg: 'Ed25519',
      status: 'active',
      public_key_pem: publicPem,
      created_at: '2026-06-01T00:00:00Z',
    };
    const didDoc = buildArkovaDidDocument(didKey);
    const verdict = verifyDidBinding({ bundle: res.body, didDocument: didDoc });
    expect(verdict.valid).toBe(true);
    expect(verdict.bound).toBe(true);
    expect(verdict.verificationMethodId).toBe(`${ARKOVA_DID}#arkova-proof-test`);
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

describe('SCRUM-2490 — verified is cryptographic, never status-derived', () => {
  it('verified=true when the branch recomputes to merkle_root (SECURED)', () => {
    const result = buildProofResponse(ANCHOR);
    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty('error');
    if (result && !('error' in result)) {
      expect(result.verified).toBe(true);
      expect(result.merkle_root).toBe(TREE.root);
    }
  });

  it('verified=true from anchor_proofs storedProof (preferred over metadata)', () => {
    const stored: ProofRecordData = {
      merkle_root: TREE.root,
      proof_path: DOC_BRANCH,
      batch_id: 'batch-1',
      merkle_index: DOC_INDEX,
    };
    // metadata deliberately carries a WRONG root; storedProof must win.
    const anchorWrongMeta: ProofAnchorData = {
      ...ANCHOR,
      metadata: { merkle_root: fp('wrong'), merkle_proof: [], batch_id: 'x' },
    };
    const result = buildProofResponse(anchorWrongMeta, stored);
    if (result && !('error' in result)) {
      expect(result.verified).toBe(true);
      expect(result.merkle_root).toBe(TREE.root);
    }
  });

  it('ADVERSARIAL flipped sibling ⇒ verified=false even though status=SECURED', () => {
    const flipped = DOC_BRANCH.map((e) => ({
      ...e,
      position: (e.position === 'left' ? 'right' : 'left') as 'left' | 'right',
    }));
    const anchor: ProofAnchorData = {
      ...ANCHOR,
      metadata: { merkle_root: TREE.root, merkle_proof: flipped, merkle_index: DOC_INDEX, batch_id: 'b' },
    };
    const result = buildProofResponse(anchor);
    if (result && !('error' in result)) {
      expect(result.verified).toBe(false);
    }
  });

  it('ADVERSARIAL wrong leaf (fingerprint) ⇒ verified=false even though status=SECURED', () => {
    const anchor: ProofAnchorData = { ...ANCHOR, fingerprint: fp('intruder') };
    const result = buildProofResponse(anchor);
    if (result && !('error' in result)) {
      expect(result.verified).toBe(false);
    }
  });

  it('ADVERSARIAL empty branch with root != fingerprint ⇒ verified=false', () => {
    const anchor: ProofAnchorData = {
      ...ANCHOR,
      metadata: { merkle_root: TREE.root, merkle_proof: [], batch_id: 'b' },
    };
    const result = buildProofResponse(anchor);
    if (result && !('error' in result)) {
      expect(result.verified).toBe(false);
    }
  });

  it('single-leaf anchor (root == fingerprint, empty branch) ⇒ verified=true', () => {
    const single = buildMerkleTree([DOC_FP]);
    const anchor: ProofAnchorData = {
      ...ANCHOR,
      fingerprint: DOC_FP,
      metadata: { merkle_root: single.root, merkle_proof: [], merkle_index: 0, batch_id: 'solo' },
    };
    const result = buildProofResponse(anchor);
    if (result && !('error' in result)) {
      expect(result.verified).toBe(true);
      expect(result.merkle_root).toBe(DOC_FP);
    }
  });

  it('does NOT set verified=true purely from status when the stored root does not recompute', () => {
    // A SECURED anchor whose stored proof has a non-recomputing root.
    const anchor: ProofAnchorData = {
      ...ANCHOR,
      metadata: { merkle_root: fp('unrelated-root'), merkle_proof: DOC_BRANCH, merkle_index: DOC_INDEX, batch_id: 'b' },
    };
    const result = buildProofResponse(anchor);
    if (result && !('error' in result)) {
      expect(result.verified).toBe(false);
    }
  });
});
