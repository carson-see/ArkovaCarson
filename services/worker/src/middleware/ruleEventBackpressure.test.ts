/**
 * Tests for SCRUM-1024 — rule event backpressure middleware.
 *
 * Acceptance Criteria:
 *   - When `rule_events_pending > 10,000`, pause new rule-event ingestion
 *     (return 503 with Retry-After to triggering connectors).
 *   - Audit-logged backpressure trip with triggering metric values.
 *   - 503 response doesn't leak internal state — generic message + retry_after.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

const headMock = vi.fn();
const auditInsertMock = vi.fn();
const loggerInfo = vi.fn();
const loggerWarn = vi.fn();

vi.mock('../utils/logger.js', () => ({
  logger: { info: loggerInfo, warn: loggerWarn, error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../utils/db.js', () => {
  const eqChain = {
    eq: vi.fn().mockReturnThis(),
  };
  Object.assign(eqChain, {
    then: (resolve: (v: { count: number | null; error: unknown }) => unknown) => {
      const result = headMock();
      resolve(result as { count: number | null; error: unknown });
      return Promise.resolve();
    },
  });
  return {
    db: {
      from: (table: string) => {
        if (table === 'organization_rule_events') {
          return {
            select: () => eqChain,
          };
        }
        if (table === 'audit_events') {
          return { insert: (...args: unknown[]) => auditInsertMock(...args) };
        }
        throw new Error(`unexpected table: ${table}`);
      },
    },
  };
});

const { ruleEventBackpressure, RULE_EVENTS_BACKPRESSURE_THRESHOLD, getBackpressureState, resetBackpressureForTests } = await import(
  './ruleEventBackpressure.js'
);

function buildReq(): Request {
  return { path: '/webhooks/docusign', headers: {}, body: {} } as unknown as Request;
}

function buildRes() {
  let statusCode: number | undefined;
  let body: unknown;
  let retryAfter: string | null = null;
  const json = vi.fn((payload: unknown) => { body = payload; });
  const status = vi.fn((code: number) => { statusCode = code; return { json }; });
  const setHeader = vi.fn((name: string, val: string) => {
    if (name.toLowerCase() === 'retry-after') retryAfter = val;
  });
  const res = { status, json, setHeader } as unknown as Response;
  return {
    res, status, json, setHeader,
    get body() { return body; },
    get statusCode() { return statusCode; },
    get retryAfter() { return retryAfter; },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetBackpressureForTests();
  auditInsertMock.mockResolvedValue({ error: null });
});

afterEach(() => vi.clearAllMocks());

describe('ruleEventBackpressure (SCRUM-1024)', () => {
  it('exposes a threshold >= 10,000 per AC', () => {
    expect(RULE_EVENTS_BACKPRESSURE_THRESHOLD).toBeGreaterThanOrEqual(10_000);
  });

  it('passes through when pending count is below threshold', async () => {
    headMock.mockReturnValue({ count: 5000, error: null });
    const ctx = buildRes();
    const next = vi.fn() as NextFunction;
    await ruleEventBackpressure(buildReq(), ctx.res, next);
    expect(next).toHaveBeenCalled();
    expect(ctx.status).not.toHaveBeenCalled();
  });

  it('returns 503 + Retry-After when pending count exceeds threshold', async () => {
    headMock.mockReturnValue({ count: RULE_EVENTS_BACKPRESSURE_THRESHOLD + 1, error: null });
    const ctx = buildRes();
    const next = vi.fn() as NextFunction;
    await ruleEventBackpressure(buildReq(), ctx.res, next);
    expect(next).not.toHaveBeenCalled();
    expect(ctx.statusCode).toBe(503);
    expect(ctx.retryAfter).toBeTruthy();
    expect(Number(ctx.retryAfter)).toBeGreaterThan(0);
  });

  it('503 body uses generic copy that does not leak internal state', async () => {
    headMock.mockReturnValue({ count: RULE_EVENTS_BACKPRESSURE_THRESHOLD + 100, error: null });
    const ctx = buildRes();
    const next = vi.fn() as NextFunction;
    await ruleEventBackpressure(buildReq(), ctx.res, next);
    const body = ctx.body as { error: string; retry_after: number };
    expect(body.error).toBe('service temporarily unavailable');
    expect(typeof body.retry_after).toBe('number');
    // Must not leak internal queue depth
    const json = JSON.stringify(body);
    expect(json).not.toContain(String(RULE_EVENTS_BACKPRESSURE_THRESHOLD + 100));
  });

  it('audit-logs the backpressure trip exactly once per trip-then-recovery cycle', async () => {
    headMock.mockReturnValue({ count: RULE_EVENTS_BACKPRESSURE_THRESHOLD + 1, error: null });
    const next = vi.fn() as NextFunction;
    await ruleEventBackpressure(buildReq(), buildRes().res, next);
    await ruleEventBackpressure(buildReq(), buildRes().res, next);
    await ruleEventBackpressure(buildReq(), buildRes().res, next);
    // Three trips during the same overload period — audit should fire ONCE.
    expect(auditInsertMock).toHaveBeenCalledTimes(1);
    const call = auditInsertMock.mock.calls[0][0] as { event_type: string; details: string };
    expect(call.event_type).toBe('RULE_EVENT_BACKPRESSURE_TRIPPED');
    // Trigger metric values are in the audit details (server-side only).
    expect(call.details).toContain('pending_count');
    // Recovery: pending drops below threshold, then trips again → second audit.
    // resetBackpressureForTests clears the count cache so the new value is read.
    resetBackpressureForTests();
    headMock.mockReturnValue({ count: 100, error: null });
    await ruleEventBackpressure(buildReq(), buildRes().res, next);
    resetBackpressureForTests();
    headMock.mockReturnValue({ count: RULE_EVENTS_BACKPRESSURE_THRESHOLD + 1, error: null });
    await ruleEventBackpressure(buildReq(), buildRes().res, next);
    expect(auditInsertMock).toHaveBeenCalledTimes(2);
  });

  it('passes through (fail-open) when the count query errors — does not block legitimate webhooks', async () => {
    headMock.mockReturnValue({ count: null, error: { message: 'db unavailable' } });
    const ctx = buildRes();
    const next = vi.fn() as NextFunction;
    await ruleEventBackpressure(buildReq(), ctx.res, next);
    expect(next).toHaveBeenCalled();
    expect(ctx.status).not.toHaveBeenCalled();
  });

  it('caches the count query for COUNT_CACHE_MS to avoid hammering the DB on every webhook', async () => {
    headMock.mockReturnValue({ count: 500, error: null });
    const next = vi.fn() as NextFunction;
    await ruleEventBackpressure(buildReq(), buildRes().res, next);
    await ruleEventBackpressure(buildReq(), buildRes().res, next);
    await ruleEventBackpressure(buildReq(), buildRes().res, next);
    // 3 calls in quick succession should hit the cache, not the DB.
    expect(headMock).toHaveBeenCalledTimes(1);
  });

  it('exposes getBackpressureState for /health diagnostics', async () => {
    headMock.mockReturnValue({ count: 200, error: null });
    await ruleEventBackpressure(buildReq(), buildRes().res, vi.fn() as NextFunction);
    const state = getBackpressureState();
    expect(state.tripped).toBe(false);
    expect(state.lastPendingCount).toBe(200);
  });
});
