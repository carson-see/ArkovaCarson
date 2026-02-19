/**
 * Webhook Delivery Engine
 *
 * Handles signed webhook delivery with exponential backoff retries.
 */

import crypto from 'crypto';
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';

const MAX_RETRIES = 5;
const INITIAL_RETRY_DELAY_MS = 1000;

interface WebhookPayload {
  event_type: string;
  event_id: string;
  timestamp: string;
  data: Record<string, unknown>;
}

interface WebhookEndpoint {
  id: string;
  url: string;
  secret_hash: string;
  events: string[];
  is_active: boolean;
  org_id: string;
}

/**
 * Sign a webhook payload with HMAC-SHA256
 */
function signPayload(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Calculate exponential backoff delay
 */
function getRetryDelay(attempt: number): number {
  return INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
}

/**
 * Deliver a webhook to an endpoint
 */
async function deliverToEndpoint(
  endpoint: WebhookEndpoint,
  payload: WebhookPayload,
  attempt: number = 1
): Promise<boolean> {
  const payloadString = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = signPayload(`${timestamp}.${payloadString}`, endpoint.secret_hash);

  const idempotencyKey = `${endpoint.id}-${payload.event_id}-${attempt}`;

  // Check if already delivered
  const { data: existing } = await db
    .from('webhook_delivery_logs')
    .select('id')
    .eq('idempotency_key', idempotencyKey)
    .single();

  if (existing) {
    logger.debug({ endpointId: endpoint.id, eventId: payload.event_id }, 'Webhook already delivered');
    return true;
  }

  // Log the attempt
  const { data: logEntry, error: logError } = await db
    .from('webhook_delivery_logs')
    .insert({
      endpoint_id: endpoint.id,
      event_type: payload.event_type,
      event_id: payload.event_id,
      payload: payload,
      attempt_number: attempt,
      status: 'pending',
      idempotency_key: idempotencyKey,
    })
    .select()
    .single();

  if (logError) {
    logger.error({ error: logError }, 'Failed to create delivery log');
    return false;
  }

  try {
    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Arkova-Signature': signature,
        'X-Arkova-Timestamp': timestamp,
        'X-Arkova-Event': payload.event_type,
      },
      body: payloadString,
      signal: AbortSignal.timeout(10000), // 10 second timeout
    });

    const responseBody = await response.text().catch(() => '');

    if (response.ok) {
      // Success
      await db
        .from('webhook_delivery_logs')
        .update({
          status: 'success',
          response_status: response.status,
          response_body: responseBody.slice(0, 1000),
          delivered_at: new Date().toISOString(),
        })
        .eq('id', logEntry.id);

      logger.info(
        { endpointId: endpoint.id, eventId: payload.event_id, status: response.status },
        'Webhook delivered successfully'
      );
      return true;
    } else {
      // HTTP error - schedule retry if attempts remaining
      const shouldRetry = attempt < MAX_RETRIES;

      await db
        .from('webhook_delivery_logs')
        .update({
          status: shouldRetry ? 'retrying' : 'failed',
          response_status: response.status,
          response_body: responseBody.slice(0, 1000),
          error_message: `HTTP ${response.status}`,
          next_retry_at: shouldRetry
            ? new Date(Date.now() + getRetryDelay(attempt)).toISOString()
            : null,
        })
        .eq('id', logEntry.id);

      logger.warn(
        {
          endpointId: endpoint.id,
          eventId: payload.event_id,
          status: response.status,
          attempt,
          willRetry: shouldRetry,
        },
        'Webhook delivery failed'
      );

      return false;
    }
  } catch (error) {
    // Network error
    const shouldRetry = attempt < MAX_RETRIES;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    await db
      .from('webhook_delivery_logs')
      .update({
        status: shouldRetry ? 'retrying' : 'failed',
        error_message: errorMessage,
        next_retry_at: shouldRetry
          ? new Date(Date.now() + getRetryDelay(attempt)).toISOString()
          : null,
      })
      .eq('id', logEntry.id);

    logger.error(
      { endpointId: endpoint.id, eventId: payload.event_id, error, attempt },
      'Webhook delivery error'
    );

    return false;
  }
}

/**
 * Dispatch an event to all matching endpoints
 */
export async function dispatchWebhookEvent(
  orgId: string,
  eventType: string,
  eventId: string,
  data: Record<string, unknown>
): Promise<void> {
  // Check if webhooks are enabled
  const { data: flag } = await db.rpc('get_flag', { p_flag_id: 'ENABLE_OUTBOUND_WEBHOOKS' });
  if (!flag) {
    logger.debug({ eventType }, 'Outbound webhooks disabled');
    return;
  }

  // Get active endpoints for this org and event type
  const { data: endpoints, error } = await db
    .from('webhook_endpoints')
    .select('*')
    .eq('org_id', orgId)
    .eq('is_active', true)
    .contains('events', [eventType]);

  if (error) {
    logger.error({ error }, 'Failed to fetch webhook endpoints');
    return;
  }

  if (!endpoints || endpoints.length === 0) {
    logger.debug({ orgId, eventType }, 'No webhook endpoints configured');
    return;
  }

  const payload: WebhookPayload = {
    event_type: eventType,
    event_id: eventId,
    timestamp: new Date().toISOString(),
    data,
  };

  // Deliver to all endpoints (in parallel)
  await Promise.all(endpoints.map((endpoint) => deliverToEndpoint(endpoint, payload)));
}

/**
 * Process pending retries
 */
export async function processWebhookRetries(): Promise<number> {
  // Get logs that need retry
  const { data: logs, error } = await db
    .from('webhook_delivery_logs')
    .select('*, webhook_endpoints(*)')
    .eq('status', 'retrying')
    .lte('next_retry_at', new Date().toISOString())
    .limit(50);

  if (error) {
    logger.error({ error }, 'Failed to fetch retry logs');
    return 0;
  }

  if (!logs || logs.length === 0) {
    return 0;
  }

  let retried = 0;

  for (const log of logs) {
    const endpoint = log.webhook_endpoints as WebhookEndpoint;
    if (!endpoint || !endpoint.is_active) continue;

    await deliverToEndpoint(
      endpoint,
      log.payload as WebhookPayload,
      log.attempt_number + 1
    );
    retried++;
  }

  return retried;
}
