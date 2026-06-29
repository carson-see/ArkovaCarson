/**
 * Canonical proof-fixture conformance tests (PROOF-08 / SCRUM-2341).
 *
 * Exercises the shared fixture set (`proof-fixtures.json`) against the REAL
 * proof verifiers so that every proof consumer — API verify-proof, PDF, SDK,
 * CLI, server-side verify — has a single, code-grounded set of vectors:
 *
 *   - one VALID inclusion proof,
 *   - invalid proofs covering bad document hash, tampered Merkle branch
 *     (sibling + position), the CVE-2012-2459 duplicated-leaf attack, wrong
 *     leaf index, bad block header, and bad signature.
 *
 * These are the SAME vectors SCRUM-2490's adversarial Merkle tests pin: the
 * VALID case round-trips through `buildMerkleTree`, and every invalid case is
 * rejected by `verifyMerkleInclusion` / `verifySignedBundle` / the
 * confirmation-proof header rule. Synthetic anchors only — NO PII (§1.6/§1.5).
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { buildMerkleTree, verifyMerkleProof } from '../../utils/merkle.js';
import { verifyMerkleInclusion } from '../../utils/merkle-verify.js';
import { verifySignedBundle, BUNDLE_VERSION } from '../signed-bundle.js';
import { buildProofResponse } from '../../api/v1/verify-proof.js';
import {
  proofFixtures,
  validInclusion,
  invalidById,
  isInclusionVector,
  isBlockHeaderVector,
  FIXTURE_PROOF_SCHEMA_VERSION,
  ARKV_PREFIX_HEX,
  type InclusionVector,
  type BlockHeaderVector,
} from './index.js';

/** The 80-byte (160-hex) raw-block-header rule from confirmation-proof.ts. */
const BLOCK_HEADER_HEX_RE = /^[0-9a-fA-F]{160}$/;

function sha256(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

describe('proof fixtures — file integrity (PROOF-08)', () => {
  it('is version-stamped to proof_schema_version 1 (non-null)', () => {
    expect(FIXTURE_PROOF_SCHEMA_VERSION).toBe(1);
    expect(proofFixtures.proof_schema_version).toBe(1);
    expect(proofFixtures.proof_schema_version).not.toBeNull();
  });

  it('hash_rule states double-SHA256 (not RFC-6962) and the no-version-byte v0 commitment', () => {
    expect(proofFixtures.hash_rule).toMatch(/double-SHA256/i);
    expect(proofFixtures.hash_rule).toMatch(/NOT RFC-6962/i);
    expect(proofFixtures.hash_rule).toMatch(/no version byte|NO version byte/i);
  });

  it('contains NO PII / customer data — synthetic anchors only', () => {
    const blob = JSON.stringify(proofFixtures);
    // No emails, no real-looking PEM-less secrets beyond the documented test key.
    expect(blob).not.toMatch(/@(?!arkova)\w+\.\w+/); // no foreign email domains
    expect(validInclusion.public_id).toMatch(/^rec_fixture_/);
    expect(proofFixtures.valid.batch_id).toMatch(/^batch_fixture_/);
  });

  it('the tree leaves + root are reproducible from buildMerkleTree (no hand-rolled hashes)', () => {
    const expectedLeaves = Array.from({ length: 4 }, (_, i) => sha256(`arkova-fixture-leaf-${i}`));
    expect(proofFixtures.tree.leaves).toEqual(expectedLeaves);
    expect(proofFixtures.tree.leaf_count).toBe(expectedLeaves.length);
    const tree = buildMerkleTree(expectedLeaves);
    expect(tree.root).toBe(proofFixtures.tree.merkle_root);
    expect(proofFixtures.valid.merkle_root).toBe(tree.root);
  });

  it('every inclusion vector carries leaf_count alongside merkle_index (CVE-2012-2459 guard arming)', () => {
    const inclusionVectors = [validInclusion, ...proofFixtures.invalid.filter(isInclusionVector)];
    for (const v of inclusionVectors) {
      expect(typeof v.merkle_index).toBe('number');
      expect(typeof v.leaf_count).toBe('number');
      expect(v.leaf_count).toBe(4);
    }
  });

  it('every merkle_proof entry is a {hash, position} object — NOT a bare string', () => {
    const allProofs = [
      validInclusion.merkle_proof,
      proofFixtures.signed_bundle.valid_bundle.payload.merkle_proof,
      ...proofFixtures.invalid.filter(isInclusionVector).map((v) => v.merkle_proof),
    ];
    for (const proof of allProofs as Array<Array<{ hash: string; position: string }>>) {
      expect(Array.isArray(proof)).toBe(true);
      for (const entry of proof) {
        expect(typeof entry).toBe('object');
        expect(typeof entry.hash).toBe('string');
        expect(entry.hash).toMatch(/^[0-9a-f]{64}$/i);
        expect(['left', 'right']).toContain(entry.position);
      }
    }
  });
});

describe('proof fixtures — on-chain OP_RETURN commitment (the PROOF-08 bug)', () => {
  const payload = proofFixtures.valid.on_chain.op_return_payload;

  it('is even-length (byte-aligned) hex', () => {
    expect(payload).toMatch(/^[0-9a-f]+$/i);
    expect(payload.length % 2).toBe(0);
  });

  it('starts with the ARKV prefix and has NO version byte', () => {
    expect(payload.startsWith(ARKV_PREFIX_HEX)).toBe(true);
    // ARKV (4 bytes) + 32-byte root = 36 bytes = 72 hex chars. No stray byte.
    expect(payload.length).toBe((4 + 32) * 2);
  });

  it('decoded bytes [4, 36) equal the fixture merkle_root', () => {
    const bytes = Buffer.from(payload, 'hex');
    expect(bytes.length).toBe(36);
    expect(bytes.subarray(0, 4).toString('ascii')).toBe('ARKV');
    expect(bytes.subarray(4, 36).toString('hex')).toBe(validInclusion.merkle_root);
  });
});

describe('proof fixtures — VALID inclusion vector', () => {
  it('verifyMerkleInclusion accepts it WITH structural opts', () => {
    const r = verifyMerkleInclusion(
      validInclusion.fingerprint,
      validInclusion.merkle_proof,
      validInclusion.merkle_root,
      { leafIndex: validInclusion.merkle_index, leafCount: validInclusion.leaf_count },
    );
    expect(r.valid).toBe(true);
  });

  it('verifyMerkleInclusion accepts it WITHOUT structural opts (back-compat)', () => {
    const r = verifyMerkleInclusion(
      validInclusion.fingerprint,
      validInclusion.merkle_proof,
      validInclusion.merkle_root,
    );
    expect(r.valid).toBe(true);
  });

  it('the legacy verifyMerkleProof helper also accepts it', () => {
    expect(
      verifyMerkleProof(validInclusion.fingerprint, validInclusion.merkle_proof, validInclusion.merkle_root),
    ).toBe(true);
  });

  it('buildProofResponse (the API surface) marks it verified:true', () => {
    const result = buildProofResponse(
      {
        public_id: validInclusion.public_id,
        fingerprint: validInclusion.fingerprint,
        status: 'SECURED',
        chain_tx_id: proofFixtures.valid.on_chain.tx_id,
        chain_block_height: proofFixtures.valid.on_chain.block_height,
        chain_timestamp: proofFixtures.valid.on_chain.block_timestamp,
        metadata: null,
      },
      {
        merkle_root: validInclusion.merkle_root,
        proof_path: validInclusion.merkle_proof,
        batch_id: proofFixtures.valid.batch_id,
        merkle_index: validInclusion.merkle_index,
      },
    );
    expect(result).not.toBeNull();
    expect(result && 'verified' in result ? result.verified : null).toBe(true);
  });
});

describe('proof fixtures — VALID signed bundle', () => {
  it('verifySignedBundle accepts the valid bundle against the published test key', () => {
    const sb = proofFixtures.signed_bundle;
    expect(sb.valid_bundle.bundle_version).toBe(BUNDLE_VERSION);
    const r = verifySignedBundle({
      bundle: sb.valid_bundle,
      publicKeyPem: sb.test_public_key_pem,
    });
    expect(r.valid).toBe(true);
  });

  /**
   * Anti-drift guard (Carson P2, PR #1357): the signed-bundle payload is the
   * cross-consumer source of truth a CLI / SDK / PDF consumer verifies against.
   * If it omitted the canonical proof-bundle fields, a consumer could pass the
   * signed-bundle fixture while NEVER exercising the CVE-2012-2459 structural
   * guard inputs (merkle_index / leaf_count) or the canonical OP_RETURN field.
   * This pins the signed payload to the `valid` vector for EVERY canonical
   * field, so the two fixtures cannot silently diverge again.
   */
  it('signed payload carries the SAME canonical proof-bundle fields as the `valid` vector', () => {
    const payload = proofFixtures.signed_bundle.valid_bundle.payload;
    const v = validInclusion;
    const chain = proofFixtures.valid.on_chain;

    // Layer-1 app-tree inclusion fields (incl. the CVE-2012-2459 guard inputs).
    expect(payload.fingerprint).toBe(v.fingerprint);
    expect(payload.merkle_root).toBe(v.merkle_root);
    expect(payload.merkle_index).toBe(v.merkle_index);
    expect(payload.leaf_count).toBe(v.leaf_count);
    expect(payload.merkle_proof).toEqual(v.merkle_proof);

    // On-chain commitment fields (incl. the canonical OP_RETURN + raw header).
    expect(payload.tx_id).toBe(chain.tx_id);
    expect(payload.block_height).toBe(chain.block_height);
    expect(payload.block_hash).toBe(chain.block_hash);
    expect(payload.block_header).toBe(chain.block_header);
    expect(payload.op_return_payload).toBe(chain.op_return_payload);
    expect(payload.block_timestamp).toBe(chain.block_timestamp);

    // Schema version is stamped on the signed payload too.
    expect(payload.proof_schema_version).toBe(FIXTURE_PROOF_SCHEMA_VERSION);

    // And the canonical OP_RETURN field is present (not just under on_chain) —
    // proves the signed bundle exercises the field the PROOF-08 bug missed.
    expect(typeof payload.op_return_payload).toBe('string');
    expect((payload.op_return_payload as string).startsWith(ARKV_PREFIX_HEX)).toBe(true);
  });
});

describe('proof fixtures — INVALID Merkle inclusion vectors', () => {
  const cases: Array<{ id: string }> = [
    { id: 'bad-document-hash' },
    { id: 'tampered-merkle-branch' },
    { id: 'flipped-branch-position' },
    { id: 'duplicated-leaf-attack' },
    { id: 'wrong-leaf-index' },
  ];

  it.each(cases)('rejects $id with a matching reason', ({ id }) => {
    const v = invalidById<InclusionVector>(id);
    expect(isInclusionVector(v)).toBe(true);
    const r = verifyMerkleInclusion(v.fingerprint, v.merkle_proof, v.merkle_root, {
      leafIndex: v.merkle_index,
      leafCount: v.leaf_count,
    });
    expect(r.valid).toBe(false);
    expect(r.reason?.toLowerCase()).toContain(v.expect_invalid_reason!.toLowerCase());
  });

  it('the duplicated-leaf (CVE-2012-2459) attack is caught by the structural index/count guard', () => {
    const v = invalidById<InclusionVector>('duplicated-leaf-attack');
    const guarded = verifyMerkleInclusion(v.fingerprint, v.merkle_proof, v.merkle_root, {
      leafIndex: v.merkle_index,
      leafCount: v.leaf_count,
    });
    expect(guarded.valid).toBe(false);
    expect(guarded.reason).toMatch(/duplicat|CVE-2012-2459|self-pair/i);
  });
});

describe('proof fixtures — INVALID block-header vector', () => {
  it('rejects a block header that is not 80 bytes (160-hex)', () => {
    const v = invalidById<BlockHeaderVector>('bad-block-header');
    expect(isBlockHeaderVector(v)).toBe(true);
    expect(BLOCK_HEADER_HEX_RE.test(v.block_header_hex)).toBe(false);
  });
});

describe('proof fixtures — INVALID signature vector', () => {
  it('verifySignedBundle rejects the tampered signature', () => {
    const sb = proofFixtures.signed_bundle;
    const tampered = {
      ...sb.valid_bundle,
      signature: { ...sb.valid_bundle.signature, value: sb.bad_signature_value },
    };
    const r = verifySignedBundle({ bundle: tampered, publicKeyPem: sb.test_public_key_pem });
    expect(r.valid).toBe(false);
    const expected = invalidById<InclusionVector>('bad-signature').expect_invalid_reason!;
    expect(r.reason?.toLowerCase()).toContain(expected.toLowerCase());
  });
});
