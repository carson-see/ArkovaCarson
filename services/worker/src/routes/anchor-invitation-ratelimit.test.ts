/**
 * Invitation route rate-limit scoping (SCRUM-3012).
 *
 * These tests deliberately do NOT mock `../utils/rateLimit.js` — the other
 * invitation tests replace the limiters with pass-throughs, which is exactly
 * why the shared-bucket bug below was invisible. Here the REAL limiters run
 * behind a stand-in for `index.ts`'s `apiIpShadowGuard`, which is mounted at
 * `app.use('/api', apiIpShadowGuard, badgeRouter)` and therefore executes for
 * EVERY `/api/*` request — including `/api/invitations/*` — before
 * `anchorRouter` gets a chance to match.
 *
 * `rateLimit()` keys buckets as `scope ? scope + ':' + key : key`, so two
 * UNSCOPED limiters share one bucket per client IP. With the invitation routes
 * on the unscoped 5/min `rateLimiters.auth`, every invitation request
 * incremented that one bucket twice (guard + route) against a cap of 5 — two
 * requests per IP per minute. An invitee who reloaded `/accept-invite` once
 * before submitting got a 429 on submit, as did a second colleague accepting
 * from the same office NAT. index.ts:360 documents the same bug class biting
 * `/api/v1/identity`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { NextFunction, Request, Response } from 'express';

const { mockExtractAuthUserId, mockGetInvitationPreview, mockAcceptInvitation } = vi.hoisted(() => ({
  mockExtractAuthUserId: vi.fn(),
  mockGetInvitationPreview: vi.fn(),
  mockAcceptInvitation: vi.fn(),
}));

vi.mock('./middleware.js', () => ({
  corsMiddleware: (_req: Request, _res: Response, next: NextFunction) => next(),
  extractAuthUserId: mockExtractAuthUserId,
}));

vi.mock('../api/invitations.js', () => ({
  getInvitationPreview: mockGetInvitationPreview,
  acceptInvitation: mockAcceptInvitation,
  InvitationError: class InvitationError extends Error {
    constructor(message: string, readonly code: string) {
      super(message);
    }
  },
}));

vi.mock('../utils/db.js', () => ({ db: { from: vi.fn() } }));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../config.js', () => ({
  config: { frontendUrl: 'https://app.arkova.test', corsAllowedOrigins: '' },
}));

import { anchorRouter } from './anchor.js';
import { rateLimit } from '../utils/rateLimit.js';

const TOKEN = '11111111-1111-4111-8111-111111111111';

/** Mirrors index.ts's `apiIpShadowGuard`: unscoped, 60/min, per source IP. */
const apiIpShadowGuard = rateLimit({ windowMs: 60_000, maxRequests: 60 });

function makeApp() {
  const app = express();
  app.set('trust proxy', true); // so X-Forwarded-For gives each test its own bucket
  app.use(express.json());
  app.use('/api', apiIpShadowGuard);
  app.use('/api', anchorRouter);
  return app;
}

/** Distinct per test so the module-global limiter store can't leak between them. */
let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `203.0.113.${ipCounter}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExtractAuthUserId.mockResolvedValue(null);
  mockGetInvitationPreview.mockResolvedValue({
    orgName: 'Example Org',
    email: 'invitee@example.com',
    role: 'INDIVIDUAL',
    expired: false,
    alreadyUsed: false,
  });
  mockAcceptInvitation.mockResolvedValue({
    orgId: 'org-1',
    orgName: 'Example Org',
    verificationRequired: true,
    verificationEmailSent: true,
  });
});

describe('invitation routes: rate-limit bucket is not shared with apiIpShadowGuard', () => {
  it('lets a normal accept flow through even after the invitee reloads the page', async () => {
    const app = makeApp();
    const ip = nextIp();

    // Open the link, page reload, one more retry, then submit — the exact
    // sequence that used to 429 on the third request.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const preview = await request(app).get(`/api/invitations/${TOKEN}`).set('X-Forwarded-For', ip);
      expect(preview.status).toBe(200);
    }

    const accept = await request(app)
      .post('/api/invitations/accept')
      .set('X-Forwarded-For', ip)
      .send({ token: TOKEN, password: 'longenough' });

    expect(accept.status).toBe(200);
    expect(mockAcceptInvitation).toHaveBeenCalledTimes(1);
  });

  it('lets several colleagues behind one office NAT accept in the same minute', async () => {
    const app = makeApp();
    const ip = nextIp();

    for (let colleague = 0; colleague < 6; colleague += 1) {
      const preview = await request(app).get(`/api/invitations/${TOKEN}`).set('X-Forwarded-For', ip);
      expect(preview.status).toBe(200);

      const accept = await request(app)
        .post('/api/invitations/accept')
        .set('X-Forwarded-For', ip)
        .send({ token: TOKEN, password: 'longenough' });
      expect(accept.status).toBe(200);
    }
  });

  it('still rate-limits invitation traffic — the bucket is scoped, not removed', async () => {
    const app = makeApp();
    const ip = nextIp();

    let sawLimit = false;
    for (let i = 0; i < 40; i += 1) {
      const res = await request(app).get(`/api/invitations/${TOKEN}`).set('X-Forwarded-For', ip);
      if (res.status === 429) {
        sawLimit = true;
        expect(res.headers['retry-after']).toBeDefined();
        break;
      }
    }

    expect(sawLimit).toBe(true);
  });
});
