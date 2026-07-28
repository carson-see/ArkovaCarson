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
