/**
 * GET /api/v1/verify/:publicId (P4.5-TS-01)
 *
 * Public anchor verification by publicId. Returns the frozen verification
 * response schema (CLAUDE.md Section 10).
 *
 * This endpoint accepts a publicId (e.g., ARK-2026-TEST-001), NOT a
 * fingerprint. For fingerprint-based verification, use POST /api/verify-anchor.
 */

import { Router } from 'express';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

const router = Router();

/** Full frozen schema result per CLAUDE.md Section 10 */
export interface VerificationResult {
  verified: boolean;
  status?: 'ACTIVE' | 'REVOKED' | 'SUPERSEDED' | 'EXPIRED' | 'PENDING';
  issuer_name?: string;
  recipient_identifier?: string;
  credential_type?: string;
  issued_date?: string | null;
  expiry_date?: string | null;
  anchor_timestamp?: string;
  bitcoin_block?: number | null;
  network_receipt_id?: string | null;
  merkle_proof_hash?: string | null;
  record_uri?: string;
  jurisdiction?: string;
  error?: string;
}

function mapStatus(status: string): VerificationResult['status'] {
  switch (status) {
    case 'SECURED':
    case 'ACTIVE':
      return 'ACTIVE';
    case 'REVOKED':
      return 'REVOKED';
    case 'SUPERSEDED':
      return 'SUPERSEDED';
    case 'EXPIRED':
      return 'EXPIRED';
    case 'PENDING':
      return 'PENDING';
    default:
      return undefined;
  }
}

/**
 * Lookup anchor by publicId from the database.
 * Injectable for testing.
 */
export interface PublicIdLookup {
  lookupByPublicId(publicId: string): Promise<AnchorByPublicId | null>;
}

export interface AnchorByPublicId {
  public_id: string;
  fingerprint: string;
  status: string;
  chain_tx_id: string | null;
  chain_block_height: number | null;
  chain_timestamp: string | null;
  created_at: string;
  credential_type: string | null;
  org_name: string | null;
  recipient_hash: string | null;
  issued_at: string | null;
  expires_at: string | null;
  jurisdiction: string | null;
  merkle_root: string | null;
}

/**
 * Core verification logic — extracted for testability.
 */
export function buildVerificationResult(anchor: AnchorByPublicId): VerificationResult {
  const publicStatus = mapStatus(anchor.status);
  const isVerified = anchor.status === 'SECURED' || anchor.status === 'ACTIVE';

  const result: VerificationResult = {
    verified: isVerified,
    status: publicStatus,
    anchor_timestamp: anchor.created_at,
    bitcoin_block: anchor.chain_block_height ?? null,
    network_receipt_id: anchor.chain_tx_id ?? null,
    merkle_proof_hash: anchor.merkle_root ?? null,
    record_uri: `https://app.arkova.io/verify/${anchor.public_id}`,
  };

  if (anchor.credential_type) {
    result.credential_type = anchor.credential_type;
  }
  if (anchor.org_name) {
    result.issuer_name = anchor.org_name;
  }
  if (anchor.recipient_hash) {
    result.recipient_identifier = anchor.recipient_hash;
  }
  if (anchor.issued_at !== undefined) {
    result.issued_date = anchor.issued_at;
  }
  if (anchor.expires_at !== undefined) {
    result.expiry_date = anchor.expires_at;
  }
  // Frozen schema: omit jurisdiction when null, never return null
  if (anchor.jurisdiction) {
    result.jurisdiction = anchor.jurisdiction;
  }

  return result;
}

/** Default DB-backed lookup */
const defaultLookup: PublicIdLookup = {
  async lookupByPublicId(publicId: string) {
    const { data, error } = await db
      .from('anchors')
      .select(`
        public_id,
        fingerprint,
        status,
        chain_tx_id,
        chain_block_height,
        chain_timestamp,
        created_at,
        credential_type,
        issued_at,
        expires_at,
        org_id
      `)
      .eq('public_id', publicId)
      .is('deleted_at', null)
      .single();

    if (error || !data) return null;

    // Look up org name separately
    let orgName: string | null = null;
    if (data.org_id) {
      const { data: org } = await db
        .from('organizations')
        .select('display_name')
        .eq('id', data.org_id)
        .single();
      orgName = org?.display_name ?? null;
    }

    return {
      public_id: data.public_id ?? '',
      fingerprint: data.fingerprint,
      status: data.status,
      chain_tx_id: data.chain_tx_id,
      chain_block_height: data.chain_block_height,
      chain_timestamp: data.chain_timestamp,
      created_at: data.created_at,
      credential_type: data.credential_type,
      org_name: orgName,
      recipient_hash: null,
      issued_at: data.issued_at,
      expires_at: data.expires_at,
      jurisdiction: null,
      merkle_root: null,
    } as AnchorByPublicId;
  },
};

/**
 * GET /api/v1/verify/:publicId
 */
router.get('/:publicId', async (req, res) => {
  const { publicId } = req.params;

  if (!publicId || publicId.length < 3) {
    res.status(400).json({
      verified: false,
      error: 'Invalid publicId parameter',
    });
    return;
  }

  try {
    const lookup = (req as unknown as { _testLookup?: PublicIdLookup })._testLookup ?? defaultLookup;
    const anchor = await lookup.lookupByPublicId(publicId);

    if (!anchor) {
      res.status(404).json({
        verified: false,
        error: 'Record not found',
      });
      return;
    }

    const result = buildVerificationResult(anchor);
    res.json(result);
  } catch (err) {
    logger.error({ error: err, publicId }, 'Verification lookup failed');
    res.status(500).json({
      verified: false,
      error: 'Internal server error',
    });
  }
});

export { router as verifyRouter };
