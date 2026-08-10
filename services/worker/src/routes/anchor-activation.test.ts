/**
 * Activation route wiring.
 *
 * The activation defect shipped precisely because nothing exercised the path
 * end to end: the frontend called an RPC overload that did not exist, and no
 * test ever asserted the contract. These tests pin the HTTP surface — the
 * routes are actually mounted at the paths the frontend calls, the
 * ActivationError code -> status map is honoured, and neither the token nor
 * the password can escape in a response body.
 *
 * Uses the router-stack `getHandler` harness (same as
 * anchor-invitation-email.test.ts) rather than supertest, so the route paths
 * themselves are asserted: `getHandler` throws if the path is not registered.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

// FakeActivationError lives in the hoisted block: `vi.mock` factories are
// hoisted above ordinary top-level declarations, so a plain `class` here would
// be in its TDZ when the factory runs.
const { mockGetActivationPreview, mockCompleteActivation, mockLogger, FakeActivationError } =
  vi.hoisted(() => ({
    mockGetActivationPreview: vi.fn(),
    mockCompleteActivation: vi.fn(),
    mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    FakeActivationError: class FakeActivationError extends Error {
      readonly code: string;
      constructor(message: string, code: string) {
        super(message);
        this.name = 'ActivationError';
        this.code = code;
      }
    },
  }));

vi.mock('./middleware.js', () => ({
  corsMiddleware: (_req: Request, _res: Response, next: NextFunction) => next(),
  extractAuthUserId: vi.fn().mockResolvedValue(null),
}));

vi.mock('../utils/rateLimit.js', () => {
  const passthrough = (_req: Request, _res: Response, next: NextFunction) => next();
  return {
    rateLimit: () => passthrough,
    rateLimiters: { checkout: passthrough, auth: passthrough },
  };
});

vi.mock('../api/activation.js', () => ({
  getActivationPreview: mockGetActivationPreview,
  completeActivation: mockCompleteActivation,
  ActivationError: FakeActivationError,
}));

vi.mock('../utils/db.js', () => ({ db: { from: vi.fn() } }));
vi.mock('../utils/logger.js', () => ({ logger: mockLogger }));
// anchor.ts pulls in the Resend-backed email stack for the invitation routes;
// none of it is exercised here (same stub as anchor-invitation-email.test.ts).
vi.mock('../email/sender.js', () => ({ sendEmail: vi.fn() }));
vi.mock('../config.js', () => ({
  config: { frontendUrl: 'https://app.arkova.test', corsAllowedOrigins: '' },
}));

import { anchorRouter } from './anchor.js';

const TOKEN = 'a'.repeat(64);
const PASSWORD = 'correct horse battery';

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

async function call(path: string, req: Partial<Request>): Promise<MockResponse> {
  const res = makeRes();
  await getHandler(path)(req as Request, res as unknown as Response);
  return res;
}

describe('GET /api/activation/:token', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is mounted and returns the preview for a valid link', async () => {
    mockGetActivationPreview.mockResolvedValue({
      email: 'recipient@example.com',
      fullName: null,
      orgName: 'Example University',
      expired: false,
    });

    const res = await call('/activation/:token', { params: { token: TOKEN } });

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      email: 'recipient@example.com',
      orgName: 'Example University',
    });
    expect(mockGetActivationPreview).toHaveBeenCalledWith(expect.anything(), TOKEN);
  });

  it('maps not_found to 404', async () => {
    mockGetActivationPreview.mockRejectedValue(new FakeActivationError('Invalid link.', 'not_found'));

    const res = await call('/activation/:token', { params: { token: TOKEN } });

    expect(res.statusCode).toBe(404);
    expect(res.body).toMatchObject({ error: { code: 'not_found' } });
  });
});

describe('POST /api/activation/complete', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is mounted, activates the account, and never echoes the token back', async () => {
    mockCompleteActivation.mockResolvedValue({
      email: 'recipient@example.com',
      orgId: 'org-1',
      orgName: 'Example University',
    });

    const res = await call('/activation/complete', { body: { token: TOKEN, password: PASSWORD } });

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ success: true, email: 'recipient@example.com' });
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);
    expect(mockCompleteActivation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ token: TOKEN, password: PASSWORD }),
    );
  });

  it('rejects a request with no password before reaching the handler', async () => {
    const res = await call('/activation/complete', { body: { token: TOKEN } });

    expect(res.statusCode).toBe(400);
    expect(mockCompleteActivation).not.toHaveBeenCalled();
  });

  it('maps expired to 410 so the page can tell the recipient to ask for a new link', async () => {
    mockCompleteActivation.mockRejectedValue(new FakeActivationError('Link expired.', 'expired'));

    const res = await call('/activation/complete', { body: { token: TOKEN, password: PASSWORD } });

    expect(res.statusCode).toBe(410);
    expect(res.body).toMatchObject({ error: { code: 'expired' } });
  });

  it('maps already_used to 410', async () => {
    mockCompleteActivation.mockRejectedValue(new FakeActivationError('Already used.', 'already_used'));

    const res = await call('/activation/complete', { body: { token: TOKEN, password: PASSWORD } });

    expect(res.statusCode).toBe(410);
  });

  it('does not leak an unexpected internal error to the caller', async () => {
    mockCompleteActivation.mockRejectedValue(
      new Error(`raw failure containing ${TOKEN} and ${PASSWORD}`),
    );

    const res = await call('/activation/complete', { body: { token: TOKEN, password: PASSWORD } });

    expect(res.statusCode).toBe(500);
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain(PASSWORD);
  });
});
