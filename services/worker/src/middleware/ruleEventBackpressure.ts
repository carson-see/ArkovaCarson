/**
 * Rule Event Backpressure Middleware (SCRUM-1024)
 *
 * Returns `503 + Retry-After` to inbound webhooks when the
 * `organization_rule_events` queue exceeds RULE_EVENTS_BACKPRESSURE_THRESHOLD.
 * Inbound connectors (DocuSign, Adobe Sign, Drive, Checkr, …) honor
 * Retry-After and back off, which gives the rules engine + dispatcher time
 * to drain without losing events.
 *
 * Per the AC:
 *   - Generic 503 body: never leaks internal queue depth.
 *   - Audit-logged once per overload period (trip → recover → trip = 2 rows).
 *   - Fail-open on DB count error (treat unknown depth as "probably fine"
 *     so a transient Supabase blip does not stop legitimate webhooks).
 *   - Cache the count query for COUNT_CACHE_MS so 100 webhooks/sec don't
 *     each issue a head-count query.
 *
 * Cloud Run min/max instances + custom queue-depth scale metric live in
 * the infrastructure config (deferred under `feedback_worker_hands_off`).
 */
import type { Request, Response, NextFunction } from 'express';
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { Sentry } from '../utils/sentry.js';

export const RULE_EVENTS_BACKPRESSURE_THRESHOLD = 10_000;
const COUNT_CACHE_MS = 5_000;
const RETRY_AFTER_SECONDS = 30;

interface BackpressureState {
  tripped: boolean;
  lastPendingCount: number;
  lastCheckedAt: number;
}

const state: BackpressureState = {
  tripped: false,
  lastPendingCount: 0,
  lastCheckedAt: 0,
};

let cachedCount: { value: number; cachedAt: number } | null = null;

export function resetBackpressureForTests(): void {
  state.tripped = false;
  state.lastPendingCount = 0;
  state.lastCheckedAt = 0;
  cachedCount = null;
}

export function getBackpressureState(): BackpressureState {
  return { ...state };
}

async function getPendingCount(): Promise<number | null> {
  const now = Date.now();
  if (cachedCount && now - cachedCount.cachedAt < COUNT_CACHE_MS) {
    return cachedCount.value;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { count, error } = await (db as any)
      .from('organization_rule_events')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'PENDING');
    if (error) {
      logger.warn({ error }, 'rule-event backpressure: count query errored — failing open');
      return null;
    }
    const value = typeof count === 'number' ? count : 0;
    cachedCount = { value, cachedAt: now };
    return value;
  } catch (err) {
    logger.warn({ error: err }, 'rule-event backpressure: count query threw — failing open');
    return null;
  }
}

async function emitBackpressureAudit(pendingCount: number): Promise<void> {
  try {
    const { error } = await db.from('audit_events').insert({
      event_type: 'RULE_EVENT_BACKPRESSURE_TRIPPED',
      event_category: 'PLATFORM',
      target_type: 'organization_rule_events',
      target_id: 'backpressure',
      details: JSON.stringify({
        pending_count: pendingCount,
        threshold: RULE_EVENTS_BACKPRESSURE_THRESHOLD,
        tripped_at: new Date().toISOString(),
      }).slice(0, 10000),
    });
    if (error) {
      logger.warn({ error }, 'rule-event backpressure: audit emit failed');
    }
  } catch (err) {
    logger.warn({ error: err }, 'rule-event backpressure: audit emit threw');
  }
}

export async function ruleEventBackpressure(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const pending = await getPendingCount();
  if (pending === null) {
    // Fail-open: treat DB unavailability as "not overloaded" so a transient
    // Supabase blip doesn't reject legitimate vendor webhooks.
    next();
    return;
  }
  state.lastPendingCount = pending;
  state.lastCheckedAt = Date.now();

  if (pending <= RULE_EVENTS_BACKPRESSURE_THRESHOLD) {
    if (state.tripped) {
      logger.info({ pendingCount: pending }, 'rule-event backpressure: recovered');
    }
    state.tripped = false;
    next();
    return;
  }

  const wasTripped = state.tripped;
  state.tripped = true;
  if (!wasTripped) {
    logger.warn(
      { pendingCount: pending, threshold: RULE_EVENTS_BACKPRESSURE_THRESHOLD },
      'rule-event backpressure: TRIPPED',
    );
    void emitBackpressureAudit(pending);
    // Surface to Sentry once per trip cycle so the saved-search alert paged on
    // `RULE_EVENT_BACKPRESSURE_TRIPPED` fires PagerDuty. Counts are server-side
    // only (no per-request data, no PII).
    try {
      Sentry.captureMessage('RULE_EVENT_BACKPRESSURE_TRIPPED', {
        level: 'warning',
        tags: { signal: 'rule-event-backpressure' },
        extra: {
          pending_count: pending,
          threshold: RULE_EVENTS_BACKPRESSURE_THRESHOLD,
        },
      });
    } catch (err) {
      logger.warn({ error: err }, 'rule-event backpressure: Sentry capture threw');
    }
  }

  res.setHeader?.('Retry-After', String(RETRY_AFTER_SECONDS));
  res.status(503).json({
    error: 'service temporarily unavailable',
    retry_after: RETRY_AFTER_SECONDS,
  });
}
