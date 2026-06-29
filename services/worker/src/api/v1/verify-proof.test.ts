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

  // ----- Carson P1 (2nd pass): leafCount arms the CVE guard on the VERDICT ----
  //
  // The structural CVE-2012-2459 self-pair guard inside verifyMerkleInclusion is
  // active only when BOTH leafIndex AND leafCount are supplied. Before the fix,
  // buildProofResponse threaded leafCount ONLY into buildProofBundle, so the
  // public `verified` verdict ran with {leafIndex} alone — the guard was INACTIVE
  // even when the exact count was known, and a structurally-forged self-pair
  // branch that recomputes to the committed root read verified=TRUE.
  //
  // Construct the canonical collision: a 3-leaf tree [a,b,c] where c legitimately
  // self-pairs at level-0 (rightmost odd). An attacker forges `c`'s branch so it
  // self-pairs at claimed index 0 of a size-4 level — NOT a rightmost-odd
  // position. recompute-and-compare ALONE accepts it (d2(c‖c)=cc, then
  // d2(ab‖cc)=root); only the count-armed structural guard rejects it.
  describe('CVE-2012-2459 self-pair on the top-level verdict', () => {
    const sha = (d: Buffer) => createHash('sha256').update(d).digest();
    const dsha = (d: Buffer) => sha(sha(d));
    const cat = (x: string, y: string) => Buffer.concat([Buffer.from(x, 'hex'), Buffer.from(y, 'hex')]);
    const A = fp('cve-a');
    const B = fp('cve-b');
    const C = fp('cve-c');
    const AB = dsha(cat(A, B)).toString('hex');
    const CC = dsha(cat(C, C)).toString('hex');
    const CVE_ROOT = dsha(cat(AB, CC)).toString('hex');
    // Forged branch for leaf C: step0 sibling == C (illegitimate self-pair),
    // step1 sibling == AB. Recomputes to CVE_ROOT.
    const FORGED_BRANCH = [
      { hash: C, position: 'right' as const },
      { hash: AB, position: 'left' as const },
    ];

    const forgedAnchor: ProofAnchorData = {
      ...ANCHOR,
      fingerprint: C,
      metadata: {
        merkle_root: CVE_ROOT,
        merkle_proof: FORGED_BRANCH,
        merkle_index: 0,
        batch_id: 'cve-batch',
      },
    };

    it('verified=true when leaf_count is UNKNOWN (recompute-only; structural guard cannot arm — documents the residual risk)', () => {
      // No leafCount ⇒ {leafIndex} only ⇒ recompute-and-compare accepts the
      // forgery. This is the pre-fix behaviour for legacy rows with no count.
      const result = buildProofResponse(forgedAnchor, null, null);
      expect(result).not.toBeNull();
      if (result && !('error' in result)) {
        expect(result.verified).toBe(true);
      }
    });

    it('verified=FALSE for the forged self-pair branch once leaf_count is threaded into the verdict (Carson P1)', () => {
      // The 3-leaf tree's claimed size-4 level: index 0 is NOT rightmost-odd, so
      // the self-pair is a forgery. With leafCount=4 the guard fires on the
      // PUBLIC verdict, not just inside the bundle.
      const result = buildProofResponse(forgedAnchor, null, 4);
      expect(result).not.toBeNull();
      expect(result).not.toHaveProperty('error');
      if (result && !('error' in result)) {
        expect(result.verified).toBe(false);
      }
    });

    it('legitimate proofs stay verified=true with leaf_count supplied (no false negatives)', () => {
      // The honest 4-leaf ANCHOR proof must still verify with its real count.
      const result = buildProofResponse(ANCHOR, null, LEAVES.length);
      if (result && !('error' in result)) {
        expect(result.verified).toBe(true);
      }
    });
  });
});

describe('PROOF-05 (SCRUM-2338) — additive nullable proof_bundle', () => {
  // 80-byte (160-hex) header.
  const HEADER_HEX = 'aa'.repeat(80);
  // Canonical Arkova OP_RETURN: "ARKV" (41524b56) + the 32-byte app root (64 hex),
  // NO version byte (matches prod signet.ts: Buffer.concat([ARKV, root])).
  //
  // Carson P1 (2nd pass): the committed root MUST be THIS proof's merkle_root
  // (TREE.root) — a row whose OP_RETURN commits a different root is internally
  // contradictory and the builder now rejects it (see (f1) below). So we derive
  // the canonical OP_RETURN from TREE.root, never a stand-in (`cd`*32) that
  // happens to share the shape but commits the wrong tree.
  const OP_RETURN_HEX = '41524b56' + TREE.root; // "ARKV" + the actual app root
  const BLOCK_HASH = 'bb'.repeat(32);
  // The PROOF-05 leaf count is exact: the number of anchor_proofs rows sharing
  // this proof's batch_id (the production reader counts them). Threaded into
  // buildProofResponse via the leafCount argument so the pure builder stays
  // testable without a DB.
  const LEAF_COUNT = LEAVES.length; // 4

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
    expect(result).not.toHaveProperty('error');
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
    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty('error');
    if (result && !('error' in result)) {
      expect(result.proof_bundle).toBeNull();
    }
  });

  it('(b2) proof_bundle is null when only SOME bitcoin-tree columns are present (honest, never partial)', () => {
    const partial: ProofRecordData = { ...COMPLETE_STORED, op_return_payload: null };
    const result = buildProofResponse(ANCHOR, partial, LEAF_COUNT);
    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty('error');
    if (result && !('error' in result)) {
      // block_header present but op_return_payload missing ⇒ incomplete ⇒ null.
      expect(result.proof_bundle).toBeNull();
    }
  });

  it('(c) proof_bundle populated when the anchor is SECURED with a complete two-layer proof', () => {
    const result = buildProofResponse(ANCHOR, COMPLETE_STORED, LEAF_COUNT);
    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty('error');
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
        // PROOF-05: leaf_count present + non-null arms the CVE-2012-2459 guard
        // (both merkle_index AND leaf_count must be present in a complete bundle).
        expect(b.leaf_count).toBe(LEAF_COUNT);
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
    const result = buildProofResponse(ANCHOR, hostile, LEAF_COUNT);
    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty('error');
    if (result && !('error' in result)) {
      expect(result.proof_bundle).not.toBeNull();
      if (result.proof_bundle) {
        const keys = Object.keys(result.proof_bundle).sort();
        expect(keys).toEqual(
          [
            'block_hash',
            'block_header',
            'block_height',
            'block_timestamp',
            'fingerprint',
            'leaf_count',
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
    }
  });

  it('(d2) malformed block_header (odd-length / non-hex) ⇒ bundle null, never a fabricated header', () => {
    const malformed: ProofRecordData = { ...COMPLETE_STORED, block_header: '\\xZZ' };
    const result = buildProofResponse(ANCHOR, malformed, LEAF_COUNT);
    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty('error');
    if (result && !('error' in result)) {
      expect(result.proof_bundle).toBeNull();
    }
  });

  // ----- Carson P1: tightened completeness gate ------------------------------

  it('(e1) short-but-valid-hex block_header (not 160 hex / 80 bytes) ⇒ bundle null', () => {
    // `\xaa` parses as valid hex but is 1 byte, not an 80-byte header. The old
    // gate accepted it; the tightened gate requires EXACTLY 160 hex.
    const shortHeader: ProofRecordData = { ...COMPLETE_STORED, block_header: '\\xaa' };
    const result = buildProofResponse(ANCHOR, shortHeader, LEAF_COUNT);
    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty('error');
    if (result && !('error' in result)) {
      expect(result.proof_bundle).toBeNull();
    }
  });

  it('(e2) short-but-valid block_hash (not 64 hex / 32 bytes) ⇒ bundle null', () => {
    const shortHash: ProofRecordData = { ...COMPLETE_STORED, block_hash: 'bb' };
    const result = buildProofResponse(ANCHOR, shortHash, LEAF_COUNT);
    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty('error');
    if (result && !('error' in result)) {
      expect(result.proof_bundle).toBeNull();
    }
  });

  it('(e3) missing tx_id (no receipt to fetch) ⇒ bundle null even with full layer-2 columns', () => {
    const anchorNoTx: ProofAnchorData = { ...ANCHOR, chain_tx_id: null };
    const result = buildProofResponse(anchorNoTx, COMPLETE_STORED, LEAF_COUNT);
    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty('error');
    if (result && !('error' in result)) {
      expect(result.proof_bundle).toBeNull();
    }
  });

  it('(e4) missing block_height ⇒ bundle null', () => {
    const anchorNoHeight: ProofAnchorData = { ...ANCHOR, chain_block_height: null };
    const result = buildProofResponse(anchorNoHeight, COMPLETE_STORED, LEAF_COUNT);
    if (result && !('error' in result)) {
      expect(result.proof_bundle).toBeNull();
    }
  });

  it('(e5) missing block_timestamp ⇒ bundle null', () => {
    const anchorNoTs: ProofAnchorData = { ...ANCHOR, chain_timestamp: null };
    const result = buildProofResponse(anchorNoTs, COMPLETE_STORED, LEAF_COUNT);
    if (result && !('error' in result)) {
      expect(result.proof_bundle).toBeNull();
    }
  });

  it('(e6) non-ARKV op_return_payload ⇒ bundle null (canonical shape required)', () => {
    // Right length, wrong prefix: must start with 41524b56 ("ARKV").
    const badPrefix: ProofRecordData = {
      ...COMPLETE_STORED,
      op_return_payload: `\\x${'deadbeef' + 'cd'.repeat(32)}`,
    };
    const result = buildProofResponse(ANCHOR, badPrefix, LEAF_COUNT);
    if (result && !('error' in result)) {
      expect(result.proof_bundle).toBeNull();
    }
  });

  it('(e7) ARKV prefix but no 32-byte root (too short) ⇒ bundle null', () => {
    const tooShort: ProofRecordData = {
      ...COMPLETE_STORED,
      op_return_payload: `\\x${'41524b56' + 'cd'.repeat(16)}`, // ARKV + only 16 bytes
    };
    const result = buildProofResponse(ANCHOR, tooShort, LEAF_COUNT);
    if (result && !('error' in result)) {
      expect(result.proof_bundle).toBeNull();
    }
  });

  it('(e8) canonical ARKV payload WITH trailing metadata (44-byte) ⇒ bundle populated', () => {
    // signet.ts allows ARKV + root + optional 8/16-byte metadata hash. The
    // committed root is still THIS proof's root (TREE.root); only a trailing
    // metadata hash follows.
    const withMeta: ProofRecordData = {
      ...COMPLETE_STORED,
      op_return_payload: `\\x${'41524b56' + TREE.root + 'ab'.repeat(8)}`,
    };
    const result = buildProofResponse(ANCHOR, withMeta, LEAF_COUNT);
    if (result && !('error' in result)) {
      expect(result.proof_bundle).not.toBeNull();
    }
  });

  it('(e9) complete layer-2 columns but unknown leaf_count ⇒ bundle null (CVE guard cannot arm)', () => {
    // leaf_count is mandatory for a complete, independently-checkable bundle.
    const result = buildProofResponse(ANCHOR, COMPLETE_STORED, null);
    if (result && !('error' in result)) {
      expect(result.proof_bundle).toBeNull();
    }
  });

  it('(e10) complete layer-2 columns but null merkle_index ⇒ bundle null (CVE guard cannot arm)', () => {
    const noIndex: ProofRecordData = { ...COMPLETE_STORED, merkle_index: null };
    const result = buildProofResponse(ANCHOR, noIndex, LEAF_COUNT);
    if (result && !('error' in result)) {
      expect(result.proof_bundle).toBeNull();
    }
  });

  it('proof_bundle.merkle_proof matches the top-level merkle_proof exactly', () => {
    const result = buildProofResponse(ANCHOR, COMPLETE_STORED, LEAF_COUNT);
    expect(result).not.toBeNull();
    if (result && !('error' in result) && result.proof_bundle) {
      expect(result.proof_bundle.merkle_proof).toEqual(result.merkle_proof);
      expect(result.proof_bundle.merkle_root).toBe(result.merkle_root);
    }
  });

  // ----- Carson P1 (2nd pass): OP_RETURN must COMMIT THIS EXACT root ----------

  it('(f1) op_return commits a DIFFERENT root than merkle_root ⇒ bundle null (internally-contradictory row never advertised complete)', () => {
    // Canonical ARKV shape, exact 80-byte header, exact 32-byte hash, valid
    // index/count — but the OP_RETURN commits a root that is NOT TREE.root.
    // The old gate (shape-only) emitted a non-null "complete" bundle here; the
    // tightened gate must return null because the on-chain commitment names a
    // different app-tree than the branch this bundle ships.
    const wrongCommit: ProofRecordData = {
      ...COMPLETE_STORED,
      op_return_payload: `\\x${'41524b56' + fp('some-other-tree-root')}`,
    };
    const result = buildProofResponse(ANCHOR, wrongCommit, LEAF_COUNT);
    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty('error');
    if (result && !('error' in result)) {
      // merkle_root=TREE.root but op_return commits fp('some-other-tree-root').
      expect(result.merkle_root).toBe(TREE.root);
      expect(result.proof_bundle).toBeNull();
    }
  });

  it('(f2) op_return committing the EXACT merkle_root (case-insensitive) ⇒ bundle populated', () => {
    // Same root, uppercased in storage — the committed-root comparison is
    // case-insensitive, so this remains a complete bundle.
    const upperCommit: ProofRecordData = {
      ...COMPLETE_STORED,
      op_return_payload: `\\x${'41524b56' + TREE.root.toUpperCase()}`,
    };
    const result = buildProofResponse(ANCHOR, upperCommit, LEAF_COUNT);
    expect(result).not.toBeNull();
    if (result && !('error' in result) && result.proof_bundle) {
      // Emitted lowercased on the wire, committing the right root.
      expect(result.proof_bundle.op_return_payload).toBe(
        ('41524b56' + TREE.root).toLowerCase(),
      );
    }
  });
});
