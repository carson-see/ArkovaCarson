/**
 * Tests for Organization Verification API (GAP-10)
 *
 * Covers:
 *   - POST /verify-ein: EIN submission, validation, duplicate detection
 *   - POST /verify-domain: Domain verification initiation, email sending
 *   - POST /confirm-domain: Code confirmation, expiry, full verification
 *   - POST /dev-verify: Dev-only bypass
 *   - GET /verification-status: Status retrieval
 *   - Auth + org membership guards on all routes
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// ─── Mocks (must be before imports) ───

const mockFrom = vi.fn();

vi.mock('../../config.js', () => ({
  config: {
    nodeEnv: 'development',
  },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../utils/db.js', () => ({
  db: {
    from: (...args: unknown[]) => mockFrom(...args),
  },
}));

const mockSendEmail = vi.fn();
vi.mock('../../email/sender.js', () => ({
  sendEmail: (...args: unknown[]) => mockSendEmail(...args),
}));

const mockBuildDomainVerificationEmail = vi.fn();
vi.mock('../../email/templates.js', () => ({
  buildDomainVerificationEmail: (...args: unknown[]) => mockBuildDomainVerificationEmail(...args),
}));

import { orgVerificationRouter } from './orgVerification.js';

// ─── Helpers ───

function createApp(userId?: string) {
  const app = express();
  app.use(express.json());
  // Inject userId into request (simulating auth middleware)
  if (userId) {
    app.use((req, _res, next) => {
      (req as unknown as { userId: string }).userId = userId;
      next();
    });
  }
  app.use('/org', orgVerificationRouter);
  return app;
}

/** Build a fluent chain for Supabase query mocking.
 *  The chain is thenable so `await db.from(...).update(...).eq(...)` resolves. */
function mockQuery(result: { data?: unknown; error?: unknown }) {
  const chain: Record<string, unknown> = {};
  const terminal = () => Promise.resolve(result);
  // Make chain itself thenable (for cases where .eq() is the final call)
  chain.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
    terminal().then(resolve, reject);
  chain.select = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockReturnValue(chain);
  chain.neq = vi.fn().mockReturnValue(chain);
  chain.update = vi.fn().mockReturnValue(chain);
  chain.insert = vi.fn().mockReturnValue(chain);
  chain.single = vi.fn().mockImplementation(terminal);
  chain.maybeSingle = vi.fn().mockImplementation(terminal);
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Auth Guards ───

describe('auth guards', () => {
  it('returns 401 when no userId on all routes', async () => {
    const app = createApp(); // no userId injected

    const routes = [
      { method: 'post', path: '/org/verify-ein', body: { ein: '12-3456789' } },
      { method: 'post', path: '/org/verify-domain', body: {} },
      { method: 'post', path: '/org/confirm-domain', body: { code: '123456' } },
      { method: 'post', path: '/org/dev-verify', body: {} },
      { method: 'get', path: '/org/verification-status' },
    ];

    for (const route of routes) {
      const res = route.method === 'get'
        ? await request(app).get(route.path)
        : await request(app).post(route.path).send(route.body);
      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Authentication');
    }
  });

  it('returns 400 when user has no org on all routes', async () => {
    const app = createApp('user-no-org');

    // getUserOrgId returns null
    const profileChain = mockQuery({ data: { org_id: null } });
    mockFrom.mockReturnValue(profileChain);

    const routes = [
      { method: 'post', path: '/org/verify-ein', body: { ein: '12-3456789' } },
      { method: 'post', path: '/org/verify-domain', body: {} },
      { method: 'post', path: '/org/confirm-domain', body: { code: '123456' } },
      { method: 'post', path: '/org/dev-verify', body: {} },
      { method: 'get', path: '/org/verification-status' },
    ];

    for (const route of routes) {
      const res = route.method === 'get'
        ? await request(app).get(route.path)
        : await request(app).post(route.path).send(route.body);
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('organization');
    }
  });
});

// ─── POST /verify-ein ───

describe('POST /verify-ein', () => {
  const app = createApp('user-123');

  function setupMocks(opts: {
    orgId?: string | null;
    existingEin?: { id: string; display_name: string } | null;
    updateError?: unknown;
    auditError?: unknown;
  }) {
    const callIdx = { current: 0 };
    mockFrom.mockImplementation((table: string) => {
      if (table === 'profiles') {
        return mockQuery({ data: { org_id: opts.orgId ?? 'org-abc' } });
      }
      if (table === 'organizations') {
        callIdx.current++;
        if (callIdx.current === 1) {
          // duplicate check
          return mockQuery({ data: opts.existingEin ?? null });
        }
        // update
        return mockQuery({ data: null, error: opts.updateError ?? null });
      }
      if (table === 'audit_events') {
        return mockQuery({ data: null, error: opts.auditError ?? null });
      }
      return mockQuery({ data: null });
    });
  }

  it('rejects missing EIN', async () => {
    setupMocks({});
    const res = await request(app).post('/org/verify-ein').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('EIN');
  });

  it('rejects EIN shorter than 5 characters', async () => {
    setupMocks({});
    const res = await request(app).post('/org/verify-ein').send({ ein: '123' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('minimum 5');
  });

  it('returns 409 when EIN is already registered', async () => {
    setupMocks({ existingEin: { id: 'other-org', display_name: 'Other Corp' } });
    const res = await request(app).post('/org/verify-ein').send({ ein: '12-3456789' });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('already registered');
  });

  it('submits EIN and returns PENDING', async () => {
    setupMocks({});
    const res = await request(app).post('/org/verify-ein').send({ ein: '12-3456789' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('PENDING');
  });

  it('returns 500 when update fails', async () => {
    setupMocks({ updateError: { message: 'db error' } });
    const res = await request(app).post('/org/verify-ein').send({ ein: '12-3456789' });
    expect(res.status).toBe(500);
  });
});

// ─── POST /verify-domain ───

describe('POST /verify-domain', () => {
  const app = createApp('user-123');

  function setupMocks(opts: {
    orgId?: string | null;
    orgData?: { domain?: string | null; domain_verified?: boolean } | null;
    orgError?: unknown;
    updateError?: unknown;
  }) {
    const orgCallIdx = { current: 0 };
    mockFrom.mockImplementation((table: string) => {
      if (table === 'profiles') {
        return mockQuery({ data: { org_id: opts.orgId ?? 'org-abc' } });
      }
      if (table === 'organizations') {
        orgCallIdx.current++;
        if (orgCallIdx.current === 1) {
          // select domain
          return mockQuery({
            data: opts.orgData ?? { domain: 'example.com', domain_verified: false },
            error: opts.orgError ?? null,
          });
        }
        // update token
        return mockQuery({ data: null, error: opts.updateError ?? null });
      }
      return mockQuery({ data: null });
    });
  }

  it('returns 400 when org has no domain', async () => {
    setupMocks({ orgData: { domain: null, domain_verified: false } });
    const res = await request(app).post('/org/verify-domain').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('domain set');
  });

  it('returns 400 when domain already verified', async () => {
    setupMocks({ orgData: { domain: 'example.com', domain_verified: true } });
    const res = await request(app).post('/org/verify-domain').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('already verified');
  });

  it('returns devCode in development mode', async () => {
    setupMocks({});
    const res = await request(app).post('/org/verify-domain').send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending');
    expect(res.body.devCode).toBeDefined();
    expect(res.body.devCode).toHaveLength(6);
    expect(res.body.domain).toBe('example.com');
  });

  it('returns 500 when org fetch fails', async () => {
    setupMocks({ orgError: { message: 'db error' } });
    const res = await request(app).post('/org/verify-domain').send({});
    expect(res.status).toBe(500);
  });

  it('returns 500 when token update fails', async () => {
    setupMocks({ updateError: { message: 'db error' } });
    const res = await request(app).post('/org/verify-domain').send({});
    expect(res.status).toBe(500);
    expect(res.body.error).toContain('start domain');
  });
});

// Note: Production email-sending path cannot be tested here because `isDev`
// is captured at module load time. Would require a separate test file with
// config.nodeEnv mocked to 'production' before import.

// ─── POST /confirm-domain ───

describe('POST /confirm-domain', () => {
  const app = createApp('user-123');

  function setupMocks(opts: {
    orgData?: Record<string, unknown> | null;
    orgError?: unknown;
    updateError?: unknown;
  }) {
    const orgCallIdx = { current: 0 };
    mockFrom.mockImplementation((table: string) => {
      if (table === 'profiles') {
        return mockQuery({ data: { org_id: 'org-abc' } });
      }
      if (table === 'organizations') {
        orgCallIdx.current++;
        if (orgCallIdx.current === 1) {
          return mockQuery({
            data: opts.orgData ?? {
              domain_verification_token: '123456:abcdef',
              domain_verification_token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
              ein_tax_id: null,
              domain_verified: false,
            },
            error: opts.orgError ?? null,
          });
        }
        // update
        return mockQuery({ data: null, error: opts.updateError ?? null });
      }
      if (table === 'audit_events') {
        return mockQuery({ data: null });
      }
      return mockQuery({ data: null });
    });
  }

  it('rejects missing code', async () => {
    setupMocks({});
    const res = await request(app).post('/org/confirm-domain').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('code is required');
  });

  it('rejects code shorter than 6 chars', async () => {
    setupMocks({});
    const res = await request(app).post('/org/confirm-domain').send({ code: '123' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when domain already verified', async () => {
    setupMocks({
      orgData: {
        domain_verification_token: '123456:abcdef',
        domain_verification_token_expires_at: null,
        ein_tax_id: null,
        domain_verified: true,
      },
    });
    const res = await request(app).post('/org/confirm-domain').send({ code: '123456' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('already verified');
  });

  it('returns 400 when no pending verification', async () => {
    setupMocks({
      orgData: {
        domain_verification_token: null,
        domain_verification_token_expires_at: null,
        ein_tax_id: null,
        domain_verified: false,
      },
    });
    const res = await request(app).post('/org/confirm-domain').send({ code: '123456' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('No pending');
  });

  it('returns 400 when code expired', async () => {
    setupMocks({
      orgData: {
        domain_verification_token: '123456:abcdef',
        domain_verification_token_expires_at: new Date(Date.now() - 3600_000).toISOString(),
        ein_tax_id: null,
        domain_verified: false,
      },
    });
    const res = await request(app).post('/org/confirm-domain').send({ code: '123456' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('expired');
  });

  it('returns 400 when code is wrong', async () => {
    setupMocks({});
    const res = await request(app).post('/org/confirm-domain').send({ code: '999999' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid');
  });

  it('confirms domain (partial verification — no EIN)', async () => {
    setupMocks({});
    const res = await request(app).post('/org/confirm-domain').send({ code: '123456' });
    expect(res.status).toBe(200);
    expect(res.body.domainVerified).toBe(true);
    expect(res.body.verificationStatus).toBe('PENDING');
    expect(res.body.message).toContain('Submit EIN');
  });

  it('confirms domain + fully verifies when EIN present', async () => {
    setupMocks({
      orgData: {
        domain_verification_token: '123456:abcdef',
        domain_verification_token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
        ein_tax_id: '12-3456789',
        domain_verified: false,
      },
    });
    const res = await request(app).post('/org/confirm-domain').send({ code: '123456' });
    expect(res.status).toBe(200);
    expect(res.body.domainVerified).toBe(true);
    expect(res.body.verificationStatus).toBe('VERIFIED');
    expect(res.body.message).toContain('fully verified');
  });

  it('returns 500 when update fails', async () => {
    setupMocks({ updateError: { message: 'db error' } });
    const res = await request(app).post('/org/confirm-domain').send({ code: '123456' });
    expect(res.status).toBe(500);
  });
});

// ─── POST /dev-verify ───

describe('POST /dev-verify', () => {
  it('auto-verifies org in dev mode', async () => {
    const app = createApp('user-123');

    const orgCallIdx = { current: 0 };
    mockFrom.mockImplementation((table: string) => {
      if (table === 'profiles') {
        return mockQuery({ data: { org_id: 'org-abc' } });
      }
      if (table === 'organizations') {
        orgCallIdx.current++;
        return mockQuery({ data: null, error: null });
      }
      if (table === 'audit_events') {
        return mockQuery({ data: null });
      }
      return mockQuery({ data: null });
    });

    const res = await request(app).post('/org/dev-verify').send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('VERIFIED');
  });

  // Note: Production 403 test cannot run here because `isDev` is captured at
  // module load time. Would require separate test file with production config.

  it('returns 500 when update fails', async () => {
    const app = createApp('user-123');

    mockFrom.mockImplementation((table: string) => {
      if (table === 'profiles') {
        return mockQuery({ data: { org_id: 'org-abc' } });
      }
      if (table === 'organizations') {
        return mockQuery({ data: null, error: { message: 'db error' } });
      }
      return mockQuery({ data: null });
    });

    const res = await request(app).post('/org/dev-verify').send({});
    expect(res.status).toBe(500);
  });
});

// ─── GET /verification-status ───

describe('GET /verification-status', () => {
  const app = createApp('user-123');

  it('returns verification status', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'profiles') {
        return mockQuery({ data: { org_id: 'org-abc' } });
      }
      if (table === 'organizations') {
        return mockQuery({
          data: {
            verification_status: 'VERIFIED',
            domain: 'example.com',
            domain_verified: true,
            domain_verification_method: 'email',
            domain_verified_at: '2026-03-01T00:00:00Z',
            ein_tax_id: '12-3456789',
          },
        });
      }
      return mockQuery({ data: null });
    });

    const res = await request(app).get('/org/verification-status');
    expect(res.status).toBe(200);
    expect(res.body.verificationStatus).toBe('VERIFIED');
    expect(res.body.domain).toBe('example.com');
    expect(res.body.domainVerified).toBe(true);
    expect(res.body.hasEin).toBe(true);
    // Constitution 1.4: actual EIN never returned
    expect(res.body.ein_tax_id).toBeUndefined();
  });

  it('returns UNVERIFIED when no status set', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'profiles') {
        return mockQuery({ data: { org_id: 'org-abc' } });
      }
      if (table === 'organizations') {
        return mockQuery({
          data: {
            verification_status: null,
            domain: null,
            domain_verified: null,
            domain_verification_method: null,
            domain_verified_at: null,
            ein_tax_id: null,
          },
        });
      }
      return mockQuery({ data: null });
    });

    const res = await request(app).get('/org/verification-status');
    expect(res.status).toBe(200);
    expect(res.body.verificationStatus).toBe('UNVERIFIED');
    expect(res.body.domainVerified).toBe(false);
    expect(res.body.hasEin).toBe(false);
  });

  it('returns 500 when org fetch fails', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'profiles') {
        return mockQuery({ data: { org_id: 'org-abc' } });
      }
      if (table === 'organizations') {
        return mockQuery({ data: null, error: { message: 'db error' } });
      }
      return mockQuery({ data: null });
    });

    const res = await request(app).get('/org/verification-status');
    expect(res.status).toBe(500);
  });
});
