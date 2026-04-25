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

// POST /api/v1/webhooks/ats/:provider/:integrationId
// The integrationId in the URL pins the webhook to a single org, preventing
// the multi-secret iteration that let org A's secret validate org B's payload.
router.post('/:provider/:integrationId', async (req: Request, res: Response) => {
  const { provider, integrationId } = req.params;

  if (!SUPPORTED_PROVIDERS.includes(provider as AtsProvider)) {
    res.status(400).json({ error: 'Unsupported ATS provider' });
    return;
  }

  const atsProvider = provider as AtsProvider;

  // Use raw body bytes for HMAC verification. The request must pass through
  // express.raw() BEFORE express.json() so req.body is a Buffer.
  const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
  const rawBodyStr = rawBody ? rawBody.toString('utf8') : JSON.stringify(req.body);

  const sigHeader = getSignatureHeader(req, atsProvider);
  if (!sigHeader) {
    res.status(401).json({ error: 'Missing webhook signature' });
    return;
  }

  try {
    // Look up exactly ONE integration by (integrationId, provider). No iteration.
    const { data: integration, error: intError } = await dbAny
      .from('ats_integrations')
      .select('id, org_id, webhook_secret, callback_url, field_mapping')
      .eq('id', integrationId)
      .eq('provider', atsProvider)
      .eq('enabled', true)
      .maybeSingle();

    if (intError || !integration) {
      logger.warn({ provider: atsProvider, integrationId }, 'No active ATS integration found');
      res.status(404).json({ error: 'No active integration found' });
      return;
    }

    if (!verifySignature(atsProvider, rawBodyStr, sigHeader, integration.webhook_secret)) {
      logger.warn({ provider: atsProvider, integrationId }, 'ATS webhook signature verification failed');
      res.status(401).json({ error: 'Invalid webhook signature' });
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const matchedIntegration = integration as any;

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
      // SEC-024: Escape PostgREST filter syntax chars to prevent .or() injection (CRIT-3 pattern)
      const escapeIlike = (input: string): string => {
        let escaped = input.replace(/[%_\\]/g, '\\$&');
        escaped = escaped.replace(/[,.()"']/g, '');
        return escaped;
      };
      const filters = searchTerms.map((term) => `subject_identifier.ilike.%${escapeIlike(term)}%`);
      // SCRUM-1240 (AUDIT-0424-16): scope attestations to the integration's
      // org. Previously the .or() ilike search ran without any org_id
      // constraint — two orgs that both connected the same ATS provider with
      // overlapping candidate names leaked each other's attestation rows
      // into the response. The integration row was already resolved upstream
      // (its `org_id` is the only authoritative org for this delivery).
      const { data, error } = await dbAny
        .from('attestations')
        .select('public_id, attestation_type, status, subject_identifier, attester_name, expires_at, chain_tx_id')
        .eq('org_id', matchedIntegration.org_id)
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
