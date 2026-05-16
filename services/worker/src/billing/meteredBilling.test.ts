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

interface SubRow { id: string; user_id: string; org_id: string; stripe_subscription_id: string; plan_id: string }
interface CreditRow { org_id: string; is_test: boolean }
interface UsageRow { payload: { quantity: number } }

function mockSelectIn<T>(data: T[] | null, error: { message: string } | null = null) {
  return { select: vi.fn().mockReturnValue({ in: vi.fn().mockResolvedValue({ data, error }) }) };
}

function mockBillingEventsChain(data: UsageRow[] | null, error: { message: string } | null = null, eqAssert?: (col: string, val: string) => void) {
  return {
    select: vi.fn().mockReturnValue({
      eq: vi.fn((col: string, val: string) => {
        eqAssert?.(col, val);
        return {
          eq: vi.fn().mockReturnValue({
            gte: vi.fn().mockReturnValue({
              lte: vi.fn().mockResolvedValue({ data, error }),
            }),
          }),
        };
      }),
    }),
  };
}

function mockReportDb(opts: {
  subs: SubRow[];
  credits: CreditRow[] | null;
  creditsError?: { message: string } | null;
  usage?: UsageRow[];
  usageEqAssert?: (col: string, val: string) => void;
  throwOnBillingEvents?: boolean;
}) {
  (db.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
    if (table === 'subscriptions') return mockSelectIn(opts.subs);
    if (table === 'org_credits') return mockSelectIn(opts.credits, opts.creditsError ?? null);
    if (opts.throwOnBillingEvents) throw new Error(`unexpected table query: ${table}`);
    return mockBillingEventsChain(opts.usage ?? [], null, opts.usageEqAssert);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('recordMeteredUsage', () => {
  it('inserts usage record into billing_events', async () => {
    const mockInsert = vi.fn().mockResolvedValue({ error: null });
    (db.from as ReturnType<typeof vi.fn>).mockReturnValue({ insert: mockInsert });

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
    (db.from as ReturnType<typeof vi.fn>).mockReturnValue({
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
    (db.from as ReturnType<typeof vi.fn>).mockReturnValue({
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
    (db.from as ReturnType<typeof vi.fn>).mockReturnValue({
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
    (db.from as ReturnType<typeof vi.fn>).mockReturnValue({
      select: vi.fn().mockReturnValue({
        in: vi.fn().mockResolvedValue({ data: [], error: null }),
      }),
    });

    const results = await reportMeteredUsageToStripe();
    expect(results).toEqual([]);
  });

  it('reports usage for dev mode (no Stripe key)', async () => {
    mockReportDb({
      subs: [{ id: 's-1', user_id: 'u-1', org_id: 'org-1', stripe_subscription_id: 'sub_1', plan_id: 'plan-metered' }],
      credits: [{ org_id: 'org-1', is_test: false }],
      usage: [{ payload: { quantity: 42 } }],
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
      mockReportDb({
        subs: [{ id: 's-1', user_id: 'u-1', org_id: 'sandbox-org-1', stripe_subscription_id: 'sub_sandbox', plan_id: 'plan-metered' }],
        credits: [{ org_id: 'sandbox-org-1', is_test: true }],
        throwOnBillingEvents: true,
      });

      const results = await reportMeteredUsageToStripe();
      expect(results).toHaveLength(1);
      expect(results[0].org_id).toBe('sandbox-org-1');
      expect(results[0].total_usage).toBe(0);
      expect(results[0].reported_to_stripe).toBe(false);
      expect(results[0].error).toBe('sandbox_excluded');
    });

    it('still meters orgs with is_test=false alongside sandbox orgs', async () => {
      mockReportDb({
        subs: [
          { id: 's-prod', user_id: 'u-prod', org_id: 'prod-org', stripe_subscription_id: 'sub_prod', plan_id: 'plan-metered' },
          { id: 's-sand', user_id: 'u-sand', org_id: 'sandbox-org-1', stripe_subscription_id: 'sub_sandbox', plan_id: 'plan-metered' },
        ],
        credits: [
          { org_id: 'prod-org', is_test: false },
          { org_id: 'sandbox-org-1', is_test: true },
        ],
        usage: [{ payload: { quantity: 17 } }],
        usageEqAssert: (_col, val) => { expect(val).toBe('prod-org'); },
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
      mockReportDb({
        subs: [{ id: 's-1', user_id: 'u-1', org_id: 'org-1', stripe_subscription_id: 'sub_1', plan_id: 'plan-metered' }],
        credits: null,
        creditsError: { message: 'connection reset' },
        throwOnBillingEvents: true,
      });

      const results = await reportMeteredUsageToStripe();
      expect(results).toEqual([]);
    });
  });
});
