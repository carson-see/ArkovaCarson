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
import { z } from 'zod';
import { buildVerifyUrl } from '../../lib/urls.js';
import {
  ANCHOR_CREDENTIAL_TYPES,
  hasPublicCredentialEvidenceMetadataKeys,
  parsePublicCredentialEvidenceMetadata,
} from '../../lib/credential-evidence.js';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { deductOrgCredit } from '../../utils/orgCredits.js';

const router = Router();

// Frozen request shape per CLAUDE.md §1.8 — additive nullable fields only.
// Fingerprint must be 64-char hex (SHA-256). Description capped to keep
// inserts predictable and PostgREST payload size bounded. Metadata keys
// are restricted to safe identifier characters so prototype-pollution-
// adjacent keys (`__proto__`, `constructor`, `prototype`) cannot ride
// through downstream code that may spread metadata into a fresh object.
const SAFE_METADATA_KEY = /^[a-zA-Z0-9_.-]+$/;
const AnchorSubmitSchema = z.object({
  fingerprint: z.string().regex(/^[a-fA-F0-9]{64}$/, 'must be a 64-character hex SHA-256 hash'),
  credential_type: z.enum(ANCHOR_CREDENTIAL_TYPES).optional(),
  description: z.string().max(1000).optional(),
  metadata: z.record(z.string().regex(SAFE_METADATA_KEY, 'metadata keys must match [a-zA-Z0-9_.-]+'), z.unknown()).optional(),
}).strict();

type AnchorSubmitRequest = z.infer<typeof AnchorSubmitSchema>;

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

  // Zod validation per CLAUDE.md §1.2 ("Validation: Zod. Every write path.")
  // Returns RFC 7807-style problem+JSON on validation failure so client
  // integrations can surface field-level errors to their users.
  const parsed = AnchorSubmitSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'invalid_request',
      message: 'Request body failed validation',
      details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), code: i.code, message: i.message })),
    });
    return;
  }
  const body: AnchorSubmitRequest = parsed.data;

  const fingerprint = body.fingerprint.toLowerCase();
  const publicSafeCredentialEvidenceMetadata = parsePublicCredentialEvidenceMetadata(body.metadata);
  if (body.metadata && hasPublicCredentialEvidenceMetadataKeys(body.metadata) && !publicSafeCredentialEvidenceMetadata) {
    res.status(400).json({
      error: 'invalid_request',
      message: 'Request body failed validation',
      details: [{ path: 'metadata', code: 'invalid_credential_evidence_metadata', message: 'Credential evidence metadata is invalid or not public-safe' }],
    });
    return;
  }

  try {
    // Check for duplicate fingerprint (idempotent — return existing if already anchored)
    const { data: existing } = await db
      .from('anchors')
      .select('public_id, fingerprint, status, created_at')
      .eq('fingerprint', fingerprint)
      .is('deleted_at', null)
      .maybeSingle();

    if (existing) {
      const existingPublicId = existing.public_id ?? '';
      const receipt: AnchorReceipt = {
        public_id: existingPublicId,
        fingerprint: existing.fingerprint,
        status: 'PENDING',
        created_at: existing.created_at,
        record_uri: buildVerifyUrl(existingPublicId),
      };
      res.status(200).json(receipt);
      return;
    }

    // Generate public_id
    const shortId = randomUUID().slice(0, 8).toUpperCase();
    const publicId = `ARK-${new Date().getFullYear()}-${shortId}`;

    // Get org_id from API key
    const orgId = req.apiKey.orgId ?? null;

    // SCRUM-1170-B — gate org-credit deduction. Helper short-circuits to
    // allowed=true when ENABLE_ORG_CREDIT_ENFORCEMENT is off (default), so
    // existing API-key paths without per-org credit setup are unaffected.
    if (orgId) {
      const deduction = await deductOrgCredit(db, orgId, 1, 'anchor.create');
      if (!deduction.allowed && deduction.error === 'insufficient_credits') {
        res.status(402).json({
          error: 'insufficient_credits',
          message: 'Organization has insufficient anchor credits for this cycle.',
          balance: deduction.balance,
          required: deduction.required,
        });
        return;
      }
      if (!deduction.allowed && deduction.error === 'rpc_failure') {
        logger.error({ err: deduction.message, orgId }, 'org_credit_deduct_rpc_failure');
        // Fail closed only when enforcement is on. The helper's feature_disabled
        // short-circuit returns allowed=true so this branch is unreachable in the
        // off state.
        res.status(503).json({ error: 'credit_check_unavailable' });
        return;
      }
      // org_not_initialized in enforcement mode = fail closed. If enforcement
      // is ON and the org has no credit row, that's a pre-flight error, not a
      // bypass. Letting it through silently would leak free anchors when an
      // operator forgets to seed before flipping the flag (codex review).
      if (!deduction.allowed && deduction.error === 'org_not_initialized') {
        logger.warn({ orgId }, 'org_credit_deduct_blocked_uninitialized');
        res.status(402).json({
          error: 'org_credits_not_initialized',
          message:
            'This organization is not provisioned for credit-based billing. ' +
            'An operator must seed org_credits before this API key can submit.',
        });
        return;
      }
    }

    // credential_type already validated by Zod enum; defaults to 'OTHER'.
    const credentialType = body.credential_type ?? 'OTHER';
    const { data: anchor, error: insertError } = await db
      .from('anchors')
      .insert({
        fingerprint,
        public_id: publicId,
        status: 'PENDING' as const,
        org_id: orgId,
        user_id: req.apiKey.userId,
        filename: `api-${fingerprint.slice(0, 12)}`,
        credential_type: credentialType,
        description: body.description ?? null,
        metadata: publicSafeCredentialEvidenceMetadata,
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
      record_uri: buildVerifyUrl(anchor.public_id ?? publicId),
    };

    logger.info({ publicId, fingerprint: fingerprint.slice(0, 12) }, 'Anchor submitted via API');
    res.status(201).json(receipt);
  } catch (error) {
    logger.error({ error }, 'Anchor submission failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as anchorSubmitRouter };
