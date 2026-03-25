/**
 * GET /api/v1/verify/:publicId/proof (BTC-003)
 *
 * Returns the Merkle inclusion proof for a batch-anchored document.
 * Enables independent client-side verification that a document's
 * fingerprint is included in the on-chain Merkle root.
 *
 * Response includes:
 *   - merkle_proof: array of sibling hashes + positions
 *   - merkle_root: the root committed on-chain
 *   - tx_id: Bitcoin transaction containing the root
 *   - block_height / block_timestamp: confirmation details
 *   - batch_id: internal batch identifier
 */

import { Router, Request, Response } from 'express';

const router = Router();

/** Merkle proof entry matching the stored format */
export interface MerkleProofEntry {
  hash: string;
  position: 'left' | 'right';
}

/** Response shape for the proof endpoint */
export interface MerkleProofResponse {
  public_id: string;
  fingerprint: string;
  merkle_root: string;
  merkle_proof: MerkleProofEntry[];
  tx_id: string | null;
  block_height: number | null;
  block_timestamp: string | null;
  batch_id: string | null;
  verified: boolean;
}

/** Error response */
export interface ProofErrorResponse {
  error: string;
}

/** Injectable lookup for testing */
export interface ProofLookup {
  lookupByPublicId(publicId: string): Promise<ProofAnchorData | null>;
}

export interface ProofAnchorData {
  public_id: string;
  fingerprint: string;
  status: string;
  chain_tx_id: string | null;
  chain_block_height: number | null;
  chain_timestamp: string | null;
  metadata: Record<string, unknown> | null;
}

/**
 * Validate that a merkle_proof array from metadata has the correct shape.
 */
export function isValidProofArray(arr: unknown): arr is MerkleProofEntry[] {
  if (!Array.isArray(arr)) return false;
  return arr.every(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof entry.hash === 'string' &&
      (entry.position === 'left' || entry.position === 'right'),
  );
}

/**
 * Build the proof response from anchor data.
 * Extracted for testability.
 */
export function buildProofResponse(
  anchor: ProofAnchorData,
): MerkleProofResponse | ProofErrorResponse | null {
  const meta = anchor.metadata;
  if (!meta || !meta.merkle_proof || !meta.merkle_root) {
    return null; // signals "no proof available"
  }

  if (!isValidProofArray(meta.merkle_proof)) {
    return { error: 'Merkle proof data is malformed' };
  }

  const isAnchored = anchor.status === 'SECURED' || anchor.status === 'SUBMITTED';

  return {
    public_id: anchor.public_id,
    fingerprint: anchor.fingerprint,
    merkle_root: String(meta.merkle_root),
    merkle_proof: meta.merkle_proof,
    tx_id: anchor.chain_tx_id,
    block_height: anchor.chain_block_height,
    block_timestamp: anchor.chain_timestamp,
    batch_id: meta.batch_id ? String(meta.batch_id) : null,
    verified: isAnchored,
  };
}

/**
 * GET /api/v1/verify/:publicId/proof
 */
router.get('/:publicId/proof', async (req: Request, res: Response) => {
  const { publicId } = req.params;

  if (!publicId || publicId.length < 3) {
    res.status(400).json({ error: 'Invalid publicId parameter' } as ProofErrorResponse);
    return;
  }

  try {
    // Use injected lookup for tests, lazy-import db for production
    const lookup = (req as unknown as { _testLookup?: ProofLookup })._testLookup;
    let anchor: ProofAnchorData | null;

    if (lookup) {
      anchor = await lookup.lookupByPublicId(publicId);
    } else {
      const { db } = await import('../../utils/db.js');
      const { data, error } = await db
        .from('anchors')
        .select('public_id, fingerprint, status, chain_tx_id, chain_block_height, chain_timestamp, metadata')
        .eq('public_id', publicId)
        .is('deleted_at', null)
        .single();

      if (error || !data) {
        anchor = null;
      } else {
        anchor = {
          public_id: data.public_id ?? '',
          fingerprint: data.fingerprint,
          status: data.status,
          chain_tx_id: data.chain_tx_id,
          chain_block_height: data.chain_block_height,
          chain_timestamp: data.chain_timestamp,
          metadata: typeof data.metadata === 'object' && data.metadata !== null
            ? data.metadata as Record<string, unknown>
            : null,
        };
      }
    }

    if (!anchor) {
      res.status(404).json({ error: 'Record not found' } as ProofErrorResponse);
      return;
    }

    const result = buildProofResponse(anchor);

    if (result === null) {
      res.status(404).json({
        error: 'No Merkle proof available for this record. It may not have been batch-anchored.',
      } as ProofErrorResponse);
      return;
    }

    if ('error' in result) {
      res.status(500).json(result);
      return;
    }

    res.json(result);
  } catch (err) {
    // Lazy-import logger to avoid config chain in tests
    try {
      const { logger } = await import('../../utils/logger.js');
      logger.error({ error: err, publicId }, 'Merkle proof lookup failed');
    } catch {
      console.error('Merkle proof lookup failed:', err);
    }
    res.status(500).json({ error: 'Internal server error' } as ProofErrorResponse);
  }
});

export { router as verifyProofRouter };
