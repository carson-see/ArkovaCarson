/**
 * DocuSign Connect webhook handler (SCRUM-1101).
 *
 * Receives HMAC-verified `envelope-completed` events, resolves the connected
 * org integration by DocuSign account id, and queues both:
 *   1. a sanitized rules-engine event (`ESIGN_COMPLETED`)
 *   2. a retryable document-fetch job for the signed envelope
 *
 * Raw Connect payloads and signed documents are never persisted here.
 */
import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { db } from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { submitJob } from '../../../utils/jobQueue.js';
import { adaptDocusign } from '../../../integrations/connectors/adapters.js';
import {
  parseDocusignConnectPayload,
  verifyDocusignConnectHmac,
  type DocusignCompletedEnvelope,
} from '../../../integrations/oauth/docusign.js';

export const docusignWebhookRouter = Router();

interface DocusignIntegrationRow {
  id: string;
  org_id: string;
  account_id: string | null;
}

function getRawBody(req: Request): Buffer | null {
  const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody ?? req.body;
  return Buffer.isBuffer(rawBody) ? rawBody : null;
}

function signatureHeader(req: Request): string | undefined {
  const header = req.headers['x-docusign-signature-1'];
  return Array.isArray(header) ? header[0] : header;
}

async function findIntegration(accountId: string): Promise<DocusignIntegrationRow | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from('org_integrations')
    .select('id, org_id, account_id')
    .eq('provider', 'docusign')
    .eq('account_id', accountId)
    .is('revoked_at', null);

  if (error) {
    logger.error({ error, accountId }, 'DocuSign webhook integration lookup failed');
    throw new Error('integration_lookup_failed');
  }

  const rows = data as DocusignIntegrationRow[] | null;
  if (!rows || rows.length === 0) return null;

  if (rows.length > 1) {
    logger.error(
      { accountId, orgIds: rows.map(r => r.org_id) },
      'DocuSign webhook: ambiguous lookup — same accountId connected to multiple orgs, rejecting to prevent cross-tenant leak',
    );
    throw new Error('ambiguous_integration_lookup');
  }

  return rows[0];
}

async function enqueueRuleEvent(args: {
  integration: DocusignIntegrationRow;
  event: DocusignCompletedEnvelope;
  payloadHash: string;
}): Promise<string> {
  const canonical = adaptDocusign(args.event, { org_id: args.integration.org_id });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db.rpc as any)('enqueue_rule_event', {
    p_org_id: canonical.org_id,
    p_trigger_type: canonical.trigger_type,
    p_vendor: canonical.vendor,
    p_external_file_id: canonical.external_file_id,
    p_filename: canonical.filename ?? null,
    p_folder_path: canonical.folder_path ?? null,
    p_sender_email: canonical.sender_email ?? null,
    p_subject: canonical.subject ?? null,
    p_payload: {
      source: 'docusign_connect',
      integration_id: args.integration.id,
      account_id: args.event.accountId,
      envelope_id: args.event.envelopeId,
      document_ids: args.event.envelopeDocuments.map((doc) => doc.documentId),
      generated_at: args.event.generatedDateTime ?? null,
      payload_hash: args.payloadHash,
    },
  });

  if (error || !data) {
    logger.error({ error, integrationId: args.integration.id }, 'DocuSign rule-event enqueue failed');
    throw new Error('rule_event_enqueue_failed');
  }

  return String(data);
}

async function enqueueFetchJob(args: {
  integration: DocusignIntegrationRow;
  event: DocusignCompletedEnvelope;
  ruleEventId: string;
}): Promise<string> {
  const jobId = await submitJob({
    type: 'docusign.envelope_completed',
    max_attempts: 5,
    priority: 10,
    payload: {
      org_id: args.integration.org_id,
      integration_id: args.integration.id,
      account_id: args.event.accountId,
      envelope_id: args.event.envelopeId,
      rule_event_id: args.ruleEventId,
      document_ids: args.event.envelopeDocuments.map((doc) => doc.documentId),
    },
  });
  if (!jobId) {
    logger.error({ integrationId: args.integration.id }, 'DocuSign document-fetch job enqueue failed');
    throw new Error('document_job_enqueue_failed');
  }
  return jobId;
}

docusignWebhookRouter.post('/', async (req: Request, res: Response) => {
  const secret = process.env.DOCUSIGN_CONNECT_HMAC_SECRET;
  if (!secret) {
    logger.error('DOCUSIGN_CONNECT_HMAC_SECRET not set — webhook rejected');
    res.status(503).json({ error: { code: 'webhook_unconfigured' } });
    return;
  }

  const rawBody = getRawBody(req);
  if (!rawBody) {
    logger.error({ path: req.path }, 'DocuSign webhook: rawBody missing — raw parser must be mounted');
    res.status(500).json({ error: { code: 'misconfigured_raw_body' } });
    return;
  }

  if (!verifyDocusignConnectHmac({ rawBody, signature: signatureHeader(req), secret })) {
    res.status(401).json({ error: { code: 'invalid_signature' } });
    return;
  }

  let event: DocusignCompletedEnvelope;
  try {
    event = parseDocusignConnectPayload(rawBody);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'DocuSign webhook: malformed body');
    res.status(400).json({ error: { code: 'invalid_body' } });
    return;
  }

  try {
    const integration = await findIntegration(event.accountId);
    if (!integration) {
      logger.warn({ accountId: event.accountId }, 'DocuSign webhook: unknown connected account');
      res.status(200).json({ ok: true, orphaned: true });
      return;
    }

    // Replay protection: dedupe on (envelope_id, event_id, generated_at).
    // DocuSign retries on any non-2xx response, so a duplicate must return
    // 200 to stop the retry loop. Migration 0256 creates the nonce table.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: nonceErr } = await (db as any)
      .from('docusign_webhook_nonces')
      .insert({
        envelope_id: event.envelopeId,
        event_id: event.eventId ?? event.event,
        generated_at: event.generatedDateTime ?? new Date().toISOString(),
      });
    if (nonceErr) {
      // Postgres unique_violation — duplicate delivery, ack so retries stop.
      if ((nonceErr as { code?: string }).code === '23505') {
        logger.info(
          { envelopeId: event.envelopeId, eventId: event.eventId },
          'DocuSign webhook: duplicate delivery — returning 200',
        );
        res.status(200).json({ ok: true, duplicate: true });
        return;
      }
      logger.error(
        { error: nonceErr, envelopeId: event.envelopeId },
        'DocuSign webhook: nonce insert failed',
      );
      res.status(500).json({ error: { code: 'nonce_insert_failed' } });
      return;
    }

    const payloadHash = crypto.createHash('sha256').update(rawBody).digest('hex');
    const ruleEventId = await enqueueRuleEvent({ integration, event, payloadHash });
    const jobId = await enqueueFetchJob({ integration, event, ruleEventId });

    res.status(202).json({ ok: true, rule_event_id: ruleEventId, job_id: jobId });
  } catch (err) {
    logger.error({ error: err, accountId: event.accountId }, 'DocuSign webhook processing failed');
    res.status(500).json({ error: { code: 'webhook_processing_failed' } });
  }
});
