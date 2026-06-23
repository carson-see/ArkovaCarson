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
 *
 * `onGte` (optional) captures the `.gte(column, value)` arguments so a test can
 * assert which `created_at` lower bound the usage count was scoped to — the
 * load-bearing assertion for the SCRUM-1791 stale-period read-side fix.
 */
function chain(result: unknown, onGte?: (column: string, value: unknown) => void) {
  const builder: Record<string, unknown> = {};
  const passthrough = () => builder;
  for (const m of ['select', 'eq', 'order', 'limit', 'in']) builder[m] = passthrough;
  builder.gte = (column: string, value: unknown) => {
    onGte?.(column, value);
    return builder;
  };
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
function routeTables(map: Record<string, unknown>, onGte?: (table: string, column: string, value: unknown) => void) {
  mockDbFrom.mockImplementation((table: string) =>
    chain(map[table], onGte ? (column, value) => onGte(table, column, value) : undefined),
  );
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

// ─────────────────────────────────────────────────────────────────────────
// SCRUM-1791 (HARDEN-1, SEV1) — read-side defense against a stale
// subscriptions.current_period_start.
//
// The write-side roll-forward (handlePaymentSucceeded / handleSubscriptionUpdated)
// keeps current_period_start fresh on every renewal. But that depends on the
// Stripe webhook landing with a usable period. When BOTH documented fallbacks
// fire (the customer.subscription.updated is missed AND the invoice line period
// is absent), current_period_start stays stale — the exact 18-day-stale prod row
// that produced the over-limit toast. countAnchorUsage scopes the usage meter by
// `created_at >= current_period_start`, so a stale start counts anchors from
// SEVERAL past billing cycles → recordsUsed inflates → percentUsed > 100 → a
// paid+current user is shown as over-limit / locked out.
//
// Fix under test: when the stored window is stale (current_period_end is in the
// past) or current_period_start is missing, the read clamps the usage-count
// lower bound to the CURRENT calendar month (UTC date_trunc('month', now())) —
// the same boundary the already-safe frontend get_user_monthly_anchor_count RPC
// uses — so the meter always reflects the current cycle, never a multi-period
// over-count.
// ─────────────────────────────────────────────────────────────────────────
describe('handleBillingStatus — SCRUM-1791 stale-period read clamp', () => {
  /** UTC start-of-current-month ISO, matching get_user_monthly_anchor_count. */
  function currentMonthStartIso(): string {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  }

  it('clamps the usage window to the current calendar month when current_period_end is in the past (stale row)', async () => {
    // The 18-day-stale prod scenario: period_start is months old and period_end
    // is well in the past because the webhook roll-forward never fired.
    const captured: Array<{ table: string; column: string; value: unknown }> = [];
    routeTables(
      {
        subscriptions: {
          data: {
            status: 'active',
            plan_id: 'plan-professional',
            org_id: null,
            current_period_start: '2026-01-20T00:00:00.000Z',
            current_period_end: '2026-04-20T00:00:00.000Z', // stale: in the past
          },
          error: null,
        },
        plans: { data: { name: 'Professional', price_cents: 4900, billing_period: 'month', records_per_month: 100 }, error: null },
        anchors: { count: 12, error: null },
      },
      (table, column, value) => captured.push({ table, column, value }),
    );

    const res = mockRes();
    await handleBillingStatus(mockReq(), res);

    expect(res.statusCode).toBe(200);
    // The usage count must be lower-bounded by the CURRENT month, not the stale
    // period_start — otherwise it spans multiple cycles and over-counts.
    const gte = captured.find((c) => c.table === 'anchors' && c.column === 'created_at');
    expect(gte).toBeDefined();
    expect(gte!.value).toBe(currentMonthStartIso());
    // And the user is NOT falsely over-limit (12 / 100 = 12%).
    const body = res.body as { usage: { recordsUsed: number; recordsLimit: number | null; percentUsed?: number } };
    expect(body.usage).toEqual({ recordsUsed: 12, recordsLimit: 100, percentUsed: 12 });
  });

  it('clamps to the current calendar month when current_period_start is null but period_end is absent too', async () => {
    const captured: Array<{ table: string; column: string; value: unknown }> = [];
    routeTables(
      {
        subscriptions: {
          data: {
            status: 'active',
            plan_id: 'plan-professional',
            org_id: null,
            current_period_start: null,
            current_period_end: null,
          },
          error: null,
        },
        plans: { data: { name: 'Professional', price_cents: 4900, billing_period: 'month', records_per_month: 100 }, error: null },
        anchors: { count: 5, error: null },
      },
      (table, column, value) => captured.push({ table, column, value }),
    );

    const res = mockRes();
    await handleBillingStatus(mockReq(), res);

    expect(res.statusCode).toBe(200);
    const gte = captured.find((c) => c.table === 'anchors' && c.column === 'created_at');
    // Previously a null period_start meant NO lower bound at all → an unbounded
    // all-time count. The clamp now bounds it to the current month.
    expect(gte).toBeDefined();
    expect(gte!.value).toBe(currentMonthStartIso());
  });

  it('uses the stored current_period_start verbatim when the window is still current (fresh row)', async () => {
    // A fresh row whose period_end is in the FUTURE must be trusted as-is — the
    // billing period is authoritative when it has not gone stale, so a custom
    // (e.g. annual, or mid-month-aligned) cycle still meters correctly.
    const future = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString();
    const freshStart = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const captured: Array<{ table: string; column: string; value: unknown }> = [];
    routeTables(
      {
        subscriptions: {
          data: {
            status: 'active',
            plan_id: 'plan-professional',
            org_id: null,
            current_period_start: freshStart,
            current_period_end: future,
          },
          error: null,
        },
        plans: { data: { name: 'Professional', price_cents: 4900, billing_period: 'month', records_per_month: 100 }, error: null },
        anchors: { count: 8, error: null },
      },
      (table, column, value) => captured.push({ table, column, value }),
    );

    const res = mockRes();
    await handleBillingStatus(mockReq(), res);

    expect(res.statusCode).toBe(200);
    const gte = captured.find((c) => c.table === 'anchors' && c.column === 'created_at');
    expect(gte).toBeDefined();
    expect(gte!.value).toBe(freshStart);
  });

  it('still reports the stored (stale) currentPeriodEnd in the billing block — the clamp only affects the usage meter', async () => {
    // We do not fabricate a period_end for the customer-facing "next billing
    // date"; we only stop the stale value from corrupting the usage count.
    routeTables({
      subscriptions: {
        data: {
          status: 'active',
          plan_id: 'plan-professional',
          org_id: null,
          current_period_start: '2026-01-20T00:00:00.000Z',
          current_period_end: '2026-04-20T00:00:00.000Z',
        },
        error: null,
      },
      plans: { data: { name: 'Professional', price_cents: 4900, billing_period: 'month', records_per_month: 100 }, error: null },
      anchors: { count: 12, error: null },
    });

    const res = mockRes();
    await handleBillingStatus(mockReq(), res);
    const body = res.body as { billing: { currentPeriodEnd?: string } };
    expect(body.billing.currentPeriodEnd).toBe('2026-04-20T00:00:00.000Z');
  });
});
