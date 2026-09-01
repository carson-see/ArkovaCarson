/**
 * SCRUM-3865 — parent-admin credit provisioning for sub-orgs.
 *
 * Pre-mortem F3: `allocate_credits_to_sub_org` had ZERO callers anywhere in the
 * repository and `org_credit_allocations` had never had a row in production.
 * These endpoints are the missing path.
 *
 * The RPC is reached through migration 0430's identity-carrying overload,
 * because `auth.uid()` is NULL under the worker's service_role client. The
 * caller id passed to the RPC MUST come from the verified session, never from
 * the request body — a client that could choose it could move another org's
 * credits. That is pinned here explicitly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('../../utils/db.js', () => ({
  db: { from: vi.fn(), rpc: vi.fn() },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../config.js', () => ({
  config: { frontendUrl: 'https://app.test' },
}));

vi.mock('../../email/templates.js', () => ({
  buildInvitationEmail: vi.fn(() => ({ subject: 'Invite', html: '<p>Invite</p>' })),
}));

vi.mock('../../email/sender.js', () => ({
  sendEmail: vi.fn(async () => ({ success: true, messageId: 'email-1' })),
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

/**
 * Two shapes are exercised:
 *   - no `?orgId=`  → `select(...).eq('user_id', id)` awaited directly, returning
 *     every membership, so the route can refuse an ambiguous caller.
 *   - with `?orgId=` → `getUserOrgInfo`'s `.eq().eq().limit(1).maybeSingle()`.
 * The chain below is thenable so both resolve.
 */
function mockMemberships(rows: { org_id: string; role: string }[]) {
  (db.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
    if (table === 'org_members') {
      const all = { data: rows, error: null };
      const chain = {
        eq: () => chain,
        limit: () => chain,
        maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
        then: (resolve: (v: typeof all) => unknown) => Promise.resolve(all).then(resolve),
      };
      return { select: () => chain };
    }
    throw new Error(`unexpected table ${table}`);
  });
}

/** Single-org caller — the unambiguous case. */
function mockMembership(role: 'owner' | 'admin' | 'member') {
  mockMemberships([{ org_id: PARENT, role }]);
}

const rpc = () => db.rpc as ReturnType<typeof vi.fn>;

describe('POST /api/v1/org/sub-orgs/credits (SCRUM-3865)', () => {
  beforeEach(() => {
    (db.from as ReturnType<typeof vi.fn>).mockReset();
    rpc().mockReset();
  });

  it('401s without a session', async () => {
    const res = await request(buildApp()).post('/api/v1/org/sub-orgs/credits').send({
      childOrgId: CHILD,
      amount: 10,
    });
    expect(res.status).toBe(401);
    expect(rpc()).not.toHaveBeenCalled();
  });

  it('403s a member who is not an org admin, without touching the RPC', async () => {
    mockMembership('member');
    const res = await request(buildApp(ADMIN)).post('/api/v1/org/sub-orgs/credits').send({
      childOrgId: CHILD,
      amount: 10,
    });
    expect(res.status).toBe(403);
    expect(rpc()).not.toHaveBeenCalled();
  });

  it('allocates and passes the SESSION user id to the RPC, not a body value', async () => {
    mockMembership('owner');
    rpc().mockResolvedValueOnce({
      data: { success: true, parent_balance: 60, child_balance: 40 },
      error: null,
    });

    const res = await request(buildApp(ADMIN))
      .post('/api/v1/org/sub-orgs/credits')
      // An attacker-supplied identity in the body must be ignored entirely.
      .send({ childOrgId: CHILD, amount: 40, note: 'initial', callerUserId: 'attacker' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ parentBalance: 60, childBalance: 40, amount: 40 });
    expect(rpc()).toHaveBeenCalledWith('allocate_credits_to_sub_org', {
      p_parent_org_id: PARENT,
      p_child_org_id: CHILD,
      p_amount: 40,
      p_note: 'initial',
      p_caller_user_id: ADMIN,
    });
  });

  it('accepts a negative amount as a reclaim', async () => {
    mockMembership('admin');
    rpc().mockResolvedValueOnce({
      data: { success: true, parent_balance: 75, child_balance: 25 },
      error: null,
    });

    const res = await request(buildApp(ADMIN))
      .post('/api/v1/org/sub-orgs/credits')
      .send({ childOrgId: CHILD, amount: -15 });

    expect(res.status).toBe(200);
    expect(res.body.amount).toBe(-15);
  });

  it.each([
    ['zero is not a transfer', 0],
    ['non-integer', 1.5],
    ['absurdly large', 100_000_001],
  ])('422s on an invalid amount: %s', async (_label, amount) => {
    mockMembership('owner');
    const res = await request(buildApp(ADMIN))
      .post('/api/v1/org/sub-orgs/credits')
      .send({ childOrgId: CHILD, amount });
    expect(res.status).toBe(422);
    expect(rpc()).not.toHaveBeenCalled();
  });

  it('422s on a childOrgId that is not a uuid', async () => {
    mockMembership('owner');
    const res = await request(buildApp(ADMIN))
      .post('/api/v1/org/sub-orgs/credits')
      .send({ childOrgId: 'not-a-uuid', amount: 5 });
    expect(res.status).toBe(422);
    expect(rpc()).not.toHaveBeenCalled();
  });

  it.each([
    ['parent_admin_required', 403],
    ['not_a_sub_org', 404],
    ['insufficient_parent_balance', 409],
    ['insufficient_child_balance', 409],
    ['authentication_required', 401],
  ])('maps RPC error %s to HTTP %i', async (rpcError, status) => {
    mockMembership('owner');
    rpc().mockResolvedValueOnce({ data: { error: rpcError }, error: null });

    const res = await request(buildApp(ADMIN))
      .post('/api/v1/org/sub-orgs/credits')
      .send({ childOrgId: CHILD, amount: 10 });

    expect(res.status).toBe(status);
    expect(res.body.error).toBe(rpcError);
  });

  /**
   * The affiliate flow writes the parent admin into every child's org_members
   * as `owner`, so a partner admin belongs to the parent AND to each client
   * org. Guessing which one is "the parent" would decide which balance a
   * transfer debits, so an ambiguous caller must be refused, not resolved.
   */
  it('400s an admin of several orgs when no orgId is given', async () => {
    mockMemberships([
      { org_id: PARENT, role: 'owner' },
      { org_id: CHILD, role: 'owner' },
    ]);

    const res = await request(buildApp(ADMIN))
      .post('/api/v1/org/sub-orgs/credits')
      .send({ childOrgId: CHILD, amount: 10 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('org_id_required');
    expect(rpc()).not.toHaveBeenCalled();
  });

  it('uses the explicit orgId when the caller administers several orgs', async () => {
    mockMemberships([
      { org_id: PARENT, role: 'owner' },
      { org_id: CHILD, role: 'owner' },
    ]);
    rpc().mockResolvedValueOnce({
      data: { success: true, parent_balance: 1, child_balance: 2 },
      error: null,
    });

    const res = await request(buildApp(ADMIN))
      .post(`/api/v1/org/sub-orgs/credits?orgId=${PARENT}`)
      .send({ childOrgId: CHILD, amount: 10 });

    expect(res.status).toBe(200);
    expect(rpc()).toHaveBeenCalledWith(
      'allocate_credits_to_sub_org',
      expect.objectContaining({ p_parent_org_id: PARENT }),
    );
  });

  it('403s an explicit orgId the caller only belongs to as a member', async () => {
    // Explicit-org path now runs through the shared `isCallerOrgAdminResult`,
    // which falls back to the profile role before answering. Pin that the
    // fallback is reachable and still answers "no".
    (db.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === 'org_members') {
        const chain = {
          eq: () => chain,
          limit: () => chain,
          maybeSingle: () => Promise.resolve({ data: { role: 'member' }, error: null }),
        };
        return { select: () => chain };
      }
      if (table === 'profiles') {
        const chain = {
          eq: () => chain,
          maybeSingle: () => Promise.resolve({
            data: { org_id: PARENT, role: 'MEMBER', is_platform_admin: false },
            error: null,
          }),
        };
        return { select: () => chain };
      }
      throw new Error(`unexpected table ${table}`);
    });

    const res = await request(buildApp(ADMIN))
      .post(`/api/v1/org/sub-orgs/credits?orgId=${PARENT}`)
      .send({ childOrgId: CHILD, amount: 10 });

    expect(res.status).toBe(403);
    expect(rpc()).not.toHaveBeenCalled();
  });

  it('503s when the membership lookup itself fails', async () => {
    (db.from as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      select: () => ({
        eq: () => Promise.resolve({ data: null, error: { message: 'boom' } }),
      }),
    }));

    const res = await request(buildApp(ADMIN))
      .post('/api/v1/org/sub-orgs/credits')
      .send({ childOrgId: CHILD, amount: 10 });

    expect(res.status).toBe(503);
    expect(rpc()).not.toHaveBeenCalled();
  });

  it('503s when the RPC transport fails', async () => {
    mockMembership('owner');
    rpc().mockResolvedValueOnce({ data: null, error: { message: 'connection reset' } });

    const res = await request(buildApp(ADMIN))
      .post('/api/v1/org/sub-orgs/credits')
      .send({ childOrgId: CHILD, amount: 10 });

    expect(res.status).toBe(503);
  });
});

describe('GET /api/v1/org/sub-orgs/credits (SCRUM-3865)', () => {
  beforeEach(() => {
    (db.from as ReturnType<typeof vi.fn>).mockReset();
    rpc().mockReset();
  });

  it('401s without a session', async () => {
    const res = await request(buildApp()).get('/api/v1/org/sub-orgs/credits');
    expect(res.status).toBe(401);
  });

  it('returns the parent balance and per-child balances', async () => {
    mockMembership('owner');
    rpc().mockResolvedValueOnce({
      data: {
        parent_org_id: PARENT,
        parent_balance: 75,
        children: [{ child_org_id: CHILD, balance: 25, monthly_allocation: 0 }],
      },
      error: null,
    });

    const res = await request(buildApp(ADMIN)).get('/api/v1/org/sub-orgs/credits');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      parentBalance: 75,
      children: [{ childOrgId: CHILD, balance: 25, monthlyAllocation: 0 }],
    });
    expect(rpc()).toHaveBeenCalledWith('get_parent_credit_rollup', {
      p_parent_org_id: PARENT,
      p_caller_user_id: ADMIN,
    });
  });

  it('403s a non-admin member', async () => {
    mockMembership('member');
    const res = await request(buildApp(ADMIN)).get('/api/v1/org/sub-orgs/credits');
    expect(res.status).toBe(403);
    expect(rpc()).not.toHaveBeenCalled();
  });
});
