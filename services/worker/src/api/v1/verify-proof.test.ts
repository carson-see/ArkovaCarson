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

describe('PROOF-05 (SCRUM-2338) — additive nullable proof_bundle', () => {
  // 80-byte (160-hex) header + an OP_RETURN payload as PostgREST returns bytea (\x-hex).
  const HEADER_HEX = 'aa'.repeat(80);
  const OP_RETURN_HEX = '41524b56' + '01' + 'cd'.repeat(32); // "ARKV" + ver + 32-byte root
  const BLOCK_HASH = 'bb'.repeat(32);

  // A complete stored proof carrying the layer-2 bitcoin-tree columns.
  const COMPLETE_STORED: ProofRecordData = {
    merkle_root: TREE.root,
    proof_path: DOC_BRANCH,
    batch_id: 'batch-1',
    merkle_index: DOC_INDEX,
    block_header: `\\x${HEADER_HEX}`,
    block_hash: BLOCK_HASH,
    op_return_payload: `\\x${OP_RETURN_HEX}`,
    proof_schema_version: 1,
  };

  it('(a) old client unaffected — top-level fields unchanged, proof_bundle is purely additive', () => {
    const result = buildProofResponse(ANCHOR);
    expect(result).not.toBeNull();
    if (result && !('error' in result)) {
      // The full legacy frozen shape is intact (Constitution §1.8).
      expect(result.public_id).toBe('abc123');
      expect(result.fingerprint).toBe(DOC_FP);
      expect(result.merkle_root).toBe(TREE.root);
      expect(result.tx_id).toBe('tx-999');
      expect(result.block_height).toBe(800_000);
      expect(result.verified).toBe(true);
      // proof_bundle exists as a new KEY but never replaces/renames an old field.
      expect('proof_bundle' in result).toBe(true);
    }
  });

  it('(b) proof_bundle is null when the proof is incomplete (no bitcoin-tree columns)', () => {
    // Metadata-only proof (app-tree branch present, no block_header/op_return).
    const result = buildProofResponse(ANCHOR);
    if (result && !('error' in result)) {
      expect(result.proof_bundle).toBeNull();
    }
  });

  it('(b2) proof_bundle is null when only SOME bitcoin-tree columns are present (honest, never partial)', () => {
    const partial: ProofRecordData = { ...COMPLETE_STORED, op_return_payload: null };
    const result = buildProofResponse(ANCHOR, partial);
    if (result && !('error' in result)) {
      // block_header present but op_return_payload missing ⇒ incomplete ⇒ null.
      expect(result.proof_bundle).toBeNull();
    }
  });

  it('(c) proof_bundle populated when the anchor is SECURED with a complete two-layer proof', () => {
    const result = buildProofResponse(ANCHOR, COMPLETE_STORED);
    expect(result).not.toBeNull();
    if (result && !('error' in result)) {
      const b = result.proof_bundle;
      expect(b).not.toBeNull();
      if (b) {
        expect(b.fingerprint).toBe(DOC_FP);
        expect(b.merkle_root).toBe(TREE.root);
        expect(b.merkle_proof).toEqual(DOC_BRANCH);
        expect(b.tx_id).toBe('tx-999');
        expect(b.block_height).toBe(800_000);
        expect(b.block_hash).toBe(BLOCK_HASH);
        // bytea \x-prefix stripped; plain lowercase hex on the wire.
        expect(b.block_header).toBe(HEADER_HEX);
        expect(b.op_return_payload).toBe(OP_RETURN_HEX);
        expect(b.merkle_index).toBe(DOC_INDEX);
        expect(b.block_timestamp).toBe('2026-04-18T10:00:00Z');
        expect(b.proof_schema_version).toBe(1);
        // No inline signature on the default (unsigned) path — null, never faked.
        expect(b.signature).toBeNull();
      }
    }
  });

  it('(d) REDACTION GUARD — bundle never carries raw document bytes, PII, or non-allowlisted keys', () => {
    // A hostile stored proof that smuggles extra fields. The builder uses an
    // explicit allowlist, so none of these may surface in proof_bundle.
    const hostile = {
      ...COMPLETE_STORED,
      raw_document: 'SSN 123-45-6789 john@example.com',
      pii_blob: { name: 'Jane Doe', dob: '1990-01-01' },
      proof_path: DOC_BRANCH,
    } as unknown as ProofRecordData;
    const result = buildProofResponse(ANCHOR, hostile);
    if (result && !('error' in result) && result.proof_bundle) {
      const keys = Object.keys(result.proof_bundle).sort();
      expect(keys).toEqual(
        [
          'block_hash',
          'block_header',
          'block_height',
          'block_timestamp',
          'fingerprint',
          'merkle_index',
          'merkle_proof',
          'merkle_root',
          'op_return_payload',
          'proof_schema_version',
          'signature',
          'tx_id',
        ].sort(),
      );
      const serialized = JSON.stringify(result.proof_bundle);
      expect(serialized).not.toContain('123-45-6789');
      expect(serialized).not.toContain('john@example.com');
      expect(serialized).not.toContain('Jane Doe');
    }
  });

  it('(d2) malformed block_header (odd-length / non-hex) ⇒ bundle null, never a fabricated header', () => {
    const malformed: ProofRecordData = { ...COMPLETE_STORED, block_header: '\\xZZ' };
    const result = buildProofResponse(ANCHOR, malformed);
    if (result && !('error' in result)) {
      expect(result.proof_bundle).toBeNull();
    }
  });

  it('proof_bundle.merkle_proof matches the top-level merkle_proof exactly', () => {
    const result = buildProofResponse(ANCHOR, COMPLETE_STORED);
    if (result && !('error' in result) && result.proof_bundle) {
      expect(result.proof_bundle.merkle_proof).toEqual(result.merkle_proof);
      expect(result.proof_bundle.merkle_root).toBe(result.merkle_root);
    }
  });
});
