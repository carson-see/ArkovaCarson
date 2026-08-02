/**
 * Tests for GET /api/v1/usage (P4.5-TS-08)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/db.js', () => ({
  db: { from: vi.fn() },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import type { Request, Response } from 'express';
import { db } from '../../utils/db.js';
import { encodedInFilterBytesFor } from '../../test-utils/postgrestWire.js';
import { POSTGREST_URL_FILTER_BUDGET_BYTES } from '../../utils/postgrest-filter.js';
import { usageRouter } from './usage.js';

// Verify the usage response interface matches the spec
describe('UsageResponse shape', () => {
  it('matches the expected API contract', () => {
    const response = {
      used: 1500,
      limit: 10000,
      remaining: 8500,
      reset_date: '2026-04-01T00:00:00.000Z',
      month: '2026-03',
      keys: [
        { key_prefix: 'ak_live_abc1', name: 'Production', used: 1200 },
        { key_prefix: 'ak_live_def2', name: 'Staging', used: 300 },
      ],
    };

    expect(response.used).toBe(1500);
    expect(response.limit).toBe(10000);
    expect(response.remaining).toBe(8500);
    expect(response.keys).toHaveLength(2);
    expect(response.keys[0].key_prefix).toMatch(/^ak_/);
  });

  it('supports unlimited tier', () => {
    const response = {
      used: 50000,
      limit: 'unlimited' as const,
      remaining: 'unlimited' as const,
      reset_date: '2026-04-01T00:00:00.000Z',
      month: '2026-03',
      keys: [],
    };

    expect(response.limit).toBe('unlimited');
    expect(response.remaining).toBe('unlimited');
  });

  it('computes remaining correctly near quota', () => {
    const used = 9500;
    const limit = 10000;
    const remaining = Math.max(0, limit - used);

    expect(remaining).toBe(500);
  });

  it('remaining is 0 when over quota', () => {
    const used = 10500;
    const limit = 10000;
    const remaining = Math.max(0, limit - used);

    expect(remaining).toBe(0);
  });
});

/**
 * Real coverage for the handler. The block above never imports the router — it
 * asserts against object literals it builds itself, so it cannot fail for any
 * change to `usage.ts`.
 *
 * The defect: `api_key_usage` was read with `const { data: usageData } = ...`,
 * discarding the error, over an id filter bounded only by how many active API
 * keys an org has. A 400 RESOLVES (postgrest-js does not throw), so `usageRows`
 * became `[]` and the endpoint answered HTTP 200 reporting **0 requests this
 * month** — on the surface a customer uses to reconcile their bill.
 */
function getHandler() {
  type Layer = { route?: { path: string; methods: { get: boolean }; stack: Array<{ handle: (...a: unknown[]) => unknown }> } };
  const layer = (usageRouter as unknown as { stack: Layer[] }).stack.find(
    (l) => l.route?.path === '/' && l.route?.methods?.get,
  );
  return layer!.route!.stack[0].handle as (req: Request, res: Response) => Promise<void>;
}

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
  return res as unknown as Response & { statusCode: number; body: any };
}

const keyIds = (n: number) =>
  Array.from({ length: n }, (_, i) => `9f8e7d6c-5b4a-4938-8271-${String(i).padStart(12, '0')}`);

function mockDb(opts: { ids: string[]; failFilter?: (v: string[]) => boolean }) {
  const seenFilters: string[][] = [];
  vi.mocked(db.from as unknown as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
    if (table === 'api_keys') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => Promise.resolve({
              data: opts.ids.map((id, i) => ({ id, key_prefix: `ak_live_${i}`, name: `key-${i}` })),
              error: null,
            }),
          }),
        }),
      };
    }
    // api_key_usage
    return {
      select: () => ({
        in: (_c: string, values: string[]) => {
          seenFilters.push(values);
          const fail = opts.failFilter?.(values)
            ?? encodedInFilterBytesFor(values) > POSTGREST_URL_FILTER_BUDGET_BYTES;
          return {
            eq: () => fail
              ? Promise.resolve({ data: null, error: { message: 'request line too large' } })
              : Promise.resolve({ data: values.map((id) => ({ api_key_id: id, request_count: 7 })), error: null }),
          };
        },
      }),
    };
  });
  return { seenFilters };
}

describe('GET /api/v1/usage — api_key_usage id-filter', () => {
  beforeEach(() => vi.clearAllMocks());

  const req = (): Request =>
    ({ apiKey: { orgId: 'org-1', rateLimitTier: 'free' } } as unknown as Request);

  it('keeps every emitted filter inside the URL budget for an org with many keys', async () => {
    const ids = keyIds(1_000);
    const { seenFilters } = mockDb({ ids });
    const res = mockRes();

    await getHandler()(req(), res);

    expect(seenFilters.length).toBeGreaterThan(1);
    for (const chunk of seenFilters) {
      expect(encodedInFilterBytesFor(chunk)).toBeLessThanOrEqual(POSTGREST_URL_FILTER_BUDGET_BYTES);
    }
    expect(res.statusCode).toBe(200);
    // Every key counted: 1,000 keys x 7 requests.
    expect(res.body.used).toBe(7_000);
  });

  it('returns 500 rather than reporting 0 requests when the usage read fails', async () => {
    const ids = keyIds(10);
    mockDb({ ids, failFilter: () => true });
    const res = mockRes();

    await getHandler()(req(), res);

    expect(res.statusCode).toBe(500);
    expect(res.body?.used).toBeUndefined();
  });

  it('still returns 200 with an empty key list when the org has no keys', async () => {
    mockDb({ ids: [] });
    const res = mockRes();

    await getHandler()(req(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.used).toBe(0);
    expect(res.body.keys).toEqual([]);
  });
});
