/**
 * Tests for FERPA Directory Information Opt-Out API — REG-02 (SCRUM-562)
 *
 * SECURITY REGRESSION COVERAGE (fix, 2026-07-28): all three routes go through
 * `requireOrgId`, which previously trusted `x-org-id` verbatim with NO
 * membership check — any authenticated user could read/write another org's
 * directory opt-out flags. The HTTP-level tests below prove the fix: a caller
 * from org A is rejected (403) when targeting org B via the header, on both
 * a read (GET) and a write (PATCH), while a legitimate same-org caller still
 * succeeds.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const isUserMemberOfOrgResult = vi.fn();

vi.mock('../_org-auth.js', () => ({
  isUserMemberOfOrgResult: (...args: unknown[]) => isUserMemberOfOrgResult(...args),
}));

vi.mock('../../utils/db.js', () => ({
  db: { from: vi.fn() },
}));
vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../config.js', () => ({
  config: { frontendUrl: 'https://app.arkova.ai' },
}));
vi.mock('../../utils/verifyCache.js', () => ({
  invalidateVerificationCache: vi.fn(),
}));

import { ToggleOptOutSchema, BulkOptOutSchema } from './directory-opt-out.js';
import directoryOptOutRouter from './directory-opt-out.js';
import { db } from '../../utils/db.js';
import { encodedInFilterBytesFor } from '../../test-utils/postgrestWire.js';
import { POSTGREST_URL_FILTER_BUDGET_BYTES } from '../../utils/postgrest-filter.js';

function createApp(userId: string | null = 'user-org-A') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (userId) req.authUserId = userId;
    next();
  });
  app.use('/api/v1/directory-opt-out', directoryOptOutRouter);
  return app;
}

/** Chainable query-builder mock resolving to a single successful update/select. */
function chainableResolve(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  builder.update = vi.fn(chain);
  builder.select = vi.fn(chain);
  builder.eq = vi.fn(chain);
  builder.in = vi.fn(chain);
  builder.is = vi.fn(chain);
  builder.order = vi.fn(chain);
  builder.range = vi.fn().mockResolvedValue(result);
  builder.single = vi.fn().mockResolvedValue(result);
  builder.then = undefined;
  return builder;
}

describe('Directory Opt-Out API — cross-tenant isolation (HTTP)', () => {
  const fromMock = db.from as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fromMock.mockImplementation((table: string) => {
      if (table === 'anchors') {
        return chainableResolve({
          data: { public_id: 'ARK-1', directory_info_opt_out: true },
          error: null,
        });
      }
      return { insert: vi.fn().mockResolvedValue({ error: null }) };
    });
  });

  it('PATCH: org-A caller targeting org-B header is REJECTED (403), never trusted', async () => {
    isUserMemberOfOrgResult.mockResolvedValue({ value: false, error: false });
    const res = await request(createApp('user-org-A'))
      .patch('/api/v1/directory-opt-out/ARK-1')
      .set('x-org-id', 'org-B')
      .send({ opt_out: true });
    expect(res.status).toBe(403);
    expect(isUserMemberOfOrgResult).toHaveBeenCalledWith('user-org-A', 'org-B');
  });

  it('PATCH: legitimate same-org caller still succeeds (200)', async () => {
    isUserMemberOfOrgResult.mockResolvedValue({ value: true, error: false });
    const res = await request(createApp('user-org-A'))
      .patch('/api/v1/directory-opt-out/ARK-1')
      .set('x-org-id', 'org-A')
      .send({ opt_out: true });
    expect(res.status).toBe(200);
  });

  it('GET (list): org-A caller targeting org-B header is REJECTED (403), never trusted', async () => {
    isUserMemberOfOrgResult.mockResolvedValue({ value: false, error: false });
    const res = await request(createApp('user-org-A'))
      .get('/api/v1/directory-opt-out')
      .set('x-org-id', 'org-B');
    expect(res.status).toBe(403);
  });

  it('GET (list): legitimate same-org caller still succeeds (200)', async () => {
    isUserMemberOfOrgResult.mockResolvedValue({ value: true, error: false });
    fromMock.mockImplementation((table: string) => {
      if (table === 'anchors') {
        return chainableResolve({ data: [], error: null });
      }
      return { insert: vi.fn().mockResolvedValue({ error: null }) };
    });
    const res = await request(createApp('user-org-A'))
      .get('/api/v1/directory-opt-out')
      .set('x-org-id', 'org-A');
    expect(res.status).toBe(200);
  });

  it('returns 401 when unauthenticated', async () => {
    const res = await request(createApp(null))
      .get('/api/v1/directory-opt-out')
      .set('x-org-id', 'org-A');
    expect(res.status).toBe(401);
  });
});

describe('Directory Opt-Out API — REG-02', () => {
  describe('ToggleOptOutSchema (exported from module)', () => {
    it('accepts valid opt_out boolean', () => {
      expect(ToggleOptOutSchema.safeParse({ opt_out: true }).success).toBe(true);
      expect(ToggleOptOutSchema.safeParse({ opt_out: false }).success).toBe(true);
    });

    it('rejects non-boolean opt_out', () => {
      expect(ToggleOptOutSchema.safeParse({ opt_out: 'yes' }).success).toBe(false);
      expect(ToggleOptOutSchema.safeParse({}).success).toBe(false);
    });
  });

  describe('BulkOptOutSchema (exported from module)', () => {
    it('accepts valid bulk payload', () => {
      expect(BulkOptOutSchema.safeParse({
        records: [
          { public_id: 'ARK-2026-EDU-001', opt_out: true },
          { public_id: 'ARK-2026-EDU-002', opt_out: false },
        ],
      }).success).toBe(true);
    });

    it('rejects empty records', () => {
      expect(BulkOptOutSchema.safeParse({ records: [] }).success).toBe(false);
    });

    it('rejects missing public_id', () => {
      expect(BulkOptOutSchema.safeParse({
        records: [{ opt_out: true }],
      }).success).toBe(false);
    });

    it('rejects payloads exceeding 1000 records', () => {
      const tooMany = Array.from({ length: 1001 }, (_, i) => ({
        public_id: `ARK-${i}`,
        opt_out: true,
      }));
      expect(BulkOptOutSchema.safeParse({ records: tooMany }).success).toBe(false);
    });
  });
});

/**
 * POST /bulk — the two update filters.
 *
 * `records` is Zod-capped at 1000 entries but `public_id` is `z.string().min(1)`
 * with NO max, so the encoded `.in()` filter had no byte bound whatsoever. The
 * update errors were never read, so on a 400 `data` came back null, no id
 * landed in `updatedIds`, and the response told the caller
 * `updated: 0, failed: N` with `error: 'Not found'` on EVERY record — a false
 * statement about rows in the caller's own org that exist and were simply never
 * written.
 */
describe('POST /bulk — update filter width and honest failure reporting', () => {
  const fromMock = db.from as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    isUserMemberOfOrgResult.mockResolvedValue({ value: true, error: false });
  });

  function mockBulk(opts: { failChunk?: (values: string[]) => boolean } = {}) {
    const seenFilters: string[][] = [];
    fromMock.mockImplementation((table: string) => {
      if (table !== 'anchors') return { insert: vi.fn().mockResolvedValue({ error: null }) };
      const builder: Record<string, unknown> = {};
      let captured: string[] = [];
      builder.update = vi.fn(() => builder);
      builder.in = vi.fn((_c: string, values: string[]) => {
        captured = values;
        seenFilters.push(values);
        return builder;
      });
      builder.eq = vi.fn(() => builder);
      builder.select = vi.fn(() =>
        opts.failChunk?.(captured)
          ? Promise.resolve({ data: null, error: { message: 'request line too large' } })
          : Promise.resolve({ data: captured.map((id) => ({ public_id: id })), error: null }),
      );
      return builder;
    });
    return { seenFilters };
  }

  const bulkBody = (n: number, idFor = (i: number) => `ARK-2026-EDU-${String(i).padStart(6, '0')}`) => ({
    records: Array.from({ length: n }, (_, i) => ({ public_id: idFor(i), opt_out: i % 2 === 0 })),
  });

  it('keeps every emitted filter inside the URL budget at the schema maximum', async () => {
    // Schema max records, each with a long-but-legal public_id — `min(1)` sets
    // no ceiling, so this is inside the documented contract.
    const body = bulkBody(1000, (i) => `ARK-2026-EDUCATION-RECORD-${String(i).padStart(40, '0')}`);
    const { seenFilters } = mockBulk();

    const res = await request(createApp())
      .post('/api/v1/directory-opt-out/bulk')
      .set('x-org-id', 'org-A')
      .send(body);

    expect(res.status).toBe(200);
    expect(seenFilters.length).toBeGreaterThan(2);
    for (const chunk of seenFilters) {
      expect(encodedInFilterBytesFor(chunk)).toBeLessThanOrEqual(POSTGREST_URL_FILTER_BUDGET_BYTES);
    }
    expect(res.body.updated).toBe(1000);
    expect(res.body.failed).toBe(0);
  });

  it('never reports a failed write as "Not found"', async () => {
    const body = bulkBody(400);
    // Fail exactly the chunk containing the first record.
    const firstId = body.records[0].public_id;
    mockBulk({ failChunk: (values) => values.includes(firstId) });

    const res = await request(createApp())
      .post('/api/v1/directory-opt-out/bulk')
      .set('x-org-id', 'org-A')
      .send(body);

    expect(res.status).toBe(200);
    const first = res.body.results.find((r: { public_id: string }) => r.public_id === firstId);
    expect(first.updated).toBe(false);
    // The lie this test exists to prevent.
    expect(first.error).not.toBe('Not found');
    expect(first.error).toBe('update_failed');
    // Records in the surviving chunks are still reported as updated.
    expect(res.body.updated).toBeGreaterThan(0);
  });

  it('still reports a genuinely absent record as "Not found"', async () => {
    const body = bulkBody(4);
    const missing = body.records[2].public_id;
    fromMock.mockImplementation((table: string) => {
      if (table !== 'anchors') return { insert: vi.fn().mockResolvedValue({ error: null }) };
      const builder: Record<string, unknown> = {};
      let captured: string[] = [];
      builder.update = vi.fn(() => builder);
      builder.in = vi.fn((_c: string, values: string[]) => { captured = values; return builder; });
      builder.eq = vi.fn(() => builder);
      builder.select = vi.fn(() =>
        Promise.resolve({
          data: captured.filter((id) => id !== missing).map((id) => ({ public_id: id })),
          error: null,
        }),
      );
      return builder;
    });

    const res = await request(createApp())
      .post('/api/v1/directory-opt-out/bulk')
      .set('x-org-id', 'org-A')
      .send(body);

    const row = res.body.results.find((r: { public_id: string }) => r.public_id === missing);
    expect(row.error).toBe('Not found');
  });
});
