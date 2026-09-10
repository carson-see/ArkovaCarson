/**
 * SCRUM-3868 — sub-org offboarding.
 *
 * Pre-mortem F6: "Revoke" changed `parent_approval_status` and nothing else.
 * The ex-client kept its records, its remaining credits, its members and its
 * integrations, and carried on anchoring against a budget the parent funded.
 * This endpoint is the real lever.
 *
 * ORDER IS THE DESIGN. Reclaim first, then suspend. If the suspend fails after
 * a successful reclaim, the credits are safely back with the parent and the
 * sub-org is merely still active — a retry finishes the job. The reverse order
 * strands the parent's credits inside an org nobody can act in.
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

/** Single-org admin plus a child credit balance. */
function mockDb(opts: { role?: string; childBalance?: number; balanceError?: boolean } = {}) {
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
    if (table === 'org_credits') {
      const chain = {
        eq: () => chain,
        maybeSingle: () => Promise.resolve(
          opts.balanceError
            ? { data: null, error: { message: 'boom' } }
            : { data: { balance: opts.childBalance ?? 0 }, error: null },
        ),
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

  it('reclaims the unspent balance and THEN suspends', async () => {
    mockDb({ childBalance: 40 });
    rpc()
      .mockResolvedValueOnce({ data: { success: true, parent_balance: 140, child_balance: 0 }, error: null })
      .mockResolvedValueOnce({ data: { success: true, sub_org_id: CHILD }, error: null });

    const res = await request(buildApp(ADMIN))
      .post('/api/v1/org/sub-orgs/offboard')
      .send({ childOrgId: CHILD, reason: 'engagement ended' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ reclaimed: 40, suspended: true });

    const [firstCall, secondCall] = rpc().mock.calls;
    expect(firstCall[0]).toBe('allocate_credits_to_sub_org');
    expect(firstCall[1]).toMatchObject({ p_amount: -40, p_caller_user_id: ADMIN });
    expect(secondCall[0]).toBe('suspend_suborg');
    expect(secondCall[1]).toMatchObject({
      p_parent_org_id: PARENT,
      p_sub_org_id: CHILD,
      p_reason: 'engagement ended',
      p_caller_user_id: ADMIN,
    });
  });

  it('skips the reclaim when the sub-org has nothing left', async () => {
    mockDb({ childBalance: 0 });
    rpc().mockResolvedValueOnce({ data: { success: true }, error: null });

    const res = await request(buildApp(ADMIN))
      .post('/api/v1/org/sub-orgs/offboard')
      .send({ childOrgId: CHILD });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ reclaimed: 0, suspended: true });
    expect(rpc()).toHaveBeenCalledTimes(1);
    expect(rpc().mock.calls[0][0]).toBe('suspend_suborg');
  });

  it('does NOT suspend when the reclaim fails', async () => {
    // Suspending anyway would strand the parent's credits inside an org nobody
    // can act in.
    mockDb({ childBalance: 40 });
    rpc().mockResolvedValueOnce({ data: { error: 'not_a_sub_org' }, error: null });

    const res = await request(buildApp(ADMIN))
      .post('/api/v1/org/sub-orgs/offboard')
      .send({ childOrgId: CHILD });

    // not_a_sub_org is a 404 in CREDIT_RPC_STATUS — the child named does not
    // stand in the claimed relationship, which is a missing thing, not a
    // conflicting one.
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_a_sub_org');
    expect(rpc()).toHaveBeenCalledTimes(1);
  });

  it('reports the partial state when reclaim succeeds but suspend fails', async () => {
    mockDb({ childBalance: 40 });
    rpc()
      .mockResolvedValueOnce({ data: { success: true, parent_balance: 140, child_balance: 0 }, error: null })
      .mockResolvedValueOnce({ data: { success: false, error: 'parent_admin_required' }, error: null });

    const res = await request(buildApp(ADMIN))
      .post('/api/v1/org/sub-orgs/offboard')
      .send({ childOrgId: CHILD });

    // The caller must learn the credits DID move — retrying is safe, but only
    // if they know the reclaim already happened.
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'parent_admin_required', reclaimed: 40, suspended: false });
  });

  it('503s when the balance cannot be read, without moving anything', async () => {
    mockDb({ balanceError: true });
    const res = await request(buildApp(ADMIN))
      .post('/api/v1/org/sub-orgs/offboard')
      .send({ childOrgId: CHILD });
    expect(res.status).toBe(503);
    expect(rpc()).not.toHaveBeenCalled();
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
