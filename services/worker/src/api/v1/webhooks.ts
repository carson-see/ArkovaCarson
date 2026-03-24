/**
 * Webhook Management Endpoints (WEBHOOK-3, WEBHOOK-4)
 *
 * POST /api/v1/webhooks/test — Send a test webhook to a specified endpoint
 * GET /api/v1/webhooks/deliveries — View delivery logs for self-service debugging
 */

import { Router } from 'express';
import crypto from 'node:crypto';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

const router = Router();

/**
 * POST /api/v1/webhooks/test (WEBHOOK-3)
 *
 * Send a synthetic test event to a webhook endpoint. Allows developers
 * to verify their endpoint configuration without creating real data.
 */
router.post('/test', async (req, res) => {
  if (!req.apiKey) {
    res.status(401).json({
      error: 'authentication_required',
      message: 'API key required to send test webhooks',
    });
    return;
  }

  const { endpoint_id } = req.body as { endpoint_id?: string };
  if (!endpoint_id) {
    res.status(400).json({
      error: 'invalid_request',
      message: 'endpoint_id is required',
    });
    return;
  }

  try {
    // Look up the endpoint (must belong to the API key's org)
    const { data: endpoint, error } = await db
      .from('webhook_endpoints')
      .select('id, url, secret_hash, events, is_active, org_id')
      .eq('id', endpoint_id)
      .eq('org_id', req.apiKey.orgId)
      .single();

    if (error || !endpoint) {
      res.status(404).json({
        error: 'not_found',
        message: 'Webhook endpoint not found or does not belong to your organization',
      });
      return;
    }

    if (!endpoint.is_active) {
      res.status(400).json({
        error: 'endpoint_inactive',
        message: 'Webhook endpoint is not active',
      });
      return;
    }

    // Build synthetic test payload
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

    // Sign and send
    const payloadString = JSON.stringify(testPayload);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = crypto
      .createHmac('sha256', endpoint.secret_hash)
      .update(`${timestamp}.${payloadString}`)
      .digest('hex');

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
    res.status(500).json({
      error: 'delivery_failed',
      message: err instanceof Error ? err.message : 'Failed to deliver test webhook',
    });
  }
});

/**
 * GET /api/v1/webhooks/deliveries (WEBHOOK-4)
 *
 * Returns recent delivery attempts for an endpoint, enabling
 * developers to self-service debug webhook failures.
 */
router.get('/deliveries', async (req, res) => {
  if (!req.apiKey) {
    res.status(401).json({
      error: 'authentication_required',
      message: 'API key required to view delivery logs',
    });
    return;
  }

  const endpointId = req.query.endpoint_id as string | undefined;
  const limit = Math.min(Number(req.query.limit) || 50, 100);

  try {
    // Verify endpoint belongs to org
    if (endpointId) {
      const { data: endpoint } = await db
        .from('webhook_endpoints')
        .select('id')
        .eq('id', endpointId)
        .eq('org_id', req.apiKey.orgId)
        .single();

      if (!endpoint) {
        res.status(404).json({
          error: 'not_found',
          message: 'Webhook endpoint not found or does not belong to your organization',
        });
        return;
      }
    }

    // Fetch delivery logs
    let query = db
      .from('webhook_delivery_logs')
      .select('id, endpoint_id, event_type, event_id, status, response_status, error_message, attempt_number, delivered_at, created_at, next_retry_at')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (endpointId) {
      query = query.eq('endpoint_id', endpointId);
    }

    const { data: logs, error } = await query;

    if (error) {
      logger.error({ error }, 'Failed to fetch delivery logs');
      res.status(500).json({
        error: 'internal_error',
        message: 'Failed to fetch delivery logs',
      });
      return;
    }

    res.json({
      deliveries: logs ?? [],
      total: logs?.length ?? 0,
    });
  } catch (err) {
    logger.error({ error: err }, 'Delivery logs query failed');
    res.status(500).json({
      error: 'internal_error',
      message: 'Failed to fetch delivery logs',
    });
  }
});

export { router as webhooksRouter };
