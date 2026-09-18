/**
 * SCRUM-3868 — sub-org offboarding.
 *
 * Pre-mortem F6: "Revoke" changed `parent_approval_status` and nothing else.
 * The ex-client kept its records, its remaining credits, its members and its
 * integrations, and carried on anchoring against a budget the parent funded.
 * This endpoint is the real lever.
 *
 * 0460 makes reclaim, suspend and their audits one transaction. The worker
 * forwards verified identity and never chooses a stale balance to reclaim.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('../../utils/db.js', () => ({ db: { from: vi.fn(), rpc: vi.fn() } }));
vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../config.js', () => ({ config: { frontendUrl: 'https://app.test' } }));
vi.mock('../../email/templates.js', () => ({
  buildInvitationEmail: vi.fn(() => ({ subject: 'x', html: '<p>x</p>' })),
}));
vi.mock('../../email/sender.js', () => ({
  sendEmail: vi.fn(async () => ({ success: true, messageId: 'e1' })),
}));

import { orgSubOrgsRouter } from './orgSubOrgs.js';
import { db } from '../../utils/db.js';
import { buildApp as buildAppFromRouter } from './__testHelpers.js';

const PARENT = '22222222-2222-4222-8222-222222222222';
const CHILD = '44444444-4444-4444-8444-444444444444';
const ADMIN = 'aaaaaaaa-0000-4000-8000-000000000001';

function buildApp(userId?: string) {
  return buildAppFromRouter(orgSubOrgsRouter, '/api/v1/org/sub-orgs', {
    userId,
    injectUserId: (req, uid) => {
      (req as unknown as { userId: string }).userId = uid;
    },
  });
}

/** Single-org admin. Balance reads belong to the SQL transaction. */
function mockDb(opts: { role?: string } = {}) {
  const role = opts.role ?? 'owner';
  (db.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
    if (table === 'org_members') {
      const all = { data: [{ org_id: PARENT, role }], error: null };
      const chain = {
        eq: () => chain,
        limit: () => chain,
        maybeSingle: () => Promise.resolve({ data: { org_id: PARENT, role }, error: null }),
        then: (r: (v: typeof all) => unknown) => Promise.resolve(all).then(r),
      };
      return { select: () => chain };
    }
    throw new Error(`unexpected table ${table}`);
  });
}

const rpc = () => db.rpc as ReturnType<typeof vi.fn>;

describe('POST /api/v1/org/sub-orgs/offboard (SCRUM-3868)', () => {
  beforeEach(() => {
    (db.from as ReturnType<typeof vi.fn>).mockReset();
    rpc().mockReset();
  });

  it('401s without a session', async () => {
    const res = await request(buildApp()).post('/api/v1/org/sub-orgs/offboard')
      .send({ childOrgId: CHILD });
    expect(res.status).toBe(401);
  });

  it('403s a non-admin', async () => {
    mockDb({ role: 'member' });
    const res = await request(buildApp(ADMIN)).post('/api/v1/org/sub-orgs/offboard')
      .send({ childOrgId: CHILD });
    expect(res.status).toBe(403);
    expect(rpc()).not.toHaveBeenCalled();
  });

  it('returns the balance actually reclaimed by the single atomic RPC', async () => {
    mockDb();
    rpc().mockResolvedValueOnce({ data: { success: true, reclaimed: 40, already_suspended: false }, error: null });
    const res = await request(buildApp(ADMIN))
      .post('/api/v1/org/sub-orgs/offboard')
      .send({ childOrgId: CHILD, reason: 'engagement ended', callerUserId: 'forged' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reclaimed: 40, suspended: true, alreadySuspended: false });
    expect(rpc()).toHaveBeenCalledExactlyOnceWith('offboard_suborg', {
      p_parent_org_id: PARENT, p_sub_org_id: CHILD,
      p_reason: 'engagement ended', p_caller_user_id: ADMIN,
    });
  });

  it('successfully suspends a child with no balance', async () => {
    mockDb();
    rpc().mockResolvedValueOnce({ data: { success: true, reclaimed: 0 }, error: null });
    const res = await request(buildApp(ADMIN)).post('/api/v1/org/sub-orgs/offboard').send({ childOrgId: CHILD });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reclaimed: 0, suspended: true, alreadySuspended: false });
    expect(rpc()).toHaveBeenCalledTimes(1);
  });

  it('does not claim a state change when the SQL relationship check refuses', async () => {
    mockDb();
    rpc().mockResolvedValueOnce({ data: { success: false, error: 'not_a_child_of_parent' }, error: null });
    const res = await request(buildApp(ADMIN)).post('/api/v1/org/sub-orgs/offboard').send({ childOrgId: CHILD });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_a_child_of_parent' });
    expect(rpc()).toHaveBeenCalledTimes(1);
  });

  it('does not claim a partial reclaim on transaction failure', async () => {
    mockDb();
    rpc().mockResolvedValueOnce({ data: null, error: { message: 'suborg_offboard_suspend_failed' } });
    const res = await request(buildApp(ADMIN)).post('/api/v1/org/sub-orgs/offboard').send({ childOrgId: CHILD });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'offboard_unavailable' });
  });

  it('503s a database outage without returning private upstream details', async () => {
    mockDb();
    rpc().mockResolvedValueOnce({ data: null, error: { message: 'private connection details' } });
    const res = await request(buildApp(ADMIN)).post('/api/v1/org/sub-orgs/offboard').send({ childOrgId: CHILD });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'offboard_unavailable' });
  });

  it('422s on a childOrgId that is not a uuid', async () => {
    mockDb();
    const res = await request(buildApp(ADMIN))
      .post('/api/v1/org/sub-orgs/offboard')
      .send({ childOrgId: 'nope' });
    expect(res.status).toBe(422);
    expect(rpc()).not.toHaveBeenCalled();
  });
});
