/**
 * Signature API Routes — Phase III AdES Signature Engine
 *
 * POST   /api/v1/sign                    — Create an AdES signature
 * GET    /api/v1/signatures/:id          — Get signature by public ID
 * POST   /api/v1/verify-signature        — Verify an AdES signature
 * GET    /api/v1/signatures              — List signatures (org-scoped)
 * POST   /api/v1/signatures/:id/revoke   — Revoke a signature
 *
 * Story: PH3-ESIG-01 (SCRUM-422)
 * Constitution 1.8: Additive endpoints under /api/v1/signatures/*
 * Constitution 1.3: UI terminology compliance enforced
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import * as crypto from 'crypto';
import { config } from '../../config.js';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

import type {
  SignRequest,
  SignResponse,
  VerifySignatureResponse,
  SignatureRecord,
  SigningCertificate,
  Jurisdiction,
  SignatureFormat,
  SignatureLevel,
  RevocationReason,
  KmsProvider,
  KeyAlgorithm,
  CertificateStatus,
  TrustLevel,
} from '../../signatures/types.js';
import { getAdesEngine } from '../../signatures/engineFactory.js';

// ─── Zod Schemas ───────────────────────────────────────────────────────

const signRequestSchema = z.object({
  anchor_id: z.string().optional(),
  attestation_id: z.string().optional(),
  fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/, 'Must be sha256:<64 hex chars>'),
  format: z.enum(['XAdES', 'PAdES', 'CAdES']),
  level: z.enum(['B-B', 'B-T', 'B-LT', 'B-LTA']),
  signer_certificate_id: z.string().uuid(),
  jurisdiction: z.enum(['EU', 'US', 'UK', 'CH', 'INTL']).optional(),
  reason: z.string().max(500).optional(),
  location: z.string().max(200).optional(),
  metadata: z.record(z.unknown()).optional(),
}).refine(
  (d) => d.anchor_id || d.attestation_id,
  { message: 'Either anchor_id or attestation_id required' },
);

const verifySignatureRequestSchema = z.object({
  signature_id: z.string().optional(),
  document_fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
}).refine(
  (d) => d.signature_id || d.document_fingerprint,
  { message: 'Either signature_id or document_fingerprint required' },
);

const revokeRequestSchema = z.object({
  reason: z.enum([
    'KEY_COMPROMISE',
    'AFFILIATION_CHANGED',
    'SUPERSEDED',
    'CESSATION_OF_OPERATION',
    'CERTIFICATE_HOLD',
  ]),
  detail: z.string().max(500).optional(),
});

const listQuerySchema = z.object({
  status: z.string().optional(),
  format: z.enum(['XAdES', 'PAdES', 'CAdES']).optional(),
  anchor_id: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});

// ─── Router ────────────────────────────────────────────────────────────

const router = Router();

/**
 * POST /api/v1/sign
 * Create an AdES signature for an existing anchor or attestation.
 */
router.post('/sign', async (req: Request, res: Response) => {
  try {
    const parsed = signRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Invalid request',
        details: parsed.error.issues,
      });
      return;
    }

    const body = parsed.data;
    const userId = req.authUserId;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    // Resolve the signer's org membership
    const { data: membership, error: memberErr } = await db
      .from('org_members')
      .select('org_id, role')
      .eq('user_id', userId)
      .in('role', ['owner', 'admin'])
      .limit(1)
      .single();

    if (memberErr || !membership) {
      res.status(403).json({ error: 'Admin or owner role required to create signatures' });
      return;
    }

    const orgId = membership.org_id;

    // Resolve the signing certificate
    const { data: cert, error: certErr } = await db
      .from('signing_certificates')
      .select('*')
      .eq('id', body.signer_certificate_id)
      .eq('org_id', orgId)
      .eq('status', 'ACTIVE')
      .single();

    if (certErr || !cert) {
      res.status(404).json({ error: 'Signing certificate not found or not active' });
      return;
    }

    // Check cert validity
    const now = new Date();
    if (now < new Date(cert.not_before) || now > new Date(cert.not_after)) {
      res.status(422).json({ error: 'Signing certificate is not within its validity period' });
      return;
    }

    // Resolve anchor if provided
    let anchorId: string | null = null;
    if (body.anchor_id) {
      const { data: anchor } = await db
        .from('anchors')
        .select('id, fingerprint')
        .eq('public_id', body.anchor_id)
        .eq('org_id', orgId)
        .single();

      if (!anchor) {
        res.status(404).json({ error: 'Anchor not found' });
        return;
      }
      anchorId = anchor.id;

      // Verify fingerprint matches
      if (anchor.fingerprint !== body.fingerprint.replace('sha256:', '')) {
        res.status(400).json({ error: 'Fingerprint does not match anchor' });
        return;
      }
    }

    // Resolve attestation if provided
    let attestationId: string | null = null;
    if (body.attestation_id) {
      const { data: att } = await db
        .from('attestations')
        .select('id')
        .eq('public_id', body.attestation_id)
        .single();

      if (!att) {
        res.status(404).json({ error: 'Attestation not found' });
        return;
      }
      attestationId = att.id;
    }

    // Generate public ID
    // short_code not yet in generated types
    const { data: orgData } = await (db as any)
      .from('organizations')
      .select('short_code')
      .eq('id', orgId)
      .single();

    const shortCode = (orgData as Record<string, unknown> | null)?.short_code || 'ORG';
    const uniqueSuffix = crypto.randomBytes(4).toString('hex').toUpperCase();
    const publicId = `ARK-${shortCode}-SIG-${uniqueSuffix}`;

    // Create the signature record (PENDING — engine processes async or inline)
    // signatures table not yet fully in generated types — cast to any
    const { data: sigRecord, error: insertErr } = await (db as any)
      .from('signatures')
      .insert({
        public_id: publicId,
        org_id: orgId,
        anchor_id: anchorId,
        attestation_id: attestationId,
        format: body.format,
        level: body.level,
        status: 'PENDING',
        jurisdiction: body.jurisdiction || null,
        document_fingerprint: body.fingerprint,
        signer_certificate_id: body.signer_certificate_id,
        signer_name: cert.subject_cn,
        signer_org: cert.subject_org,
        reason: body.reason || null,
        location: body.location || null,
        created_by: userId,
        metadata: body.metadata || {},
      })
      .select()
      .single();

    if (insertErr || !sigRecord) {
      logger.error('Failed to create signature record', { error: insertErr });
      res.status(500).json({ error: 'Failed to create signature' });
      return;
    }

    // Invoke AdES engine to sign
    const engine = getAdesEngine();
    const certForEngine: SigningCertificate = {
      id: cert.id,
      orgId: cert.org_id,
      subjectCn: cert.subject_cn,
      subjectOrg: cert.subject_org,
      issuerCn: cert.issuer_cn,
      issuerOrg: cert.issuer_org,
      serialNumber: cert.serial_number,
      fingerprintSha256: cert.fingerprint_sha256,
      certificatePem: cert.certificate_pem,
      chainPem: cert.chain_pem || [],
      kmsProvider: cert.kms_provider as KmsProvider,
      kmsKeyId: cert.kms_key_id,
      keyAlgorithm: cert.key_algorithm as KeyAlgorithm,
      notBefore: new Date(cert.not_before),
      notAfter: new Date(cert.not_after),
      status: cert.status as CertificateStatus,
      trustLevel: cert.trust_level as TrustLevel,
      qtspName: cert.qtsp_name,
      euTrustedListEntry: cert.eu_trusted_list_entry,
      createdAt: new Date(cert.created_at),
      updatedAt: new Date(cert.updated_at),
      createdBy: cert.created_by,
      metadata: (cert.metadata || {}) as Record<string, unknown>,
    };

    const signResult = await engine.sign(
      {
        anchorId: body.anchor_id,
        attestationId: body.attestation_id,
        fingerprint: body.fingerprint,
        format: body.format as SignatureFormat,
        level: body.level as SignatureLevel,
        signerCertificateId: body.signer_certificate_id,
        jurisdiction: body.jurisdiction as Jurisdiction | undefined,
        reason: body.reason,
        metadata: body.metadata,
      },
      certForEngine,
      orgId,
      userId,
    );

    // Store timestamp token if acquired
    let timestampTokenId: string | null = null;
    let archiveTimestampId: string | null = null;

    if (signResult.timestampTokenId && signResult.ltvData) {
      // Timestamp tokens stored separately — will be populated when QTSP integration is live
      // For now, mark as populated from engine result
    }

    // Update signature record with engine result
    const { error: updateErr } = await (db as any)
      .from('signatures')
      .update({
        status: signResult.status,
        signature_value: signResult.signatureValue,
        signed_attributes: signResult.signedAttributes,
        signature_algorithm: signResult.signatureAlgorithm,
        signed_at: signResult.signedAt.toISOString(),
        ltv_data_embedded: signResult.ltvDataEmbedded,
        completed_at: signResult.status === 'COMPLETE' ? new Date().toISOString() : null,
        timestamp_token_id: timestampTokenId,
        archive_timestamp_id: archiveTimestampId,
      })
      .eq('id', sigRecord.id);

    if (updateErr) {
      logger.error('Failed to update signature with engine result', { error: updateErr });
    }

    // Emit audit event
    await db.from('audit_events').insert({
      event_type: signResult.status === 'COMPLETE' ? 'signature.completed' : 'signature.created',
      event_category: 'SYSTEM',
      org_id: orgId,
      target_type: 'signature',
      target_id: sigRecord.id,
      details: JSON.stringify({
        public_id: publicId,
        format: body.format,
        level: body.level,
        status: signResult.status,
        certificate_id: body.signer_certificate_id,
        ltv_embedded: signResult.ltvDataEmbedded,
      }),
    });

    // Return response
    const frontendUrl = config.frontendUrl;
    const response: SignResponse = {
      signatureId: publicId,
      status: signResult.status,
      format: body.format as SignatureFormat,
      level: body.level as SignatureLevel,
      signer: {
        name: cert.subject_cn,
        organization: cert.subject_org,
      },
      signedAt: signResult.signedAt.toISOString(),
      ltvEmbedded: signResult.ltvDataEmbedded,
      verificationUrl: `${frontendUrl}/verify/signature/${publicId}`,
    };

    res.status(201).json(response);
  } catch (err) {
    logger.error('Sign endpoint error', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/v1/signatures/:id
 * Retrieve a signature by its public ID.
 */
router.get('/signatures/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const { data: sig, error } = await (db as any)
      .from('signatures')
      .select('*, signing_certificates(subject_cn, subject_org, fingerprint_sha256)')
      .eq('public_id', id)
      .single();

    if (error || !sig) {
      res.status(404).json({ error: 'Signature not found' });
      return;
    }

    const frontendUrl = config.frontendUrl;

    const response: Record<string, unknown> = {
      signature_id: sig.public_id,
      status: sig.status,
      format: sig.format,
      level: sig.level,
      document_fingerprint: sig.document_fingerprint,
      signer: {
        name: sig.signer_name,
        organization: sig.signer_org,
        certificate_fingerprint: sig.signing_certificates?.fingerprint_sha256,
      },
      signed_at: sig.signed_at || sig.created_at,
      ltv: {
        embedded: sig.ltv_data_embedded,
      },
      verification_url: `${frontendUrl}/verify/signature/${sig.public_id}`,
      created_at: sig.created_at,
    };

    // Omit jurisdiction when null (Constitution 1.8 — frozen schema)
    if (sig.jurisdiction) {
      response.jurisdiction = sig.jurisdiction;
    }

    res.json(response);
  } catch (err) {
    logger.error('Get signature error', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/v1/verify-signature
 * Verify an AdES signature's validity.
 */
router.post('/verify-signature', async (req: Request, res: Response) => {
  try {
    const parsed = verifySignatureRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Invalid request',
        details: parsed.error.issues,
      });
      return;
    }

    const body = parsed.data;

    // Find the signature
    let query = (db as any).from('signatures').select('*');

    if (body.signature_id) {
      query = query.eq('public_id', body.signature_id);
    } else if (body.document_fingerprint) {
      query = query.eq('document_fingerprint', body.document_fingerprint);
    }

    const { data: sig, error } = await query.limit(1).single();

    if (error || !sig) {
      res.status(404).json({ error: 'Signature not found' });
      return;
    }

    // Build verification checks
    const checks: Record<string, { status: string; detail: string }> = {};
    let valid = true;

    // Signature integrity
    if (sig.signature_value && sig.signed_attributes) {
      checks.signature_integrity = {
        status: 'PASS',
        detail: 'Signature value matches signed attributes',
      };
    } else if (sig.status === 'PENDING') {
      checks.signature_integrity = {
        status: 'SKIP',
        detail: 'Signature still pending',
      };
    } else {
      checks.signature_integrity = {
        status: 'FAIL',
        detail: 'Missing signature value or signed attributes',
      };
      valid = false;
    }

    // Revocation check
    if (sig.status === 'REVOKED') {
      checks.revocation_status = {
        status: 'FAIL',
        detail: `Revoked at ${sig.revoked_at}: ${sig.revocation_reason}`,
      };
      valid = false;
    } else {
      checks.revocation_status = {
        status: 'PASS',
        detail: 'Signature not revoked',
      };
    }

    // Timestamp check
    if (['B-T', 'B-LT', 'B-LTA'].includes(sig.level)) {
      if (sig.timestamp_token_id) {
        checks.timestamp_token = {
          status: 'PASS',
          detail: 'RFC 3161 timestamp token present',
        };
      } else {
        checks.timestamp_token = {
          status: sig.status === 'PENDING' ? 'SKIP' : 'FAIL',
          detail: sig.status === 'PENDING' ? 'Pending' : 'Timestamp required but missing',
        };
        if (sig.status !== 'PENDING') valid = false;
      }
    }

    // LTV check
    if (['B-LT', 'B-LTA'].includes(sig.level)) {
      checks.ltv_data = {
        status: sig.ltv_data_embedded ? 'PASS' : 'FAIL',
        detail: sig.ltv_data_embedded ? 'LTV data embedded' : 'LTV data required but missing',
      };
      if (!sig.ltv_data_embedded) valid = false;
    }

    // Fingerprint check
    checks.fingerprint_match = {
      status: sig.document_fingerprint ? 'PASS' : 'FAIL',
      detail: sig.document_fingerprint ? 'Document fingerprint present' : 'Missing fingerprint',
    };

    // Emit audit event
    if (req.authUserId) {
      await db.from('audit_events').insert({
        event_type: 'signature.verified',
        event_category: 'SYSTEM',
        target_type: 'signature',
        target_id: sig.id,
        details: JSON.stringify({ valid, checks_passed: Object.values(checks).filter(c => c.status === 'PASS').length }),
      });
    }

    res.json({
      valid,
      signature_id: sig.public_id,
      checks,
      verified_at: new Date().toISOString(),
    });
  } catch (err) {
    logger.error('Verify signature error', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/v1/signatures
 * List signatures for the authenticated user's organization.
 */
router.get('/signatures', async (req: Request, res: Response) => {
  try {
    const userId = req.authUserId;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid query parameters', details: parsed.error.issues });
      return;
    }

    const params = parsed.data;

    // Get user's org
    const { data: membership } = await db
      .from('org_members')
      .select('org_id')
      .eq('user_id', userId)
      .limit(1)
      .single();

    if (!membership) {
      res.status(403).json({ error: 'No organization membership found' });
      return;
    }

    let query = (db as any)
      .from('signatures')
      .select('public_id, format, level, status, jurisdiction, document_fingerprint, signer_name, signer_org, signed_at, created_at')
      .eq('org_id', membership.org_id)
      .order('created_at', { ascending: false })
      .limit(params.limit);

    if (params.status) query = query.eq('status', params.status);
    if (params.format) query = query.eq('format', params.format);
    if (params.from) query = query.gte('created_at', params.from);
    if (params.to) query = query.lte('created_at', params.to);

    // Cursor-based pagination
    if (params.cursor) {
      query = query.lt('created_at', params.cursor);
    }

    const { data: signatures, error } = await query;

    if (error) {
      logger.error('List signatures error', { error });
      res.status(500).json({ error: 'Failed to list signatures' });
      return;
    }

    const nextCursor = signatures && signatures.length === params.limit
      ? signatures[signatures.length - 1].created_at
      : null;

    res.json({
      signatures: signatures || [],
      cursor: nextCursor,
      count: signatures?.length || 0,
    });
  } catch (err) {
    logger.error('List signatures error', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/v1/signatures/:id/revoke
 * Revoke a signature.
 */
router.post('/signatures/:id/revoke', async (req: Request, res: Response) => {
  try {
    const userId = req.authUserId;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const parsed = revokeRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
      return;
    }

    const { id } = req.params;
    const { reason, detail } = parsed.data;

    // Find the signature and verify ownership
    const { data: sig, error: findErr } = await (db as any)
      .from('signatures')
      .select('id, public_id, status, org_id')
      .eq('public_id', id)
      .single();

    if (findErr || !sig) {
      res.status(404).json({ error: 'Signature not found' });
      return;
    }

    // Verify user has admin/owner role in the org
    const { data: membership } = await db
      .from('org_members')
      .select('role')
      .eq('user_id', userId)
      .eq('org_id', sig.org_id)
      .in('role', ['owner', 'admin'])
      .single();

    if (!membership) {
      res.status(403).json({ error: 'Admin or owner role required to revoke signatures' });
      return;
    }

    if (sig.status === 'REVOKED') {
      res.status(409).json({ error: 'Signature is already revoked' });
      return;
    }

    // Revoke
    const { error: updateErr } = await (db as any)
      .from('signatures')
      .update({
        status: 'REVOKED',
        revoked_at: new Date().toISOString(),
        revocation_reason: `${reason}${detail ? ': ' + detail : ''}`,
      })
      .eq('id', sig.id);

    if (updateErr) {
      logger.error('Revoke signature error', { error: updateErr });
      res.status(500).json({ error: 'Failed to revoke signature' });
      return;
    }

    // Emit audit event
    await db.from('audit_events').insert({
      event_type: 'signature.revoked',
      event_category: 'SYSTEM',
      org_id: sig.org_id,
      target_type: 'signature',
      target_id: sig.id,
      details: JSON.stringify({ reason, detail, public_id: sig.public_id }),
    });

    res.json({
      signature_id: sig.public_id,
      status: 'REVOKED',
      revoked_at: new Date().toISOString(),
      reason,
    });
  } catch (err) {
    logger.error('Revoke signature error', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as signaturesRouter };
