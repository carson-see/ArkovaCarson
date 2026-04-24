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
import { createSignedBundle, staticEd25519Signer, type SignerFn } from '../../proof/signed-bundle.js';

const router = Router();

// Resolve the signer once per request. Returns null when neither env var is
// set so `?format=signed` can respond 503 (caller degrades to the legacy
// unsigned shape) instead of silently shipping an unsigned bundle.
// Production will swap `staticEd25519Signer` for a GCP KMS adapter; the
// `SignerFn` contract doesn't change.
function resolveSigner(): { sign: SignerFn; keyId: string } | null {
  const pem = process.env.PROOF_SIGNING_KEY_PEM;
  const keyId = process.env.PROOF_SIGNING_KEY_ID;
  if (!pem || !keyId) return null;
  return { sign: staticEd25519Signer(pem, keyId), keyId };
}

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

export interface ProofRecordData {
  merkle_root: string | null;
  proof_path: unknown;
  batch_id?: string | null;
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

function extractStoredProof(
  proof: ProofRecordData | null,
): { merkleRoot: string; merkleProof: MerkleProofEntry[]; batchId: string | null } | ProofErrorResponse | null {
  if (!proof?.merkle_root || !proof.proof_path) return null;
  if (!isValidProofArray(proof.proof_path)) {
    return { error: 'Merkle proof data is malformed' };
  }
  return {
    merkleRoot: proof.merkle_root,
    merkleProof: proof.proof_path,
    batchId: proof.batch_id ? String(proof.batch_id) : null,
  };
}

function extractMetadataProof(
  metadata: Record<string, unknown> | null,
): { merkleRoot: string; merkleProof: MerkleProofEntry[]; batchId: string | null } | ProofErrorResponse | null {
  if (!metadata?.merkle_root || !metadata.merkle_proof) return null;
  if (typeof metadata.merkle_root !== 'string') {
    return { error: 'Merkle proof data is malformed' };
  }
  if (metadata.batch_id != null && typeof metadata.batch_id !== 'string') {
    return { error: 'Merkle proof data is malformed' };
  }
  if (!isValidProofArray(metadata.merkle_proof)) {
    return { error: 'Merkle proof data is malformed' };
  }
  return {
    merkleRoot: metadata.merkle_root,
    merkleProof: metadata.merkle_proof,
    batchId: metadata.batch_id ?? null,
  };
}

/**
 * Build the proof response from anchor data.
 * Extracted for testability.
 */
export function buildProofResponse(
  anchor: ProofAnchorData,
  proof: ProofRecordData | null = null,
): MerkleProofResponse | ProofErrorResponse | null {
  const proofSource = extractStoredProof(proof) ?? extractMetadataProof(anchor.metadata);
  if (!proofSource) return null;
  if ('error' in proofSource) return proofSource;

  const isAnchored = anchor.status === 'SECURED' || anchor.status === 'SUBMITTED';

  return {
    public_id: anchor.public_id,
    fingerprint: anchor.fingerprint,
    merkle_root: proofSource.merkleRoot,
    merkle_proof: proofSource.merkleProof,
    tx_id: anchor.chain_tx_id,
    block_height: anchor.chain_block_height,
    block_timestamp: anchor.chain_timestamp,
    batch_id: proofSource.batchId,
    verified: isAnchored,
  };
}

/**
 * GET /api/v1/verify/:publicId/proof
 */
router.get('/:publicId/proof', async (req: Request<{ publicId: string }>, res: Response) => {
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
      // Generated DB types do not yet reflect the latest proof-table fields.
      // Keep the casts narrow to this route.
      const dbAny = db as any;
      const { data, error } = await db
        .from('anchors')
        .select('id, public_id, fingerprint, status, chain_tx_id, chain_block_height, chain_timestamp, metadata')
        .eq('public_id', publicId)
        .is('deleted_at', null)
        .single();

      if (error || !data) {
        anchor = null;
      } else {
        const { data: proofData } = await dbAny
          .from('anchor_proofs')
          .select('merkle_root, proof_path, batch_id')
          .eq('anchor_id', data.id)
          .maybeSingle();

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

        const result = buildProofResponse(
          anchor,
          proofData
            ? {
                merkle_root: proofData.merkle_root ?? null,
                proof_path: proofData.proof_path ?? null,
                batch_id: proofData.batch_id ?? null,
              }
            : null,
        );

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

        if ((req.query.format as string | undefined) === 'signed') {
          const signer = resolveSigner();
          if (!signer) {
            res.status(503).json({
              error:
                'Signed proof bundle is not configured in this environment. Set PROOF_SIGNING_KEY_PEM + PROOF_SIGNING_KEY_ID or call without ?format=signed.',
            } as ProofErrorResponse);
            return;
          }
          const bundle = await createSignedBundle({
            payload: result as unknown as Record<string, unknown>,
            sign: signer.sign,
          });
          res.json(bundle);
          return;
        }

        res.json(result);
        return;
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

    // Default shape is unchanged for backwards compatibility. `?format=signed`
    // wraps the payload in an Ed25519 envelope verifiable against our
    // published public key (docs.arkova.ai/keys.json).
    if ((req.query.format as string | undefined) === 'signed') {
      const signer = resolveSigner();
      if (!signer) {
        res.status(503).json({
          error:
            'Signed proof bundle is not configured in this environment. Set PROOF_SIGNING_KEY_PEM + PROOF_SIGNING_KEY_ID or call without ?format=signed.',
        } as ProofErrorResponse);
        return;
      }
      const bundle = await createSignedBundle({
        payload: result as unknown as Record<string, unknown>,
        sign: signer.sign,
      });
      res.json(bundle);
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
