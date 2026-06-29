/**
 * Hardened Merkle inclusion verifier tests (PROOF-VERIFY / SCRUM-2490).
 *
 * These pin the cryptographic recompute-and-compare that
 * `api/v1/verify-proof.ts` uses to set `verified` — the verdict is derived
 * from the branch recomputation, NEVER from `anchors.status`.
 *
 * The verifier MUST recompute using the SAME hashing rule as
 * `utils/merkle.ts::buildMerkleTree` (plain double-SHA256 with positional
 * concat), because that is what is committed in the on-chain Merkle root.
 * On top of that it adds:
 *   - leaf/sibling 32-byte (64-hex) validation (leaf↔internal length
 *     domain separation for this Bitcoin-style scheme)
 *   - the CVE-2012-2459 duplicated-leaf guard: when the leaf's position
 *     (`merkle_index`) + tree `leafCount` are known, a self-pair
 *     (sibling == running hash) is legitimate ONLY at the rightmost node of
 *     an odd-sized level; any other self-pair is a forged duplicate and is
 *     rejected.
 *   - empty branch ⇒ root must equal the leaf (single-leaf tree)
 *
 * The PROOF-01 contract's RFC-6962 tagged-hash primitives (for a future
 * `proof_schema_version=2`, gated behind the §4 OP_RETURN version-byte
 * decision) are pinned separately at the bottom — they are NOT wired into
 * the v1 verdict, which must match what is already anchored.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { buildMerkleTree } from './merkle.js';
import {
  verifyMerkleInclusion,
  hashLeafTagged,
  hashNodeTagged,
} from './merkle-verify.js';
import { proofFixtures, isInclusionVector } from '../proof/fixtures/index.js';

function fp(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

describe('verifyMerkleInclusion — recompute-and-compare (SCRUM-2490)', () => {
  it('validates every leaf of a real multi-leaf tree (matches buildMerkleTree)', () => {
    // 7 leaves exercises the odd-level duplication path: the last leaf
    // legitimately self-pairs at level 0. Verification must accept it.
    const leaves = Array.from({ length: 7 }, (_, i) => fp(`leaf-${i}`));
    const tree = buildMerkleTree(leaves);
    leaves.forEach((leaf, idx) => {
      const branch = tree.proofs.get(leaf)!;
      const result = verifyMerkleInclusion(leaf, branch, tree.root, {
        leafIndex: idx,
        leafCount: leaves.length,
      });
      expect(result.valid).toBe(true);
    });
  });

  it('validates the legitimate last leaf even WITHOUT structural opts (back-compat)', () => {
    const leaves = Array.from({ length: 7 }, (_, i) => fp(`leaf-${i}`));
    const tree = buildMerkleTree(leaves);
    const lastLeaf = leaves[6];
    const result = verifyMerkleInclusion(lastLeaf, tree.proofs.get(lastLeaf)!, tree.root);
    expect(result.valid).toBe(true);
  });

  it('validates a single-leaf tree where the branch is empty and root == leaf', () => {
    const leaf = fp('solo');
    const tree = buildMerkleTree([leaf]);
    expect(tree.root).toBe(leaf);
    expect(verifyMerkleInclusion(leaf, [], tree.root).valid).toBe(true);
    expect(verifyMerkleInclusion(leaf, [], tree.root, { leafIndex: 0, leafCount: 1 }).valid).toBe(true);
  });

  // --- Adversarial cases (the three the brief calls out + CVE) ---

  it('ADVERSARIAL empty branch: rejects when root != leaf', () => {
    const leaf = fp('alpha');
    const otherRoot = fp('not-the-leaf');
    const result = verifyMerkleInclusion(leaf, [], otherRoot);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/single-leaf|root/i);
  });

  it('ADVERSARIAL flipped sibling: rejects when a sibling position is flipped', () => {
    const a = fp('a');
    const b = fp('b');
    const tree = buildMerkleTree([a, b]);
    const branch = tree.proofs.get(a)!.map((e) => ({
      ...e,
      position: (e.position === 'left' ? 'right' : 'left') as 'left' | 'right',
    }));
    const result = verifyMerkleInclusion(a, branch, tree.root);
    expect(result.valid).toBe(false);
  });

  it('ADVERSARIAL wrong leaf: rejects a different leaf against a valid branch+root', () => {
    const a = fp('a');
    const b = fp('b');
    const tree = buildMerkleTree([a, b]);
    const wrongLeaf = fp('intruder');
    const result = verifyMerkleInclusion(wrongLeaf, tree.proofs.get(a)!, tree.root);
    expect(result.valid).toBe(false);
  });

  it('ADVERSARIAL CVE-2012-2459: rejects an illegitimate self-pairing sibling', () => {
    // Even (4-leaf) tree — NO level has a legitimate duplication. An
    // attacker forges leaf `a`'s branch so step 0 presents a sibling equal
    // to the leaf itself (sibling == running hash). With the leaf's true
    // position (index 0, count 4) the guard knows index 0 of a size-4 level
    // is NOT a rightmost-odd node, so this self-pair can only be a forgery.
    const a = fp('a');
    const b = fp('b');
    const c = fp('c');
    const d = fp('d');
    const tree = buildMerkleTree([a, b, c, d]);
    const realBranch = tree.proofs.get(a)!;
    const forged = [{ hash: a, position: 'right' as const }, ...realBranch.slice(1)];
    const result = verifyMerkleInclusion(a, forged, tree.root, { leafIndex: 0, leafCount: 4 });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/duplicat|CVE-2012-2459|self-pair/i);
  });

  it('rejects a leaf that is not 32 bytes (64 hex) — leaf/internal domain separation', () => {
    const result = verifyMerkleInclusion('deadbeef', [], 'deadbeef');
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/64.?hex|32.?byte|format/i);
  });

  it('rejects a sibling that is not 32 bytes (64 hex)', () => {
    const a = fp('a');
    const result = verifyMerkleInclusion(
      a,
      [{ hash: 'beef', position: 'right' }],
      fp('whatever'),
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/64.?hex|32.?byte|format|sibling/i);
  });

  it('rejects a malformed branch entry (bad position)', () => {
    const a = fp('a');
    const result = verifyMerkleInclusion(
      a,
      [{ hash: fp('b'), position: 'sideways' as unknown as 'left' }],
      fp('root'),
    );
    expect(result.valid).toBe(false);
  });

  it('rejects when leafIndex is out of range for leafCount', () => {
    const leaves = [fp('a'), fp('b')];
    const tree = buildMerkleTree(leaves);
    const result = verifyMerkleInclusion(leaves[0], tree.proofs.get(leaves[0])!, tree.root, {
      leafIndex: 5,
      leafCount: 2,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/index|range/i);
  });

  it('is case-insensitive on hex input but compares against the provided root', () => {
    const a = fp('a');
    const b = fp('b');
    const tree = buildMerkleTree([a, b]);
    const branchUpper = tree.proofs.get(a)!.map((e) => ({ ...e, hash: e.hash.toUpperCase() }));
    const result = verifyMerkleInclusion(a.toUpperCase(), branchUpper, tree.root);
    expect(result.valid).toBe(true);
  });
});

describe('RFC-6962 tagged hashing primitives (future proof_schema_version=2)', () => {
  // These are NOT used by the v1 verdict (the on-chain roots were built
  // without tags). They exist + are pinned so the domain-separated format
  // is ready once the OP_RETURN version byte (PROOF-01 §4) is decided.
  it('hashLeafTagged differs from hashNodeTagged for the same bytes', () => {
    const data = Buffer.from(fp('x'), 'hex');
    const leafHash = hashLeafTagged(data);
    const node = Buffer.concat([data, data]);
    const nodeHash = hashNodeTagged(node.subarray(0, 32), node.subarray(32, 64));
    expect(leafHash).not.toBe(nodeHash);
    expect(leafHash).toMatch(/^[0-9a-f]{64}$/);
    expect(nodeHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('tagged leaf hash is double-SHA256 of (0x00 || data)', () => {
    const data = Buffer.from(fp('y'), 'hex');
    const expected = createHash('sha256')
      .update(createHash('sha256').update(Buffer.concat([Buffer.from([0x00]), data])).digest())
      .digest('hex');
    expect(hashLeafTagged(data)).toBe(expected);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Canonical proof fixtures (PROOF-08 / SCRUM-2341) wired into THIS suite so the
// hardened verifier and the cross-consumer fixture set stay on one vector set.
// The shared fixtures live in proof/fixtures/proof-fixtures.json; their own
// conformance tests are in proof/fixtures/proof-fixtures.test.ts. Pinning them
// here too guarantees a verifier change can't pass without the shared fixtures
// (and every downstream consumer that imports them) still verifying.
// ───────────────────────────────────────────────────────────────────────────
describe('verifyMerkleInclusion ↔ canonical proof fixtures (PROOF-08)', () => {
  it('accepts the shared valid-inclusion fixture', () => {
    const v = proofFixtures.valid;
    const r = verifyMerkleInclusion(v.fingerprint, v.merkle_proof, v.merkle_root, {
      leafIndex: v.merkle_index,
      leafCount: v.leaf_count,
    });
    expect(r.valid).toBe(true);
  });

  it.each(
    proofFixtures.invalid
      .filter(isInclusionVector)
      .map((v) => ({ id: v.id, v })),
  )('rejects the shared $id fixture with the documented reason', ({ v }) => {
    const r = verifyMerkleInclusion(v.fingerprint, v.merkle_proof, v.merkle_root, {
      leafIndex: v.merkle_index,
      leafCount: v.leaf_count,
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(new RegExp(v.expect_invalid_reason!, 'i'));
  });
});
