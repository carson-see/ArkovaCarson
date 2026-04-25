/**
 * Checkr webhook handler (SCRUM-1030 / SCRUM-1151).
 *
 * Checkr signs Webhook v1 deliveries with HMAC-SHA256-hex over the raw body
 * via the `X-Checkr-Signature` header. Account routing is via the
 * `X-Checkr-Account-Id` header (Checkr partner accounts can multiplex
 * multiple sub-accounts; we map account_id → org_integrations.account_id).
 *
 * In scope for SCRUM-1030/1151:
 *   - HMAC verification (hex encoding, vs DocuSign/Adobe base64)
 *   - `report.completed` is the only supported event for now; other events
 *     are 200-OK acked + ignored.
 *   - Replay protection via `checkr_webhook_nonces` table.
 *   - Failures land in `webhook_dlq` (introduced in batch 2's migration 0258).
 *
 * Per [SCRUM-1151 spike doc](docs/integrations/background-checks-spike.md):
 * Checkr Webhook v1 is the documented contract; v2 (signed JWTs) is not yet
 * GA. Veremark stays gated until vendor docs are confirmed.
 */
import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { db } from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { adaptCheckr } from '../../../integrations/connectors/adapters.js';
import { CheckrReportCompleted } from '../../../integrations/connectors/schemas.js';
import { verifyHmacSha256Hex } from '../../../integrations/oauth/hmac.js';

export const checkrWebhookRouter = Router();

interface CheckrIntegrationRow {
  id: string;
  org_id: string;
  account_id: string | null;
}

const RawCheckrPayload = z
  .object({
    type: z.string().trim().min(1),
    data: z
      .object({
        object: z.object({ id: z.string().trim().min(1) }).passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

function getRawBody(req: Request): Buffer | null {
  const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody ?? req.body;
  return Buffer.isBuffer(rawBody) ? rawBody : null;
}

function signatureHeader(req: Request): string | undefined {
  const sig = req.headers['x-checkr-signature'];
  return Array.isArray(sig) ? sig[0] : sig;
}

function accountHeader(req: Request): string | undefined {
  const v = req.headers['x-checkr-account-id'];
  return Array.isArray(v) ? v[0] : v;
}

async function findIntegration(accountId: string | undefined): Promise<CheckrIntegrationRow | null> {
  if (!accountId) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from('org_integrations')
    .select('id, org_id, account_id')
    .eq('provider', 'checkr')
    .eq('account_id', accountId)
    .is('revoked_at', null)
    .maybeSingle();
  if (error) {
    logger.error({ error, accountId }, 'Checkr webhook integration lookup failed');
    throw new Error('integration_lookup_failed');
  }
  return (data as CheckrIntegrationRow | null) ?? null;
}

async function dlqInsert(args: {
  reason: string;
  externalId: string | null;
  payloadHash: string;
}): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (db as any).from('webhook_dlq').insert({
      provider: 'checkr',
      reason: args.reason.slice(0, 500),
      external_id: args.externalId,
      payload_hash: args.payloadHash,
    });
    if (error) {
      logger.warn({ error }, 'Checkr webhook: DLQ insert failed (non-fatal)');
    }
  } catch (err) {
    logger.warn({ error: err }, 'Checkr webhook: DLQ insert threw (non-fatal)');
  }
}

checkrWebhookRouter.post('/', async (req: Request, res: Response) => {
  const secret = process.env.CHECKR_WEBHOOK_SECRET;
  if (!secret) {
    logger.error('CHECKR_WEBHOOK_SECRET not set — webhook rejected');
    res.status(503).json({ error: { code: 'webhook_unconfigured' } });
    return;
  }

  const rawBody = getRawBody(req);
  if (!rawBody) {
    logger.error({ path: req.path }, 'Checkr webhook: rawBody missing — raw parser must be mounted');
    res.status(500).json({ error: { code: 'misconfigured_raw_body' } });
    return;
  }

  if (!verifyHmacSha256Hex({ rawBody, signature: signatureHeader(req), secret })) {
    res.status(401).json({ error: { code: 'invalid_signature' } });
    return;
  }

  const payloadHash = crypto.createHash('sha256').update(rawBody).digest('hex');
  let parsed: z.infer<typeof RawCheckrPayload>;
  try {
    parsed = RawCheckrPayload.parse(JSON.parse(rawBody.toString('utf8')));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'invalid_body';
    logger.warn({ err: message }, 'Checkr webhook: malformed body');
    await dlqInsert({ reason: message, externalId: null, payloadHash });
    res.status(400).json({ error: { code: 'invalid_body' } });
    return;
  }

  // Only `report.completed` enters the rules engine. Other events (created,
  // suspended, etc.) get 200-OK so Checkr stops retrying.
  if (parsed.type !== 'report.completed') {
    res.status(200).json({ ok: true, ignored: true });
    return;
  }

  // Strict validation of the completed-report shape — guards against schema
  // drift between Checkr API versions.
  let completed: z.infer<typeof CheckrReportCompleted>;
  try {
    completed = CheckrReportCompleted.parse(parsed);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'invalid_completed_report';
    await dlqInsert({
      reason: `report.completed shape failed validation: ${message}`,
      externalId: parsed.data.object.id ?? null,
      payloadHash,
    });
    res.status(400).json({ error: { code: 'invalid_body' } });
    return;
  }

  try {
    const integration = await findIntegration(accountHeader(req));
    if (!integration) {
      logger.warn({ accountId: accountHeader(req) }, 'Checkr webhook: unknown account');
      res.status(200).json({ ok: true, orphaned: true });
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: nonceErr } = await (db as any)
      .from('checkr_webhook_nonces')
      .insert({
        report_id: completed.data.object.id,
        payload_hash: payloadHash,
      });
    if (nonceErr) {
      if ((nonceErr as { code?: string }).code === '23505') {
        res.status(200).json({ ok: true, duplicate: true });
        return;
      }
      logger.error({ error: nonceErr }, 'Checkr webhook: nonce insert failed');
      // Fail open on the nonce write — the executions table's idempotency
      // index still de-dupes downstream side effects.
    }

    const canonical = adaptCheckr(completed, { org_id: integration.org_id });
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
        source: 'checkr_webhook',
        integration_id: integration.id,
        report_id: completed.data.object.id,
        candidate_id: completed.data.object.candidate_id,
        payload_hash: payloadHash,
      },
    });
    if (error || !data) {
      logger.error({ error, integrationId: integration.id }, 'Checkr rule-event enqueue failed');
      await dlqInsert({
        reason: 'rule_event_enqueue_failed',
        externalId: completed.data.object.id,
        payloadHash,
      });
      res.status(500).json({ error: { code: 'webhook_processing_failed' } });
      return;
    }

    res.status(202).json({ ok: true, rule_event_id: String(data) });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unexpected';
    logger.error({ error: err }, 'Checkr webhook processing failed');
    await dlqInsert({ reason: message, externalId: completed.data.object.id, payloadHash });
    res.status(500).json({ error: { code: 'webhook_processing_failed' } });
  }
});
