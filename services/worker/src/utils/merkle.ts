/**
 * Merkle Tree Utilities (MVP-23)
 *
 * Combines multiple fingerprints into a single Merkle root for
 * efficient batch anchoring on Bitcoin.
 *
 * Uses double-SHA256 (Bitcoin standard) for internal nodes.
 * Odd-count levels duplicate the last element.
 */

import { createHash } from 'node:crypto';

/** Compute SHA-256 hash of a buffer */
function sha256(data: Uint8Array): Buffer {
  return createHash('sha256').update(data).digest();
}

/** Double-SHA-256 (Bitcoin standard) */
function doubleSha256(data: Uint8Array): Buffer {
  return sha256(sha256(data));
}

/** Merkle proof entry */
export interface MerkleProofEntry {
  hash: string;
  position: 'left' | 'right';
}

/** Result of building a Merkle tree */
export interface MerkleTreeResult {
  root: string;
  proofs: Map<string, MerkleProofEntry[]>;
  leafCount: number;
}

/**
 * Build a Merkle tree from an array of hex-encoded fingerprints.
 * Returns the root hash and inclusion proofs for each leaf.
 *
 * Uses double-SHA256 (Bitcoin standard) for internal nodes.
 * Odd-count levels duplicate the last element.
 */
export function buildMerkleTree(fingerprints: string[]): MerkleTreeResult {
  if (fingerprints.length === 0) {
    throw new Error('Cannot build Merkle tree from empty array');
  }

  if (fingerprints.length === 1) {
    return {
      root: fingerprints[0],
      proofs: new Map([[fingerprints[0], []]]),
      leafCount: 1,
    };
  }

  // Build tree bottom-up, tracking leaf indices for proof generation
  let level: Buffer[] = fingerprints.map((fp) => Buffer.from(fp, 'hex'));

  // Track each original leaf's current index as we move up levels
  const indexMap = new Map<number, number>();
  fingerprints.forEach((_, i) => indexMap.set(i, i));

  const proofs = new Map<string, MerkleProofEntry[]>();
  fingerprints.forEach((fp) => proofs.set(fp, []));

  while (level.length > 1) {
    const nextLevel: Buffer[] = [];

    // Duplicate last element if odd count
    if (level.length % 2 !== 0) {
      level.push(level[level.length - 1]);
    }

    // For each original fingerprint, record its sibling at this level
    for (let origIdx = 0; origIdx < fingerprints.length; origIdx++) {
      const curIdx = indexMap.get(origIdx)!;
      const isLeft = curIdx % 2 === 0;
      const siblingIdx = isLeft ? curIdx + 1 : curIdx - 1;
      const siblingHash = level[siblingIdx].toString('hex');

      proofs.get(fingerprints[origIdx])!.push({
        hash: siblingHash,
        position: isLeft ? 'right' : 'left',
      });

      // Update index for next level
      indexMap.set(origIdx, Math.floor(curIdx / 2));
    }

    for (let i = 0; i < level.length; i += 2) {
      nextLevel.push(doubleSha256(Buffer.concat([level[i], level[i + 1]])));
    }
    level = nextLevel;
  }

  return {
    root: level[0].toString('hex'),
    proofs,
    leafCount: fingerprints.length,
  };
}

/**
 * Verify a Merkle proof for a given fingerprint against a root.
 * Returns true if the proof is valid.
 */
export function verifyMerkleProof(
  fingerprint: string,
  proof: MerkleProofEntry[],
  root: string,
): boolean {
  let current: Uint8Array = Buffer.from(fingerprint, 'hex');

  for (const entry of proof) {
    const sibling: Uint8Array = Buffer.from(entry.hash, 'hex');
    current =
      entry.position === 'right'
        ? doubleSha256(Buffer.concat([current, sibling]))
        : doubleSha256(Buffer.concat([sibling, current]));
  }

  return Buffer.from(current).toString('hex') === root;
}
