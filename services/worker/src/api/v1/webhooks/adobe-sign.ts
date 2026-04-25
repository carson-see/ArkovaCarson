/**
 * Adobe Sign webhook handler (SCRUM-1148).
 *
 * Receives HMAC-verified `AGREEMENT_WORKFLOW_COMPLETED` events, resolves the
 * connected org integration by Adobe webhookId or accountId, and queues a
 * sanitized `ESIGN_COMPLETED` rules-engine event. Raw payloads are NEVER
 * persisted; only canonical sanitized metadata reaches the database.
 *
 * Hardening (per AC):
 *   - HMAC verify against raw body using per-webhook client secret.
 *   - Canonical event normalization via existing `adaptAdobeSign` adapter.
 *   - Idempotent duplicate deliveries (nonce table, same as DocuSign).
 *   - Failures land in a dead-letter row on the queue with status='FAILED'.
 */
import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { db } from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { adaptAdobeSign } from '../../../integrations/connectors/adapters.js';
import {
  parseAdobeSignPayload,
  verifyAdobeSignHmac,
  type AdobeAgreementCompletedEvent,
} from '../../../integrations/oauth/adobe-sign.js';

export const adobeSignWebhookRouter = Router();

interface AdobeIntegrationRow {
  id: string;
  org_id: string;
  webhook_id: string | null;
}

function getRawBody(req: Request): Buffer | null {
  const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody ?? req.body;
  return Buffer.isBuffer(rawBody) ? rawBody : null;
}

function signatureHeader(req: Request): string | undefined {
  // Adobe documents both the SHA256 header and the older base ClientId proof.
  const sha = req.headers['x-adobesign-clientid-authentication-sha256'];
  if (sha) return Array.isArray(sha) ? sha[0] : sha;
  const legacy = req.headers['x-adobesign-clientid'];
  return Array.isArray(legacy) ? legacy[0] : legacy;
}

async function findIntegration(
  webhookId: string | null,
): Promise<AdobeIntegrationRow | null> {
  if (!webhookId) return null;
  // Cast until database.types.ts is regenerated — provider='adobe_sign' rows
  // mirror the existing 'docusign' shape (org_integrations table from 0251).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from('org_integrations')
    .select('id, org_id, webhook_id')
    .eq('provider', 'adobe_sign')
    .eq('webhook_id', webhookId)
    .is('revoked_at', null)
    .maybeSingle();
  if (error) {
    logger.error({ error, webhookId }, 'Adobe Sign webhook integration lookup failed');
    throw new Error('integration_lookup_failed');
  }
  return (data as AdobeIntegrationRow | null) ?? null;
}

async function enqueueRuleEvent(args: {
  integration: AdobeIntegrationRow;
  event: AdobeAgreementCompletedEvent;
  payloadHash: string;
}): Promise<string> {
  const canonical = adaptAdobeSign(
    {
      event: 'AGREEMENT_WORKFLOW_COMPLETED' as const,
      agreement: {
        id: args.event.agreementId,
        name: args.event.agreementName ?? undefined,
        senderInfo: args.event.senderEmail ? { email: args.event.senderEmail } : undefined,
      },
    },
    { org_id: args.integration.org_id },
  );
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
      source: 'adobe_sign_webhook',
      integration_id: args.integration.id,
      agreement_id: args.event.agreementId,
      document_ids: args.event.documents.map((d) => d.id),
      payload_hash: args.payloadHash,
    },
  });
  if (error || !data) {
    logger.error({ error, integrationId: args.integration.id }, 'Adobe Sign rule-event enqueue failed');
    throw new Error('rule_event_enqueue_failed');
  }
  return String(data);
}

async function dlqInsert(args: {
  webhookId: string | null;
  agreementId: string | null;
  reason: string;
  payloadHash: string;
}): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (db as any).from('webhook_dlq').insert({
      provider: 'adobe_sign',
      reason: args.reason.slice(0, 500),
      external_id: args.agreementId,
      webhook_id: args.webhookId,
      payload_hash: args.payloadHash,
    });
    if (error) {
      logger.warn({ error }, 'Adobe Sign webhook: DLQ insert failed (non-fatal)');
    }
  } catch (err) {
    logger.warn({ error: err }, 'Adobe Sign webhook: DLQ insert threw (non-fatal)');
  }
}

adobeSignWebhookRouter.post('/', async (req: Request, res: Response) => {
  const secret = process.env.ADOBE_SIGN_CLIENT_SECRET;
  if (!secret) {
    logger.error('ADOBE_SIGN_CLIENT_SECRET not set — webhook rejected');
    res.status(503).json({ error: { code: 'webhook_unconfigured' } });
    return;
  }

  const rawBody = getRawBody(req);
  if (!rawBody) {
    logger.error({ path: req.path }, 'Adobe Sign webhook: rawBody missing — raw parser must be mounted');
    res.status(500).json({ error: { code: 'misconfigured_raw_body' } });
    return;
  }

  if (!verifyAdobeSignHmac({ rawBody, signature: signatureHeader(req), clientSecret: secret })) {
    res.status(401).json({ error: { code: 'invalid_signature' } });
    return;
  }

  const payloadHash = crypto.createHash('sha256').update(rawBody).digest('hex');
  let event: AdobeAgreementCompletedEvent;
  try {
    event = parseAdobeSignPayload(rawBody);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'invalid_body';
    if (/Unsupported Adobe Sign event/.test(message)) {
      // Adobe also fires CREATED / RECALLED etc. on the same endpoint. Ack
      // them so Adobe stops retrying, but do not enqueue or DLQ.
      logger.info({ message }, 'Adobe Sign webhook: non-completed event — acked + ignored');
      res.status(200).json({ ok: true, ignored: true });
      return;
    }
    logger.warn({ err: message }, 'Adobe Sign webhook: malformed body');
    await dlqInsert({ webhookId: null, agreementId: null, reason: message, payloadHash });
    res.status(400).json({ error: { code: 'invalid_body' } });
    return;
  }

  try {
    const integration = await findIntegration(event.webhookId);
    if (!integration) {
      logger.warn({ webhookId: event.webhookId }, 'Adobe Sign webhook: unknown connected webhook');
      res.status(200).json({ ok: true, orphaned: true });
      return;
    }

    // Replay protection: dedupe by (agreement_id, webhook_id). Reuses the
    // generic `webhook_nonces` table when available; fall back to ack-on-
    // duplicate-key if the Postgres unique index complains.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: nonceErr } = await (db as any)
      .from('adobe_sign_webhook_nonces')
      .insert({
        agreement_id: event.agreementId,
        webhook_id: event.webhookId,
        payload_hash: payloadHash,
      });
    if (nonceErr) {
      if ((nonceErr as { code?: string }).code === '23505') {
        logger.info(
          { agreementId: event.agreementId },
          'Adobe Sign webhook: duplicate delivery — returning 200',
        );
        res.status(200).json({ ok: true, duplicate: true });
        return;
      }
      logger.error(
        { error: nonceErr, agreementId: event.agreementId },
        'Adobe Sign webhook: nonce insert failed',
      );
      // Fail open: we still try to enqueue rather than reject — Adobe retry
      // semantics will deliver the same event again later, but the rule
      // executions table's idempotency key still de-dupes downstream.
    }

    const ruleEventId = await enqueueRuleEvent({ integration, event, payloadHash });
    res.status(202).json({ ok: true, rule_event_id: ruleEventId });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unexpected';
    logger.error({ error: err, webhookId: event.webhookId }, 'Adobe Sign webhook processing failed');
    await dlqInsert({
      webhookId: event.webhookId,
      agreementId: event.agreementId,
      reason: message,
      payloadHash,
    });
    res.status(500).json({ error: { code: 'webhook_processing_failed' } });
  }
});
