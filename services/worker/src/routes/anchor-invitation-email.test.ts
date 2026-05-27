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

function getInvitationHandler(): (req: Request, res: Response) => Promise<void> | void {
  const stack = (anchorRouter as unknown as { stack: RouteLayer[] }).stack;
  const layer = stack.find((entry) => entry.route?.path === '/send-invitation-email');
  if (!layer?.route) throw new Error('send-invitation-email handler not found');
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

const handler = getInvitationHandler();

async function invoke(body: unknown) {
  const req = {
    body,
    headers: { authorization: 'Bearer token' },
  } as unknown as Request;
  const res = makeRes();
  await handler(req, res as unknown as Response);
  return res;
}

describe('POST /api/send-invitation-email', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExtractAuthUserId.mockResolvedValue('user-1');
    mockSendEmail.mockResolvedValue({ success: true, messageId: 'msg-1' });
    mockFrom.mockImplementation((table: string) => {
      if (table === 'org_members') return membershipChain({ role: 'owner' });
      if (table === 'profiles') return membershipChain(null);
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
});
