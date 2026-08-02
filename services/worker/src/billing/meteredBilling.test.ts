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
import { encodedInFilterBytesFor } from '../test-utils/postgrestWire.js';
import { POSTGREST_URL_FILTER_BUDGET_BYTES } from '../utils/postgrest-filter.js';
import {
  recordMeteredUsage,
  getMeteredUsage,
  reportMeteredUsageToStripe,
  meteredUsageIdempotencyKey,
} from './meteredBilling.js';

const dbFromMock = () => vi.mocked(db.from as unknown as ReturnType<typeof vi.fn>);

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
  dbFromMock().mockImplementation((table: string) => {
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
  it('inserts usage record into billing_events with a deterministic idempotency_key', async () => {
    const mockInsert = vi.fn().mockResolvedValue({ error: null });
    (db.from as ReturnType<typeof vi.fn>).mockReturnValue({ insert: mockInsert });

    await recordMeteredUsage({
      org_id: 'org-1',
      user_id: 'user-1',
      endpoint: '/api/v1/verify',
      quantity: 1,
      timestamp: '2026-04-05T00:00:00Z',
      requestId: 'req-1',
    });

    expect(db.from).toHaveBeenCalledWith('billing_events');
    expect(mockInsert).toHaveBeenCalledWith(expect.objectContaining({
      org_id: 'org-1',
      event_type: 'metered_api_usage',
      idempotency_key: meteredUsageIdempotencyKey({
        org_id: 'org-1',
        endpoint: '/api/v1/verify',
        requestId: 'req-1',
      }),
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
      requestId: 'req-1',
    })).rejects.toThrow();
  });

  // SCRUM-2971 — billing_events idempotency
  describe('SCRUM-2971: idempotency', () => {
    it('retry of the same metered call (same requestId) is a no-op, not a thrown error', async () => {
      const mockInsert = vi.fn().mockResolvedValue({ error: { code: '23505', message: 'duplicate key value violates unique constraint "billing_events_idempotency_key_key"' } });
      (db.from as ReturnType<typeof vi.fn>).mockReturnValue({ insert: mockInsert });

      const record = {
        org_id: 'org-1',
        user_id: 'user-1',
        endpoint: '/api/v1/verify',
        quantity: 1,
        timestamp: '2026-04-05T00:00:00Z',
        requestId: 'req-retry-1',
      };

      // First attempt "succeeded" upstream (row already exists); this call
      // simulates the retry hitting the same idempotency_key.
      await expect(recordMeteredUsage(record)).resolves.toBeUndefined();

      // Exactly one distinct idempotency_key was ever attempted for this
      // requestId — the retry reused it verbatim, it did not mint a new row.
      expect(mockInsert).toHaveBeenCalledTimes(1);
      expect(mockInsert).toHaveBeenCalledWith(expect.objectContaining({
        idempotency_key: meteredUsageIdempotencyKey({
          org_id: 'org-1',
          endpoint: '/api/v1/verify',
          requestId: 'req-retry-1',
        }),
      }));
    });

    it('distinct usage events (different requestId) get distinct idempotency_key values — not collapsed', () => {
      const base = { org_id: 'org-1', endpoint: '/api/v1/verify' };
      const keyA = meteredUsageIdempotencyKey({ ...base, requestId: 'req-A' });
      const keyB = meteredUsageIdempotencyKey({ ...base, requestId: 'req-B' });

      expect(keyA).not.toBe(keyB);
    });

    it('two legitimate calls in the same period (same org/endpoint/timestamp, different requestId) both insert', async () => {
      const mockInsert = vi.fn().mockResolvedValue({ error: null });
      (db.from as ReturnType<typeof vi.fn>).mockReturnValue({ insert: mockInsert });

      const shared = {
        org_id: 'org-1',
        user_id: 'user-1',
        endpoint: '/api/v1/verify',
        quantity: 1,
        timestamp: '2026-04-05T00:00:00.000Z',
      };

      await recordMeteredUsage({ ...shared, requestId: 'req-unit-1' });
      await recordMeteredUsage({ ...shared, requestId: 'req-unit-2' });

      expect(mockInsert).toHaveBeenCalledTimes(2);
      const keys = mockInsert.mock.calls.map((call) => (call[0] as { idempotency_key: string }).idempotency_key);
      expect(new Set(keys).size).toBe(2); // distinct rows, not collapsed
    });
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

  // The sandbox-exclusion read takes one org id per ACTIVE SUBSCRIPTION. That
  // set has no upper bound — it grows with the customer base — and it was sent
  // as a single `.in('org_id', …)`. Past ~200 subscribed orgs the request line
  // exceeds the proxy budget, PostgREST answers 400, and the fail-closed branch
  // above aborts the whole cycle: every org silently stops being metered, every
  // cycle, with the only signal an error log nobody reads.
  describe('org_credits id-filter width (PostgREST request-line budget)', () => {
    function mockWideReportDb(orgIds: string[], failFilter?: (values: string[]) => boolean) {
      const seenFilters: string[][] = [];
      dbFromMock().mockImplementation((table: string) => {
        if (table === 'subscriptions') {
          return mockSelectIn(
            orgIds.map((org, i) => ({
              id: `s-${i}`,
              user_id: `u-${i}`,
              org_id: org,
              stripe_subscription_id: `sub_${i}`,
              plan_id: 'plan-metered',
            })),
          );
        }
        if (table === 'org_credits') {
          return {
            select: vi.fn().mockReturnValue({
              in: vi.fn((_col: string, values: string[]) => {
                seenFilters.push(values);
                if (failFilter?.(values)) {
                  return Promise.resolve({ data: null, error: { message: 'request line too large' } });
                }
                return Promise.resolve({
                  data: values.map((org) => ({ org_id: org, is_test: org.startsWith('sandbox') })),
                  error: null,
                });
              }),
            }),
          };
        }
        return mockBillingEventsChain([{ payload: { quantity: 1 } }], null);
      });
      return { seenFilters };
    }

    const orgIds = (n: number, prefix = 'org') =>
      Array.from({ length: n }, (_, i) => `${prefix}-1a2b3c4d-5e6f-4a8b-9c0d-${String(i).padStart(12, '0')}`);

    it('keeps every emitted org_credits filter inside the URL budget at 5,000 subscribed orgs', async () => {
      const ids = orgIds(5_000);
      const { seenFilters } = mockWideReportDb(ids);

      await reportMeteredUsageToStripe();

      expect(seenFilters.length).toBeGreaterThan(1);
      for (const chunk of seenFilters) {
        expect(encodedInFilterBytesFor(chunk)).toBeLessThanOrEqual(POSTGREST_URL_FILTER_BUDGET_BYTES);
      }
      // No org id may be dropped by chunking — a missed org is an unmetered org.
      expect(seenFilters.flat().sort()).toEqual([...ids].sort());
    });

    it('still excludes a sandbox org that lands in a later chunk', async () => {
      const ids = [...orgIds(400), 'sandbox-org-late'];
      mockWideReportDb(ids);

      const results = await reportMeteredUsageToStripe();

      const sandbox = results.find((r) => r.org_id === 'sandbox-org-late');
      expect(sandbox?.error).toBe('sandbox_excluded');
      expect(sandbox?.reported_to_stripe).toBe(false);
    });

    it('fails CLOSED when ONE chunk errors — a partial is_test map may mark a sandbox org billable', async () => {
      const ids = orgIds(400);
      // Only the second chunk fails: the first returns a complete-looking map
      // that simply omits every org in the failed chunk. Indistinguishable from
      // "those orgs have no org_credits row", i.e. is_test=false, i.e. billable.
      let call = 0;
      mockWideReportDb(ids, () => call++ === 1);

      const results = await reportMeteredUsageToStripe();
      expect(results).toEqual([]);
    });
  });
});
