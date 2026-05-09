/**
 * Metered Billing Tests (PAY-02 / SCRUM-443)
 * Constitution 1.7: No real Stripe calls — mock everything.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/db.js', () => ({
  db: {
    from: vi.fn(),
    rpc: vi.fn(),
  },
}));

vi.mock('../config.js', () => ({
  config: {
    stripeSecretKey: '',
  },
}));

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { db } from '../utils/db.js';
import { recordMeteredUsage, getMeteredUsage, reportMeteredUsageToStripe } from './meteredBilling.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('recordMeteredUsage', () => {
  it('inserts usage record into billing_events', async () => {
    const mockInsert = vi.fn().mockResolvedValue({ error: null });
    (db.from as any).mockReturnValue({ insert: mockInsert });

    await recordMeteredUsage({
      org_id: 'org-1',
      user_id: 'user-1',
      endpoint: '/api/v1/verify',
      quantity: 1,
      timestamp: '2026-04-05T00:00:00Z',
    });

    expect(db.from).toHaveBeenCalledWith('billing_events');
    expect(mockInsert).toHaveBeenCalledWith(expect.objectContaining({
      org_id: 'org-1',
      event_type: 'metered_api_usage',
    }));
  });

  it('throws on DB error', async () => {
    (db.from as any).mockReturnValue({
      insert: vi.fn().mockResolvedValue({ error: { message: 'DB error' } }),
    });

    await expect(recordMeteredUsage({
      org_id: 'org-1',
      user_id: 'user-1',
      endpoint: '/api/v1/verify',
      quantity: 1,
      timestamp: '2026-04-05T00:00:00Z',
    })).rejects.toThrow();
  });
});

describe('getMeteredUsage', () => {
  it('aggregates usage quantities', async () => {
    (db.from as any).mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            gte: vi.fn().mockReturnValue({
              lte: vi.fn().mockResolvedValue({
                data: [
                  { payload: { quantity: 5 } },
                  { payload: { quantity: 10 } },
                  { payload: { quantity: 3 } },
                ],
                error: null,
              }),
            }),
          }),
        }),
      }),
    });

    const total = await getMeteredUsage('org-1', '2026-04-01', '2026-04-30');
    expect(total).toBe(18);
  });

  it('returns 0 on error', async () => {
    (db.from as any).mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            gte: vi.fn().mockReturnValue({
              lte: vi.fn().mockResolvedValue({ data: null, error: { message: 'fail' } }),
            }),
          }),
        }),
      }),
    });

    const total = await getMeteredUsage('org-1', '2026-04-01', '2026-04-30');
    expect(total).toBe(0);
  });
});

describe('reportMeteredUsageToStripe', () => {
  it('returns empty when no metered subscriptions', async () => {
    (db.from as any).mockReturnValue({
      select: vi.fn().mockReturnValue({
        in: vi.fn().mockResolvedValue({ data: [], error: null }),
      }),
    });

    const results = await reportMeteredUsageToStripe();
    expect(results).toEqual([]);
  });

  it('reports usage for dev mode (no Stripe key)', async () => {
    // Subscriptions query (no plan_type filter — uses plan_id instead) +
    // org_credits is_test check (SCRUM-1740 AC4) + billing_events for usage.
    (db.from as any).mockImplementation((table: string) => {
      if (table === 'subscriptions') {
        return {
          select: vi.fn().mockReturnValue({
            in: vi.fn().mockResolvedValue({
              data: [{ id: 's-1', user_id: 'u-1', org_id: 'org-1', stripe_subscription_id: 'sub_1', plan_id: 'plan-metered' }],
              error: null,
            }),
          }),
        };
      }
      if (table === 'org_credits') {
        return {
          select: vi.fn().mockReturnValue({
            in: vi.fn().mockResolvedValue({
              data: [{ org_id: 'org-1', is_test: false }],
              error: null,
            }),
          }),
        };
      }
      // billing_events query for usage (uses payload + processed_at columns)
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              gte: vi.fn().mockReturnValue({
                lte: vi.fn().mockResolvedValue({
                  data: [{ payload: { quantity: 42 } }],
                  error: null,
                }),
              }),
            }),
          }),
        }),
      };
    });

    const results = await reportMeteredUsageToStripe();
    expect(results).toHaveLength(1);
    expect(results[0].total_usage).toBe(42);
    expect(results[0].reported_to_stripe).toBe(false); // dev mode
    expect(results[0].error).toBeUndefined(); // not sandbox-excluded
  });

  // SCRUM-1740 AC4 — partner-sandbox orgs (is_test=true) MUST be excluded
  // from Stripe meter events. The spec is in SCRUM-1739 Confluence page
  // 43483138; the runtime gate is in meteredBilling.ts loop.
  describe('SCRUM-1740 AC4: sandbox meter-event exclusion', () => {
    it('skips orgs with org_credits.is_test=true and emits sandbox_excluded marker', async () => {
      (db.from as any).mockImplementation((table: string) => {
        if (table === 'subscriptions') {
          return {
            select: vi.fn().mockReturnValue({
              in: vi.fn().mockResolvedValue({
                data: [{ id: 's-1', user_id: 'u-1', org_id: 'sandbox-org-1', stripe_subscription_id: 'sub_sandbox', plan_id: 'plan-metered' }],
                error: null,
              }),
            }),
          };
        }
        if (table === 'org_credits') {
          return {
            select: vi.fn().mockReturnValue({
              in: vi.fn().mockResolvedValue({
                data: [{ org_id: 'sandbox-org-1', is_test: true }],
                error: null,
              }),
            }),
          };
        }
        // If billing_events is queried we throw — the test asserts the
        // sandbox path SHORT-CIRCUITS before this query fires.
        throw new Error(`unexpected table query: ${table}`);
      });

      const results = await reportMeteredUsageToStripe();
      expect(results).toHaveLength(1);
      expect(results[0].org_id).toBe('sandbox-org-1');
      expect(results[0].total_usage).toBe(0);
      expect(results[0].reported_to_stripe).toBe(false);
      expect(results[0].error).toBe('sandbox_excluded');
    });

    it('still meters orgs with is_test=false alongside sandbox orgs', async () => {
      (db.from as any).mockImplementation((table: string) => {
        if (table === 'subscriptions') {
          return {
            select: vi.fn().mockReturnValue({
              in: vi.fn().mockResolvedValue({
                data: [
                  { id: 's-prod', user_id: 'u-prod', org_id: 'prod-org', stripe_subscription_id: 'sub_prod', plan_id: 'plan-metered' },
                  { id: 's-sand', user_id: 'u-sand', org_id: 'sandbox-org-1', stripe_subscription_id: 'sub_sandbox', plan_id: 'plan-metered' },
                ],
                error: null,
              }),
            }),
          };
        }
        if (table === 'org_credits') {
          return {
            select: vi.fn().mockReturnValue({
              in: vi.fn().mockResolvedValue({
                data: [
                  { org_id: 'prod-org', is_test: false },
                  { org_id: 'sandbox-org-1', is_test: true },
                ],
                error: null,
              }),
            }),
          };
        }
        // billing_events — only prod-org should reach here.
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn((col: string, val: string) => {
              expect(val).toBe('prod-org'); // sandbox short-circuited
              return {
                eq: vi.fn().mockReturnValue({
                  gte: vi.fn().mockReturnValue({
                    lte: vi.fn().mockResolvedValue({
                      data: [{ payload: { quantity: 17 } }],
                      error: null,
                    }),
                  }),
                }),
              };
            }),
          }),
        };
      });

      const results = await reportMeteredUsageToStripe();
      const sandbox = results.find((r) => r.org_id === 'sandbox-org-1');
      const prod = results.find((r) => r.org_id === 'prod-org');
      expect(sandbox?.error).toBe('sandbox_excluded');
      expect(sandbox?.reported_to_stripe).toBe(false);
      expect(prod?.total_usage).toBe(17);
      expect(prod?.error).toBeUndefined();
    });

    it('fails CLOSED when org_credits read errors — refuses to bill any org rather than risk billing a sandbox', async () => {
      (db.from as any).mockImplementation((table: string) => {
        if (table === 'subscriptions') {
          return {
            select: vi.fn().mockReturnValue({
              in: vi.fn().mockResolvedValue({
                data: [{ id: 's-1', user_id: 'u-1', org_id: 'org-1', stripe_subscription_id: 'sub_1', plan_id: 'plan-metered' }],
                error: null,
              }),
            }),
          };
        }
        if (table === 'org_credits') {
          return {
            select: vi.fn().mockReturnValue({
              in: vi.fn().mockResolvedValue({
                data: null,
                error: { message: 'connection reset' },
              }),
            }),
          };
        }
        throw new Error(`unexpected table query on fail-closed path: ${table}`);
      });

      const results = await reportMeteredUsageToStripe();
      // Fail-closed contract: no rows returned, no Stripe calls, will retry
      // next cycle.
      expect(results).toEqual([]);
    });
  });
});
