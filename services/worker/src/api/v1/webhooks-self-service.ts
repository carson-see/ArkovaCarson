/**
 * Webhook self-service endpoints for the dashboard (WH-02 / WH-03)
 *
 * SCRUM-2397 (signed test ping) + SCRUM-2398 (replay).
 *
 * `services/worker/src/api/v1/webhooks.ts` already implements
 * `POST /api/v1/webhooks/test` and `POST /api/v1/webhooks/deliveries/:id/replay`,
 * but that router is mounted behind `apiKeyAuth` (see
 * `services/worker/src/middleware/apiKeyAuth.ts`), which recognizes ONLY
 * `ak_...` API keys — never a Supabase session JWT. The dashboard
 * (`src/pages/WebhookSettingsPage.tsx` / delivery-log UI) authenticates
 * users with their session token, so it cannot reach those endpoints.
 *
 * This router is the smallest possible bridge: it is mounted behind the v1
 * router's `requireAuth` (Supabase JWT — the same middleware guarding
 * `/api/v1/keys` and `/api/v1/exports/*`), re-derives org + ORG_ADMIN from
 * `profiles` (never trusts org/role supplied by the client), and then
 * delegates to the EXISTING signing/replay implementation:
 *   - test ping reuses `signPayload` + the SSRF guard `isPrivateUrlResolved`
 *     from `../../webhooks/delivery.js` (same HMAC scheme as production
 *     deliveries and the API-key `/test` route — no new signing logic).
 *   - replay calls `replayDelivery(...)` from the same module verbatim —
 *     the exact function the API-key route calls, including its
 *     audit-preserving "always insert a new delivery_logs row" idempotency
 *     model (replaying the same failed delivery twice never mutates or
 *     duplicates the original row; each call is independently recorded).
 *
 * No schema/migration change. No new HMAC scheme. No RLS change — this
 * router runs through service_role `db`, so authorization is enforced in
 * application code here (org resolved from the caller's `profiles` row,
 * ORG_ADMIN required), mirroring every other JWT-authed v1 endpoint.
 */

import { Router, Request, Response } from 'express';
import crypto from 'node:crypto';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import {
  getDeadLetterEntries,
  isPrivateUrlResolved,
  replayDelivery,
  resolveDlqEntry,
  signPayload,
} from '../../webhooks/delivery.js';

const router = Router();

/** Build a consistent error envelope, mirroring webhooks.ts. */
function errorResponse(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: code, message });
}

/**
 * Resolve { orgId } for the authenticated caller and require ORG_ADMIN.
 * Returns null (and writes the response) on any failure — org/role are
 * ALWAYS read from `profiles`, never trusted from the request.
 */
async function requireOrgAdminCaller(
  req: Request,
  res: Response,
): Promise<{ orgId: string } | null> {
  const userId = req.authUserId;
  if (!userId) {
    errorResponse(res, 401, 'authentication_required', 'Supabase session authentication required');
    return null;
  }

  const { data: profile, error } = await db
    .from('profiles')
    .select('org_id, role')
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    logger.error({ error, userId }, 'webhook self-service: profile lookup failed');
    errorResponse(res, 500, 'internal_error', 'Failed to verify permissions');
    return null;
  }

  if (!profile?.org_id) {
    errorResponse(res, 403, 'forbidden', 'You must belong to an organization to manage webhooks');
    return null;
  }

  if (profile.role !== 'ORG_ADMIN') {
    errorResponse(res, 403, 'forbidden', 'Only organization admins can manage webhook endpoints');
    return null;
  }

  return { orgId: profile.org_id };
}

// ─── WH-02: POST /:id/test — signed test ping ────────────────────────────
// Mirrors `POST /api/v1/webhooks/test` (webhooks.ts) but takes the endpoint
// id as a path param (matches this router's REST shape) and is JWT-authed.
// Reuses signPayload verbatim — same HMAC-SHA256 scheme every real delivery
// and replay use, so a "verified" test ping proves the receiver can validate
// production signatures too.
router.post('/:id/test', async (req, res) => {
  const caller = await requireOrgAdminCaller(req, res);
  if (!caller) return;

  const { id } = req.params;

  try {
    const { data: endpoint, error } = await db
      .from('webhook_endpoints')
      .select('id, url, secret_hash, is_active, org_id')
      .eq('id', id)
      .eq('org_id', caller.orgId)
      .maybeSingle();

    if (error) {
      logger.error({ error, id }, 'webhook self-service test: endpoint lookup failed');
      errorResponse(res, 500, 'internal_error', 'Failed to load webhook endpoint');
      return;
    }

    if (!endpoint) {
      errorResponse(res, 404, 'not_found', 'Webhook endpoint not found or does not belong to your organization');
      return;
    }

    if (!endpoint.is_active) {
      errorResponse(res, 400, 'endpoint_inactive', 'Webhook endpoint is not active');
      return;
    }

    // SSRF: full DNS resolution to block DNS-rebinding attacks (same guard
    // used for create/update/API-key test-ping/replay).
    if (await isPrivateUrlResolved(endpoint.url)) {
      errorResponse(res, 400, 'invalid_url', 'Webhook URL targets a private or internal network address');
      return;
    }

    // event_id doubles as the wire event id AND the webhook_delivery_logs
    // row's event_id, which is a uuid column (SCRUM-1800) — so it must be a
    // real UUID, not a prefixed string.
    const eventId = crypto.randomUUID();
    const testPayload = {
      event_type: 'test.ping',
      event_id: eventId,
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

    // WH-02 AC: the test ping lands in the delivery log like any other
    // delivery so its status / response code / timestamp are visible in the
    // dashboard delivery history. Failure to record is logged but does not
    // fail the ping response — the caller already has the live result.
    const { error: logError } = await db.from('webhook_delivery_logs').insert({
      endpoint_id: endpoint.id,
      event_type: 'test.ping',
      event_id: eventId,
      payload: testPayload,
      attempt_number: 1,
      status: response.ok ? 'success' : 'failed',
      response_status: response.status,
      delivered_at: response.ok ? new Date().toISOString() : null,
      idempotency_key: `test-${endpoint.id}-${eventId}`,
    });
    if (logError) {
      logger.warn({ error: logError, endpointId: endpoint.id }, 'test ping delivery log insert failed');
    }

    res.json({
      success: response.ok,
      status_code: response.status,
      response_body: responseBody.slice(0, 500),
      event_id: eventId,
    });
  } catch (err) {
    logger.error({ error: err, id }, 'webhook self-service: test ping failed');
    errorResponse(
      res,
      500,
      'delivery_failed',
      err instanceof Error ? err.message : 'Failed to deliver test webhook',
    );
  }
});

// ─── WH-03: POST /deliveries/:id/replay ──────────────────────────────────
// Delegates to the SAME replayDelivery() the API-key route uses — no
// duplicated replay/signing logic. replayDelivery always inserts a NEW
// webhook_delivery_logs row (never mutates the original), so replaying the
// same failed delivery twice is safe: two independent, auditable attempts,
// never a corrupted/duplicated original record.
router.post('/deliveries/:id/replay', async (req, res) => {
  const caller = await requireOrgAdminCaller(req, res);
  if (!caller) return;

  const { id } = req.params;

  try {
    const result = await replayDelivery(id, caller.orgId);

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

    // Fire-and-forget audit insert — mirrors webhooks.ts's replay audit event.
    void Promise.resolve(
      db.from('audit_events').insert({
        event_type: 'WEBHOOK_DELIVERY_REPLAYED',
        event_category: 'ADMIN',
        actor_id: req.authUserId ?? null,
        target_type: 'webhook_delivery',
        target_id: result.new_delivery_id ?? null,
        org_id: caller.orgId,
        details: JSON.stringify({
          replayed_from: id,
          ok: result.ok,
          status_code: result.status_code ?? null,
        }),
      }),
    )
      .then((r) => {
        if (r?.error) {
          logger.error({ error: r.error, deliveryId: id }, 'Failed to record WEBHOOK_DELIVERY_REPLAYED audit event');
        }
      })
      .catch((err: unknown) => {
        logger.error({ error: err, deliveryId: id }, 'Audit event insert rejected for WEBHOOK_DELIVERY_REPLAYED');
      });

    res.json({
      replayed: true,
      ok: result.ok,
      delivery_id: result.new_delivery_id,
      status_code: result.status_code ?? null,
    });
  } catch (err) {
    logger.error({ error: err, id }, 'webhook self-service: replay failed');
    errorResponse(res, 500, 'internal_error', 'Failed to replay delivery');
  }
});

// ─── WH-03: GET /dlq — dead-letter queue listing (metadata only) ─────────
// `webhook_dead_letter_queue` has service_role-only RLS (baseline policy
// `service_role_full_access`), so the browser cannot read it directly the
// way it reads `webhook_delivery_logs` (which has an org-scoped
// authenticated SELECT policy). This endpoint reuses the existing
// `getDeadLetterEntries(orgId)` from delivery.ts and projects an explicit
// ALLOWLIST of metadata fields. The jsonb `payload` (which can carry
// document metadata), internal `endpoint_id`/`org_id` UUIDs, and everything
// else are deliberately dropped (§1.6 / §6 — delivery metadata only).
router.get('/dlq', async (req, res) => {
  const caller = await requireOrgAdminCaller(req, res);
  if (!caller) return;

  try {
    const rows = await getDeadLetterEntries(caller.orgId);

    const entries = rows.map((row) => ({
      id: row.id,
      endpoint_url: row.endpoint_url,
      event_type: row.event_type,
      event_id: row.event_id,
      error_message: row.error_message,
      last_attempt: row.last_attempt,
      failed_at: row.failed_at,
    }));

    res.json({ entries });
  } catch (err) {
    logger.error({ error: err }, 'webhook self-service: DLQ listing failed');
    errorResponse(res, 500, 'internal_error', 'Failed to load failed deliveries');
  }
});

// ─── WH-03: POST /dlq/:id/resolve — dismiss a DLQ entry ──────────────────
// Reuses `resolveDlqEntry(entryId, orgId)` (ARK-SEC-026: verifies the entry
// belongs to the caller org before resolving). A false return is reported
// as 404 — cross-org and missing are indistinguishable to the caller.
router.post('/dlq/:id/resolve', async (req, res) => {
  const caller = await requireOrgAdminCaller(req, res);
  if (!caller) return;

  const { id } = req.params;

  try {
    const ok = await resolveDlqEntry(id, caller.orgId);

    if (!ok) {
      errorResponse(res, 404, 'not_found', 'Failed delivery not found or does not belong to your organization');
      return;
    }

    res.json({ resolved: true });
  } catch (err) {
    logger.error({ error: err, id }, 'webhook self-service: DLQ resolve failed');
    errorResponse(res, 500, 'internal_error', 'Failed to update the failed delivery');
  }
});

export { router as webhooksSelfServiceRouter };
