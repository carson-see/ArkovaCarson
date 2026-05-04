/**
 * Microsoft Graph change-notifications webhook
 * (SCRUM-1138 / R2 closeout — see Confluence page id 27328665).
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
import { z } from 'zod';
import { config } from '../../../config.js';
import { db } from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { adaptMicrosoftGraph } from '../../../integrations/connectors/adapters.js';

// Zod gate for nonce + write paths (CodeRabbit ASSERTIVE on PR #695):
// Microsoft Graph items reach this handler as untyped JSON. The previous
// ad-hoc presence check (`!item.subscriptionId || !item.resource || ...`)
// caught missing fields but accepted wrong types and unbounded sizes.
// Per CLAUDE.md "Use Zod for validation on every write path before
// calling supabase.insert()" — parse defensively before recordNonce + the
// subsequent enqueue_rule_event RPC.
const GraphChangeItemSchema = z
  .object({
    subscriptionId: z.string().min(1).max(256),
    clientState: z.string().min(1).max(256).optional(),
    resource: z.string().min(1).max(2048),
    resourceData: z
      .object({
        id: z.string().min(1).max(512),
        name: z.string().max(1024).optional(),
        parentReference: z
          .object({ path: z.string().max(2048).optional() })
          .passthrough()
          .optional(),
      })
      .passthrough(),
    changeType: z.enum(['created', 'updated', 'deleted']),
    tenantId: z.string().max(256).optional(),
  })
  .passthrough();

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

interface IntegrationLookup {
  row: IntegrationRow | null;
  lookupFailed: boolean;
}

async function findIntegrationBySubscription(
  subscriptionId: string,
): Promise<IntegrationLookup> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from('connector_subscriptions')
    .select('integration_id, org_integrations:integration_id ( id, org_id )')
    .eq('provider', 'microsoft_graph')
    .eq('vendor_subscription_id', subscriptionId)
    .is('revoked_at', null)
    .maybeSingle();
  if (error) {
    // CodeRabbit ASSERTIVE on PR #695: distinguish "not found" (legitimately
    // unknown subscription) from "lookup failed" (transient DB outage). The
    // previous behavior collapsed both to `null`, which the caller then
    // treated as `unknown_subscription` + 202 ack. Graph stops retrying on
    // 2xx, so a DB blip silently dropped notifications.
    logger.error({ error, subscriptionId }, 'MS Graph webhook: integration lookup failed');
    return { row: null, lookupFailed: true };
  }
  const row = data as { org_integrations?: { id: string; org_id: string } } | null;
  if (!row?.org_integrations) return { row: null, lookupFailed: false };
  return {
    row: { id: row.org_integrations.id, org_id: row.org_integrations.org_id },
    lookupFailed: false,
  };
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

// Microsoft Graph validation tokens are URL-safe random strings produced by
// Graph itself. Real tokens fit comfortably under 1024 chars and only use
// the characters in the regex below. We constrain the echo to that exact
// shape so an attacker cannot use the handshake endpoint to reflect
// arbitrary content (defense in depth — the response is already
// `text/plain` so HTML/JS injection is moot, but bounding the echo keeps
// the surface to documented Microsoft Graph contract).
const VALIDATION_TOKEN_MAX_LEN = 1024;
const VALIDATION_TOKEN_SAFE_RE = /^[A-Za-z0-9_\-.~+/=]+$/;

// Per-item processing extracted from the route handler so the handler
// stays under SonarCloud's Cognitive Complexity 15 limit. Returns a
// discriminated result; the handler accumulates outcomes and decides
// the HTTP response from the aggregate.
interface ProcessItemContext {
  expectedClientState: string;
  payloadHash: string;
}
type ProcessItemResult =
  | { outcome: 'enqueued'; ruleEventId: string }
  | { outcome: 'skipped'; reason: string; subscriptionId: string; lookupFailed?: boolean };

async function processGraphChangeItem(
  rawItem: unknown,
  ctx: ProcessItemContext,
): Promise<ProcessItemResult> {
  const parsedItem = GraphChangeItemSchema.safeParse(rawItem);
  if (!parsedItem.success) {
    const subId =
      typeof (rawItem as { subscriptionId?: unknown })?.subscriptionId === 'string'
        ? ((rawItem as { subscriptionId: string }).subscriptionId)
        : 'unknown';
    return { outcome: 'skipped', reason: 'malformed_item', subscriptionId: subId };
  }
  const item = parsedItem.data;
  if (!item.clientState || !constantTimeEqual(item.clientState, ctx.expectedClientState)) {
    return { outcome: 'skipped', reason: 'invalid_client_state', subscriptionId: item.subscriptionId };
  }
  const lookup = await findIntegrationBySubscription(item.subscriptionId);
  if (lookup.lookupFailed) {
    return {
      outcome: 'skipped',
      reason: 'lookup_failed',
      subscriptionId: item.subscriptionId,
      lookupFailed: true,
    };
  }
  if (!lookup.row) {
    return { outcome: 'skipped', reason: 'unknown_subscription', subscriptionId: item.subscriptionId };
  }
  const nonce = await recordNonce({
    subscriptionId: item.subscriptionId,
    resourceId: item.resourceData.id,
    changeType: item.changeType,
  });
  if (nonce.duplicate) {
    return { outcome: 'skipped', reason: 'duplicate', subscriptionId: item.subscriptionId };
  }
  if (nonce.failed) {
    return { outcome: 'skipped', reason: 'nonce_failed', subscriptionId: item.subscriptionId };
  }
  const ruleEventId = await enqueueRuleEvent({
    integration: lookup.row,
    item,
    payloadHash: ctx.payloadHash,
  });
  if (!ruleEventId) {
    return { outcome: 'skipped', reason: 'enqueue_failed', subscriptionId: item.subscriptionId };
  }
  return { outcome: 'enqueued', ruleEventId };
}

function handleValidationHandshake(rawToken: string, res: Response): void {
  if (
    rawToken.length === 0 ||
    rawToken.length > VALIDATION_TOKEN_MAX_LEN ||
    !VALIDATION_TOKEN_SAFE_RE.test(rawToken)
  ) {
    res.status(400).type('text/plain').send('invalid_validation_token');
    return;
  }
  // NOSONAR S5131: Echo of validation token is REQUIRED by the Microsoft
  // Graph subscription-create handshake contract — Graph rejects the
  // subscription if we don't return the exact bytes within 10 seconds.
  // The reflection surface is contained because (a) we already validated
  // the token shape (URL-safe charset, ≤1024 chars) above, (b) the
  // Content-Type is `text/plain` (browsers won't interpret as HTML/JS),
  // and (c) this endpoint has no session cookies / auth context to
  // exfiltrate. Spec: https://learn.microsoft.com/en-us/graph/webhooks#notification-endpoint-validation
  res.status(200).type('text/plain').send(rawToken); // NOSONAR
}

function parseNotificationBody(rawBody: Buffer): { items: GraphChangeItem[] } | { error: string } {
  try {
    const parsed = JSON.parse(rawBody.toString('utf8')) as { value?: GraphChangeItem[] };
    const items = Array.isArray(parsed.value) ? parsed.value : null;
    if (!items || items.length === 0) {
      return { error: 'value[] missing or empty' };
    }
    return { items };
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'MS Graph webhook: malformed body',
    );
    return { error: 'invalid_json' };
  }
}

microsoftGraphWebhookRouter.post('/', async (req: Request, res: Response) => {
  // Validation handshake: Graph creates a subscription by POSTing a body-less
  // request whose only signal is `?validationToken=...`. Echo it back as
  // text/plain within 10 seconds; otherwise the subscription create fails.
  const rawToken =
    typeof req.query.validationToken === 'string' ? req.query.validationToken : null;
  if (rawToken !== null) {
    handleValidationHandshake(rawToken, res);
    return;
  }

  const expectedClientState = config.microsoftGraphClientState;
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

  const parsedBody = parseNotificationBody(rawBody);
  if ('error' in parsedBody) {
    res.status(400).json({
      error: {
        code: 'invalid_body',
        ...(parsedBody.error !== 'invalid_json' && { message: parsedBody.error }),
      },
    });
    return;
  }

  const payloadHash = crypto.createHash('sha256').update(rawBody).digest('hex');
  const enqueued: string[] = [];
  const skipped: { reason: string; subscriptionId: string }[] = [];
  let anyLookupFailed = false;

  for (const rawItem of parsedBody.items) {
    const result = await processGraphChangeItem(rawItem, { expectedClientState, payloadHash });
    if (result.outcome === 'enqueued') {
      enqueued.push(result.ruleEventId);
    } else {
      if (result.lookupFailed) anyLookupFailed = true;
      skipped.push({ reason: result.reason, subscriptionId: result.subscriptionId });
    }
  }

  // Response decision: 401 if every item failed clientState (auth signal),
  // 503 if at least one transient DB lookup failed and nothing got through
  // (so Graph retries; nonce dedupe handles double-delivery), otherwise 202.
  const allRejected =
    enqueued.length === 0 &&
    skipped.length > 0 &&
    skipped.every((s) => s.reason === 'invalid_client_state');
  if (allRejected) {
    res.status(401).json({ error: { code: 'invalid_client_state' } });
    return;
  }
  if (anyLookupFailed && enqueued.length === 0) {
    res.status(503).json({
      error: {
        code: 'integration_lookup_failed',
        message: 'transient connector_subscriptions lookup failure; retry expected',
      },
    });
    return;
  }

  res.status(202).json({
    ok: true,
    enqueued: enqueued.length,
    skipped: skipped.length,
    rule_event_ids: enqueued,
  });
});
