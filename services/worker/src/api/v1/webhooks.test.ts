import express, { type Request } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetDeadLetterEntries = vi.fn();
const mockResolveDlqEntry = vi.fn();

vi.mock('../../webhooks/delivery.js', () => ({
  getDeadLetterEntries: mockGetDeadLetterEntries,
  isPrivateUrlResolved: vi.fn(),
  replayDelivery: vi.fn(),
  resolveDlqEntry: mockResolveDlqEntry,
  signPayload: vi.fn(() => 'sig-test'),
}));

const mockDbFrom = vi.fn();

vi.mock('../../utils/db.js', () => ({
  db: {
    from: mockDbFrom,
  },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

import { encodedInFilterBytesFor } from '../../test-utils/postgrestWire.js';
import { POSTGREST_URL_FILTER_BUDGET_BYTES } from '../../utils/postgrest-filter.js';

const { webhooksRouter } = await import('./webhooks.js');

function buildApp(apiKey: Request['apiKey'] | null = {
  keyId: 'key-1',
  keyPrefix: 'ak_test',
  orgId: 'org-001',
  userId: 'user-001',
  scopes: ['webhooks:manage'],
  rateLimitTier: 'paid',
}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (apiKey) req.apiKey = apiKey;
    next();
  });
  app.use('/api/v1/webhooks', webhooksRouter);
  return app;
}

function mockProfileRole(role: string) {
  const single = vi.fn().mockResolvedValue({ data: { role }, error: null });
  const eq = vi.fn(() => ({ single }));
  const select = vi.fn(() => ({ eq }));
  mockDbFrom.mockImplementation((table: string) => {
    if (table === 'profiles') return { select };
    if (table === 'audit_events') return { insert: vi.fn().mockResolvedValue({ error: null }) };
    return {};
  });
}

describe('webhooks self-service DLQ routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbFrom.mockReturnValue({});
    mockGetDeadLetterEntries.mockResolvedValue([
      { id: 'dlq-001', event_id: 'evt-001', resolved: false },
    ]);
    mockResolveDlqEntry.mockResolvedValue(true);
  });

  it('lists unresolved DLQ entries through the deployed /webhooks/dlq route', async () => {
    mockProfileRole('ORG_ADMIN');

    const res = await request(buildApp()).get('/api/v1/webhooks/dlq').expect(200);

    expect(mockGetDeadLetterEntries).toHaveBeenCalledWith('org-001', 50);
    expect(res.body).toEqual({
      entries: [{ id: 'dlq-001', event_id: 'evt-001', resolved: false }],
      total: 1,
    });
  });

  it('rejects non-admin API keys before listing DLQ entries', async () => {
    mockProfileRole('INDIVIDUAL');

    await request(buildApp()).get('/api/v1/webhooks/dlq').expect(403);

    expect(mockGetDeadLetterEntries).not.toHaveBeenCalled();
  });

  it('resolves a seeded DLQ entry through the deployed /webhooks/dlq/:id/resolve route', async () => {
    mockProfileRole('ORG_ADMIN');

    const res = await request(buildApp())
      .post('/api/v1/webhooks/dlq/dlq-001/resolve')
      .expect(200);

    expect(mockResolveDlqEntry).toHaveBeenCalledWith('dlq-001', 'org-001');
    expect(res.body).toEqual({ resolved: true, id: 'dlq-001' });
  });
});

/**
 * GET /api/v1/webhooks/deliveries — the org-scoping id filter.
 *
 * `scopedEndpointIds` is one id per webhook endpoint the org owns, with no
 * upper bound in code, and it went out as a single `.in('endpoint_id', …)`.
 * This read fails loud (500), so unlike the silent-empty sites the damage is an
 * outage rather than a wrong answer — the delivery-log view simply stops
 * working for the orgs with the most endpoints.
 */
describe('GET /webhooks/deliveries — endpoint_id filter width', () => {
  beforeEach(() => vi.clearAllMocks());

  const endpointIds = (n: number) =>
    Array.from({ length: n }, (_, i) => `7c8d9e0f-1a2b-4c3d-8e4f-${String(i).padStart(12, '0')}`);

  function mockDelivery(ids: string[]) {
    const seenFilters: string[][] = [];
    mockDbFrom.mockImplementation((table: string) => {
      if (table === 'webhook_endpoints') {
        return {
          select: () => ({ eq: () => Promise.resolve({ data: ids.map((id) => ({ id })), error: null }) }),
        };
      }
      // webhook_delivery_logs
      return {
        select: () => ({
          order: () => ({
            limit: (lim: number) => ({
              in: (_c: string, values: string[]) => {
                seenFilters.push(values);
                if (encodedInFilterBytesFor(values) > POSTGREST_URL_FILTER_BUDGET_BYTES) {
                  return Promise.resolve({ data: null, error: { message: 'request line too large' } });
                }
                // Newest-first within the chunk, `lim` rows max — like the real query.
                return Promise.resolve({
                  data: values.slice(0, lim).map((id) => ({
                    id: `log-${id}`,
                    endpoint_id: id,
                    created_at: `2026-08-01T00:00:${String(values.indexOf(id) % 60).padStart(2, '0')}Z`,
                  })),
                  error: null,
                });
              },
            }),
          }),
        }),
      };
    });
    return { seenFilters };
  }

  it('keeps every emitted filter inside the URL budget for an org with many endpoints', async () => {
    const ids = endpointIds(2_000);
    const { seenFilters } = mockDelivery(ids);

    const res = await request(buildApp()).get('/api/v1/webhooks/deliveries');

    expect(res.status).toBe(200);
    expect(seenFilters.length).toBeGreaterThan(1);
    for (const chunk of seenFilters) {
      expect(encodedInFilterBytesFor(chunk)).toBeLessThanOrEqual(POSTGREST_URL_FILTER_BUDGET_BYTES);
    }
  });

  it('never returns more than the requested limit after merging chunks', async () => {
    mockDelivery(endpointIds(2_000));

    const res = await request(buildApp()).get('/api/v1/webhooks/deliveries?limit=25');

    expect(res.status).toBe(200);
    expect(res.body.deliveries.length).toBeLessThanOrEqual(25);
    expect(res.body.total).toBe(res.body.deliveries.length);
    // Merged result must still be newest-first, not chunk-order.
    const times = res.body.deliveries.map((d: { created_at: string }) => d.created_at);
    expect([...times].sort().reverse()).toEqual(times);
  });

  // REGRESSION: the merge sort was originally inside `if (logs.length > limit)`,
  // so a result at or under the limit came back in CHUNK order — the common
  // case, and the one the limit-capping test above never reaches.
  it('returns newest-first even when the merged result is under the limit', async () => {
    const ids = endpointIds(400); // 2 chunks
    // Chunk 1 gets the OLD row, chunk 2 gets the NEW one. Concatenated in chunk
    // order that is oldest-first — the exact inversion the guard allowed.
    // Hoisted: `db.from()` runs once per chunk, so a counter declared inside
    // the implementation resets every time and both chunks look like chunk 1.
    let call = 0;
    mockDbFrom.mockImplementation((table: string) => {
      if (table === 'webhook_endpoints') {
        return { select: () => ({ eq: () => Promise.resolve({ data: ids.map((id) => ({ id })), error: null }) }) };
      }
      return {
        select: () => ({
          order: () => ({
            limit: () => ({
              in: () => {
                const first = call++ === 0;
                return Promise.resolve({
                  data: [{
                    id: first ? 'log-old' : 'log-new',
                    endpoint_id: ids[0],
                    created_at: first ? '2026-08-01T00:00:00Z' : '2026-08-02T00:00:00Z',
                  }],
                  error: null,
                });
              },
            }),
          }),
        }),
      };
    });

    const res = await request(buildApp()).get('/api/v1/webhooks/deliveries?limit=50');

    expect(res.status).toBe(200);
    expect(res.body.deliveries).toHaveLength(2);
    // Under the limit, so no trimming happens — ordering must still be global.
    expect(res.body.deliveries[0].id).toBe('log-new');
    expect(res.body.deliveries[1].id).toBe('log-old');
  });

  it('500s when a chunk fails rather than returning a short delivery list', async () => {
    const ids = endpointIds(400);
    // Hoisted: `db.from()` is called once per chunk, so a counter declared
    // inside the implementation would reset every time and never fail a chunk.
    let call = 0;
    mockDbFrom.mockImplementation((table: string) => {
      if (table === 'webhook_endpoints') {
        return { select: () => ({ eq: () => Promise.resolve({ data: ids.map((id) => ({ id })), error: null }) }) };
      }
      return {
        select: () => ({
          order: () => ({
            limit: () => ({
              in: () => call++ === 1
                ? Promise.resolve({ data: null, error: { message: 'boom' } })
                : Promise.resolve({ data: [], error: null }),
            }),
          }),
        }),
      };
    });

    const res = await request(buildApp()).get('/api/v1/webhooks/deliveries');
    expect(res.status).toBe(500);
  });
});
