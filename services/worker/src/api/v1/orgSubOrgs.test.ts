/**
 * SCRUM-1170 (HAKI-REQ-01) — sub-org management router smoke tests.
 *
 * Covers the auth + role gates on the parent/child credit-allocation
 * endpoints. The DB layer is mocked at `db.from(table)` to keep these
 * isolated from Supabase. Per-route happy-path coverage uses the same
 * fluent-builder pattern as `compliance-audit.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../utils/db.js', () => ({
  db: { from: vi.fn() },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { orgSubOrgsRouter } from './orgSubOrgs.js';
import { db } from '../../utils/db.js';

function buildApp(userId?: string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (userId) (req as unknown as { userId: string }).userId = userId;
    next();
  });
  app.use('/api/v1/org/sub-orgs', orgSubOrgsRouter);
  return app;
}

interface Builder {
  select: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  order: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  single: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
}

function makeBuilder(state: {
  data?: unknown;
  error?: unknown;
  singleData?: unknown;
  maybeSingleData?: unknown;
} = {}): Builder {
  const builder = {} as Builder;
  const chain = () => builder;
  builder.select = vi.fn(chain);
  builder.eq = vi.fn(chain);
  builder.order = vi.fn(() => Promise.resolve({ data: state.data ?? [], error: state.error ?? null }));
  builder.limit = vi.fn(chain);
  builder.single = vi.fn(() => Promise.resolve({ data: state.singleData ?? null, error: null }));
  builder.maybeSingle = vi.fn(() => Promise.resolve({ data: state.maybeSingleData ?? null, error: null }));
  builder.insert = vi.fn(chain);
  builder.update = vi.fn(chain);
  return builder;
}

describe('GET /api/v1/org/sub-orgs (HAKI-REQ-01)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('401s when no userId on request', async () => {
    const app = buildApp(/* no userId */);
    await request(app).get('/api/v1/org/sub-orgs').expect(401);
  });

  it('400s when user has no org membership', async () => {
    vi.mocked(db.from).mockImplementation((): never =>
      makeBuilder({ maybeSingleData: null }) as unknown as never,
    );
    const app = buildApp('user-1');
    const res = await request(app).get('/api/v1/org/sub-orgs').expect(400);
    expect(res.body.error).toContain('organization');
  });

  it('returns sub-orgs list with maxSubOrgs and count for parent admin', async () => {
    vi.mocked(db.from).mockImplementation((table: string): never => {
      if (table === 'org_members') {
        return makeBuilder({
          maybeSingleData: { org_id: 'parent-1', role: 'owner' },
        }) as unknown as never;
      }
      if (table === 'organizations') {
        // Two queries land on this table — list of children, then parent's max_sub_orgs.
        // The fluent builder is shared; the first await returns from .order(), the second
        // from .single(). We seed both so either resolution path produces sane data.
        return makeBuilder({
          data: [
            { id: 'child-1', display_name: 'Child A', verification_status: 'approved', parent_approval_status: 'approved' },
            { id: 'child-2', display_name: 'Child B', verification_status: 'pending',  parent_approval_status: 'pending'  },
          ],
          singleData: { max_sub_orgs: 5 },
        }) as unknown as never;
      }
      return makeBuilder() as unknown as never;
    });

    const app = buildApp('user-1');
    const res = await request(app).get('/api/v1/org/sub-orgs').expect(200);
    expect(res.body.count).toBe(2);
    expect(res.body.subOrgs).toHaveLength(2);
    expect(res.body.maxSubOrgs).toBe(5);
  });
});

describe('POST /api/v1/org/sub-orgs/approve (HAKI-REQ-01)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('401s when no userId on request', async () => {
    const app = buildApp();
    await request(app)
      .post('/api/v1/org/sub-orgs/approve')
      .send({ childOrgId: 'child-1' })
      .expect(401);
  });

  it('403s when caller is not org admin', async () => {
    vi.mocked(db.from).mockImplementation((): never =>
      makeBuilder({
        maybeSingleData: { org_id: 'parent-1', role: 'member' },
      }) as unknown as never,
    );
    const app = buildApp('user-1');
    const res = await request(app)
      .post('/api/v1/org/sub-orgs/approve')
      .send({ childOrgId: 'child-1' })
      .expect(403);
    expect(res.body.error).toBeDefined();
  });
});
