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
