/**
 * SCRUM-1170 (HAKI-REQ-01) — sub-org management router smoke tests.
 *
 * Covers the auth + role gates on the parent/child credit-allocation
 * endpoints. The DB layer is mocked at `db.from(table)` to keep these
 * isolated from Supabase. Per-route happy-path coverage uses the same
 * fluent-builder pattern as `compliance-audit.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('../../utils/db.js', () => ({
  db: { from: vi.fn() },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { orgSubOrgsRouter } from './orgSubOrgs.js';
import { db } from '../../utils/db.js';
import { buildApp as buildAppFromRouter, makeBuilder } from './__testHelpers.js';

/**
 * orgSubOrgs.ts reads `req.userId` (untyped cast at line 27), not the typed
 * `req.authUserId` convention used by most v1 routers. Inject the cast field
 * here rather than widening the global Request type for one router.
 */
function buildApp(userId?: string) {
  return buildAppFromRouter(orgSubOrgsRouter, '/api/v1/org/sub-orgs', {
    userId,
    injectUserId: (req, uid) => {
      (req as unknown as { userId: string }).userId = uid;
    },
  });
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
