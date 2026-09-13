import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockIsPlatformAdmin, mockDbFrom, mockLogger, mockSendEmail, mockBuildInvitationEmail, mockBuildInviteAcceptUrl } = vi.hoisted(() => ({
  mockIsPlatformAdmin: vi.fn(),
  mockDbFrom: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  mockSendEmail: vi.fn(),
  mockBuildInvitationEmail: vi.fn(() => ({ subject: 'trusted subject', html: '<p>trusted body</p>' })),
  mockBuildInviteAcceptUrl: vi.fn(() => 'https://app.arkova.test/accept-invite?token=trusted-token'),
}));

vi.mock('../utils/platformAdmin.js', () => ({ isPlatformAdmin: mockIsPlatformAdmin }));
vi.mock('../utils/db.js', () => ({ db: { from: mockDbFrom } }));
vi.mock('../utils/logger.js', () => ({ logger: mockLogger }));
vi.mock('../email/sender.js', () => ({ sendEmail: mockSendEmail }));
vi.mock('../email/templates.js', () => ({ buildInvitationEmail: mockBuildInvitationEmail }));
vi.mock('../lib/urls.js', () => ({ buildInviteAcceptUrl: mockBuildInviteAcceptUrl }));

import type { Request, Response } from 'express';
import { handleAdminCreateInvitation } from './admin-invitations.js';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_ID = '22222222-2222-4222-8222-222222222222';
const IDEMPOTENCY_KEY = '33333333-3333-4333-8333-333333333333';
const INVITATION = {
  id: IDEMPOTENCY_KEY,
  email: 'member@example.com',
  role: 'ORG_ADMIN',
  org_id: ORG_ID,
  invited_by: ACTOR_ID,
  status: 'pending',
  token: '44444444-4444-4444-8444-444444444444',
  expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
};

function chain(result: { data?: unknown; error?: unknown }) {
  const value: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'insert']) value[method] = vi.fn(() => value);
  value.maybeSingle = vi.fn(async () => result);
  value.single = vi.fn(async () => result);
  (value as { then: unknown }).then = (
    resolve: (input: unknown) => unknown,
    reject?: (reason: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  return value;
}

function req(body: Record<string, unknown>): Request {
  return { body } as Request;
}

function response(): Response & { statusCode: number; body: unknown } {
  const res = {
    statusCode: 200,
    body: null as unknown,
    status(code: number) { res.statusCode = code; return res; },
    json(body: unknown) { res.body = body; return res; },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    email: ' MEMBER@Example.com ',
    role: 'ORG_ADMIN',
    idempotency_key: IDEMPOTENCY_KEY,
    ...overrides,
  };
}

describe('handleAdminCreateInvitation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsPlatformAdmin.mockResolvedValue(true);
    mockSendEmail.mockResolvedValue({ success: true, messageId: 'email-1' });
  });

  it('fails closed before DB access for a non-platform-admin', async () => {
    mockIsPlatformAdmin.mockResolvedValue(false);
    const res = response();
    await handleAdminCreateInvitation(ACTOR_ID, ORG_ID, req(validBody()), res);
    expect(res.statusCode).toBe(403);
    expect(mockDbFrom).not.toHaveBeenCalled();
  });

  it('rejects malformed input before DB access', async () => {
    const res = response();
    await handleAdminCreateInvitation(ACTOR_ID, ORG_ID, req(validBody({ idempotency_key: 'retry-1' })), res);
    expect(res.statusCode).toBe(400);
    expect(mockDbFrom).not.toHaveBeenCalled();
  });

  it('creates the selected-org invitation and emails only trusted row values', async () => {
    const orgQuery = chain({ data: { id: ORG_ID, display_name: 'PlanBook Trusted' }, error: null });
    const actorQuery = chain({ data: { full_name: 'Trusted Admin' }, error: null });
    const insertQuery = chain({ data: INVITATION, error: null });
    const auditQuery = chain({ error: null });
    mockDbFrom.mockImplementation((table: string) => {
      if (table === 'organizations') return orgQuery;
      if (table === 'profiles') return actorQuery;
      if (table === 'invitations') return insertQuery;
      if (table === 'audit_events') return auditQuery;
      throw new Error(`unexpected table ${table}`);
    });

    const res = response();
    await handleAdminCreateInvitation(ACTOR_ID, ORG_ID, req(validBody({ orgName: 'Spoofed', inviterName: 'Spoofed' })), res);

    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual({ sent: true, invitationId: IDEMPOTENCY_KEY, replayed: false });
    expect(insertQuery.insert).toHaveBeenCalledWith(expect.objectContaining({
      id: IDEMPOTENCY_KEY,
      email: 'member@example.com',
      role: 'ORG_ADMIN',
      org_id: ORG_ID,
      invited_by: ACTOR_ID,
    }));
    expect(mockBuildInvitationEmail).toHaveBeenCalledWith({
      recipientEmail: 'member@example.com',
      organizationName: 'PlanBook Trusted',
      inviterName: 'Trusted Admin',
      role: 'ORG_ADMIN',
      inviteUrl: 'https://app.arkova.test/accept-invite?token=trusted-token',
    });
    expect(mockSendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'member@example.com',
      emailType: 'invitation',
      orgId: ORG_ID,
      actorId: ACTOR_ID,
      idempotencyKey: `invitation/${IDEMPOTENCY_KEY}`,
    }));
  });

  it('reuses the committed row after a concurrent duplicate-key insert', async () => {
    const queues = new Map<string, ReturnType<typeof chain>[]>([
      ['organizations', [chain({ data: { id: ORG_ID, display_name: 'PlanBook Trusted' }, error: null })]],
      ['profiles', [
        chain({ data: { full_name: null }, error: null }),
        chain({ data: null, error: null }),
      ]],
      ['invitations', [
        chain({ data: null, error: { code: '23505', message: 'duplicate key' } }),
        chain({ data: INVITATION, error: null }),
      ]],
    ]);
    mockDbFrom.mockImplementation((table: string) => queues.get(table)?.shift() ?? (() => { throw new Error(`unexpected table ${table}`); })());

    const res = response();
    await handleAdminCreateInvitation(ACTOR_ID, ORG_ID, req(validBody()), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ sent: true, invitationId: IDEMPOTENCY_KEY, replayed: true });
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });

  it('rejects reuse of an idempotency key for different invitation data', async () => {
    const queues = new Map<string, ReturnType<typeof chain>[]>([
      ['organizations', [chain({ data: { id: ORG_ID, display_name: 'PlanBook Trusted' }, error: null })]],
      ['profiles', [
        chain({ data: { full_name: null }, error: null }),
        chain({ data: null, error: null }),
      ]],
      ['invitations', [
        chain({ data: null, error: { code: '23505', message: 'duplicate key' } }),
        chain({ data: { ...INVITATION, email: 'different@example.com' }, error: null }),
      ]],
    ]);
    mockDbFrom.mockImplementation((table: string) => queues.get(table)?.shift() ?? (() => { throw new Error(`unexpected table ${table}`); })());

    const res = response();
    await handleAdminCreateInvitation(ACTOR_ID, ORG_ID, req(validBody()), res);
    expect(res.statusCode).toBe(409);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('rejects an address that is already a member of the selected organization', async () => {
    const queues = new Map<string, ReturnType<typeof chain>[]>([
      ['organizations', [chain({ data: { id: ORG_ID, display_name: 'PlanBook Trusted' }, error: null })]],
      ['profiles', [
        chain({ data: { full_name: 'Trusted Admin' }, error: null }),
        chain({ data: { id: 'existing-user', org_id: 'another-home-org' }, error: null }),
      ]],
      ['org_members', [chain({ data: { id: 'existing-membership' }, error: null })]],
    ]);
    mockDbFrom.mockImplementation((table: string) => queues.get(table)?.shift() ?? (() => { throw new Error(`unexpected table ${table}`); })());

    const res = response();
    await handleAdminCreateInvitation(ACTOR_ID, ORG_ID, req(validBody()), res);
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ code: 'already_member', error: 'This person is already a member of the organization.' });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('allows an existing account from another home org without changing its profile', async () => {
    const profileLookup = chain({ data: { id: 'existing-user', org_id: 'home-org' }, error: null });
    const queues = new Map<string, ReturnType<typeof chain>[]>([
      ['organizations', [chain({ data: { id: ORG_ID, display_name: 'PlanBook Trusted' }, error: null })]],
      ['profiles', [
        chain({ data: { full_name: 'Trusted Admin' }, error: null }),
        profileLookup,
      ]],
      ['org_members', [chain({ data: null, error: null })]],
      ['invitations', [chain({ data: INVITATION, error: null })]],
      ['audit_events', [chain({ error: null })]],
    ]);
    mockDbFrom.mockImplementation((table: string) => queues.get(table)?.shift() ?? (() => { throw new Error(`unexpected table ${table}`); })());

    const res = response();
    await handleAdminCreateInvitation(ACTOR_ID, ORG_ID, req(validBody()), res);
    expect(res.statusCode).toBe(201);
    expect(mockDbFrom).not.toHaveBeenCalledWith('profiles', expect.anything());
    expect((profileLookup as { update?: unknown }).update).toBeUndefined();
  });

  it('reports delivery failure truthfully while preserving the retryable invitation row', async () => {
    mockSendEmail.mockResolvedValue({ success: false, error: 'provider unavailable' });
    const queues = new Map<string, ReturnType<typeof chain>[]>([
      ['organizations', [chain({ data: { id: ORG_ID, display_name: 'PlanBook Trusted' }, error: null })]],
      ['profiles', [
        chain({ data: { full_name: null }, error: null }),
        chain({ data: null, error: null }),
      ]],
      ['invitations', [chain({ data: INVITATION, error: null })]],
      ['audit_events', [chain({ error: null })]],
    ]);
    mockDbFrom.mockImplementation((table: string) => queues.get(table)?.shift() ?? (() => { throw new Error(`unexpected table ${table}`); })());

    const res = response();
    await handleAdminCreateInvitation(ACTOR_ID, ORG_ID, req(validBody()), res);
    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({
      sent: false,
      created: true,
      code: 'email_delivery_failed',
      error: 'Invitation was created, but email delivery could not be confirmed.',
    });
  });

  it('fails honestly when a replay payload changed after the provider idempotency claim', async () => {
    mockSendEmail.mockResolvedValue({ success: false, error: 'invalid_idempotent_request' });
    const queues = new Map<string, ReturnType<typeof chain>[]>([
      ['organizations', [chain({ data: { id: ORG_ID, display_name: 'PlanBook Renamed' }, error: null })]],
      ['profiles', [
        chain({ data: { full_name: 'Renamed Admin' }, error: null }),
        chain({ data: null, error: null }),
      ]],
      ['invitations', [
        chain({ data: null, error: { code: '23505', message: 'duplicate key' } }),
        chain({ data: INVITATION, error: null }),
      ]],
    ]);
    mockDbFrom.mockImplementation((table: string) => queues.get(table)?.shift() ?? (() => { throw new Error(`unexpected table ${table}`); })());

    const res = response();
    await handleAdminCreateInvitation(ACTOR_ID, ORG_ID, req(validBody()), res);
    expect(res.statusCode).toBe(502);
    expect((res.body as { sent: boolean }).sent).toBe(false);
  });
});
