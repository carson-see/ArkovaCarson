/**
 * ATS Webhook Integration (ATT-04)
 *
 * Receives inbound webhooks from ATS systems (Greenhouse, Lever, generic).
 * Verifies HMAC signatures, extracts candidate info, and returns matching
 * attestation verification results.
 *
 * POST /api/v1/webhooks/ats/:provider
 *
 * Authentication: HMAC signature verification (not API key — these are
 * inbound webhooks from external ATS systems).
 */

import { Router, Request, Response } from 'express';
import crypto from 'node:crypto';
import { db } from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';

const router = Router();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbAny = db as any;

const SUPPORTED_PROVIDERS = ['greenhouse', 'lever', 'generic'] as const;
type AtsProvider = (typeof SUPPORTED_PROVIDERS)[number];

/**
 * Constant-time HMAC-SHA256 signature verification.
 * Returns false (rather than throwing) if buffers differ in length.
 */
function verifyHmacSignature(payload: string, signature: string, secret: string): boolean {
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    // timingSafeEqual throws if buffers differ in length
    return false;
  }
}

/**
 * Lever prepends "sha256=" to its signature header.
 */
function verifyLeverSignature(payload: string, signature: string, secret: string): boolean {
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  try {
    return crypto.timingSafeEqual(
      Buffer.from(`sha256=${expected}`),
      Buffer.from(signature),
    );
  } catch {
    return false;
  }
}

/**
 * Resolve the correct signature header for a given provider.
 */
function getSignatureHeader(req: Request, provider: AtsProvider): string | undefined {
  switch (provider) {
    case 'greenhouse':
      return req.headers['x-greenhouse-signature'] as string | undefined;
    case 'lever':
      return req.headers['x-lever-signature'] as string | undefined;
    case 'generic':
      return req.headers['x-webhook-signature'] as string | undefined;
  }
}

/**
 * Verify signature for a given provider.
 */
function verifySignature(provider: AtsProvider, payload: string, signature: string, secret: string): boolean {
  if (provider === 'lever') {
    return verifyLeverSignature(payload, signature, secret);
  }
  // greenhouse and generic both use plain HMAC-SHA256
  return verifyHmacSignature(payload, signature, secret);
}

/**
 * Extract candidate info from provider-specific webhook payload.
 */
function extractCandidateInfo(
  provider: AtsProvider,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any,
): { name?: string; email?: string; stage?: string } {
  if (provider === 'greenhouse') {
    const payload = body?.payload;
    return {
      name: payload?.candidate
        ? `${payload.candidate.first_name} ${payload.candidate.last_name}`
        : undefined,
      email: payload?.candidate?.email_addresses?.[0]?.value,
      stage: payload?.stage?.name,
    };
  }

  if (provider === 'lever') {
    return {
      name: body?.data?.candidate_name,
      email: body?.data?.candidate_email,
      stage: body?.data?.toStageId,
    };
  }

  // Generic: expect flat structure
  return {
    name: body?.candidate_name,
    email: body?.candidate_email,
    stage: body?.stage,
  };
}

// POST /api/v1/webhooks/ats/:provider
router.post('/:provider', async (req: Request, res: Response) => {
  const { provider } = req.params;

  if (!SUPPORTED_PROVIDERS.includes(provider as AtsProvider)) {
    res.status(400).json({ error: 'Unsupported ATS provider' });
    return;
  }

  const atsProvider = provider as AtsProvider;
  const rawBody = JSON.stringify(req.body);

  // Resolve provider-specific signature header
  const signatureHeader = getSignatureHeader(req, atsProvider);
  if (!signatureHeader) {
    res.status(401).json({ error: 'Missing webhook signature' });
    return;
  }

  try {
    // Find all enabled integrations for this provider
    const { data: integrations, error: intError } = await dbAny
      .from('ats_integrations')
      .select('id, org_id, webhook_secret, callback_url, field_mapping')
      .eq('provider', atsProvider)
      .eq('enabled', true);

    if (intError || !integrations?.length) {
      logger.warn({ provider: atsProvider }, 'No active ATS integration found for provider');
      res.status(404).json({ error: 'No active integration found' });
      return;
    }

    // Try to match signature against each integration's secret
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let matchedIntegration: any = null;
    for (const integration of integrations) {
      if (verifySignature(atsProvider, rawBody, signatureHeader, integration.webhook_secret)) {
        matchedIntegration = integration;
        break;
      }
    }

    if (!matchedIntegration) {
      logger.warn({ provider: atsProvider }, 'ATS webhook signature verification failed');
      res.status(401).json({ error: 'Invalid webhook signature' });
      return;
    }

    // Extract candidate info based on provider format
    const candidateInfo = extractCandidateInfo(atsProvider, req.body);

    // Build search terms from candidate info (no PII in logs)
    const searchTerms: string[] = [];
    if (candidateInfo.name) searchTerms.push(candidateInfo.name);
    if (candidateInfo.email) searchTerms.push(candidateInfo.email);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let attestations: any[] = [];
    if (searchTerms.length > 0) {
      // Search attestations by subject_identifier matching candidate info
      const filters = searchTerms.map((term) => `subject_identifier.ilike.%${term}%`);
      const { data, error } = await dbAny
        .from('attestations')
        .select('public_id, attestation_type, status, subject_identifier, attester_name, expires_at, chain_tx_id')
        .or(filters.join(','));

      if (!error && data) {
        attestations = data;
      }
    }

    // Compute effective statuses (check expiry)
    const now = new Date();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = attestations.map((att: any) => {
      const isExpired = att.expires_at && new Date(att.expires_at) < now;
      const effectiveStatus = isExpired && att.status === 'ACTIVE' ? 'EXPIRED' : att.status;
      return {
        public_id: att.public_id,
        attestation_type: att.attestation_type,
        status: effectiveStatus,
        subject_identifier: att.subject_identifier,
        attester_name: att.attester_name,
        anchored: Boolean(att.chain_tx_id),
      };
    });

    // Audit log (no email/PII — only name and stage)
    logger.info({
      provider: atsProvider,
      integrationId: matchedIntegration.id,
      orgId: matchedIntegration.org_id,
      candidateName: candidateInfo.name,
      stage: candidateInfo.stage,
      attestationsFound: results.length,
    }, 'ATS webhook processed');

    res.status(202).json({
      status: 'accepted',
      provider: atsProvider,
      candidate: {
        name: candidateInfo.name,
        stage: candidateInfo.stage,
      },
      verification_results: results,
      summary: {
        total: results.length,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        active: results.filter((r: any) => r.status === 'ACTIVE').length,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expired: results.filter((r: any) => r.status === 'EXPIRED').length,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        revoked: results.filter((r: any) => r.status === 'REVOKED').length,
      },
    });
  } catch (error) {
    logger.error({ error, provider: atsProvider }, 'ATS webhook processing failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as atsWebhookRouter };
