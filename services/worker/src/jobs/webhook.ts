/**
 * Outbound Webhook Delivery Job
 *
 * Delivers webhook notifications to customer endpoints.
 *
 * NOTE: The webhook_configs table is not yet implemented in the database schema.
 * This module provides stub implementations that log webhook events.
 * When the webhook_configs table is added, update this to use the database.
 */

import { createHmac } from 'crypto';
import { logger } from '../utils/logger.js';

export interface WebhookConfig {
  id: string;
  org_id: string;
  url: string;
  secret: string;
  events: string[];
  enabled: boolean;
  failure_count: number;
}

interface WebhookPayload {
  type: string;
  timestamp: string;
  data: Record<string, unknown>;
}

const _MAX_RETRIES = 5;
const TIMEOUT_MS = 30000;

/**
 * Sign a webhook payload
 */
function signPayload(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Deliver a webhook to a customer endpoint
 */
export async function deliverWebhook(
  config: WebhookConfig,
  payload: WebhookPayload
): Promise<boolean> {
  const body = JSON.stringify(payload);
  const signature = signPayload(body, config.secret);

  logger.info({ configId: config.id, eventType: payload.type }, 'Delivering webhook');

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const response = await fetch(config.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Arkova-Signature': signature,
        'X-Arkova-Event': payload.type,
        'X-Arkova-Timestamp': payload.timestamp,
      },
      body,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    // NOTE: webhook_configs table not yet implemented - skipping database update
    logger.info({ configId: config.id }, 'Webhook delivered successfully');
    return true;
  } catch (error) {
    logger.error({ configId: config.id, error }, 'Webhook delivery failed');
    // NOTE: webhook_configs table not yet implemented - skipping failure tracking
    return false;
  }
}

/**
 * Queue a webhook for delivery
 *
 * NOTE: Currently a stub - logs the event but doesn't deliver.
 * The webhook_configs table needs to be added to the database schema.
 */
export async function queueWebhook(
  orgId: string,
  eventType: string,
  data: Record<string, unknown>
): Promise<void> {
  // NOTE: webhook_configs table not yet implemented
  // For now, just log that a webhook would be sent
  logger.debug(
    { orgId, eventType, dataKeys: Object.keys(data) },
    'Webhook queued (stub - no webhook_configs table yet)'
  );

  // When webhook_configs table is added, uncomment and implement:
  // const { data: configs, error } = await db
  //   .from('webhook_configs')
  //   .select('*')
  //   .eq('org_id', orgId)
  //   .eq('enabled', true)
  //   .contains('events', [eventType]);
}
