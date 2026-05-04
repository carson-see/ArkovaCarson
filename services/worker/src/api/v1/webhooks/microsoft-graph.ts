/**
 * Microsoft Graph change-notifications webhook (SCRUM-1138 / R2 closeout).
 *
 * Microsoft Graph authenticates change notifications via a per-subscription
 * `clientState` shared secret in the body, NOT HMAC. The validation handshake
 * for subscription creation echoes the `validationToken` query param back as
 * plain text within 10 seconds.
 *
 * - Validation handshake: GET/POST with `?validationToken=...` → 200 text echo.
 * - Notification: POST `{ value: [{ subscriptionId, clientState, resource,
 *   resourceData, changeType, ... }] }` → reject any item whose `clientState`
 *   fails constant-time compare against `MICROSOFT_GRAPH_CLIENT_STATE`.
 * - Each item flows through `adaptMicrosoftGraph` (sharepoint vs onedrive
 *   distinction) into the same `enqueue_rule_event` RPC every other receiver
 *   uses — no rules-loop bypass.
 * - Per-subscription replay protection via `microsoft_graph_webhook_nonces`
 *   table; duplicate item returns 202 to stop Graph's retry storm.
 */
import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { db } from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { adaptMicrosoftGraph } from '../../../integrations/connectors/adapters.js';

export const microsoftGraphWebhookRouter = Router();

interface IntegrationRow {
  id: string;
  org_id: string;
}

interface GraphChangeItem {
  subscriptionId: string;
  clientState?: string;
  resource: string;
  resourceData: {
    id: string;
    name?: string;
    parentReference?: { path?: string };
  };
  changeType: 'created' | 'updated' | 'deleted';
  tenantId?: string;
}

function getRawBody(req: Request): Buffer | null {
  const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody ?? req.body;
  return Buffer.isBuffer(rawBody) ? rawBody : null;
}

function constantTimeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

async function findIntegrationBySubscription(
  subscriptionId: string,
): Promise<IntegrationRow | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from('connector_subscriptions')
    .select('integration_id, org_integrations:integration_id ( id, org_id )')
    .eq('provider', 'microsoft_graph')
    .eq('vendor_subscription_id', subscriptionId)
    .is('revoked_at', null)
    .maybeSingle();
  if (error) {
    logger.error({ error, subscriptionId }, 'MS Graph webhook: integration lookup failed');
    return null;
  }
  const row = data as { org_integrations?: { id: string; org_id: string } } | null;
  if (!row?.org_integrations) return null;
  return { id: row.org_integrations.id, org_id: row.org_integrations.org_id };
}

async function recordNonce(args: {
  subscriptionId: string;
  resourceId: string;
  changeType: string;
}): Promise<{ duplicate: boolean; failed: boolean }> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (db as any).from('microsoft_graph_webhook_nonces').insert({
      subscription_id: args.subscriptionId,
      resource_id: args.resourceId,
      change_type: args.changeType,
    });
    if (error) {
      if ((error as { code?: string }).code === '23505') return { duplicate: true, failed: false };
      logger.warn({ error, ...args }, 'MS Graph webhook: nonce insert failed');
      return { duplicate: false, failed: true };
    }
    return { duplicate: false, failed: false };
  } catch (err) {
    logger.warn({ error: err, ...args }, 'MS Graph webhook: nonce insert threw');
    return { duplicate: false, failed: true };
  }
}

async function enqueueRuleEvent(args: {
  integration: IntegrationRow;
  item: GraphChangeItem;
  payloadHash: string;
}): Promise<string | null> {
  let canonical;
  try {
    canonical = adaptMicrosoftGraph(args.item, { org_id: args.integration.org_id });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), subId: args.item.subscriptionId },
      'MS Graph webhook: adapter rejected item',
    );
    return null;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db.rpc as any)('enqueue_rule_event', {
    p_org_id: canonical.org_id,
    p_trigger_type: canonical.trigger_type,
    p_vendor: canonical.vendor,
    p_external_file_id: canonical.external_file_id,
    p_filename: canonical.filename ?? null,
    p_folder_path: canonical.folder_path ?? null,
    p_sender_email: null,
    p_subject: null,
    p_payload: {
      source: 'microsoft_graph',
      integration_id: args.integration.id,
      subscription_id: args.item.subscriptionId,
      change_type: args.item.changeType,
      tenant_id: args.item.tenantId ?? null,
      payload_hash: args.payloadHash,
    },
  });
  if (error || !data) {
    logger.error(
      { error, integrationId: args.integration.id },
      'MS Graph webhook: enqueue_rule_event failed',
    );
    return null;
  }
  return String(data);
}

microsoftGraphWebhookRouter.post('/', async (req: Request, res: Response) => {
  // Validation handshake: Graph creates a subscription by POSTing a body-less
  // request whose only signal is `?validationToken=...`. Echo it back as
  // text/plain within 10 seconds; otherwise the subscription create fails.
  const validationToken =
    typeof req.query.validationToken === 'string' ? req.query.validationToken : null;
  if (validationToken) {
    res.status(200).type('text/plain').send(validationToken);
    return;
  }

  const expectedClientState = process.env.MICROSOFT_GRAPH_CLIENT_STATE;
  if (!expectedClientState) {
    logger.error('MS Graph webhook: MICROSOFT_GRAPH_CLIENT_STATE not set — rejecting');
    res.status(503).json({ error: { code: 'webhook_unconfigured' } });
    return;
  }

  const rawBody = getRawBody(req);
  if (!rawBody) {
    logger.error({ path: req.path }, 'MS Graph webhook: rawBody missing');
    res.status(500).json({ error: { code: 'misconfigured_raw_body' } });
    return;
  }

  let parsed: { value?: GraphChangeItem[] };
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'MS Graph webhook: malformed body',
    );
    res.status(400).json({ error: { code: 'invalid_body' } });
    return;
  }

  const items = Array.isArray(parsed.value) ? parsed.value : null;
  if (!items || items.length === 0) {
    res.status(400).json({ error: { code: 'invalid_body', message: 'value[] missing or empty' } });
    return;
  }

  const payloadHash = crypto.createHash('sha256').update(rawBody).digest('hex');
  const enqueued: string[] = [];
  const skipped: { reason: string; subscriptionId: string }[] = [];

  for (const item of items) {
    if (!item.subscriptionId || !item.resource || !item.resourceData?.id || !item.changeType) {
      skipped.push({ reason: 'malformed_item', subscriptionId: item.subscriptionId ?? 'unknown' });
      continue;
    }
    if (!item.clientState || !constantTimeEqual(item.clientState, expectedClientState)) {
      skipped.push({ reason: 'invalid_client_state', subscriptionId: item.subscriptionId });
      continue;
    }
    const integration = await findIntegrationBySubscription(item.subscriptionId);
    if (!integration) {
      skipped.push({ reason: 'unknown_subscription', subscriptionId: item.subscriptionId });
      continue;
    }
    const nonce = await recordNonce({
      subscriptionId: item.subscriptionId,
      resourceId: item.resourceData.id,
      changeType: item.changeType,
    });
    if (nonce.duplicate) {
      skipped.push({ reason: 'duplicate', subscriptionId: item.subscriptionId });
      continue;
    }
    if (nonce.failed) {
      skipped.push({ reason: 'nonce_failed', subscriptionId: item.subscriptionId });
      continue;
    }
    const ruleEventId = await enqueueRuleEvent({ integration, item, payloadHash });
    if (ruleEventId) enqueued.push(ruleEventId);
    else skipped.push({ reason: 'enqueue_failed', subscriptionId: item.subscriptionId });
  }

  // If at least one item was enqueued, return 202 — Graph treats 2xx as ack
  // and stops retrying. If the entire batch failed authentication (clientState
  // mismatch on every item), surface 401 so the caller knows it's not us
  // silently dropping their notifications.
  const allRejected =
    enqueued.length === 0 &&
    skipped.length > 0 &&
    skipped.every((s) => s.reason === 'invalid_client_state');
  if (allRejected) {
    res.status(401).json({ error: { code: 'invalid_client_state' } });
    return;
  }

  res.status(202).json({
    ok: true,
    enqueued: enqueued.length,
    skipped: skipped.length,
    rule_event_ids: enqueued,
  });
});
