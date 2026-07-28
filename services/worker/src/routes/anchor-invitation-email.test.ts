import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

const { mockExtractAuthUserId, mockFrom, mockSendEmail, mockLogger } = vi.hoisted(() => ({
  mockExtractAuthUserId: vi.fn(),
  mockFrom: vi.fn(),
  mockSendEmail: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('./middleware.js', () => ({
  corsMiddleware: (_req: Request, _res: Response, next: NextFunction) => next(),
  extractAuthUserId: mockExtractAuthUserId,
}));

vi.mock('../utils/rateLimit.js', () => ({
  rateLimiters: {
    checkout: (_req: Request, _res: Response, next: NextFunction) => next(),
    auth: (_req: Request, _res: Response, next: NextFunction) => next(),
  },
}));

vi.mock('../utils/db.js', () => ({
  db: { from: mockFrom },
}));

vi.mock('../utils/logger.js', () => ({ logger: mockLogger }));
vi.mock('../email/sender.js', () => ({ sendEmail: mockSendEmail }));
vi.mock('../config.js', () => ({
  config: {
    frontendUrl: 'https://app.arkova.test',
    corsAllowedOrigins: '',
  },
}));

import { anchorRouter } from './anchor.js';

interface MockResponse {
  statusCode: number;
  body: unknown;
  status(code: number): MockResponse;
  json(payload: unknown): MockResponse;
}

interface RouteLayer {
  route?: {
    path: string;
    stack: Array<{ handle: (req: Request, res: Response) => Promise<void> | void }>;
  };
}

function membershipChain(data: unknown) {
  const chain = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    single: vi.fn(async () => ({ data, error: null })),
    maybeSingle: vi.fn(async () => ({ data, error: null })),
  };
  return chain;
}

function makeRes(): MockResponse {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

function getHandler(path: string): (req: Request, res: Response) => Promise<void> | void {
  const stack = (anchorRouter as unknown as { stack: RouteLayer[] }).stack;
  const layer = stack.find((entry) => entry.route?.path === path);
  if (!layer?.route) throw new Error(`${path} handler not found`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

const handler = getHandler('/send-invitation-email');

async function invoke(body: unknown) {
  const req = {
    body,
    headers: { authorization: 'Bearer token' },
  } as unknown as Request;
  const res = makeRes();
  await handler(req, res as unknown as Response);
  return res;
}

const INVITATION_ROW = { token: 'real-invite-token-uuid', org_id: 'org-1', email: 'invitee@example.com' };

describe('POST /api/send-invitation-email', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExtractAuthUserId.mockResolvedValue('user-1');
    mockSendEmail.mockResolvedValue({ success: true, messageId: 'msg-1' });
    mockFrom.mockImplementation((table: string) => {
      if (table === 'org_members') return membershipChain({ role: 'owner' });
      if (table === 'profiles') return membershipChain(null);
      if (table === 'invitations') return membershipChain(INVITATION_ROW);
      return membershipChain({ role: 'owner' });
    });
  });

  it('authorizes onboarding-created org owner memberships', async () => {
    const res = await invoke({
      email: 'invitee@example.com',
      orgId: 'org-1',
      orgName: 'Example Org',
      role: 'INDIVIDUAL',
      inviterName: 'Carson',
      invitationId: 'invite-id-1',
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ sent: true, messageId: 'msg-1' });
    expect(mockFrom).toHaveBeenCalledWith('org_members');
    expect(mockSendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'invitee@example.com',
      emailType: 'invitation',
      actorId: 'user-1',
      orgId: 'org-1',
    }));
  });

  // SCRUM-3012: root-cause regression test — the link previously dropped the
  // invitation's token entirely (`/login?invite=true&org=...`), so nothing
  // could ever validate an accept. The emailed link must now carry the real
  // per-invitation token via /accept-invite.
  it('embeds the real invitation token in the emailed accept link (SCRUM-3012)', async () => {
    await invoke({
      email: 'invitee@example.com',
      orgId: 'org-1',
      orgName: 'Example Org',
      role: 'INDIVIDUAL',
      inviterName: 'Carson',
      invitationId: 'invite-id-1',
    });

    expect(mockFrom).toHaveBeenCalledWith('invitations');
    const call = mockSendEmail.mock.calls[0]?.[0] as { html: string };
    expect(call.html).toContain('https://app.arkova.test/accept-invite?token=real-invite-token-uuid');
    expect(call.html).not.toContain('/login?invite=true');
  });

  it('rejects the request when invitationId is missing', async () => {
    const res = await invoke({
      email: 'invitee@example.com',
      orgId: 'org-1',
      orgName: 'Example Org',
      role: 'INDIVIDUAL',
    });

    expect(res.statusCode).toBe(400);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('404s when the invitation does not belong to the claimed org (defense in depth)', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'org_members') return membershipChain({ role: 'owner' });
      if (table === 'profiles') return membershipChain(null);
      if (table === 'invitations') return membershipChain({ ...INVITATION_ROW, org_id: 'a-different-org' });
      return membershipChain({ role: 'owner' });
    });

    const res = await invoke({
      email: 'invitee@example.com',
      orgId: 'org-1',
      orgName: 'Example Org',
      role: 'INDIVIDUAL',
      invitationId: 'invite-id-1',
    });

    expect(res.statusCode).toBe(404);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('surfaces a real send failure honestly instead of a fake success (SCRUM-3012)', async () => {
    mockSendEmail.mockResolvedValue({ success: false, error: 'Email delivery is not configured' });

    const res = await invoke({
      email: 'invitee@example.com',
      orgId: 'org-1',
      orgName: 'Example Org',
      role: 'INDIVIDUAL',
      invitationId: 'invite-id-1',
    });

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      error: { code: 'email_failed', message: 'Email delivery is not configured' },
    });
  });
});

describe('GET /api/invitations/:token', () => {
  it('returns a public preview for a valid invitation', async () => {
    const handler = getHandler('/invitations/:token');
    mockFrom.mockImplementation((table: string) => {
      if (table === 'invitations') {
        return membershipChain({
          id: 'invite-id-1',
          email: 'invitee@example.com',
          role: 'INDIVIDUAL',
          org_id: 'org-1',
          invited_by: 'admin-1',
          status: 'pending',
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        });
      }
      if (table === 'organizations') return membershipChain({ display_name: 'Example Org' });
      return membershipChain(null);
    });

    const req = { params: { token: 'good-token' } } as unknown as Request;
    const res = makeRes();
    await handler(req, res as unknown as Response);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      orgName: 'Example Org',
      email: 'invitee@example.com',
      role: 'INDIVIDUAL',
      expired: false,
      alreadyUsed: false,
    });
  });

  it('returns 404 for an unknown token', async () => {
    const handler = getHandler('/invitations/:token');
    mockFrom.mockImplementation(() => membershipChain(null));

    const req = { params: { token: 'unknown' } } as unknown as Request;
    const res = makeRes();
    await handler(req, res as unknown as Response);

    expect(res.statusCode).toBe(404);
  });
});

describe('POST /api/invitations/accept', () => {
  it('requires a token', async () => {
    const handler = getHandler('/invitations/accept');
    mockExtractAuthUserId.mockResolvedValue(null);

    const req = { body: {}, headers: {} } as unknown as Request;
    const res = makeRes();
    await handler(req, res as unknown as Response);

    expect(res.statusCode).toBe(400);
  });

  it('maps an InvitationError code to the matching HTTP status', async () => {
    const handler = getHandler('/invitations/accept');
    mockExtractAuthUserId.mockResolvedValue(null);
    mockFrom.mockImplementation((table: string) => {
      if (table === 'invitations') return membershipChain(null); // not found
      return membershipChain(null);
    });

    const req = { body: { token: 'bad-token' }, headers: {} } as unknown as Request;
    const res = makeRes();
    await handler(req, res as unknown as Response);

    expect(res.statusCode).toBe(404);
    expect((res.body as { error: { code: string } }).error.code).toBe('not_found');
  });
});
