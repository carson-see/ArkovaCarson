/**
 * Webhook Management Endpoints
 *
 * Existing (WEBHOOK-3, WEBHOOK-4):
 *   POST /api/v1/webhooks/test         — Send a test webhook to a specified endpoint
 *   GET  /api/v1/webhooks/deliveries   — View delivery logs for self-service debugging
 *
 * Webhook CRUD (INT-09 / SCRUM-645) — closes the API-only loop:
 *   POST   /api/v1/webhooks            — Register a new webhook endpoint
 *   GET    /api/v1/webhooks            — List org's webhook endpoints (paginated)
 *   GET    /api/v1/webhooks/:id        — Get a single endpoint
 *   PATCH  /api/v1/webhooks/:id        — Update url / events / is_active / description
 *   DELETE /api/v1/webhooks/:id        — Delete an endpoint (cascades to delivery logs)
 *
 * All endpoints require API key auth (X-API-Key or Bearer ak_...).
 * SSRF protection: URLs are validated against private/internal IP ranges via
 * isPrivateUrlResolved() with full DNS resolution. Audit events emitted to
 * audit_events for every state-changing operation.
 *
 * Route order matters: static routes (/test, /deliveries) MUST be registered
 * before parameterized routes (/:id) so Express matches them first.
 */

import { Router, Request, Response } from 'express';
import crypto from 'node:crypto';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { isPrivateUrlResolved, replayDelivery, signPayload } from '../../webhooks/delivery.js';
import {
  CreateWebhookSchema,
  UpdateWebhookSchema,
  ListWebhooksQuerySchema,
} from './webhooks-schemas.js';

export { CreateWebhookSchema, UpdateWebhookSchema, ListWebhooksQuerySchema, VALID_WEBHOOK_EVENTS } from './webhooks-schemas.js';
import { VALID_WEBHOOK_EVENTS } from './webhooks-schemas.js';

const router = Router();
// Keep VALID_WEBHOOK_EVENTS in scope for runtime reference elsewhere if needed.
void VALID_WEBHOOK_EVENTS;

// ─── Shared helpers ───────────────────────────────────────────────────────

/** Require API key auth. Returns false and writes a 401 when missing. */
function requireApiKey(req: Request, res: Response): req is Request & { apiKey: NonNullable<Request['apiKey']> } {
  if (!req.apiKey) {
    res.status(401).json({ error: 'authentication_required', message: 'API key required' });
    return false;
  }
  return true;
}

/**
 * Require the underlying API key actor to be an ORG_ADMIN. Mirrors the
 * ORG_ADMIN enforcement in migration 0046's `create_webhook_endpoint` and
 * `delete_webhook_endpoint` RPCs so the API-managed CRUD path cannot be
 * used by non-admin keys to silently register outbound data exfiltration.
 *
 * Returns false and writes a 403 when the actor is not an admin.
 */
async function requireOrgAdmin(
  req: Request & { apiKey: NonNullable<Request['apiKey']> },
  res: Response,
): Promise<boolean> {
  try {
    const { data: profile } = await db
      .from('profiles')
      .select('role')
      .eq('id', req.apiKey.userId)
      .single();

    if (!profile || profile.role !== 'ORG_ADMIN') {
      errorResponse(
        res,
        403,
        'forbidden',
        'Only organization admins can manage webhook endpoints',
      );
      return false;
    }
    return true;
  } catch (err) {
    logger.error({ err, userId: req.apiKey.userId }, 'webhook admin check failed');
    errorResponse(res, 500, 'internal_error', 'Failed to verify admin permissions');
    return false;
  }
}

/** Build a consistent error envelope across every handler. */
function errorResponse(
  res: Response,
  status: number,
  code: string,
  message: string,
  details?: unknown,
): void {
  res.status(status).json(details === undefined ? { error: code, message } : { error: code, message, details });
}

/** Generate a cryptographically random 64-char hex secret for HMAC signing. */
function generateWebhookSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Send a verification ping to the URL with a challenge token. The endpoint
 * must respond 2xx and echo the challenge in the body. Returns null on
 * success, or an error message on failure. Timeout: 5 seconds.
 */
async function sendVerificationPing(url: string, secret: string): Promise<string | null> {
  const challenge = crypto.randomBytes(16).toString('hex');
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const payload = JSON.stringify({ event_type: 'webhook.verification', challenge, timestamp });
  const signature = signPayload(`${timestamp}.${payload}`, secret);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Arkova-Signature': signature,
        'X-Arkova-Timestamp': timestamp,
        'X-Arkova-Event': 'webhook.verification',
      },
      body: payload,
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) return `verification endpoint returned HTTP ${response.status}`;

    const body = await response.text().catch(() => '');
    if (!body.includes(challenge)) return 'verification endpoint did not echo challenge token';
    return null;
  } catch (err) {
    return err instanceof Error ? `verification ping failed: ${err.message}` : 'verification ping failed';
  }
}

/**
 * Fire-and-forget audit event logger for webhook CRUD operations.
 *
 * Constraints (from migrations 0006 + 0066):
 *   - `audit_events.actor_id` has an FK to profiles(id). Callers must pass
 *     the `userId` from `req.apiKey` (== api_keys.created_by), NOT `keyId`
 *     (== api_keys.id). The latter would violate the FK and the insert
 *     would be silently rejected.
 *   - `audit_events.event_category` has a CHECK constraint requiring an
 *     UPPERCASE allowlist value. Use `WEBHOOK_ENDPOINT_*` + `'WEBHOOK'` to
 *     match the UI/RPC path already in migration 0046.
 *   - `audit_events.details` is a TEXT column — JSON.stringify to preserve
 *     structure.
 */
function logWebhookAudit(
  orgId: string,
  actorProfileId: string,
  eventType: 'WEBHOOK_ENDPOINT_CREATED' | 'WEBHOOK_ENDPOINT_UPDATED' | 'WEBHOOK_ENDPOINT_DELETED',
  endpointId: string,
  details: Record<string, unknown> = {},
): void {
  void Promise.resolve(
    db
      .from('audit_events')
      .insert({
        event_type: eventType,
        event_category: 'WEBHOOK',
        actor_id: actorProfileId,
        org_id: orgId,
        target_type: 'webhook_endpoint',
        target_id: endpointId,
        details: JSON.stringify(details),
      }),
  )
    .then((result) => {
      if (result.error) logger.warn({ error: result.error, eventType, endpointId }, 'audit event insert failed');
    })
    .catch((err: unknown) => {
      logger.warn({ err, eventType, endpointId }, 'audit event insert rejected');
    });
}

/** Columns selected for every response; DB schema === JSON schema. */
const ENDPOINT_SELECT = 'id, url, events, is_active, description, created_at, updated_at';

interface WebhookEndpointResponse {
  id: string;
  url: string;
  events: string[];
  is_active: boolean;
  description: string | null;
  created_at: string;
  updated_at: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// ROUTE ORDER: static routes FIRST, parameterized routes AFTER.
// ═══════════════════════════════════════════════════════════════════════════

// ─── INT-09: POST /api/v1/webhooks — register ────────────────────────────

router.post('/', async (req, res) => {
  if (!requireApiKey(req, res)) return;
  if (!(await requireOrgAdmin(req, res))) return;

  const parsed = CreateWebhookSchema.safeParse(req.body);
  if (!parsed.success) {
    errorResponse(res, 400, 'validation_error', 'Invalid webhook registration payload', parsed.error.flatten().fieldErrors);
    return;
  }

  const { url, events, description, verify } = parsed.data;

  if (await isPrivateUrlResolved(url)) {
    errorResponse(res, 400, 'invalid_url', 'Webhook URL targets a private, internal, or cloud-metadata address');
    return;
  }

  const secret = generateWebhookSecret();

  // Insert first (inactive if verify is opt-in), then ping, then activate.
  // This prevents sending a signed ping to a URL whose DB row never got created.
  try {
    const { data: inserted, error } = await db
      .from('webhook_endpoints')
      .insert({
        org_id: req.apiKey.orgId,
        url,
        secret_hash: secret,
        events,
        is_active: !verify,
        description: description ?? null,
      })
      .select(ENDPOINT_SELECT)
      .single();

    if (error || !inserted) {
      logger.error({ error, orgId: req.apiKey.orgId }, 'failed to create webhook endpoint');
      errorResponse(res, 500, 'internal_error', 'Failed to register webhook endpoint');
      return;
    }

    if (verify) {
      const pingError = await sendVerificationPing(url, secret);
      if (pingError) {
        // Roll back: delete the endpoint we just inserted.
        await db.from('webhook_endpoints').delete().eq('id', inserted.id);
        errorResponse(res, 400, 'verification_failed', pingError);
        return;
      }

      // Ping succeeded — activate. If activation fails we must NOT return a
      // success envelope, otherwise the caller believes registration worked,
      // already received the one-time secret, but events will never fire.
      const { data: activated, error: activateError } = await db
        .from('webhook_endpoints')
        .update({ is_active: true })
        .eq('id', inserted.id)
        .select(ENDPOINT_SELECT)
        .single();

      if (activateError || !activated) {
        await db.from('webhook_endpoints').delete().eq('id', inserted.id);
        logger.error({ error: activateError, id: inserted.id }, 'webhook activation failed after verification ping');
        errorResponse(
          res,
          500,
          'activation_failed',
          'Verification ping succeeded but endpoint activation failed; please retry',
        );
        return;
      }

      Object.assign(inserted, activated);
    }

    logWebhookAudit(req.apiKey.orgId, req.apiKey.userId, 'WEBHOOK_ENDPOINT_CREATED', inserted.id, {
      url,
      events,
      verified: Boolean(verify),
    });

    res.status(201).json({
      ...(inserted as WebhookEndpointResponse),
      secret,
      warning: 'Save this secret now. It is shown once and used to verify HMAC signatures on incoming webhooks.',
    });
  } catch (err) {
    logger.error({ error: err }, 'webhook registration failed');
    errorResponse(res, 500, 'internal_error', 'Failed to register webhook endpoint');
  }
});

// ─── INT-09: GET /api/v1/webhooks — list ────────────────────────────────

router.get('/', async (req, res) => {
  if (!requireApiKey(req, res)) return;

  const parsed = ListWebhooksQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    errorResponse(res, 400, 'validation_error', 'Invalid query parameters', parsed.error.flatten().fieldErrors);
    return;
  }

  const { limit, offset } = parsed.data;

  try {
    // Use { count: 'exact' } so `total` reflects the row count across all
    // pages — consumers need this for correct pagination. Org webhook counts
    // are bounded in the low hundreds, so the extra COUNT(*) is cheap.
    const { data: rows, error, count } = await db
      .from('webhook_endpoints')
      .select(ENDPOINT_SELECT, { count: 'exact' })
      .eq('org_id', req.apiKey.orgId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      logger.error({ error, orgId: req.apiKey.orgId }, 'failed to list webhook endpoints');
      errorResponse(res, 500, 'internal_error', 'Failed to list webhook endpoints');
      return;
    }

    const webhooks = (rows ?? []) as WebhookEndpointResponse[];
    res.json({ webhooks, total: count ?? webhooks.length, limit, offset });
  } catch (err) {
    logger.error({ error: err }, 'webhook listing failed');
    errorResponse(res, 500, 'internal_error', 'Failed to list webhook endpoints');
  }
});

// ─── WEBHOOK-3: POST /api/v1/webhooks/test ────────────────────────────────
// NOTE: Must be registered BEFORE /:id so Express matches the literal path first.

router.post('/test', async (req, res) => {
  if (!requireApiKey(req, res)) return;

  const { endpoint_id } = req.body as { endpoint_id?: string };
  if (!endpoint_id) {
    errorResponse(res, 400, 'invalid_request', 'endpoint_id is required');
    return;
  }

  try {
    const { data: endpoint, error } = await db
      .from('webhook_endpoints')
      .select('id, url, secret_hash, events, is_active, org_id')
      .eq('id', endpoint_id)
      .eq('org_id', req.apiKey.orgId)
      .single();

    if (error || !endpoint) {
      errorResponse(res, 404, 'not_found', 'Webhook endpoint not found or does not belong to your organization');
      return;
    }

    if (!endpoint.is_active) {
      errorResponse(res, 400, 'endpoint_inactive', 'Webhook endpoint is not active');
      return;
    }

    // SEC-023: SSRF — full DNS resolution to block DNS-rebinding attacks.
    if (await isPrivateUrlResolved(endpoint.url)) {
      errorResponse(res, 400, 'invalid_url', 'Webhook URL targets a private or internal network address');
      return;
    }

    const testPayload = {
      event_type: 'test.ping',
      event_id: `test_${crypto.randomBytes(12).toString('hex')}`,
      timestamp: new Date().toISOString(),
      test: true,
      data: {
        message: 'This is a test webhook from Arkova. Your endpoint is configured correctly.',
        endpoint_id: endpoint.id,
      },
    };

    const payloadString = JSON.stringify(testPayload);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = signPayload(`${timestamp}.${payloadString}`, endpoint.secret_hash);

    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Arkova-Signature': signature,
        'X-Arkova-Timestamp': timestamp,
        'X-Arkova-Event': 'test.ping',
      },
      body: payloadString,
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
    });

    const responseBody = await response.text().catch(() => '');

    res.json({
      success: response.ok,
      status_code: response.status,
      response_body: responseBody.slice(0, 500),
      event_id: testPayload.event_id,
    });
  } catch (err) {
    logger.error({ error: err, endpoint_id }, 'Test webhook delivery failed');
    errorResponse(
      res,
      500,
      'delivery_failed',
      err instanceof Error ? err.message : 'Failed to deliver test webhook',
    );
  }
});

// ─── WEBHOOK-4: GET /api/v1/webhooks/deliveries ──────────────────────────
// NOTE: Must be registered BEFORE /:id so Express matches the literal path first.

router.get('/deliveries', async (req, res) => {
  if (!requireApiKey(req, res)) return;

  const endpointId = req.query.endpoint_id as string | undefined;
  const limit = Math.min(Number(req.query.limit) || 50, 100);

  try {
    if (endpointId) {
      const { data: endpoint } = await db
        .from('webhook_endpoints')
        .select('id')
        .eq('id', endpointId)
        .eq('org_id', req.apiKey.orgId)
        .single();

      if (!endpoint) {
        errorResponse(res, 404, 'not_found', 'Webhook endpoint not found or does not belong to your organization');
        return;
      }
    }

    // SEC-025: Always scope delivery logs to the caller's org endpoints.
    let scopedEndpointIds: string[] = [];
    if (!endpointId) {
      const { data: orgEndpoints, error: scopeError } = await db
        .from('webhook_endpoints')
        .select('id')
        .eq('org_id', req.apiKey.orgId);

      if (scopeError) {
        // Never mask a real DB failure as an empty result — callers cannot
        // distinguish "I have no webhooks" from "our database is down".
        logger.error({ error: scopeError, orgId: req.apiKey.orgId }, 'failed to scope delivery logs');
        errorResponse(res, 500, 'internal_error', 'Failed to fetch delivery logs');
        return;
      }

      scopedEndpointIds = (orgEndpoints ?? []).map((e: { id: string }) => e.id);
      if (scopedEndpointIds.length === 0) {
        res.json({ deliveries: [], total: 0 });
        return;
      }
    }

    let query = db
      .from('webhook_delivery_logs')
      .select('id, endpoint_id, event_type, event_id, status, response_status, error_message, attempt_number, delivered_at, created_at, next_retry_at')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (endpointId) {
      query = query.eq('endpoint_id', endpointId);
    } else {
      query = query.in('endpoint_id', scopedEndpointIds);
    }

    const { data: logs, error } = await query;

    if (error) {
      logger.error({ error }, 'Failed to fetch delivery logs');
      errorResponse(res, 500, 'internal_error', 'Failed to fetch delivery logs');
      return;
    }

    res.json({ deliveries: logs ?? [], total: logs?.length ?? 0 });
  } catch (err) {
    logger.error({ error: err }, 'Delivery logs query failed');
    errorResponse(res, 500, 'internal_error', 'Failed to fetch delivery logs');
  }
});

// ─── SCRUM-1172 / HAKI-REQ-03 AC3: POST /api/v1/webhooks/deliveries/:id/replay ──
// Re-fires a previously-attempted delivery using the original payload, signed
// with a fresh timestamp. Inserts a new `webhook_delivery_logs` row tagged with
// idempotency_key=`replay-{id}-{ts}` so the original is preserved for audit.
// Cross-org access returns 404 (matches existing /deliveries scoping).
router.post('/deliveries/:id/replay', async (req, res) => {
  if (!requireApiKey(req, res)) return;

  try {
    const result = await replayDelivery(req.params.id, req.apiKey.orgId);

    if (result.error === 'not_found' || result.error === 'cross_org') {
      errorResponse(res, 404, 'not_found', 'Delivery not found or does not belong to your organization');
      return;
    }
    if (result.error === 'endpoint_inactive') {
      errorResponse(res, 409, 'endpoint_inactive', 'Cannot replay to a disabled webhook endpoint');
      return;
    }
    if (result.error === 'ssrf_blocked') {
      errorResponse(res, 403, 'ssrf_blocked', 'Endpoint URL targets a private network');
      return;
    }
    if (result.error === 'delivery_failed' && !result.new_delivery_id) {
      errorResponse(res, 500, 'internal_error', 'Failed to record replay');
      return;
    }

    // Fire-and-forget audit insert. Wrap in Promise.resolve so .catch surfaces
    // a rejection (Supabase builders return PromiseLike, not Promise) — losing
    // the audit event silently would defeat the gate.
    void Promise.resolve(
      db.from('audit_events').insert({
        event_type: 'WEBHOOK_DELIVERY_REPLAYED',
        event_category: 'ADMIN',
        actor_id: req.apiKey.userId,
        target_type: 'webhook_delivery',
        target_id: result.new_delivery_id ?? null,
        org_id: req.apiKey.orgId,
        details: JSON.stringify({
          replayed_from: req.params.id,
          ok: result.ok,
          status_code: result.status_code ?? null,
        }),
      }),
    )
      .then((r) => {
        if (r?.error) {
          logger.error(
            { error: r.error, deliveryId: req.params.id },
            'Failed to record WEBHOOK_DELIVERY_REPLAYED audit event',
          );
        }
      })
      .catch((err: unknown) => {
        logger.error(
          { error: err, deliveryId: req.params.id },
          'Audit event insert rejected for WEBHOOK_DELIVERY_REPLAYED',
        );
      });

    res.json({
      replayed: true,
      ok: result.ok,
      delivery_id: result.new_delivery_id,
      status_code: result.status_code ?? null,
    });
  } catch (err) {
    logger.error({ error: err, deliveryId: req.params.id }, 'webhook replay failed');
    errorResponse(res, 500, 'internal_error', 'Failed to replay delivery');
  }
});

// ─── INT-09: GET /api/v1/webhooks/:id ────────────────────────────────────

router.get('/:id', async (req, res) => {
  if (!requireApiKey(req, res)) return;

  try {
    const { data: endpoint, error } = await db
      .from('webhook_endpoints')
      .select(ENDPOINT_SELECT)
      .eq('id', req.params.id)
      .eq('org_id', req.apiKey.orgId)
      .maybeSingle();

    if (error || !endpoint) {
      errorResponse(res, 404, 'not_found', 'Webhook endpoint not found or does not belong to your organization');
      return;
    }

    res.json(endpoint as WebhookEndpointResponse);
  } catch (err) {
    logger.error({ error: err, id: req.params.id }, 'webhook get failed');
    errorResponse(res, 500, 'internal_error', 'Failed to fetch webhook endpoint');
  }
});

// ─── INT-09: PATCH /api/v1/webhooks/:id ──────────────────────────────────

router.patch('/:id', async (req, res) => {
  if (!requireApiKey(req, res)) return;
  if (!(await requireOrgAdmin(req, res))) return;

  const parsed = UpdateWebhookSchema.safeParse(req.body);
  if (!parsed.success) {
    errorResponse(res, 400, 'validation_error', 'Invalid webhook update payload', parsed.error.flatten().fieldErrors);
    return;
  }

  // Always re-validate SSRF on any supplied URL (closes the read-then-compare TOCTOU).
  if (parsed.data.url && (await isPrivateUrlResolved(parsed.data.url))) {
    errorResponse(res, 400, 'invalid_url', 'Webhook URL targets a private, internal, or cloud-metadata address');
    return;
  }

  // supabase-js v2.x update() rejects Record<string, unknown> via
  // RejectExcessProperties; declare the partial-update shape explicitly.
  const updateData: {
    url?: string;
    events?: string[];
    description?: string | null;
    is_active?: boolean;
  } = {};
  if (parsed.data.url !== undefined) updateData.url = parsed.data.url;
  if (parsed.data.events !== undefined) updateData.events = parsed.data.events;
  if (parsed.data.description !== undefined) updateData.description = parsed.data.description;
  if (parsed.data.is_active !== undefined) updateData.is_active = parsed.data.is_active;

  try {
    const { data: updated, error } = await db
      .from('webhook_endpoints')
      .update(updateData)
      .eq('id', req.params.id)
      .eq('org_id', req.apiKey.orgId)
      .select(ENDPOINT_SELECT)
      .maybeSingle();

    if (error) {
      logger.error({ error, id: req.params.id }, 'failed to update webhook endpoint');
      errorResponse(res, 500, 'internal_error', 'Failed to update webhook endpoint');
      return;
    }

    if (!updated) {
      errorResponse(res, 404, 'not_found', 'Webhook endpoint not found or does not belong to your organization');
      return;
    }

    logWebhookAudit(req.apiKey.orgId, req.apiKey.userId, 'WEBHOOK_ENDPOINT_UPDATED', req.params.id, {
      changed_fields: Object.keys(updateData),
    });

    res.json(updated as WebhookEndpointResponse);
  } catch (err) {
    logger.error({ error: err, id: req.params.id }, 'webhook update failed');
    errorResponse(res, 500, 'internal_error', 'Failed to update webhook endpoint');
  }
});

// ─── INT-09: DELETE /api/v1/webhooks/:id ─────────────────────────────────

router.delete('/:id', async (req, res) => {
  if (!requireApiKey(req, res)) return;
  if (!(await requireOrgAdmin(req, res))) return;

  try {
    const { data: deleted, error } = await db
      .from('webhook_endpoints')
      .delete()
      .eq('id', req.params.id)
      .eq('org_id', req.apiKey.orgId)
      .select('id')
      .maybeSingle();

    if (error) {
      logger.error({ error, id: req.params.id }, 'failed to delete webhook endpoint');
      errorResponse(res, 500, 'internal_error', 'Failed to delete webhook endpoint');
      return;
    }

    if (!deleted) {
      errorResponse(res, 404, 'not_found', 'Webhook endpoint not found or does not belong to your organization');
      return;
    }

    logWebhookAudit(req.apiKey.orgId, req.apiKey.userId, 'WEBHOOK_ENDPOINT_DELETED', req.params.id);
    res.status(204).end();
  } catch (err) {
    logger.error({ error: err, id: req.params.id }, 'webhook delete failed');
    errorResponse(res, 500, 'internal_error', 'Failed to delete webhook endpoint');
  }
});

export { router as webhooksRouter };
