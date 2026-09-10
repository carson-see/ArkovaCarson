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
import { readFileSync } from 'node:fs';

vi.mock('../../utils/db.js', () => ({
  db: { from: vi.fn() },
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
import { sendEmail } from '../../email/sender.js';
import { buildInvitationEmail } from '../../email/templates.js';
import { buildApp as buildAppFromRouter, makeBuilder } from './__testHelpers.js';

/**
 * Seed for the sub-org cap's child lookup.
 *
 * The cap no longer asks PostgREST for an exact count (R0-8 / SCRUM-1254): it
 * does `.select('id').eq(...).eq(...)` and awaits that chain directly. With no
 * `{ count }` option, `makeBuilder`'s countChain never engages and awaiting the
 * plain builder yields the builder itself — which reads as "unavailable" and
 * fails the cap CLOSED. This gives the chain a terminal that resolves to N
 * approved children. Deliberately local rather than making every builder's
 * `.eq()` awaitable, which the note in makeBuilder records as having broken
 * unrelated create/approve chains.
 */
function capChildrenBuilder(approved: number) {
  const rows = Array.from({ length: approved }, (_unused, i) => ({ id: `child-${i}` }));
  const chain: Record<string, unknown> = {};
  chain.eq = () => chain;
  chain.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data: rows, error: null }).then(resolve);
  return { select: () => chain };
}


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

const actionParentOrgId = '22222222-2222-4222-8222-222222222222';
const actionChildOrgId = '44444444-4444-4444-8444-444444444444';

function setupActionRouteDb(options: {
  role: 'owner' | 'admin' | 'member';
  childStatus: 'PENDING' | 'APPROVED' | 'REVOKED' | null;
  interleavedParent?: string;
  interleavedStatus?: 'PENDING' | 'APPROVED' | 'REVOKED';
  /** D3 sub-org cap inputs, used only on the APPROVE path. */
  maxSubOrgs?: number | null;
  approvedCount?: number;
  writeError?: { code: string; message: string };
}) {
  const membership = makeBuilder({
    maybeSingleData: { org_id: actionParentOrgId, role: options.role },
  });
  const childFetch = makeBuilder({
    singleData: {
      id: actionChildOrgId,
      parent_org_id: actionParentOrgId,
      parent_approval_status: options.childStatus,
      display_name: 'Child A',
    },
  });
  const statusUpdate = makeBuilder();
  const writeState = {
    row: { id: actionChildOrgId, parent_org_id: options.interleavedParent ?? actionParentOrgId,
      parent_approval_status: options.interleavedStatus ?? options.childStatus },
    writes: 0,
  };
  const filters: Record<string, unknown> = {};
  const filter = (key: string, value: unknown) => { filters[key] = value; return statusUpdate; };
  statusUpdate.eq.mockImplementation(filter);
  statusUpdate.is.mockImplementation(filter);
  const apply = () => {
    if (options.writeError) return { data: null, error: options.writeError };
    if (!Object.entries(filters).every(([key, value]) =>
      writeState.row[key as keyof typeof writeState.row] === value)) return { data: null, error: null };
    writeState.writes += 1;
    writeState.row.parent_approval_status = statusUpdate.update.mock.calls[0][0].parent_approval_status;
    return { data: { id: actionChildOrgId }, error: null };
  };
  statusUpdate.maybeSingle.mockImplementation(async () => apply());
  Object.assign(statusUpdate, { then: (resolve: (value: unknown) => unknown) => Promise.resolve(apply()).then(resolve) });
  const auditInsert = makeBuilder();
  // D3: APPROVE now checks the sub-org cap before flipping the status — two
  // more `from('organizations')` calls, and this list is a queue. REVOKE never
  // adds a sub-org, so it does not consult the cap and needs no extra builders.
  const capBuilders = options.childStatus === 'PENDING' || options.childStatus === null
    ? [makeBuilder({ maybeSingleData: { max_sub_orgs: options.maxSubOrgs ?? null } }),
       capChildrenBuilder(options.approvedCount ?? 0) as unknown as ReturnType<typeof makeBuilder>]
    : [];
  const orgBuilders = [childFetch, ...capBuilders, statusUpdate];

  vi.mocked(db.from).mockImplementation((table: string): never => {
    if (table === 'org_members') return membership as unknown as never;
    if (table === 'organizations') return orgBuilders.shift() as unknown as never;
    if (table === 'audit_events') return auditInsert as unknown as never;
    return makeBuilder() as unknown as never;
  });

  return { membership, orgBuilders, statusUpdate, auditInsert, writeState };
}

const affiliateStatusCases = [
  {
    label: 'approves a pending affiliate when the sub-org cap has room',
    path: '/api/v1/org/sub-orgs/approve',
    role: 'owner',
    childStatus: 'PENDING',
    resultStatus: 'APPROVED',
  },
  {
    label: 'revokes an approved affiliate with explicit parent org scope',
    path: '/api/v1/org/sub-orgs/revoke',
    role: 'admin',
    childStatus: 'APPROVED',
    resultStatus: 'REVOKED',
  },
] as const;

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
      .send({ childOrgId: actionChildOrgId })
      .expect(401);
  });

  it('400s when approve request identifiers are malformed', async () => {
    const app = buildApp('user-1');
    const res = await request(app)
      .post('/api/v1/org/sub-orgs/approve')
      .send({ childOrgId: 'child-1', parentOrgId: 'parent-1' })
      .expect(400);

    expect(res.body.error).toContain('Invalid');
    expect(db.from).not.toHaveBeenCalled();
  });

  it('403s when caller is not org admin', async () => {
    vi.mocked(db.from).mockImplementation((): never =>
      makeBuilder({
        maybeSingleData: { org_id: actionParentOrgId, role: 'member' },
      }) as unknown as never,
    );
    const app = buildApp('user-1');
    const res = await request(app)
      .post('/api/v1/org/sub-orgs/approve')
      .send({ childOrgId: actionChildOrgId })
      .expect(403);
    expect(res.body.error).toBeDefined();
  });
});

describe('POST /api/v1/org/sub-orgs/revoke (HAKI-REQ-01)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('400s when revoke request identifiers are malformed', async () => {
    const app = buildApp('user-1');
    const res = await request(app)
      .post('/api/v1/org/sub-orgs/revoke')
      .send({ childOrgId: 'child-1', parentOrgId: 'parent-1' })
      .expect(400);

    expect(res.body.error).toContain('Invalid');
    expect(db.from).not.toHaveBeenCalled();
  });
});

describe('parent-scoped affiliate status actions (HAKI-REQ-01)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it.each(affiliateStatusCases)('$label', async ({ path, role, childStatus, resultStatus }) => {
    const { membership, orgBuilders, statusUpdate } = setupActionRouteDb({
      role,
      childStatus,
    });

    const app = buildApp('user-1');
    const res = await request(app)
      .post(path)
      .send({ childOrgId: actionChildOrgId, parentOrgId: actionParentOrgId })
      .expect(200);

    expect(res.body).toEqual({ status: resultStatus, childOrgId: actionChildOrgId });
    expect(membership.eq).toHaveBeenCalledWith('org_id', actionParentOrgId);
    expect(statusUpdate.update).toHaveBeenCalledWith(expect.objectContaining({
      parent_approval_status: resultStatus,
    }));
    expect(orgBuilders).toHaveLength(0);
  });

  it('refuses to approve once the sub-org cap is reached', async () => {
    // The cap must bind on BOTH paths that add a sub-org. Enforcing only on
    // create would leave a limit you can walk around by asking to be
    // affiliated instead of being created.
    setupActionRouteDb({ role: 'owner', childStatus: 'PENDING', maxSubOrgs: 20, approvedCount: 20 });

    const app = buildApp('user-1');
    const res = await request(app)
      .post('/api/v1/org/sub-orgs/approve')
      .send({ childOrgId: actionChildOrgId, parentOrgId: actionParentOrgId })
      .expect(409);

    expect(res.body.error).toMatch(/limit reached/i);
  });

  it.each([
    [{ code: '23514', message: 'sub_org_limit_reached' }, 409, 'sub_org_limit_reached'],
    [{ code: '55P03', message: 'lock timeout' }, 503, 'cap_check_unavailable'],
    [{ code: '40001', message: 'serialization failure' }, 503, 'cap_check_unavailable'],
    [{ code: '40P01', message: 'deadlock detected' }, 503, 'cap_check_unavailable'],
    [{ code: '23514', message: 'unrelated_check' }, 500, 'Failed to approve organization'],
  ] as const)('maps a post-preflight approval write failure %j to %i', async (writeError, status, error) => {
    const { auditInsert } = setupActionRouteDb({ role: 'owner', childStatus: 'PENDING', approvedCount: 0, writeError });
    const res = await request(buildApp('user-1'))
      .post('/api/v1/org/sub-orgs/approve')
      .send({ childOrgId: actionChildOrgId, parentOrgId: actionParentOrgId })
      .expect(status);
    expect(res.body.error).toBe(error);
    expect(auditInsert.insert).not.toHaveBeenCalled();
  });

  it.each([
    { path: 'approve', childStatus: 'PENDING', interleavedParent: '55555555-5555-4555-8555-555555555555' },
    { path: 'approve', childStatus: 'PENDING', interleavedStatus: 'REVOKED' },
    { path: 'revoke', childStatus: 'APPROVED', interleavedParent: '55555555-5555-4555-8555-555555555555' },
    { path: 'revoke', childStatus: 'APPROVED', interleavedStatus: 'PENDING' },
  ] as const)('refuses a relationship changed between lookup and $path: $interleavedParent $interleavedStatus', async ({ path, ...options }) => {
    const { writeState, auditInsert } = setupActionRouteDb({ role: 'owner', ...options });
    const before = { ...writeState.row };
    const res = await request(buildApp('user-1'))
      .post(`/api/v1/org/sub-orgs/${path}`)
      .send({ childOrgId: actionChildOrgId, parentOrgId: actionParentOrgId }).expect(409);
    expect(res.body.error).toBe('Affiliation changed. Refresh and try again.');
    expect(writeState.row).toEqual(before);
    expect(writeState.writes).toBe(0);
    expect(auditInsert.insert).not.toHaveBeenCalled();
  });

  it('approves a legacy null status with a null-aware write predicate', async () => {
    const { statusUpdate, writeState } = setupActionRouteDb({ role: 'owner', childStatus: null });
    await request(buildApp('user-1')).post('/api/v1/org/sub-orgs/approve')
      .send({ childOrgId: actionChildOrgId, parentOrgId: actionParentOrgId }).expect(200);
    expect(statusUpdate.is).toHaveBeenCalledWith('parent_approval_status', null);
    expect(writeState.row.parent_approval_status).toBe('APPROVED');
  });

  it('still approves when an explicit override leaves room above the default', async () => {
    setupActionRouteDb({ role: 'owner', childStatus: 'PENDING', maxSubOrgs: 50, approvedCount: 30 });
    const app = buildApp('user-1');
    await request(app)
      .post('/api/v1/org/sub-orgs/approve')
      .send({ childOrgId: actionChildOrgId, parentOrgId: actionParentOrgId })
      .expect(200);
  });
});

describe('POST /api/v1/org/sub-orgs/create (HAKI-REQ-01)', () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  const parentOrgId = '22222222-2222-4222-8222-222222222222';
  const adminUserId = '33333333-3333-4333-8333-333333333333';
  const childOrgId = '44444444-4444-4444-8444-444444444444';
  const validBody = {
    parentOrgId,
    displayName: 'Affiliate Legal Aid',
    legalName: 'Affiliate Legal Aid LLC',
    domain: 'affiliate.example',
    adminEmail: 'admin@affiliate.example',
  };
  const childOrgRow = {
    id: childOrgId,
    display_name: 'Affiliate Legal Aid',
    domain: 'affiliate.example',
    verification_status: 'UNVERIFIED',
    parent_approval_status: 'APPROVED',
    created_at: '2026-05-05T13:00:00.000Z',
    logo_url: null,
  };
  const existingAdminProfile = {
    id: adminUserId,
    email: 'admin@affiliate.example',
    full_name: 'Affiliate Admin',
  };

  function setupCreateRouteDb(options: {
    role?: 'owner' | 'admin' | 'member';
    parentStatus?: string;
    adminProfile?: typeof existingAdminProfile | null;
    auditInsert?: ReturnType<typeof makeBuilder>;
    writeError?: { code: string; message: string };
  } = {}) {
    const membership = makeBuilder({
      maybeSingleData: { org_id: parentOrgId, role: options.role ?? 'owner' },
    });
    const parentOrg = makeBuilder({
      singleData: {
        id: parentOrgId,
        display_name: 'Parent Org',
        verification_status: options.parentStatus ?? 'VERIFIED',
        parent_org_id: null,
      },
    });
    const profile = makeBuilder({
      maybeSingleData: options.adminProfile === undefined
        ? existingAdminProfile
        : options.adminProfile,
    });
    const childCreate = makeBuilder({ singleData: options.writeError ? null : childOrgRow, singleError: options.writeError });
    const memberInsert = makeBuilder();
    const creditInsert = makeBuilder();
    const inviteInsert = makeBuilder({ singleData: { id: 'invite-1' } });
    const auditInsert = options.auditInsert ?? makeBuilder();
    const cleanupDelete = makeBuilder();
    // D3: the create route now consults the sub-org cap between resolving the
    // parent context and creating the child — two more `from('organizations')`
    // calls. This list is a QUEUE, so they must be seeded in call order or the
    // child-create shifts the wrong builder and returns no row.
    const capLimit = makeBuilder({ maybeSingleData: { max_sub_orgs: null } });
    const capCount = capChildrenBuilder(0) as unknown as ReturnType<typeof makeBuilder>;
    const orgBuilders = [parentOrg, capLimit, capCount, childCreate, cleanupDelete];
    const orgMemberBuilders = [membership, memberInsert];

    vi.mocked(db.from).mockImplementation((table: string): never => {
      if (table === 'org_members') return (orgMemberBuilders.shift() ?? makeBuilder()) as unknown as never;
      if (table === 'organizations') return (orgBuilders.shift() ?? makeBuilder()) as unknown as never;
      if (table === 'profiles') return profile as unknown as never;
      if (table === 'org_credits') return creditInsert as unknown as never;
      if (table === 'invitations') return inviteInsert as unknown as never;
      if (table === 'audit_events') return auditInsert as unknown as never;
      return makeBuilder() as unknown as never;
    });

    return {
      childCreate,
      memberInsert,
      creditInsert,
      inviteInsert,
      auditInsert,
      cleanupDelete,
    };
  }

  it.each([
    [{ code: '23514', message: 'sub_org_limit_reached' }, 409, 'sub_org_limit_reached'],
    [{ code: '55P03', message: 'lock timeout' }, 503, 'cap_check_unavailable'],
    [{ code: '40001', message: 'serialization failure' }, 503, 'cap_check_unavailable'],
    [{ code: '40P01', message: 'deadlock detected' }, 503, 'cap_check_unavailable'],
    [{ code: '23514', message: 'unrelated_check' }, 500, 'Failed to create affiliate organization'],
  ] as const)('maps a post-preflight create write failure %j to %i', async (writeError, status, error) => {
    const calls = setupCreateRouteDb({ writeError });
    const res = await request(buildApp(userId)).post('/api/v1/org/sub-orgs/create').send(validBody).expect(status);
    expect(res.body.error).toBe(error);
    expect(calls.memberInsert.insert).not.toHaveBeenCalled();
    expect(calls.creditInsert.insert).not.toHaveBeenCalled();
    expect(calls.auditInsert.insert).not.toHaveBeenCalled();
  });

  beforeEach(() => { vi.clearAllMocks(); });

  it('401s when no userId on request', async () => {
    const app = buildApp();
    await request(app)
      .post('/api/v1/org/sub-orgs/create')
      .send(validBody)
      .expect(401);
  });

  it('400s when required affiliate details are missing', async () => {
    const app = buildApp(userId);
    const res = await request(app)
      .post('/api/v1/org/sub-orgs/create')
      .send({ parentOrgId, displayName: 'Affiliate Legal Aid' })
      .expect(400);

    expect(res.body.error).toContain('Invalid');
  });

  it('403s when caller is not an admin of the selected parent org', async () => {
    setupCreateRouteDb({ role: 'member' });

    const app = buildApp(userId);
    const res = await request(app)
      .post('/api/v1/org/sub-orgs/create')
      .send(validBody)
      .expect(403);

    expect(res.body.error).toBeDefined();
  });

  it('400s when the selected parent org is not verified', async () => {
    setupCreateRouteDb({ parentStatus: 'PENDING' });

    const app = buildApp(userId);
    const res = await request(app)
      .post('/api/v1/org/sub-orgs/create')
      .send(validBody)
      .expect(400);

    expect(res.body.error).toContain('verified');
  });

  it('creates a pending affiliate admin invitation when the admin is not an existing Arkova user', async () => {
    const { memberInsert, inviteInsert } = setupCreateRouteDb({ adminProfile: null });

    const app = buildApp(userId);
    const res = await request(app)
      .post('/api/v1/org/sub-orgs/create')
      .send(validBody)
      .expect(201);

    expect(res.body.affiliateAdmin).toEqual({
      status: 'invited',
      id: null,
      email: 'admin@affiliate.example',
      fullName: null,
      invitationId: 'invite-1',
      invitationEmailSent: true,
    });
    expect(memberInsert.insert).toHaveBeenCalledWith([
      expect.objectContaining({
        user_id: userId,
        org_id: childOrgId,
        role: 'owner',
      }),
    ]);
    expect(inviteInsert.insert).toHaveBeenCalledWith(expect.objectContaining({
      email: 'admin@affiliate.example',
      role: 'ORG_ADMIN',
      org_id: childOrgId,
      invited_by: userId,
    }));
    expect(buildInvitationEmail).toHaveBeenCalledWith(expect.objectContaining({
      recipientEmail: 'admin@affiliate.example',
      organizationName: 'Affiliate Legal Aid',
      role: 'ORG_ADMIN',
      inviteUrl: `https://app.test/login?invite=true&org=${childOrgId}`,
    }));
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'admin@affiliate.example',
      emailType: 'invitation',
      actorId: userId,
      orgId: childOrgId,
    }));
  });

  it('keeps affiliate creation successful when invitation email rendering throws', async () => {
    vi.mocked(buildInvitationEmail).mockImplementationOnce(() => {
      throw new Error('template unavailable');
    });
    setupCreateRouteDb({ adminProfile: null });

    const app = buildApp(userId);
    const res = await request(app)
      .post('/api/v1/org/sub-orgs/create')
      .send(validBody)
      .expect(201);

    expect(res.body.affiliateAdmin).toEqual(expect.objectContaining({
      status: 'invited',
      invitationId: 'invite-1',
      invitationEmailSent: false,
    }));
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('creates an approved affiliate with isolated child memberships, credits, and audit event', async () => {
    const {
      childCreate,
      memberInsert,
      creditInsert,
      auditInsert,
    } = setupCreateRouteDb();

    const app = buildApp(userId);
    const res = await request(app)
      .post('/api/v1/org/sub-orgs/create')
      .send(validBody)
      .expect(201);

    expect(res.body.affiliateOrg.id).toBe(childOrgId);
    expect(res.body.affiliateAdmin).toEqual({
      status: 'assigned',
      id: adminUserId,
      email: 'admin@affiliate.example',
      fullName: 'Affiliate Admin',
    });
    expect(childCreate.insert).toHaveBeenCalledWith(expect.objectContaining({
      display_name: 'Affiliate Legal Aid',
      legal_name: 'Affiliate Legal Aid LLC',
      domain: 'affiliate.example',
      verification_status: 'UNVERIFIED',
      parent_org_id: parentOrgId,
      parent_approval_status: 'APPROVED',
    }));
    expect(memberInsert.insert).toHaveBeenCalledWith([
      expect.objectContaining({
        user_id: userId,
        org_id: childOrgId,
        role: 'owner',
      }),
      expect.objectContaining({
        user_id: adminUserId,
        org_id: childOrgId,
        role: 'admin',
      }),
    ]);
    expect(creditInsert.insert).toHaveBeenCalledWith({ org_id: childOrgId });
    expect(auditInsert.insert).toHaveBeenCalledWith(expect.objectContaining({
      actor_id: userId,
      event_type: 'SUB_ORG_CREATED',
      target_id: childOrgId,
      org_id: parentOrgId,
    }));
  });

  it('500s and cleans up the child org when creation audit fails after dependent rows are inserted', async () => {
    const auditInsert = {
      ...makeBuilder(),
      insert: vi.fn(async () => ({ data: null, error: { message: 'audit unavailable' } })),
    };
    const {
      cleanupDelete,
      memberInsert,
      creditInsert,
      inviteInsert,
    } = setupCreateRouteDb({ auditInsert, adminProfile: null });

    const app = buildApp(userId);
    const res = await request(app)
      .post('/api/v1/org/sub-orgs/create')
      .send(validBody)
      .expect(500);

    expect(res.body.error).toContain('audit');
    expect(memberInsert.insert).toHaveBeenCalled();
    expect(creditInsert.insert).toHaveBeenCalled();
    expect(inviteInsert.insert).toHaveBeenCalled();
    expect(cleanupDelete.delete).toHaveBeenCalled();
    expect(cleanupDelete.eq).toHaveBeenCalledWith('id', childOrgId);
  });

  it('documents organization-delete cascades for affiliate cleanup dependencies', () => {
    // After SCRUM-1668 Path C, individual migrations 0013/0087/0278 are
    // collapsed into the byte-faithful pg_dump baseline. The CASCADE
    // constraints survive in the dump but are emitted as `ALTER TABLE …
    // ADD CONSTRAINT … FOREIGN KEY … ON DELETE CASCADE` rather than as
    // an inline column-level REFERENCES clause. Match either form.
    const baseline = readFileSync(
      new URL('../../../../../supabase/migrations/00000000000000_baseline_at_main_HEAD.sql', import.meta.url),
      'utf8',
    );

    // Inline form (hand-written CREATE TABLE column): `org_id uuid ... REFERENCES organizations(id) ON DELETE CASCADE`
    // pg_dump form: `ALTER TABLE ONLY "public"."<tbl>" ADD CONSTRAINT … FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE`
    const cascadeOnOrgIdFor = (table: string): RegExp =>
      new RegExp(
        // Either inline column REFERENCES on the right table, or the pg_dump
        // ALTER TABLE on this specific table referencing organizations(id).
        `(?:org_id\\s+uuid\\b[^,]*REFERENCES\\s+(?:"?public"?\\.)?"?organizations"?\\("?id"?\\)\\s+ON\\s+DELETE\\s+CASCADE` +
          `|ALTER\\s+TABLE\\s+(?:ONLY\\s+)?"public"\\."${table}"[\\s\\S]*?FOREIGN\\s+KEY\\s*\\(\\s*"?org_id"?\\s*\\)[\\s\\S]*?REFERENCES\\s+"public"\\."organizations"\\s*\\(\\s*"?id"?\\s*\\)[\\s\\S]*?ON\\s+DELETE\\s+CASCADE)`,
        'i',
      );

    expect(baseline).toMatch(cascadeOnOrgIdFor('org_members'));
    expect(baseline).toMatch(cascadeOnOrgIdFor('org_credits'));
    expect(baseline).toMatch(cascadeOnOrgIdFor('invitations'));
  });
});
