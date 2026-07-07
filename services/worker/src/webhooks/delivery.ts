/**
 * Webhook Delivery Engine
 *
 * Handles signed webhook delivery with exponential backoff retries.
 */

import crypto from 'node:crypto';
import type { Json } from '../types/database.types.js';
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { Sentry } from '../utils/sentry.js';
import { validateWebhookPayload } from './payload-schemas.js';
// ─── SSRF Protection (INJ-02) ─────────────────────────────────────────
// SCRUM-2483: the private-IP classifier + hostname blocklist + DNS-resolution
// helper were lifted verbatim into ../lib/ssrf-guard.js so this webhook guard
// and the new safeFetch egress primitive share ONE source of truth. The guard
// body is byte-identical to the previous inline definition — no behaviour delta
// on the webhook delivery path. delivery.ts re-exports the shared symbols so
// existing importers (api/v1/webhooks.ts, credential-sources.ts) are unchanged.
import {
  BLOCKED_HOSTNAMES,
  PRIVATE_IP_PATTERNS,
  isPrivateIp,
} from '../lib/ssrf-guard.js';

const MAX_RETRIES = 5;
const INITIAL_RETRY_DELAY_MS = 1000;

/**
 * Check if a webhook URL targets a private/internal network address.
 * Blocks RFC 1918 ranges, loopback, link-local, cloud metadata endpoints.
 *
 * ARK-SEC-002: Performs DNS resolution to prevent DNS rebinding attacks.
 * The hostname is resolved to IP addresses, and all resolved IPs are checked
 * against the private IP blocklist. This prevents an attacker from registering
 * a domain that resolves to a public IP during validation but switches to
 * 169.254.169.254 via DNS rebinding.
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

    // Check IP patterns on hostname (catches literal IP addresses)
    return PRIVATE_IP_PATTERNS.some((pattern) => pattern.test(hostname));
  } catch {
    // Malformed URL — block it
    return true;
  }
}

/**
 * ARK-SEC-002: Async version that resolves DNS before checking.
 * Use this before making actual fetch() calls to prevent DNS rebinding.
 */
export async function isPrivateUrlResolved(url: string): Promise<boolean> {
  // First check static patterns
  if (isPrivateUrl(url)) return true;

  try {
    const { hostname } = new URL(url);
    const cleanHost = hostname.toLowerCase().replace(/^\[|\]$/g, '');

    // Skip DNS resolution for literal IP addresses
    if (/^[\d.]+$/.test(cleanHost) || cleanHost.includes(':')) return isPrivateIp(cleanHost);

    // Resolve hostname to IP addresses
    const dns = await import('node:dns');
    const { resolve4, resolve6 } = dns.promises;

    const [ipv4Results, ipv6Results] = await Promise.allSettled([
      resolve4(cleanHost),
      resolve6(cleanHost),
    ]);

    const allIps: string[] = [];
    if (ipv4Results.status === 'fulfilled') allIps.push(...ipv4Results.value);
    if (ipv6Results.status === 'fulfilled') allIps.push(...ipv6Results.value);

    // ARK-SEC-002: fail CLOSED when both resolvers reject (no IPs resolved).
    // Originally this fell through to `.some()` which returns false for an empty
    // array, letting the caller treat an unresolvable host as "public / safe" —
    // exactly the opposite of the intended DNS-rebinding defense.
    if (allIps.length === 0) return true;

    // Block if ANY resolved IP is private
    return allIps.some(isPrivateIp);
  } catch {
    // DNS resolution failed — block as precaution
    return true;
  }
}

// ─── Circuit Breaker (DH-04) ──────────────────────────────────────────
const CIRCUIT_BREAKER_THRESHOLD = 5; // consecutive failures to open
const CIRCUIT_BREAKER_HALF_OPEN_MS = 60_000; // 60s before half-open
const CIRCUIT_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours — evict stale entries
const CIRCUIT_MAX_SIZE = 5_000; // cap to prevent unbounded growth

interface CircuitState {
  consecutiveFailures: number;
  openedAt: number | null; // timestamp when circuit opened
  lastAccessedAt: number; // timestamp for TTL eviction
}

// Per-endpoint circuit breaker state
const circuitBreakers = new Map<string, CircuitState>();

/** Get or create circuit state for an endpoint */
function getCircuit(endpointId: string): CircuitState {
  let state = circuitBreakers.get(endpointId);

  // TTL eviction: discard entries older than CIRCUIT_MAX_AGE_MS
  if (state && Date.now() - state.lastAccessedAt > CIRCUIT_MAX_AGE_MS) {
    circuitBreakers.delete(endpointId);
    state = undefined;
  }

  if (!state) {
    // Evict oldest entry (first inserted) if at capacity
    if (circuitBreakers.size >= CIRCUIT_MAX_SIZE) {
      const oldestKey = circuitBreakers.keys().next().value;
      if (oldestKey) circuitBreakers.delete(oldestKey);
    }
    state = { consecutiveFailures: 0, openedAt: null, lastAccessedAt: Date.now() };
    circuitBreakers.set(endpointId, state);
  } else {
    state.lastAccessedAt = Date.now();
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

/** Exported for diagnostics / testing — current Map size */
export function getCircuitBreakerSize(): number {
  return circuitBreakers.size;
}

interface WebhookPayload {
  event_type: string;
  event_id: string;
  timestamp: string;
  data: Record<string, unknown>;
  // ─── SCRUM-2250 (BUG-2026-05-16-001) per-resource ordering ───────────
  // `resource_key` identifies the logical resource a lifecycle event belongs
  // to (a document/anchor/attestation `public_id`). `sequence` is a strictly
  // monotonic integer assigned at dispatch time from a GLOBAL Postgres sequence
  // (`next_webhook_sequence` RPC, migration 0337), so it is monotonic across
  // ALL worker replicas — not just within one process. Together they let a
  // consumer detect/reject out-of-order delivery for the SAME resource: if a
  // retried earlier event (lower `sequence`) arrives AFTER a later one (higher
  // `sequence`) for the same `resource_key`, the consumer can drop the stale
  // update. Both fields are ADDITIVE + NULLABLE on the wire (CLAUDE.md §1.8
  // frozen-API: no v2 bump) — `resource_key` is null for events with no single
  // resource identity (e.g. anchor.batch_secured); `sequence` is null only when
  // the sequence RPC was unreachable at dispatch (in which case NO ordering is
  // asserted for that event), and older payloads replayed from the DB simply
  // omit both. The values are frozen into `webhook_delivery_logs.payload`, so a
  // retry preserves the original dispatch-time `sequence` even when delivered
  // later.
  resource_key?: string | null;
  sequence?: number | null;
}

interface WebhookEndpoint {
  id: string;
  url: string;
  // Column is named secret_hash but stores the raw signing secret (see migration 0046).
  // This IS the HMAC key — consumers receive this value at endpoint creation time.
  secret_hash: string;
  events: string[];
  is_active: boolean;
  org_id: string;
}

/**
 * Sign a webhook payload with HMAC-SHA256. The `payload` is expected to
 * already be the concatenated `${timestamp}.${rawBody}` string — callers
 * are responsible for building that input so this stays a pure function.
 */
export function signPayload(payload: string, secret: string): string {
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
  // INJ-02 + ARK-SEC-002: SSRF protection with DNS rebinding mitigation
  if (await isPrivateUrlResolved(endpoint.url)) {
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

  // RACE-6 fix: Remove attempt number from idempotency key to prevent
  // duplicate deliveries across retry attempts after worker restart.
  //
  // CodeRabbit PR #753: include event_type in the dedup key so two distinct
  // lifecycle events that happen to share an event_id string (e.g. a future
  // caller passing `anchor.public_id` for both anchor.expired and
  // credential.status_changed for the same anchor) don't collide and
  // silently drop the second event. The webhook_delivery_logs table's
  // idempotency_key column is text + UNIQUE (no schema change required).
  const idempotencyKey = `${endpoint.id}-${payload.event_type}-${payload.event_id}`;

  // SCRUM-1800 (post-PR #734 hotfix): `webhook_delivery_logs.event_id` is
  // typed `uuid NOT NULL`, but every existing producer (anchor.ts,
  // anchorExpirySweep.ts, credential-sources.ts, anchor-revoke.ts,
  // check-confirmations.ts, oracle.ts, verify.ts) passes a string event_id
  // (`public_id`, `expired-${public_id}`, etc.) — so the insert at line ~289
  // throws PG 22P02 "invalid input syntax for type uuid" and the delivery is
  // silently dropped (deliverToEndpoint returns false; dispatchWebhookEvent
  // doesn't observe it). This was found during PR #753 staging soak; the
  // bug pre-dates PR #753 and affects anchor.submitted / anchor.expired in
  // prod too. Fix at the dispatcher: assign a fresh UUID for the column,
  // keep the original string in the JSONB payload so customers see the
  // semantically meaningful `event_id` field, and keep the idempotency_key
  // based on the supplied string so retries dedupe deterministically.
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    payload.event_id,
  );
  const dbEventId = isUuid ? payload.event_id : crypto.randomUUID();

  // PR #753 audit-fix (A1+A2): the previous "if (existing) return true" pattern
  // short-circuited every retry attempt because processWebhookRetries
  // re-enters deliverToEndpoint with the SAME payload (read from log.payload),
  // which produces the same idempotency_key, so the original 'retrying' row
  // was found and the HTTP fetch was skipped entirely. Net effect: every
  // webhook retry was a silent no-op. Fix: only short-circuit on 'success'
  // (the row represents a completed delivery — the customer has already
  // received this event). For 'retrying'/'pending'/'failed' rows, UPDATE in
  // place with the new attempt_number and proceed to re-fire the HTTP call.
  // Also propagate the SELECT error: PGRST116 = no row (happy path), anything
  // else (RLS regression, transient DB) should fail loud, not be swallowed.
  const { data: existing, error: lookupError } = await db
    .from('webhook_delivery_logs')
    .select('id, status, attempt_number')
    .eq('idempotency_key', idempotencyKey)
    .single();

  // PGRST116 = "JSON object requested, multiple (or no) rows returned" — for
  // .single() this means zero rows matched (the happy path for first attempt).
  // Anything else (RLS regression, transient DB) should fail loud.
  const isNoRowError = (err: unknown): boolean => {
    const code = (err as { code?: string })?.code;
    return code === 'PGRST116';
  };
  if (lookupError && !isNoRowError(lookupError)) {
    logger.error({ error: lookupError, endpointId: endpoint.id }, 'Idempotency lookup failed');
    Sentry.captureException(
      lookupError instanceof Error ? lookupError : new Error('idempotency lookup failed'),
      {
        tags: { subsystem: 'webhooks', stage: 'idempotency_lookup', event_type: payload.event_type },
        extra: { idempotency_key: idempotencyKey, endpoint_id: endpoint.id },
      },
    );
    return false;
  }

  if (existing && existing.status === 'success') {
    logger.debug({ endpointId: endpoint.id, eventId: payload.event_id }, 'Webhook already delivered');
    return true;
  }

  // Either insert a new row (first attempt) or update the existing
  // pending/retrying/failed row in place (retry attempt).
  let logEntry: { id: string } | null;
  let logError: { message?: string } | null;

  const performLogWrite = async (): Promise<{ data: { id: string } | null; error: { message?: string } | null }> => {
    if (existing) {
      return db
        .from('webhook_delivery_logs')
        .update({
          attempt_number: attempt,
          status: 'pending',
        })
        .eq('id', existing.id)
        .select()
        .single();
    }
    return db
      .from('webhook_delivery_logs')
      .insert({
        endpoint_id: endpoint.id,
        event_type: payload.event_type,
        event_id: dbEventId,
        payload: payload as unknown as Json,
        attempt_number: attempt,
        status: 'pending',
        idempotency_key: idempotencyKey,
      })
      .select()
      .single();
  };

  ({ data: logEntry, error: logError } = await performLogWrite());

  // Single retry on transient network errors (e.g. "TypeError: fetch failed")
  // before giving up. Fixes ARKOVA-WORKER-C.
  if (logError && /fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i.test(logError.message ?? '')) {
    logger.warn({ error: logError, endpointId: endpoint.id }, 'Transient delivery_log write failure — retrying once');
    await new Promise((r) => setTimeout(r, INITIAL_RETRY_DELAY_MS));
    ({ data: logEntry, error: logError } = await performLogWrite());
  }

  // If the retry (or first attempt) hit a duplicate-key / unique constraint
  // violation, the original insert actually committed — fetch the existing row
  // so delivery can proceed instead of silently dropping the event.
  if (logError && /duplicate key|unique constraint|23505/i.test(logError.message ?? '')) {
    logger.info({ endpointId: endpoint.id, idempotencyKey }, 'Duplicate key on delivery_log — fetching committed row');
    const { data: existingRow } = await db
      .from('webhook_delivery_logs')
      .select('id, status, attempt_number')
      .eq('idempotency_key', idempotencyKey)
      .single();
    if (existingRow) {
      logEntry = existingRow;
      logError = null;
    }
  }

  if (logError) {
    // SCRUM-1805: surface delivery-log insert failures to Sentry so an outage
    // (DB unreachable, schema mismatch, RLS regression, etc.) doesn't silently
    // drop customer webhook events. The pre-PR-#753 22P02 UUID-coercion bug
    // ran undetected for the lifetime of PR #734 because nobody was watching
    // for this `logger.error`. Using captureException with structured tags so
    // it groups by endpoint + event_type for triage.
    Sentry.captureException(
      logError instanceof Error ? logError : new Error(`webhook delivery_log insert failed: ${(logError as { message?: string })?.message ?? 'unknown'}`),
      {
        tags: {
          subsystem: 'webhooks',
          stage: 'delivery_log_insert',
          event_type: payload.event_type,
          endpoint_id: endpoint.id,
        },
        extra: {
          event_id: payload.event_id,
          db_event_id: dbEventId,
          idempotency_key: idempotencyKey,
          org_id: endpoint.org_id,
        },
      },
    );
    logger.error({ error: logError }, 'Failed to create delivery log');

    // SCRUM-2244 (HARDEN-1-A): when the delivery_log write fails persistently
    // (after the single transient retry + duplicate-key recovery above), the
    // audit row for this event would otherwise be silently dropped — a SOC2
    // audit-integrity SEV1. The existing DLQ only covered HTTP-delivery
    // failure; here we route the *log-write* failure to the same durable
    // dead-letter queue so the event is preserved best-effort (keyed by
    // idempotency_key, deduped via the 0338 partial unique index) and can be
    // reconciled/replayed. No new PII beyond what the table already stores.
    //
    // Honest residual risk: this is BEST-EFFORT preservation, not a guarantee.
    // The `false` return is NOT a drop signal any caller acts on —
    // processWebhookRetries ignores the boolean and dispatchWebhookEvent fans
    // out via Promise.all without gating on it. Under a full-DB outage the DLQ
    // upsert below ALSO fails (same outage), and the event is dropped with a
    // Sentry alert (the captureException above) + the DLQ-write error log. The
    // durable store is the audit-integrity backstop only when at least the DLQ
    // table is reachable.
    await moveToDeadLetterQueue(
      endpoint,
      payload,
      `delivery_log write failed (audit-integrity): ${(logError as { message?: string })?.message ?? 'unknown'} [idempotency_key=${idempotencyKey}]`,
      attempt,
      'log_write',
    );
    return false;
  }

  // PR #753 audit fix: even on the no-error path, narrow `logEntry` to
  // non-null before downstream `logEntry.id` accesses below. The DB happy
  // path always returns the inserted/updated row, but TypeScript can't see
  // that and would let a future regression silently dereference null.
  if (!logEntry) {
    logger.error({ endpointId: endpoint.id }, 'delivery_log insert/update returned no row but no error — bailing');
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
        await moveToDeadLetterQueue(endpoint, payload, `HTTP ${response.status}`, attempt, 'http_delivery');
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
      await moveToDeadLetterQueue(endpoint, payload, errorMessage, attempt, 'http_delivery');
    }

    logger.error(
      { endpointId: endpoint.id, eventId: payload.event_id, error, attempt },
      'Webhook delivery error'
    );

    return false;
  }
}

// ─── SCRUM-2250 per-resource ordering helpers ───────────────────────────
//
// `nextSequence()` returns a strictly-monotonic-increasing integer that is
// globally monotonic across ALL worker replicas, sourced from a single
// Postgres SEQUENCE via the `next_webhook_sequence` SECURITY DEFINER RPC
// (migration 0337_scrum2250_webhook_event_sequence.sql).
//
// REVIEW-FIX (defect #1, the SEV1 root cause): the original implementation
// used an in-process counter seeded from Date.now(). The worker runs 2-10
// Cloud Run replicas, and same-resource lifecycle events
// (anchor.submitted/secured/revoked) are emitted from DIFFERENT replicas.
// With a per-process counter, replica A's clock could be skewed ahead of
// replica B, so a LATER event dispatched on B got a LOWER `sequence` than an
// EARLIER event on A — the consumer then drops the newer event as stale. That
// is exactly BUG-2026-05-16-001. A Postgres sequence is atomic and globally
// monotonic with no clock dependency, so nextval() is correct across every
// replica and connection. The worker reaches Postgres only through PostgREST
// (service_role), so the sequence is consumed via a SECURITY DEFINER RPC
// rather than a raw `nextval` call. One DB round-trip per dispatch.
//
// Failure handling: if the RPC errors (transient DB blip), we MUST NOT
// fabricate a sequence — a wrong value reintroduces the inversion bug.
// Instead we return null. A null `sequence` is treated by both the consumer
// contract and the retry sweep exactly like a legacy/pre-2250 payload: no
// ordering is asserted for that event (it is never head-of-line-blocked and
// never blocks others). The failure is surfaced to Sentry/logger so it is
// visible rather than a silent ordering downgrade. This preserves liveness
// (the event still delivers) without ever asserting a FALSE ordering.
async function nextSequence(): Promise<number | null> {
  const { data, error } = await db.rpc('next_webhook_sequence');
  if (error || data == null) {
    logger.error(
      { error },
      'next_webhook_sequence RPC failed — dispatching with null sequence (no ordering asserted for this event)',
    );
    Sentry.captureException(
      error instanceof Error ? error : new Error('next_webhook_sequence RPC failed'),
      {
        tags: { subsystem: 'webhooks', stage: 'sequence_alloc' },
        extra: { rpc_error: (error as { message?: string } | null)?.message ?? 'null data' },
      },
    );
    return null;
  }
  return Number(data);
}

/**
 * Exported for testing — historically reset the in-process sequence counter.
 * The sequence is now sourced from a global Postgres sequence (no in-process
 * state), so this is a no-op kept only so existing test `beforeEach` blocks
 * keep compiling. Tests control ordering by stubbing the
 * `next_webhook_sequence` RPC return value.
 */
export function __resetSequenceForTest(): void {
  /* no in-process state to reset — sequence is DB-backed (migration 0337) */
}

/**
 * Derive the per-resource ordering key from an event's data block. The
 * resource identity for every anchor/credential/attestation lifecycle event
 * is its `public_id` (the document/anchor/attestation slug). Aggregate events
 * with no single resource (e.g. anchor.batch_secured carries `public_ids[]`)
 * return null — they are not ordered against any one resource. Returning null
 * means the retry-sweep guard treats them as un-keyed and never serializes
 * them against per-resource events.
 */
export function deriveResourceKey(
  eventType: string,
  data: Record<string, unknown>,
): string | null {
  const pid = data.public_id;
  if (typeof pid === 'string' && pid.length > 0) {
    // Namespace by event family so an anchor and a credential that happen to
    // share a public_id slug are still ordered independently.
    const family = eventType.split('.')[0] || 'event';
    return `${family}:${pid}`;
  }
  return null;
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
  // SCRUM-1268 (R2-5): validate the data block against the canonical schema
  // for known event types. Banned fields (anchor_id, fingerprint, user_id,
  // org_id) trigger a structured warn log + Sentry breadcrumb (via logger),
  // and the dispatch is aborted so the leaked payload is never signed or
  // delivered. Unknown event types pass through (allowlist semantics — see
  // payload-schemas.ts).
  const validation = validateWebhookPayload(eventType, data);
  if (!validation.ok) {
    logger.error(
      {
        eventType,
        eventId,
        orgId,
        issues: validation.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
      'Outbound webhook payload failed schema validation — refusing to dispatch (CLAUDE.md §6 + §1.6)',
    );
    throw validation.error;
  }
  // PR #567 CodeRabbit minor fix: surface schema bypass for unknown event
  // types so a typo (`anchor.SUBMITTED`) or a forgotten new event type isn't
  // a silent CLAUDE.md §6 / §1.6 leak.
  if (validation.bypassed) {
    logger.debug(
      { eventType, eventId, orgId },
      'Outbound webhook payload bypassed schema validation (event type not in allowlist)',
    );
  }

  // Check if webhooks are enabled
  const { data: flag, error: flagError } = await db.rpc('get_flag', {
    p_flag_key: 'ENABLE_OUTBOUND_WEBHOOKS',
  });
  if (flagError) {
    logger.error(
      { error: flagError, flagId: 'ENABLE_OUTBOUND_WEBHOOKS', eventType },
      'Failed to read outbound webhook feature flag',
    );
    return;
  }
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
    // SCRUM-2250: stamp ordering metadata at dispatch time so it is frozen
    // into webhook_delivery_logs.payload and preserved verbatim across retries.
    // `sequence` is allocated from a global Postgres sequence (replica-safe),
    // so two same-resource events emitted from DIFFERENT replicas still receive
    // strictly-ordered values. Awaited so the value is settled before the
    // payload is signed and frozen into the delivery log.
    resource_key: deriveResourceKey(eventType, data),
    sequence: await nextSequence(),
  };

  // Deliver to all endpoints (in parallel). Different resources, and multiple
  // endpoints for the same event, still fan out concurrently — the ordering
  // guarantee is enforced per-resource in the retry sweep, not by serializing
  // the happy-path dispatch.
  await Promise.all(endpoints.map((endpoint) => deliverToEndpoint(endpoint, payload)));
}

// ─── Dead Letter Queue (DH-12) ─────────────────────────────────────────

/**
 * SCRUM-2244: the two legitimate reasons an event lands in the DLQ. They are
 * separate audit facts about the same (endpoint, event_type, event_id):
 * - `http_delivery`: the endpoint exhausted all retry attempts (HTTP error /
 *   network failure on the final attempt).
 * - `log_write`: the `webhook_delivery_logs` audit-row write itself failed
 *   persistently (DB outage / schema mismatch), so the event would otherwise
 *   be silently dropped.
 * The partial unique index in migration 0338 keys on
 * (endpoint_id, event_type, event_id, failure_kind) so re-DLQ of the SAME
 * failure mode is a no-op, while the two distinct modes can each keep one row.
 */
type DlqFailureKind = 'http_delivery' | 'log_write';

/**
 * Move permanently failed webhook deliveries to a dead letter queue
 * for manual inspection and retry.
 *
 * SCRUM-2244: idempotent. Uses an UPSERT with `ignoreDuplicates` on the
 * (endpoint_id, event_type, event_id, failure_kind) partial unique index so
 * the same event DLQ'd twice (e.g. retry/re-emit during a DB outage) produces
 * exactly one row per failure mode — protecting audit integrity.
 */
async function moveToDeadLetterQueue(
  endpoint: WebhookEndpoint,
  payload: WebhookPayload,
  errorMessage: string,
  lastAttempt: number,
  failureKind: DlqFailureKind,
): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (db as any)
      .from('webhook_dead_letter_queue')
      .upsert(
        {
          endpoint_id: endpoint.id,
          endpoint_url: endpoint.url,
          org_id: endpoint.org_id,
          event_type: payload.event_type,
          event_id: payload.event_id,
          failure_kind: failureKind,
          payload: payload as unknown as Json,
          error_message: errorMessage,
          last_attempt: lastAttempt,
          failed_at: new Date().toISOString(),
        },
        {
          // Dedup on the partial unique index from migration 0338. A duplicate
          // re-DLQ of the same (endpoint, event_type, event_id, failure_kind)
          // is ignored — the first row's error_message/failed_at is preserved.
          onConflict: 'endpoint_id,event_type,event_id,failure_kind',
          ignoreDuplicates: true,
        },
      );

    logger.info(
      { endpointId: endpoint.id, eventId: payload.event_id, lastAttempt, failureKind },
      'Moved to dead letter queue',
    );
  } catch (dlqError) {
    // SCRUM-2244 residual risk: under a FULL DB outage this DLQ write fails too
    // (the same outage that broke the delivery_log write). There is no durable
    // store left, so the event is genuinely dropped — we surface it loudly here
    // (and the original log-write failure already fired Sentry) rather than
    // pretending the event was preserved.
    logger.error(
      { endpointId: endpoint.id, eventId: payload.event_id, error: dlqError, failureKind },
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
 * ARK-SEC-026: Requires orgId to verify ownership before resolving.
 */
export async function resolveDlqEntry(entryId: string, orgId: string): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dbAny = db as any;

  // ARK-SEC-026: Always verify the DLQ entry belongs to the requesting org
  const { data: entry } = await dbAny
    .from('webhook_dead_letter_queue')
    .select('endpoint_id, webhook_endpoints(org_id)')
    .eq('id', entryId)
    .single();

  const entryOrgId = entry?.webhook_endpoints?.org_id;
  if (!entryOrgId || entryOrgId !== orgId) {
    logger.warn({ entryId, orgId }, 'DLQ entry does not belong to requesting org');
    return false;
  }

  const { error } = await dbAny
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
 * SCRUM-1172 (HAKI-REQ-03 AC3) — replay a previously-attempted webhook delivery.
 *
 * Reconstructs the payload from `webhook_delivery_logs.payload`, re-signs with
 * a current timestamp, and POSTs to the same endpoint URL. Always inserts a
 * NEW `webhook_delivery_logs` row with a `replay-` idempotency key so the
 * original is preserved for audit and the existing-row idempotency check in
 * `deliverToEndpoint` can't short-circuit the replay.
 *
 * Org scope is enforced via the embedded `webhook_endpoints(org_id)` join —
 * cross-org replay is treated identically to "not found" so the endpoint
 * doesn't leak the existence of other orgs' delivery logs.
 */
export type ReplayError =
  | 'not_found'
  | 'cross_org'
  | 'endpoint_inactive'
  | 'ssrf_blocked'
  | 'delivery_failed';

export interface ReplayResult {
  ok: boolean;
  status_code?: number;
  new_delivery_id?: string;
  error?: ReplayError;
}

export interface ReplayOptions {
  /**
   * URL guard — defaults to `isPrivateUrlResolved`. Tests inject a stub so
   * unit tests don't need real DNS resolution to deny `hooks.example.com`.
   */
  urlGuard?: (url: string) => Promise<boolean>;
}

export async function replayDelivery(
  deliveryId: string,
  orgId: string,
  options: ReplayOptions = {},
): Promise<ReplayResult> {
  const urlGuard = options.urlGuard ?? isPrivateUrlResolved;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dbAny = db as any;

  const { data: row } = await dbAny
    .from('webhook_delivery_logs')
    .select(
      'id, endpoint_id, event_type, event_id, payload, ' +
        'webhook_endpoints!inner(id, url, secret_hash, is_active, org_id)',
    )
    .eq('id', deliveryId)
    .single();

  if (!row) return { ok: false, error: 'not_found' };

  const endpoint = row.webhook_endpoints as WebhookEndpoint;
  // 404 instead of 403 — never leak cross-org delivery existence to other orgs.
  if (!endpoint || endpoint.org_id !== orgId) return { ok: false, error: 'cross_org' };
  if (!endpoint.is_active) return { ok: false, error: 'endpoint_inactive' };

  if (await urlGuard(endpoint.url)) {
    logger.warn({ endpointId: endpoint.id, deliveryId }, 'Replay blocked — endpoint URL is private');
    return { ok: false, error: 'ssrf_blocked' };
  }

  const payload = row.payload as WebhookPayload;
  const payloadString = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = signPayload(`${timestamp}.${payloadString}`, endpoint.secret_hash);
  // Idempotency key includes ms + random suffix so back-to-back replays in the
  // same second don't collide on the unique-key constraint.
  const idempotencyKey = `replay-${deliveryId}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

  const { data: newLog, error: insertErr } = await dbAny
    .from('webhook_delivery_logs')
    .insert({
      endpoint_id: endpoint.id,
      event_type: row.event_type,
      event_id: row.event_id,
      payload: row.payload,
      attempt_number: 0,
      status: 'pending',
      idempotency_key: idempotencyKey,
    })
    .select()
    .single();

  if (insertErr || !newLog) {
    logger.error({ error: insertErr, deliveryId }, 'Failed to create replay delivery log');
    return { ok: false, error: 'delivery_failed' };
  }

  try {
    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Arkova-Signature': signature,
        'X-Arkova-Timestamp': timestamp,
        'X-Arkova-Event': row.event_type,
        // Explicit replay marker — receivers can dedupe against the original
        // event_id without treating the resend as a fresh event.
        'X-Arkova-Replay-Of': deliveryId,
      },
      body: payloadString,
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
    });

    const responseBody = await response.text().catch(() => '');
    const isSuccess = response.ok;

    await dbAny
      .from('webhook_delivery_logs')
      .update({
        status: isSuccess ? 'success' : 'failed',
        response_status: response.status,
        response_body: responseBody.slice(0, 1000),
        delivered_at: isSuccess ? new Date().toISOString() : null,
        error_message: isSuccess ? null : `HTTP ${response.status}`,
      })
      .eq('id', newLog.id);

    return { ok: isSuccess, status_code: response.status, new_delivery_id: newLog.id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    await dbAny
      .from('webhook_delivery_logs')
      .update({ status: 'failed', error_message: msg.slice(0, 500) })
      .eq('id', newLog.id);
    return { ok: false, error: 'delivery_failed', new_delivery_id: newLog.id };
  }
}

/**
 * Process pending retries
 */
export async function processWebhookRetries(): Promise<number> {
  // Get logs that need retry.
  //
  // REVIEW-FIX (defect #2): the limit(50) is applied to a backlog, so the
  // window MUST be ordered by `sequence` ascending — otherwise a newer event
  // (higher sequence) for a resource could land inside the 50-row window while
  // its older head-of-line sibling (lower sequence) sits OUTSIDE the window,
  // and the JS grouping below would then wrongly treat the newer row as the
  // head and re-fire it ahead of the older one — the exact out-of-order bug.
  //
  // Ordering by `payload->sequence` ASC (NULLS FIRST) makes the window the
  // globally-OLDEST outstanding events. `payload->sequence` uses the jsonb `->`
  // accessor (NOT `->>`), so Postgres compares the values numerically
  // (3 < 20 < 100), not lexicographically. NULLS FIRST puts legacy/aggregate
  // rows (no sequence) ahead of sequenced ones so they always drain promptly
  // and are never starved. Consequence: if a resource's true head is excluded
  // from the window, it is only because ≥50 strictly-older events (each the
  // head of its own resource) are ahead of it and will drain first — which is
  // exactly correct head-of-line behavior.
  const { data: logs, error } = await db
    .from('webhook_delivery_logs')
    .select('*, webhook_endpoints(*)')
    .eq('status', 'retrying')
    .lte('next_retry_at', new Date().toISOString())
    .order('payload->sequence', { ascending: true, nullsFirst: true })
    .limit(50);

  if (error) {
    logger.error({ error }, 'Failed to fetch retry logs');
    return 0;
  }

  if (!logs || logs.length === 0) {
    return 0;
  }

  // ─── SCRUM-2250 (BUG-2026-05-16-001) per-resource ordering guard ─────
  //
  // Before this fix, the sweep delivered every `retrying` row in whatever
  // arbitrary order the query returned them. For the SAME document that meant
  // a retried earlier event (event 1, failed) could be re-fired AFTER a later
  // event (event 2) had already been delivered — corrupting consumer state.
  //
  // Fix: partition rows by `(endpoint_id, resource_key)`. Within each resource
  // group, only the SINGLE lowest-`sequence` outstanding event is delivered
  // this sweep (head-of-line). The newer events for that resource wait until
  // the older one drains (succeeds → leaves 'retrying', or exhausts retries →
  // 'failed'), so a newer event is never delivered while an older one for the
  // same resource is still outstanding. Different resources (and rows with no
  // resource_key — legacy payloads or aggregate events) are NOT serialized
  // against each other: each forms its own group and all groups are delivered
  // concurrently, so throughput across distinct documents is preserved.
  interface RetryRow {
    id: string;
    attempt_number: number;
    payload: WebhookPayload;
    webhook_endpoints: WebhookEndpoint | null;
  }

  const groups = new Map<string, RetryRow[]>();
  let ungroupedCounter = 0;
  for (const raw of logs as unknown as RetryRow[]) {
    const endpoint = raw.webhook_endpoints;
    if (!endpoint?.is_active) continue;

    const payload = raw.payload as WebhookPayload;
    const resourceKey = payload?.resource_key;
    // Rows with a resource_key are serialized within their group. Rows without
    // one (legacy payloads predating SCRUM-2250, or aggregate events) get a
    // unique group so they are never head-of-line-blocked by, or block, any
    // other row — preserving the pre-fix concurrent behavior for them.
    const groupKey =
      resourceKey != null
        ? `${endpoint.id}::${resourceKey}`
        : `__ungrouped__::${endpoint.id}::${ungroupedCounter++}`;

    const bucket = groups.get(groupKey);
    if (bucket) bucket.push(raw);
    else groups.set(groupKey, [raw]);
  }

  // For each group, pick the head-of-line row: the lowest `sequence`. Rows
  // without a sequence (legacy) sort first (treated as oldest) so they always
  // drain before any sequenced event for the same resource.
  const headRows: RetryRow[] = [];
  for (const bucket of groups.values()) {
    bucket.sort((a, b) => {
      const sa = a.payload?.sequence ?? Number.NEGATIVE_INFINITY;
      const sb = b.payload?.sequence ?? Number.NEGATIVE_INFINITY;
      if (sa !== sb) return sa - sb;
      // Deterministic tie-break when sequences collide (shouldn't, but legacy
      // rows can both be -Infinity): older attempt first, then id.
      if (a.attempt_number !== b.attempt_number) return a.attempt_number - b.attempt_number;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    headRows.push(bucket[0]);
  }

  // Deliver one head row per resource concurrently — distinct documents do
  // not serialize against each other. allSettled so a single delivery throwing
  // never aborts the sweep for the other resources.
  //
  // ─── Drop-to-DLQ ordering contract (defect #3) ──────────────────────
  // The head-of-line row is delivered via deliverToEndpoint(), which on a
  // successful response leaves the 'retrying' state; on a non-final failure
  // stays 'retrying' with a later next_retry_at; and on the FINAL attempt
  // (attempt >= MAX_RETRIES) transitions the row to 'failed' AND moves it to
  // the dead-letter queue (moveToDeadLetterQueue). Once the head leaves
  // 'retrying' by either path, it no longer matches this sweep's
  // `status = 'retrying'` filter, so on the NEXT sweep the next-lowest-sequence
  // event for that resource becomes the head and proceeds. A poison head that
  // exhausts its retries therefore does NOT block its resource forever: it
  // drops to the DLQ and the newer events advance in order. Consumers should
  // treat a gap in the per-resource `sequence` (a missing intermediate event)
  // as "an earlier event was dead-lettered" and reconcile via the DLQ, not as
  // a reason to reject the newer event. This is the documented, intended
  // liveness/ordering trade-off: strict per-resource order while the head is
  // live, fail-forward (drop the dead head, deliver the rest in order) once it
  // is dead-lettered.
  await Promise.allSettled(
    headRows.map((row) =>
      deliverToEndpoint(
        row.webhook_endpoints as WebhookEndpoint,
        row.payload,
        row.attempt_number + 1,
      ),
    ),
  );

  // Count of resource head-rows attempted this sweep.
  return headRows.length;
}
