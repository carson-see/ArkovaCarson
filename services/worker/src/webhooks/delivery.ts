/**
 * Webhook Delivery Engine
 *
 * Handles signed webhook delivery with exponential backoff retries.
 */

import crypto from 'node:crypto';
import type { Json } from '../types/database.types.js';
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';

const MAX_RETRIES = 5;
const INITIAL_RETRY_DELAY_MS = 1000;

// ─── SSRF Protection (INJ-02) ─────────────────────────────────────────
// Block webhook delivery to private/internal IP ranges to prevent SSRF attacks.
// Covers RFC 1918, loopback, link-local, AWS metadata, and IPv6 equivalents.

const PRIVATE_IP_PATTERNS = [
  /^127\./, // 127.0.0.0/8 loopback
  /^10\./, // 10.0.0.0/8 private
  /^172\.(1[6-9]|2\d|3[01])\./, // 172.16.0.0/12 private
  /^192\.168\./, // 192.168.0.0/16 private
  /^169\.254\./, // 169.254.0.0/16 link-local
  /^0\./, // 0.0.0.0/8
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // 100.64.0.0/10 CGNAT
  /^192\.0\.0\./, // 192.0.0.0/24 IETF protocol assignments
  /^198\.1[89]\./, // 198.18.0.0/15 benchmark testing
  /^::1$/, // IPv6 loopback
  /^fe80:/i, // IPv6 link-local
  /^fc/i, // IPv6 unique local (fc00::/7)
  /^fd/i, // IPv6 unique local (fc00::/7)
];

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal', // GCP metadata
  'metadata.google',
]);

/**
 * Check if a webhook URL targets a private/internal network address.
 * Blocks RFC 1918 ranges, loopback, link-local, cloud metadata endpoints.
 */
export function isPrivateUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    // Strip IPv6 brackets: URL.hostname returns "[::1]" → "::1"
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');

    // Block known internal hostnames
    if (BLOCKED_HOSTNAMES.has(hostname)) return true;

    // Block cloud metadata IP (AWS, GCP, Azure)
    if (hostname === '169.254.169.254') return true;

    // Block non-HTTP(S) schemes
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return true;

    // Check IP patterns
    return PRIVATE_IP_PATTERNS.some((pattern) => pattern.test(hostname));
  } catch {
    // Malformed URL — block it
    return true;
  }
}

// ─── Circuit Breaker (DH-04) ──────────────────────────────────────────
const CIRCUIT_BREAKER_THRESHOLD = 5; // consecutive failures to open
const CIRCUIT_BREAKER_HALF_OPEN_MS = 60_000; // 60s before half-open

interface CircuitState {
  consecutiveFailures: number;
  openedAt: number | null; // timestamp when circuit opened
}

// Per-endpoint circuit breaker state
const circuitBreakers = new Map<string, CircuitState>();

/** Get or create circuit state for an endpoint */
function getCircuit(endpointId: string): CircuitState {
  let state = circuitBreakers.get(endpointId);
  if (!state) {
    state = { consecutiveFailures: 0, openedAt: null };
    circuitBreakers.set(endpointId, state);
  }
  return state;
}

/** Check if the circuit is open (blocking delivery) */
export function isCircuitOpen(endpointId: string): boolean {
  const state = getCircuit(endpointId);
  if (state.openedAt === null) return false;

  const elapsed = Date.now() - state.openedAt;
  if (elapsed >= CIRCUIT_BREAKER_HALF_OPEN_MS) {
    // Transition to half-open: allow one attempt
    return false;
  }
  return true;
}

/** Record a successful delivery (resets circuit) */
function recordSuccess(endpointId: string): void {
  const state = getCircuit(endpointId);
  state.consecutiveFailures = 0;
  state.openedAt = null;
}

/** Record a failed delivery (may open circuit) */
function recordFailure(endpointId: string): void {
  const state = getCircuit(endpointId);
  state.consecutiveFailures++;
  if (state.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
    state.openedAt = Date.now();
    logger.warn(
      { endpointId, failures: state.consecutiveFailures },
      'Circuit breaker OPEN — blocking deliveries',
    );
  }
}

/** Exported for testing — clear all circuit state */
export function resetCircuitBreakers(): void {
  circuitBreakers.clear();
}

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
  // INJ-02: SSRF protection — block private/internal URLs
  if (isPrivateUrl(endpoint.url)) {
    logger.warn(
      { endpointId: endpoint.id },
      'Blocked webhook delivery to private/internal URL (SSRF protection)',
    );
    return false;
  }

  // DH-04: Circuit breaker check
  if (isCircuitOpen(endpoint.id)) {
    logger.warn(
      { endpointId: endpoint.id, eventId: payload.event_id },
      'Circuit breaker OPEN — skipping delivery',
    );
    return false;
  }

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
      payload: payload as unknown as Json,
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
      redirect: 'manual', // Prevent SSRF via redirect to internal URL
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
      // DH-04: Reset circuit on success
      recordSuccess(endpoint.id);
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

      // DH-04: Record failure for circuit breaker
      recordFailure(endpoint.id);

      // DH-12: Move to dead letter queue if permanently failed
      if (!shouldRetry) {
        await moveToDeadLetterQueue(endpoint, payload, `HTTP ${response.status}`, attempt);
      }

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

    // DH-04: Record failure for circuit breaker
    recordFailure(endpoint.id);

    // DH-12: Move to dead letter queue if permanently failed
    if (!shouldRetry) {
      await moveToDeadLetterQueue(endpoint, payload, errorMessage, attempt);
    }

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
  const { data: flag } = await db.rpc('get_flag', { p_flag_key: 'ENABLE_OUTBOUND_WEBHOOKS' });
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

// ─── Dead Letter Queue (DH-12) ─────────────────────────────────────────

/**
 * Move permanently failed webhook deliveries to a dead letter queue
 * for manual inspection and retry.
 */
async function moveToDeadLetterQueue(
  endpoint: WebhookEndpoint,
  payload: WebhookPayload,
  errorMessage: string,
  lastAttempt: number,
): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (db as any)
      .from('webhook_dead_letter_queue')
      .insert({
        endpoint_id: endpoint.id,
        endpoint_url: endpoint.url,
        org_id: endpoint.org_id,
        event_type: payload.event_type,
        event_id: payload.event_id,
        payload: payload as unknown as Json,
        error_message: errorMessage,
        last_attempt: lastAttempt,
        failed_at: new Date().toISOString(),
      });

    logger.info(
      { endpointId: endpoint.id, eventId: payload.event_id, lastAttempt },
      'Moved to dead letter queue',
    );
  } catch (dlqError) {
    logger.error(
      { endpointId: endpoint.id, eventId: payload.event_id, error: dlqError },
      'Failed to write to dead letter queue',
    );
  }
}

/**
 * Get dead letter queue entries for an org (for manual retry UI).
 */
export async function getDeadLetterEntries(
  orgId: string,
  limit: number = 50,
): Promise<Array<Record<string, unknown>>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from('webhook_dead_letter_queue')
    .select('*')
    .eq('org_id', orgId)
    .eq('resolved', false)
    .order('failed_at', { ascending: false })
    .limit(limit);

  if (error) {
    logger.error({ error, orgId }, 'Failed to fetch DLQ entries');
    return [];
  }

  return data || [];
}

/**
 * Mark a DLQ entry as resolved (after manual retry or dismissal).
 */
export async function resolveDlqEntry(entryId: string): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (db as any)
    .from('webhook_dead_letter_queue')
    .update({ resolved: true, resolved_at: new Date().toISOString() })
    .eq('id', entryId);

  if (error) {
    logger.error({ error, entryId }, 'Failed to resolve DLQ entry');
    return false;
  }
  return true;
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
    if (!endpoint?.is_active) continue;

    await deliverToEndpoint(
      endpoint,
      log.payload as unknown as WebhookPayload,
      log.attempt_number + 1
    );
    retried++;
  }

  return retried;
}
