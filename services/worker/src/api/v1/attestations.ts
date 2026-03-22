/**
 * Attestations API (Phase II)
 *
 * POST   /api/v1/attestations          — Create a new attestation
 * GET    /api/v1/attestations/:publicId — Verify/retrieve an attestation
 * GET    /api/v1/attestations           — List attestations (filterable)
 * PATCH  /api/v1/attestations/:publicId/revoke — Revoke an attestation
 *
 * Attestations are immutable third-party claims about credentials, entities,
 * or processes, anchored to Bitcoin for tamper-evident proof.
 */

import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { createHash } from 'crypto';
import { z } from 'zod';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { verifyAuthToken } from '../../auth.js';
import { config } from '../../config.js';

const router = Router();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbAny = db as any;

// ─── Type Code Mapping ────────────────────────────────────
const ATTESTATION_TYPE_CODES: Record<string, string> = {
  VERIFICATION: 'VER',
  ENDORSEMENT: 'END',
  AUDIT: 'AUD',
  APPROVAL: 'APR',
  WITNESS: 'WIT',
  COMPLIANCE: 'COM',
  SUPPLY_CHAIN: 'SUP',
  IDENTITY: 'IDN',
  CUSTOM: 'CUS',
};

// ─── Schemas ───────────────────────────────────────────────

const CreateAttestationSchema = z.object({
  anchor_id: z.string().uuid().optional(),
  subject_type: z.enum(['credential', 'entity', 'process', 'asset']).default('credential'),
  subject_identifier: z.string().min(1).max(500),
  attestation_type: z.enum([
    'VERIFICATION', 'ENDORSEMENT', 'AUDIT', 'APPROVAL',
    'WITNESS', 'COMPLIANCE', 'SUPPLY_CHAIN', 'IDENTITY', 'CUSTOM',
  ]),
  attester_name: z.string().min(1).max(200),
  attester_type: z.enum(['INSTITUTION', 'CORPORATION', 'INDIVIDUAL', 'REGULATORY', 'THIRD_PARTY']).default('INSTITUTION'),
  attester_title: z.string().max(200).optional(),
  claims: z.array(z.object({
    claim: z.string().min(1),
    evidence: z.string().optional(),
  })).min(1).max(50),
  summary: z.string().max(2000).optional(),
  jurisdiction: z.string().max(100).optional(),
  evidence_fingerprint: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
  expires_at: z.string().datetime().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const ListAttestationsSchema = z.object({
  anchor_id: z.string().uuid().optional(),
  subject_identifier: z.string().optional(),
  attestation_type: z.string().optional(),
  status: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

// ─── Auth helper ───────────────────────────────────────────

async function requireAuth(req: Request, res: Response): Promise<string | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ') || authHeader.startsWith('Bearer ak_')) {
    // Also accept API key auth — look up the user from the key
    if (req.apiKey?.userId) {
      return req.apiKey.userId;
    }
    res.status(401).json({ error: 'Authentication required (JWT or API key)' });
    return null;
  }
  const token = authHeader.slice(7);
  const userId = await verifyAuthToken(token, config, logger);
  if (!userId) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return null;
  }
  return userId;
}

// ─── POST /api/v1/attestations ─────────────────────────────

router.post('/', async (req: Request, res: Response) => {
  const userId = await requireAuth(req, res);
  if (!userId) return;

  const parsed = CreateAttestationSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'validation_error',
      details: parsed.error.issues.map((i) => ({
        field: i.path.join('.'),
        message: i.message,
      })),
    });
    return;
  }

  const data = parsed.data;

  try {
    // Look up attester's org + org_prefix
    const { data: profile, error: profileError } = await db
      .from('profiles')
      .select('org_id')
      .eq('id', userId)
      .single();

    if (profileError) {
      logger.warn({ error: profileError, userId }, 'Profile lookup failed, defaulting to IND prefix');
    }

    let orgPrefix = 'IND'; // Default for individual users (no org)
    if (profile?.org_id) {
      const { data: org } = await dbAny
        .from('organizations')
        .select('org_prefix')
        .eq('id', profile.org_id)
        .single();
      if (org?.org_prefix) {
        orgPrefix = org.org_prefix;
      }
    }

    // Generate structured public ID: ARK-{org_prefix}-{type_code}-{unique_6}
    const typeCode = ATTESTATION_TYPE_CODES[data.attestation_type] ?? 'ATT';
    const issuedAt = new Date().toISOString();

    // Compute attestation fingerprint
    const attestationContent = JSON.stringify({
      subject_identifier: data.subject_identifier,
      attestation_type: data.attestation_type,
      attester_name: data.attester_name,
      claims: data.claims,
      issued_at: issuedAt,
    });
    const fingerprint = createHash('sha256').update(attestationContent).digest('hex');

    // Retry loop for public_id collision (max 3 attempts)
    const MAX_RETRIES = 3;
    let attestation = null;
    let insertError = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const uniquePart = randomUUID().slice(0, 6).toUpperCase();
      const publicId = `ARK-${orgPrefix}-${typeCode}-${uniquePart}`;

      const result = await dbAny
        .from('attestations')
        .insert({
          public_id: publicId,
          anchor_id: data.anchor_id ?? null,
          subject_type: data.subject_type,
          subject_identifier: data.subject_identifier,
          attester_org_id: profile?.org_id ?? null,
          attester_user_id: userId,
          attester_name: data.attester_name,
          attester_type: data.attester_type,
          attester_title: data.attester_title ?? null,
          attestation_type: data.attestation_type,
          claims: data.claims,
          summary: data.summary ?? null,
          jurisdiction: data.jurisdiction ?? null,
          evidence_fingerprint: data.evidence_fingerprint ?? null,
          fingerprint,
          status: 'PENDING',
          expires_at: data.expires_at ?? null,
          metadata: data.metadata ?? {},
        })
        .select('id, public_id, attestation_type, status, fingerprint, created_at')
        .single();

      if (!result.error) {
        attestation = result.data;
        insertError = null;
        break;
      }

      // Retry on unique constraint violation (public_id collision)
      if (result.error?.code === '23505') {
        logger.warn({ attempt, publicId }, 'Attestation public_id collision, retrying');
        continue;
      }

      // Non-collision error — stop retrying
      insertError = result.error;
      break;
    }

    if (insertError || !attestation) {
      logger.error({ error: insertError }, 'Failed to create attestation');
      res.status(500).json({ error: 'Failed to create attestation' });
      return;
    }

    logger.info({ publicId: attestation.public_id, attestationType: data.attestation_type, attester: data.attester_name }, 'Attestation created');

    res.status(201).json({
      public_id: attestation.public_id,
      attestation_id: attestation.id,
      attestation_type: attestation.attestation_type,
      status: attestation.status,
      fingerprint: attestation.fingerprint,
      created_at: attestation.created_at,
      verify_url: `https://app.arkova.io/verify/attestation/${attestation.public_id}`,
    });
  } catch (error) {
    logger.error({ error }, 'Attestation creation failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/v1/attestations/:publicId ────────────────────

router.get('/:publicId', async (req: Request, res: Response) => {
  const { publicId } = req.params;

  if (!publicId || publicId.length < 3) {
    res.status(400).json({ error: 'Invalid attestation ID' });
    return;
  }

  try {
    const { data: attestation, error } = await dbAny
      .from('attestations')
      .select('*')
      .eq('public_id', publicId)
      .single();

    if (error || !attestation) {
      res.status(404).json({ error: 'Attestation not found' });
      return;
    }

    // Check if expired
    const isExpired = attestation.expires_at && new Date(attestation.expires_at) < new Date();
    const effectiveStatus = isExpired && attestation.status === 'ACTIVE' ? 'EXPIRED' : attestation.status;

    // Build explorer URL if anchored
    let explorerUrl: string | null = null;
    if (attestation.chain_tx_id) {
      const network = config.bitcoinNetwork;
      const baseMap: Record<string, string> = {
        signet: 'https://mempool.space/signet',
        testnet: 'https://mempool.space/testnet',
        mainnet: 'https://mempool.space',
      };
      explorerUrl = `${baseMap[network] ?? baseMap.signet}/tx/${attestation.chain_tx_id}`;
    }

    // Fetch evidence count
    const { count: evidenceCount } = await dbAny
      .from('attestation_evidence')
      .select('*', { count: 'exact', head: true })
      .eq('attestation_id', attestation.id);

    // Look up linked credential info if anchor_id exists
    let linkedCredential: Record<string, unknown> | null = null;
    if (attestation.anchor_id) {
      const { data: anchor } = await db
        .from('anchors')
        .select('public_id, credential_type, status, chain_tx_id')
        .eq('id', attestation.anchor_id)
        .single();
      if (anchor) {
        linkedCredential = {
          public_id: anchor.public_id,
          credential_type: anchor.credential_type,
          verification_status: anchor.status === 'SECURED' ? 'VERIFIED' : anchor.status,
          verify_url: `https://app.arkova.io/verify/${anchor.public_id}`,
        };
      }
    }

    res.json({
      public_id: attestation.public_id,
      attestation_type: attestation.attestation_type,
      status: effectiveStatus,
      // Subject
      subject_type: attestation.subject_type,
      subject_identifier: attestation.subject_identifier,
      // Attester
      attester: {
        name: attestation.attester_name,
        type: attestation.attester_type,
        title: attestation.attester_title,
      },
      // Claims
      claims: attestation.claims,
      summary: attestation.summary,
      jurisdiction: attestation.jurisdiction,
      // Proof
      fingerprint: attestation.fingerprint,
      evidence_fingerprint: attestation.evidence_fingerprint,
      evidence_count: evidenceCount ?? 0,
      // Chain proof
      chain_proof: attestation.chain_tx_id ? {
        tx_id: attestation.chain_tx_id,
        block_height: attestation.chain_block_height,
        timestamp: attestation.chain_timestamp,
        explorer_url: explorerUrl,
      } : null,
      // Linked credential
      linked_credential: linkedCredential,
      // Lifecycle
      issued_at: attestation.issued_at,
      expires_at: attestation.expires_at,
      revoked_at: attestation.revoked_at,
      revocation_reason: attestation.revocation_reason,
      created_at: attestation.created_at,
      // URI
      verify_url: `https://app.arkova.io/verify/attestation/${attestation.public_id}`,
    });
  } catch (error) {
    logger.error({ error, publicId }, 'Attestation lookup failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/v1/attestations ──────────────────────────────

router.get('/', async (req: Request, res: Response) => {
  const parsed = ListAttestationsSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'validation_error', details: parsed.error.issues });
    return;
  }

  const { anchor_id, subject_identifier, attestation_type, status, page, limit } = parsed.data;

  try {
    let query = dbAny
      .from('attestations')
      .select('public_id, attestation_type, status, subject_type, subject_identifier, attester_name, attester_type, summary, issued_at, expires_at, created_at, fingerprint, chain_tx_id', { count: 'exact' });

    if (anchor_id) query = query.eq('anchor_id', anchor_id);
    if (subject_identifier) query = query.ilike('subject_identifier', `%${subject_identifier}%`);
    if (attestation_type) query = query.eq('attestation_type', attestation_type);
    if (status) query = query.eq('status', status);

    const offset = (page - 1) * limit;
    const { data: attestations, count, error } = await query
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      logger.error({ error }, 'Attestation list query failed');
      res.status(500).json({ error: 'Query failed' });
      return;
    }

    res.json({
      attestations: (attestations ?? []).map((a: Record<string, unknown>) => ({
        ...a,
        verify_url: `https://app.arkova.io/verify/attestation/${a.public_id}`,
      })),
      total: count ?? 0,
      page,
      limit,
    });
  } catch (error) {
    logger.error({ error }, 'Attestation list failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── PATCH /api/v1/attestations/:publicId/revoke ───────────

router.patch('/:publicId/revoke', async (req: Request, res: Response) => {
  const userId = await requireAuth(req, res);
  if (!userId) return;

  const { publicId } = req.params;
  const { reason } = req.body as { reason?: string };

  if (!reason || reason.length < 3) {
    res.status(400).json({ error: 'Revocation reason is required (min 3 characters)' });
    return;
  }

  try {
    // Verify ownership
    const { data: attestation, error: findError } = await dbAny
      .from('attestations')
      .select('id, status, attester_user_id')
      .eq('public_id', publicId)
      .single();

    if (findError || !attestation) {
      res.status(404).json({ error: 'Attestation not found' });
      return;
    }

    if (attestation.attester_user_id !== userId) {
      res.status(403).json({ error: 'Only the attester can revoke an attestation' });
      return;
    }

    if (attestation.status === 'REVOKED') {
      res.status(409).json({ error: 'Attestation is already revoked' });
      return;
    }

    const { error: updateError } = await dbAny
      .from('attestations')
      .update({
        status: 'REVOKED',
        revoked_at: new Date().toISOString(),
        revocation_reason: reason,
      })
      .eq('id', attestation.id);

    if (updateError) {
      logger.error({ error: updateError }, 'Attestation revocation failed');
      res.status(500).json({ error: 'Revocation failed' });
      return;
    }

    logger.info({ publicId, reason }, 'Attestation revoked');
    res.json({ public_id: publicId, status: 'REVOKED', revoked_at: new Date().toISOString() });
  } catch (error) {
    logger.error({ error }, 'Attestation revocation error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as attestationsRouter };
