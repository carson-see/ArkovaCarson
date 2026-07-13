/**
 * Merkle Tree Tests (MVP-23)
 *
 * Tests for buildMerkleTree() and verifyMerkleProof().
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { buildMerkleTree, verifyMerkleProof } from './merkle.js';
import type { MerkleProofEntry } from './merkle.js';

// Helper: generate a deterministic hex fingerprint from a seed string
function fakeFingerprint(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

// Helper: compute double-SHA256 of two hex buffers concatenated
function doubleSha256Hex(leftHex: string, rightHex: string): string {
  const concat = Buffer.concat([
    Buffer.from(leftHex, 'hex'),
    Buffer.from(rightHex, 'hex'),
  ]);
  const first = createHash('sha256').update(concat).digest();
  return createHash('sha256').update(first).digest('hex');
}

describe('buildMerkleTree', () => {
  it('throws when given an empty array', () => {
    expect(() => buildMerkleTree([])).toThrow(
      'Cannot build Merkle tree from empty array',
    );
  });

  it('returns the fingerprint itself as root for a single element', () => {
    const fp = fakeFingerprint('single');
    const result = buildMerkleTree([fp]);

    expect(result.root).toBe(fp);
    expect(result.leafCount).toBe(1);
    expect(result.proofs.get(fp)).toEqual([]);
  });

  it('computes correct root for two fingerprints', () => {
    const fp1 = fakeFingerprint('alpha');
    const fp2 = fakeFingerprint('beta');

    const result = buildMerkleTree([fp1, fp2]);

    const expectedRoot = doubleSha256Hex(fp1, fp2);
    expect(result.root).toBe(expectedRoot);
    expect(result.leafCount).toBe(2);
  });

  it('handles odd count by duplicating the last element (3 items)', () => {
    const fp1 = fakeFingerprint('one');
    const fp2 = fakeFingerprint('two');
    const fp3 = fakeFingerprint('three');

    const result = buildMerkleTree([fp1, fp2, fp3]);

    // Level 1: hash(fp1,fp2), hash(fp3,fp3)
    const left = doubleSha256Hex(fp1, fp2);
    const right = doubleSha256Hex(fp3, fp3);
    const expectedRoot = doubleSha256Hex(left, right);

    expect(result.root).toBe(expectedRoot);
    expect(result.leafCount).toBe(3);
  });

  it('is deterministic: same inputs produce same root', () => {
    const fps = [
      fakeFingerprint('a'),
      fakeFingerprint('b'),
      fakeFingerprint('c'),
      fakeFingerprint('d'),
    ];

    const result1 = buildMerkleTree(fps);
    const result2 = buildMerkleTree(fps);

    expect(result1.root).toBe(result2.root);
  });

  it('produces different roots for different inputs', () => {
    const fps1 = [fakeFingerprint('x'), fakeFingerprint('y')];
    const fps2 = [fakeFingerprint('y'), fakeFingerprint('x')];

    const result1 = buildMerkleTree(fps1);
    const result2 = buildMerkleTree(fps2);

    expect(result1.root).not.toBe(result2.root);
  });
});

describe('verifyMerkleProof', () => {
  it('verifies proof for all leaves in a 2-item tree', () => {
    const fp1 = fakeFingerprint('alpha');
    const fp2 = fakeFingerprint('beta');

    const result = buildMerkleTree([fp1, fp2]);

    expect(verifyMerkleProof(fp1, result.proofs.get(fp1)!, result.root)).toBe(
      true,
    );
    expect(verifyMerkleProof(fp2, result.proofs.get(fp2)!, result.root)).toBe(
      true,
    );
  });

  it('verifies proof for all leaves in a 3-item tree (odd count)', () => {
    const fp1 = fakeFingerprint('one');
    const fp2 = fakeFingerprint('two');
    const fp3 = fakeFingerprint('three');

    const result = buildMerkleTree([fp1, fp2, fp3]);

    expect(verifyMerkleProof(fp1, result.proofs.get(fp1)!, result.root)).toBe(
      true,
    );
    expect(verifyMerkleProof(fp2, result.proofs.get(fp2)!, result.root)).toBe(
      true,
    );
    expect(verifyMerkleProof(fp3, result.proofs.get(fp3)!, result.root)).toBe(
      true,
    );
  });

  it('verifies proof for all leaves in a 4-item tree', () => {
    const fps = [
      fakeFingerprint('a'),
      fakeFingerprint('b'),
      fakeFingerprint('c'),
      fakeFingerprint('d'),
    ];

    const result = buildMerkleTree(fps);

    for (const fp of fps) {
      expect(verifyMerkleProof(fp, result.proofs.get(fp)!, result.root)).toBe(
        true,
      );
    }
  });

  it('fails verification with wrong root', () => {
    const fp1 = fakeFingerprint('alpha');
    const fp2 = fakeFingerprint('beta');

    const result = buildMerkleTree([fp1, fp2]);
    const wrongRoot = fakeFingerprint('wrong');

    expect(verifyMerkleProof(fp1, result.proofs.get(fp1)!, wrongRoot)).toBe(
      false,
    );
  });

  it('fails verification with tampered proof', () => {
    const fp1 = fakeFingerprint('alpha');
    const fp2 = fakeFingerprint('beta');

    const result = buildMerkleTree([fp1, fp2]);
    const tamperedProof: MerkleProofEntry[] = [
      { hash: fakeFingerprint('tampered'), position: 'right' },
    ];

    expect(verifyMerkleProof(fp1, tamperedProof, result.root)).toBe(false);
  });

  it('fails verification with wrong fingerprint', () => {
    const fp1 = fakeFingerprint('alpha');
    const fp2 = fakeFingerprint('beta');

    const result = buildMerkleTree([fp1, fp2]);
    const wrongFp = fakeFingerprint('wrong');

    expect(verifyMerkleProof(wrongFp, result.proofs.get(fp1)!, result.root)).toBe(
      false,
    );
  });

  it('verifies all proofs in a large batch (100 items)', () => {
    const fps = Array.from({ length: 100 }, (_, i) =>
      fakeFingerprint(`item-${i}`),
    );

    const result = buildMerkleTree(fps);

    expect(result.leafCount).toBe(100);
    expect(result.root).toBeTruthy();

    // Verify every proof
    for (const fp of fps) {
      const proof = result.proofs.get(fp);
      expect(proof).toBeDefined();
      expect(verifyMerkleProof(fp, proof!, result.root)).toBe(true);
    }
  });

  it('returns empty proof for single-element tree', () => {
    const fp = fakeFingerprint('solo');
    const result = buildMerkleTree([fp]);

    expect(verifyMerkleProof(fp, [], result.root)).toBe(true);
  });
});

// =============================================================================
// S3-P0 (batch producer) — documented leaf-ordering contract, known vectors,
// and per-index proofs (duplicate-fingerprint correctness).
//
// CONTRACT (see buildMerkleTree docstring):
//   - Leaves are hashed in the EXACT array order given by the caller. The
//     batch producer sorts leaves by (fingerprint asc, anchor id asc) before
//     calling, making the root a pure function of the claimed leaf set.
//   - Internal nodes: double-SHA256(left ‖ right) — Bitcoin standard.
//   - Odd-node rule: a level with an odd node count duplicates its LAST
//     element (Bitcoin convention; the verify side carries the
//     CVE-2012-2459 structural guard for this).
// =============================================================================

describe('S3-P0 — known vectors (double-SHA256, odd-node duplication)', () => {
  const A = 'a'.repeat(64);
  const B = 'b'.repeat(64);
  const C = 'c'.repeat(64);
  const D = 'd'.repeat(64);
  const E = 'e'.repeat(64);

  // Precomputed with an independent double-SHA256 implementation:
  //   root2 = dSHA(A‖B)
  //   root3 = dSHA(dSHA(A‖B) ‖ dSHA(C‖C))          (odd level duplicates C)
  //   root4 = dSHA(dSHA(A‖B) ‖ dSHA(C‖D))
  //   root5 = dSHA(dSHA(dSHA(A‖B)‖dSHA(C‖D)) ‖ dSHA(dSHA(E‖E)‖dSHA(E‖E)))
  it('matches the 2-leaf known vector', () => {
    expect(buildMerkleTree([A, B]).root).toBe(
      '499d0d3b39373fb9b7b0f399b7411f7af213d91c32624280e995ae0f8eb776fb',
    );
  });

  it('matches the 3-leaf known vector (odd level duplicates the last leaf)', () => {
    expect(buildMerkleTree([A, B, C]).root).toBe(
      'd6f226837f442e34974d01825cbac711f4c358d1f564747d3d7203a2d4e94619',
    );
  });

  it('matches the 4-leaf known vector', () => {
    expect(buildMerkleTree([A, B, C, D]).root).toBe(
      'efe8b66f519d513b0fb54df9bfea1da6d31525e04b67a7e85ff5e97090fb02fd',
    );
  });

  it('matches the 5-leaf known vector (odd duplication at two levels)', () => {
    expect(buildMerkleTree([A, B, C, D, E]).root).toBe(
      'a86f0a7d69c167657112915b59528d860b6a3af4c4d0b1fed0b8813912af8992',
    );
  });

  it('leaf order is significant: [A,B] and [B,A] commit different roots', () => {
    expect(buildMerkleTree([A, B]).root).not.toBe(buildMerkleTree([B, A]).root);
  });
});

describe('S3-P0 — proofsByIndex (positional branches)', () => {
  it('returns one branch per leaf position, aligned with the input order', () => {
    const fps = [fakeFingerprint('p0'), fakeFingerprint('p1'), fakeFingerprint('p2')];
    const result = buildMerkleTree(fps);

    expect(result.proofsByIndex).toHaveLength(3);
    for (let i = 0; i < fps.length; i++) {
      expect(verifyMerkleProof(fps[i], result.proofsByIndex[i], result.root)).toBe(true);
    }
  });

  it('single-leaf tree yields one empty positional branch', () => {
    const fp = fakeFingerprint('solo-idx');
    const result = buildMerkleTree([fp]);
    expect(result.proofsByIndex).toEqual([[]]);
  });

  it('positional branches agree with the legacy fingerprint-keyed map for unique leaves', () => {
    const fps = ['u1', 'u2', 'u3', 'u4', 'u5'].map(fakeFingerprint);
    const result = buildMerkleTree(fps);
    for (let i = 0; i < fps.length; i++) {
      expect(result.proofsByIndex[i]).toEqual(result.proofs.get(fps[i]));
    }
  });

  it('DUPLICATE fingerprints: every position gets a branch that is valid FOR ITS OWN INDEX (structural CVE guard)', async () => {
    // Two different anchors can carry the same fingerprint (cross-user
    // duplicate). The legacy Map<fingerprint, branch> collapses them — the
    // last position's branch overwrites the first, so a stored
    // (merkle_index=i, branch-of-j) pair fails the CVE-2012-2459 structural
    // check. proofsByIndex must keep them distinct and index-consistent.
    const { verifyMerkleInclusion } = await import('./merkle-verify.js');
    const dup = fakeFingerprint('dup');
    const other = fakeFingerprint('other');
    // dup appears at index 0 AND index 2 (non-sibling positions).
    const fps = [dup, other, dup, fakeFingerprint('tail')];
    const result = buildMerkleTree(fps);

    for (let i = 0; i < fps.length; i++) {
      const verdict = verifyMerkleInclusion(fps[i], result.proofsByIndex[i], result.root, {
        leafIndex: i,
        leafCount: fps.length,
      });
      expect(verdict).toEqual({ valid: true });
    }
  });
});
