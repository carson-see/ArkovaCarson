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
 * `getUserOrgInfo` issues
 * `from('org_members').select(...).eq('user_id', id).limit(1).maybeSingle()`
 * when no explicit org is requested. Mirror that chain exactly.
 */
function mockMembership(role: 'owner' | 'admin' | 'member') {
  (db.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
    if (table === 'org_members') {
      const resolved = Promise.resolve({ data: { org_id: PARENT, role }, error: null });
      const chain = {
        eq: () => chain,
        limit: () => chain,
        maybeSingle: () => resolved,
      };
      return { select: () => chain };
    }
    throw new Error(`unexpected table ${table}`);
  });
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
