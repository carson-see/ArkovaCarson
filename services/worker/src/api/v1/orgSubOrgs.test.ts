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

  it('approves a pending affiliate without enforcing historical max_sub_orgs caps', async () => {
    const membership = makeBuilder({
      maybeSingleData: { org_id: 'parent-1', role: 'owner' },
    });
    const childFetch = makeBuilder({
      singleData: {
        id: 'child-1',
        parent_org_id: 'parent-1',
        parent_approval_status: 'PENDING',
        display_name: 'Child A',
      },
    });
    const approveUpdate = makeBuilder();
    const auditInsert = makeBuilder();
    const orgBuilders = [childFetch, approveUpdate];

    vi.mocked(db.from).mockImplementation((table: string): never => {
      if (table === 'org_members') return membership as unknown as never;
      if (table === 'organizations') return orgBuilders.shift() as unknown as never;
      if (table === 'audit_events') return auditInsert as unknown as never;
      return makeBuilder() as unknown as never;
    });

    const app = buildApp('user-1');
    const res = await request(app)
      .post('/api/v1/org/sub-orgs/approve')
      .send({ childOrgId: 'child-1' })
      .expect(200);

    expect(res.body).toEqual({ status: 'APPROVED', childOrgId: 'child-1' });
    expect(approveUpdate.update).toHaveBeenCalledWith(expect.objectContaining({
      parent_approval_status: 'APPROVED',
    }));
    expect(orgBuilders).toHaveLength(0);
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
    const childCreate = makeBuilder({ singleData: childOrgRow });
    const memberInsert = makeBuilder();
    const creditInsert = makeBuilder();
    const inviteInsert = makeBuilder({ singleData: { id: 'invite-1' } });
    const auditInsert = options.auditInsert ?? makeBuilder();
    const cleanupDelete = makeBuilder();
    const orgBuilders = [parentOrg, childCreate, cleanupDelete];
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

  it('500s and cleans up the child org when creation audit fails', async () => {
    const auditInsert = {
      ...makeBuilder(),
      insert: vi.fn(async () => ({ data: null, error: { message: 'audit unavailable' } })),
    };
    const { cleanupDelete } = setupCreateRouteDb({ auditInsert });

    const app = buildApp(userId);
    const res = await request(app)
      .post('/api/v1/org/sub-orgs/create')
      .send(validBody)
      .expect(500);

    expect(res.body.error).toContain('audit');
    expect(cleanupDelete.delete).toHaveBeenCalled();
    expect(cleanupDelete.eq).toHaveBeenCalledWith('id', childOrgId);
  });
});
