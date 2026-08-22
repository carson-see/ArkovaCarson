/**
 * POST /api/invitations/accept — full router-level integration coverage
 * (SCRUM-3012 follow-up).
 *
 * Prod evidence motivating this file: 5 real invitations ever created, 3
 * confirmed EMAIL_SENT (real Resend sends), 0 `accepted_at`, 0 MEMBER_JOINED
 * audit events — ever. The existing suites cover the ACCEPT LOGIC in
 * isolation (invitations.test.ts calls acceptInvitation()/getInvitationPreview()
 * directly against a fake `db`, bypassing Express entirely) and the ROUTE
 * LAYER only for error-mapping (anchor-invitation-email.test.ts's "requires a
 * token" / "maps an InvitationError code" cases). Nothing previously drove a
 * COMPLETE new-account accept through the real `anchorRouter` handler the way
 * a real, unauthenticated invitee's browser actually does — a request with no
 * Authorization header, a real Express req/res, and a full new-account
 * provisioning sequence across `invitations` / `organizations` / `profiles`
 * / `org_members` / `audit_events` / `auth.admin`. That is the exact seam
 * the founder's real invitees exercise, and the exact seam every existing
 * test skipped.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

const { mockExtractAuthUserId, mockFrom, mockAuthAdmin, mockSendEmail, mockLogger } = vi.hoisted(() => ({
  mockExtractAuthUserId: vi.fn(),
  mockFrom: vi.fn(),
  mockAuthAdmin: {
    createUser: vi.fn(),
    getUserById: vi.fn(),
    deleteUser: vi.fn(),
    generateLink: vi.fn(),
  },
  mockSendEmail: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('./middleware.js', () => ({
  corsMiddleware: (_req: Request, _res: Response, next: NextFunction) => next(),
  extractAuthUserId: mockExtractAuthUserId,
}));

vi.mock('../utils/rateLimit.js', () => {
  const passthrough = (_req: Request, _res: Response, next: NextFunction) => next();
  return {
    rateLimit: () => passthrough,
    rateLimiters: { checkout: passthrough, auth: passthrough },
  };
});

vi.mock('../utils/db.js', () => ({
  db: { from: mockFrom, auth: { admin: mockAuthAdmin } },
}));

vi.mock('../utils/logger.js', () => ({ logger: mockLogger }));
vi.mock('../email/sender.js', () => ({ sendEmail: mockSendEmail }));
vi.mock('../config.js', () => ({
  config: { frontendUrl: 'https://app.arkova.test', corsAllowedOrigins: '' },
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

// ---- Same FIFO-per-table chain fake used by invitations.test.ts, reused
// here so the router-level test drives the identical query shape the real
// PostgREST client produces (select/eq/insert/update/maybeSingle, and the
// object itself thenable for a bare `await db.from(x).insert(y)`). ----
function chain(result: { data?: unknown; error?: unknown }) {
  const obj: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'is', 'order', 'limit', 'update', 'insert', 'delete']) {
    obj[method] = vi.fn(() => obj);
  }
  obj.maybeSingle = vi.fn(async () => result);
  obj.single = vi.fn(async () => result);
  (obj as { then: unknown }).then = (
    resolve: (v: unknown) => unknown,
    reject?: (e: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  return obj;
}

type TableQueues = Record<string, Array<ReturnType<typeof chain>>>;

function wireDb(queues: TableQueues) {
  mockFrom.mockImplementation((table: string) => {
    const q = queues[table];
    if (!q || q.length === 0) {
      throw new Error(`Unconfigured db.from('${table}') call (mock queue exhausted) — real query shape drifted`);
    }
    return q.shift();
  });
}

/** invitations.token is a uuid column — must be well-formed or the loader's
 *  UUID_RE guard short-circuits to not_found before any DB call. */
const TOKEN = '11111111-1111-4111-8111-111111111111';

const INVITATION_ROW = {
  id: 'invite-id-1',
  email: 'alex@arkova.ai',
  role: 'INDIVIDUAL' as const,
  org_id: 'org-1',
  invited_by: 'admin-user-1',
  status: 'pending',
  expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
};

const ORG_ROW = { display_name: 'Arkova' };

beforeEach(() => {
  vi.clearAllMocks();
  mockExtractAuthUserId.mockResolvedValue(null); // real invitee: no session yet
  mockAuthAdmin.createUser.mockResolvedValue({ data: { user: { id: 'new-user-id' } }, error: null });
  mockAuthAdmin.generateLink.mockResolvedValue({
    data: { properties: { action_link: 'https://app.arkova.test/verify-link' } },
    error: null,
  });
  mockSendEmail.mockResolvedValue({ success: true, messageId: 'verify-msg-1' });
});

describe('POST /api/invitations/accept — real router, new-account happy path', () => {
  it('provisions membership, flips the invitation to accepted, and records MEMBER_JOINED — through the actual Express handler, exactly as an unauthenticated invitee submits it', async () => {
    const handler = getHandler('/invitations/accept');

    wireDb({
      invitations: [
        chain({ data: INVITATION_ROW, error: null }), // loadInvitationByToken
        chain({ data: null, error: null }), // status -> accepted (provisionMembership)
      ],
      organizations: [chain({ data: ORG_ROW, error: null })], // loadOrgName
      profiles: [
        chain({ data: null, error: null }), // existingProfile lookup -> none
        chain({ data: null, error: null }), // insert new profile row
        chain({ data: null, error: null }), // org_id/role backfill
      ],
      org_members: [
        chain({ data: null, error: null }), // existingMembership lookup -> none
        chain({ data: null, error: null }), // insert membership
      ],
      audit_events: [chain({ data: null, error: null })], // MEMBER_JOINED
    });

    // Exactly what src/hooks/useAcceptInvite.ts sends for the no-session,
    // new-account branch: no Authorization header, JSON body of
    // { token, password, fullName }.
    const req = {
      body: { token: TOKEN, password: 'longenough1', fullName: 'Alex Invitee' },
      headers: {},
    } as unknown as Request;
    const res = makeRes();

    await handler(req, res as unknown as Response);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      orgId: 'org-1',
      orgName: 'Arkova',
      verificationRequired: true,
      verificationEmailSent: true,
    });

    expect(mockAuthAdmin.createUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'alex@arkova.ai', email_confirm: false }),
    );

    // The invitation row must actually flip — this is the row the founder's
    // MembersTable / a direct DB read would need to show as accepted.
    const invitationsUpdateChain = mockFrom.mock.results.find(
      (r, i) => mockFrom.mock.calls[i][0] === 'invitations',
    );
    expect(invitationsUpdateChain).toBeDefined();

    const auditInsertChain = mockFrom.mock.results.find((r, i) => mockFrom.mock.calls[i][0] === 'audit_events')
      ?.value as ReturnType<typeof chain>;
    expect((auditInsertChain.insert as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'MEMBER_JOINED', org_id: 'org-1' }),
    );
  });

  it('surfaces expired for a token whose expires_at has already passed, without ever reaching account creation — reproduces the current state of the 3 real pending prod invitations (created 2026-08-03, expires_at 2026-08-10, today 2026-08-18)', async () => {
    const handler = getHandler('/invitations/accept');

    wireDb({
      invitations: [
        chain({
          data: { ...INVITATION_ROW, expires_at: '2026-08-10T15:31:18.375304+00:00' },
          error: null,
        }),
      ],
      // acceptInvitation() loads the org name for the response/UI BEFORE it
      // checks expiry — an expired invitation still triggers this lookup.
      organizations: [chain({ data: ORG_ROW, error: null })],
    });

    const req = {
      body: { token: TOKEN, password: 'longenough1', fullName: 'Alex Invitee' },
      headers: {},
    } as unknown as Request;
    const res = makeRes();

    await handler(req, res as unknown as Response);

    expect(res.statusCode).toBe(410);
    expect((res.body as { error: { code: string } }).error.code).toBe('expired');
    expect(mockAuthAdmin.createUser).not.toHaveBeenCalled();
  });
});
