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
  /**
   * Legacy fingerprint-keyed branch map. NOTE: duplicate fingerprints share
   * ONE map entry whose levels interleave BOTH positions' siblings — unusable
   * as an inclusion branch for duplicated leaves. Use `proofsByIndex` when the
   * leaf's POSITION matters (S3-P0: `anchor_proofs.merkle_index` must pair
   * with the branch for that exact index or the CVE-2012-2459 structural
   * guard rejects the stored proof). Kept for back-compat with callers whose
   * leaf sets are unique (publicRecordAnchor, attestationAnchor, backfills).
   */
  proofs: Map<string, MerkleProofEntry[]>;
  /**
   * S3-P0: positional branches — `proofsByIndex[i]` is the inclusion branch
   * for the leaf at input index `i`. Length === leafCount. Correct for
   * duplicate fingerprints (each position keeps its own branch).
   */
  proofsByIndex: MerkleProofEntry[][];
  leafCount: number;
}

/**
 * Build a Merkle tree from an array of hex-encoded fingerprints.
 * Returns the root hash and inclusion proofs for each leaf.
 *
 * LEAF-ORDERING CONTRACT (S3-P0, documented): leaves are hashed in the EXACT
 * array order given by the caller — this function does not reorder. The batch
 * producer (`jobs/batch-anchor.ts`) sorts claimed anchors by
 * (fingerprint asc, anchor id asc) before calling, making the committed root a
 * pure function of the claimed leaf set (deterministic across crash/rerun).
 *
 * HASHING RULE: internal nodes are double-SHA256(left ‖ right) — Bitcoin
 * standard. ODD-NODE RULE: a level with an odd node count duplicates its LAST
 * element (Bitcoin convention). The verify side (`utils/merkle-verify.ts`)
 * carries the CVE-2012-2459 structural guard for the duplication.
 */
export function buildMerkleTree(fingerprints: string[]): MerkleTreeResult {
  if (fingerprints.length === 0) {
    throw new Error('Cannot build Merkle tree from empty array');
  }

  if (fingerprints.length === 1) {
    return {
      root: fingerprints[0],
      proofs: new Map([[fingerprints[0], []]]),
      proofsByIndex: [[]],
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

  // S3-P0: positional branches — one branch per input index, immune to the
  // duplicate-fingerprint collapse of the legacy map above.
  const proofsByIndex: MerkleProofEntry[][] = fingerprints.map(() => []);

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
      const entry: MerkleProofEntry = {
        hash: siblingHash,
        position: isLeft ? 'right' : 'left',
      };

      // Legacy map (pre-existing behavior: duplicate fingerprints interleave
      // into one shared entry — see MerkleTreeResult.proofs docstring).
      proofs.get(fingerprints[origIdx])!.push(entry);
      // Positional branch (each index keeps its own).
      proofsByIndex[origIdx].push(entry);

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
    proofsByIndex,
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
