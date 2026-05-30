/**
 * Unit tests for GET /api/billing/status (handleBillingStatus in billing.ts)
 *
 * SCRUM-2210: the endpoint the frontend BillingPage calls was never implemented
 * (404 → billing page bricked). These tests pin the BillingInfo contract and the
 * resilience guarantees: the endpoint always returns 200 with a usable payload
 * (free-tier default when there is no subscription, recordsUsed=0 when the usage
 * count fails) and only 500s when the primary subscription lookup itself errors.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Hoisted mocks ----
const { mockExtractAuthUserId, mockDbFrom, mockLogger } = vi.hoisted(() => ({
  mockExtractAuthUserId: vi.fn(),
  mockDbFrom: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../utils/db.js', () => ({ db: { from: mockDbFrom } }));
vi.mock('../utils/logger.js', () => ({ logger: mockLogger }));
vi.mock('./middleware.js', () => ({
  corsMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
  extractAuthUserId: mockExtractAuthUserId,
}));
vi.mock('../utils/rateLimit.js', () => ({
  rateLimiters: {
    checkout: (_req: unknown, _res: unknown, next: () => void) => next(),
    api: (_req: unknown, _res: unknown, next: () => void) => next(),
  },
}));
vi.mock('../stripe/client.js', () => ({
  createCheckoutSession: vi.fn(),
  createBillingPortalSession: vi.fn(),
}));
vi.mock('../lib/urls.js', () => ({
  BILLING_SUCCESS_URL: 'https://example.test/success',
  BILLING_CANCEL_URL: 'https://example.test/cancel',
  BILLING_PORTAL_RETURN_URL: 'https://example.test/return',
}));

import { handleBillingStatus } from './billing.js';
import type { Request, Response } from 'express';

/**
 * Chainable Supabase-query mock. Every builder method returns the builder;
 * `.maybeSingle()` resolves to `result`, and the builder is itself awaitable
 * (thenable) so `await db.from('anchors').select(...).eq(...)` resolves to
 * `result` too (the count path).
 */
function chain(result: unknown) {
  const builder: Record<string, unknown> = {};
  const passthrough = () => builder;
  for (const m of ['select', 'eq', 'order', 'limit', 'gte', 'in']) builder[m] = passthrough;
  builder.maybeSingle = () => Promise.resolve(result);
  builder.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return builder;
}

function mockReq(): Request {
  return { query: {}, headers: {} } as unknown as Request;
}

function mockRes(): Response & { statusCode: number; body: unknown } {
  const res = {
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(data: unknown) {
      res.body = data;
      return res;
    },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

/** Route db.from(table) → the configured chain result for that table. */
function routeTables(map: Record<string, unknown>) {
  mockDbFrom.mockImplementation((table: string) => chain(map[table]));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExtractAuthUserId.mockResolvedValue('user-123');
});

describe('handleBillingStatus (GET /api/billing/status)', () => {
  it('401s when the caller is unauthenticated', async () => {
    mockExtractAuthUserId.mockResolvedValue(null);
    const res = mockRes();
    await handleBillingStatus(mockReq(), res);
    expect(res.statusCode).toBe(401);
    expect((res.body as { error: { code: string } }).error.code).toBe('authentication_required');
  });

  it('returns the BillingInfo contract for an active subscription', async () => {
    routeTables({
      subscriptions: {
        data: {
          status: 'active',
          plan_id: 'plan-org',
          org_id: 'org-1',
          current_period_start: '2026-05-01T00:00:00Z',
          current_period_end: '2026-06-01T00:00:00Z',
        },
        error: null,
      },
      plans: {
        data: { name: 'Organization', price_cents: 9900, billing_period: 'month', records_per_month: 1000 },
        error: null,
      },
      anchors: { count: 250, error: null },
    });

    const res = mockRes();
    await handleBillingStatus(mockReq(), res);

    expect(res.statusCode).toBe(200);
    const body = res.body as {
      status: string;
      plan: { name: string; price?: number; period?: string; recordsIncluded: number | 'unlimited' };
      usage: { recordsUsed: number; recordsLimit: number | null; percentUsed?: number };
      billing: { status?: string; currentPeriodEnd?: string };
    };
    expect(body.status).toBe('active');
    expect(body.plan).toEqual({ name: 'Organization', price: 99, period: 'month', recordsIncluded: 1000 });
    expect(body.usage).toEqual({ recordsUsed: 250, recordsLimit: 1000, percentUsed: 25 });
    expect(body.billing.status).toBe('active');
    expect(body.billing.currentPeriodEnd).toBe('2026-06-01T00:00:00Z');
  });

  it('counts usage by user_id for an individual (no-org) subscription', async () => {
    routeTables({
      subscriptions: {
        data: {
          status: 'active',
          plan_id: 'plan-individual',
          org_id: null,
          current_period_start: '2026-05-01T00:00:00Z',
          current_period_end: '2026-06-01T00:00:00Z',
        },
        error: null,
      },
      plans: {
        data: { name: 'Individual', price_cents: 1900, billing_period: 'month', records_per_month: 100 },
        error: null,
      },
      anchors: { count: 30, error: null },
    });

    const res = mockRes();
    await handleBillingStatus(mockReq(), res);

    expect(res.statusCode).toBe(200);
    const body = res.body as { usage: { recordsUsed: number; recordsLimit: number | null; percentUsed?: number } };
    // org_id is null → usage must still be counted (by user_id), never forced to 0.
    expect(body.usage).toEqual({ recordsUsed: 30, recordsLimit: 100, percentUsed: 30 });
  });

  it('returns a free-tier default (200, not 404) when the caller has no subscription', async () => {
    routeTables({ subscriptions: { data: null, error: null } });
    const res = mockRes();
    await handleBillingStatus(mockReq(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      status: 'canceled',
      plan: { name: 'Free', recordsIncluded: 0 },
      usage: { recordsUsed: 0, recordsLimit: null },
      billing: { status: 'canceled' },
    });
  });

  it('still returns 200 with recordsUsed=0 when the usage count fails (resilience)', async () => {
    routeTables({
      subscriptions: {
        data: { status: 'active', plan_id: 'plan-org', org_id: 'org-1', current_period_start: null, current_period_end: null },
        error: null,
      },
      plans: { data: { name: 'Organization', price_cents: 9900, billing_period: 'month', records_per_month: 1000 }, error: null },
      anchors: { count: null, error: { message: 'canceling statement due to statement timeout' } },
    });

    const res = mockRes();
    await handleBillingStatus(mockReq(), res);

    expect(res.statusCode).toBe(200);
    const body = res.body as { usage: { recordsUsed: number } };
    expect(body.usage.recordsUsed).toBe(0);
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('500s only when the primary subscription lookup errors', async () => {
    routeTables({ subscriptions: { data: null, error: { message: 'db down' } } });
    const res = mockRes();
    await handleBillingStatus(mockReq(), res);
    expect(res.statusCode).toBe(500);
    expect((res.body as { error: { code: string } }).error.code).toBe('internal_error');
  });

  it('treats an unknown status as canceled and unlimited plan when records_per_month is 0', async () => {
    routeTables({
      subscriptions: {
        data: { status: 'weird', plan_id: 'plan-x', org_id: null, current_period_start: null, current_period_end: null },
        error: null,
      },
      plans: { data: { name: 'Enterprise', price_cents: 0, billing_period: 'year', records_per_month: 0 }, error: null },
    });
    const res = mockRes();
    await handleBillingStatus(mockReq(), res);
    expect(res.statusCode).toBe(200);
    const body = res.body as { status: string; plan: { recordsIncluded: unknown; period?: string }; usage: { recordsLimit: null; percentUsed?: number } };
    expect(body.status).toBe('canceled');
    expect(body.plan.recordsIncluded).toBe('unlimited');
    expect(body.plan.period).toBe('year');
    expect(body.usage.recordsLimit).toBeNull();
    expect(body.usage.percentUsed).toBeUndefined();
  });
});
