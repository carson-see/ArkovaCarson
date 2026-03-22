/**
 * POST /api/v1/anchor (Agent SDK endpoint)
 *
 * Submits a fingerprint for anchoring. Returns a receipt with the public_id
 * that can be used for later verification.
 *
 * Requires API key authentication (X-API-Key header).
 * Constitution 1.6: Documents never leave the user's device — only fingerprints are accepted.
 */

import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

const router = Router();

interface AnchorSubmitRequest {
  fingerprint: string;
  credential_type?: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

interface AnchorReceipt {
  public_id: string;
  fingerprint: string;
  status: 'PENDING';
  created_at: string;
  record_uri: string;
}

/**
 * POST /api/v1/anchor
 *
 * Submit a fingerprint for blockchain anchoring.
 * The fingerprint must be a 64-character hex SHA-256 hash.
 */
router.post('/', async (req: Request, res: Response) => {
  // Require API key
  if (!req.apiKey) {
    res.status(401).json({ error: 'API key required. Include X-API-Key header.' });
    return;
  }

  const body = req.body as AnchorSubmitRequest;

  // Validate fingerprint — must be 64-char hex SHA-256
  if (!body.fingerprint || !/^[a-fA-F0-9]{64}$/.test(body.fingerprint)) {
    res.status(400).json({
      error: 'Invalid fingerprint. Must be a 64-character hex SHA-256 hash.',
    });
    return;
  }

  const fingerprint = body.fingerprint.toLowerCase();

  try {
    // Check for duplicate fingerprint (idempotent — return existing if already anchored)
    const { data: existing } = await db
      .from('anchors')
      .select('public_id, fingerprint, status, created_at')
      .eq('fingerprint', fingerprint)
      .is('deleted_at', null)
      .maybeSingle();

    if (existing) {
      const receipt: AnchorReceipt = {
        public_id: existing.public_id ?? '',
        fingerprint: existing.fingerprint,
        status: 'PENDING',
        created_at: existing.created_at,
        record_uri: `https://app.arkova.io/verify/${existing.public_id ?? ''}`,
      };
      res.status(200).json(receipt);
      return;
    }

    // Generate public_id
    const shortId = randomUUID().slice(0, 8).toUpperCase();
    const publicId = `ARK-${new Date().getFullYear()}-${shortId}`;

    // Get org_id from API key
    const orgId = req.apiKey.orgId ?? null;

    // Insert anchor record
    // credential_type must match the enum — default to 'OTHER' for SDK submissions
    const credType = (body.credential_type ?? 'OTHER') as 'DEGREE' | 'LICENSE' | 'CERTIFICATE' | 'TRANSCRIPT' | 'PROFESSIONAL' | 'OTHER';
    const validTypes = ['DEGREE', 'LICENSE', 'CERTIFICATE', 'TRANSCRIPT', 'PROFESSIONAL', 'OTHER'];
    const { data: anchor, error: insertError } = await db
      .from('anchors')
      .insert({
        fingerprint,
        public_id: publicId,
        status: 'PENDING' as const,
        org_id: orgId,
        user_id: req.apiKey.userId,
        filename: `api-${fingerprint.slice(0, 12)}`,
        credential_type: validTypes.includes(credType) ? credType : 'OTHER',
        description: body.description ?? null,
      })
      .select('public_id, fingerprint, status, created_at')
      .single();

    if (insertError) {
      logger.error({ error: insertError, fingerprint }, 'Failed to create anchor');
      res.status(500).json({ error: 'Failed to create anchor record' });
      return;
    }

    const receipt: AnchorReceipt = {
      public_id: anchor.public_id ?? publicId,
      fingerprint: anchor.fingerprint,
      status: 'PENDING',
      created_at: anchor.created_at,
      record_uri: `https://app.arkova.io/verify/${anchor.public_id ?? publicId}`,
    };

    logger.info({ publicId, fingerprint: fingerprint.slice(0, 12) }, 'Anchor submitted via API');
    res.status(201).json(receipt);
  } catch (error) {
    logger.error({ error }, 'Anchor submission failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as anchorSubmitRouter };
