import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { KmsClient } from '../../../integrations/oauth/crypto.js';

const TEST_ORG_ID = '11111111-1111-4111-8111-111111111111';
const TEST_USER_ID = '22222222-2222-4222-8222-222222222222';

vi.mock('../../../config.js', () => ({
  config: {
    frontendUrl: 'http://localhost:5173',
    supabaseJwtSecret: 'jwt-secret',
    supabaseServiceKey: 'service-secret',
  },
}));

// Hoisted so tests can assert on it — FD-D3 made "every denial is logged" part
// of the contract, and FD-D1 adds a denial reason that must appear there too.
const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../utils/logger.js', () => ({ logger: mockLogger }));

vi.mock('../../../utils/db.js', () => ({
  db: {},
}));

// DRIVE-01 (SCRUM-2366): the connect gate resolves org membership/admin through
// the canonical owner-inclusive resolver (api/_org-auth.ts), NOT org_members
// directly. Mock it so these route tests control the admin/org answer and prove
// the router routes THROUGH the canonical resolver.
vi.mock('../../../api/_org-auth.js', () => ({
  getCallerOrgIdResult: vi.fn(async () => ({ value: null, error: false })),
  isCallerOrgAdminResult: vi.fn(async () => ({ value: true, error: false })),
}));

import { getCallerOrgIdResult, isCallerOrgAdminResult } from '../../../api/_org-auth.js';
import { createDriveOAuthRouter } from './drive-oauth.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockOrgId = getCallerOrgIdResult as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockAdmin = isCallerOrgAdminResult as any;

/**
 * Default the resolver to "verified-org admin" so pre-existing tests that only
 * exercise the org-admin happy path keep passing. Individual-tests override.
 */
function allowVerifiedOrgAdmin() {
  mockOrgId.mockResolvedValue({ value: TEST_ORG_ID, error: false });
  mockAdmin.mockResolvedValue({ value: true, error: false });
}

interface QueryResult {
  data?: unknown;
  error?: unknown;
}

function mockQuery(result: QueryResult, capture?: (method: string, value: unknown) => void) {
  const chain: Record<string, unknown> = {};
  const terminal = () => Promise.resolve(result);
  chain.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
    terminal().then(resolve, reject);
  chain.select = vi.fn((value?: unknown) => {
    capture?.('select', value);
    return chain;
  });
  chain.eq = vi.fn((field: string, value: unknown) => {
    capture?.(`eq:${field}`, value);
    return chain;
  });
  chain.is = vi.fn((field: string, value: unknown) => {
    capture?.(`is:${field}`, value);
    return chain;
  });
  chain.order = vi.fn().mockReturnValue(chain);
  chain.limit = vi.fn().mockReturnValue(chain);
  chain.update = vi.fn((value: unknown) => {
    capture?.('update', value);
    return chain;
  });
  chain.insert = vi.fn((value: unknown) => {
    capture?.('insert', value);
    return chain;
  });
  chain.upsert = vi.fn((value: unknown, options?: unknown) => {
    capture?.('upsert', value);
    if (options !== undefined) capture?.('upsertOptions', options);
    return chain;
  });
  chain.single = vi.fn().mockImplementation(terminal);
  chain.maybeSingle = vi.fn().mockImplementation(terminal);
  return chain;
}

function createApp(db: unknown) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { userId: string }).userId = TEST_USER_ID;
    next();
  });
  app.use(
    '/api/v1/integrations',
    createDriveOAuthRouter({
      db,
      env: {
        GOOGLE_OAUTH_CLIENT_ID: 'google-client',
        GOOGLE_OAUTH_CLIENT_SECRET: 'google-secret',
        GCP_KMS_INTEGRATION_TOKEN_KEY: 'projects/p/locations/l/keyRings/r/cryptoKeys/k',
      },
      stateSecret: 'test-state-secret',
      frontendUrl: 'http://localhost:5173',
      now: () => new Date('2026-04-24T12:00:00.000Z'),
      kms: {
        async encrypt() {
          return Buffer.from('encrypted-token-payload');
        },
        async decrypt() {
          return Buffer.from('{}');
        },
      } satisfies KmsClient,
    }),
  );
  return app;
}

/**
 * A route-`db` mock that serves the tables the connect gate + callback touch:
 *   - organizations → verification/suspension row (defaults VERIFIED, active)
 *   - profiles      → individual entitlement row (defaults undefined)
 *   - org_members   → legacy admin lookup (disconnect still uses requireOrgAdmin)
 *   - org_integrations / integration_events → capture upsert/insert
 */
function makeRouteDb(opts: {
  org?: { verification_status?: string; suspended?: boolean | null } | null;
  profile?: { subscription_tier?: string; identity_verified_at?: string | null } | null;
  memberRole?: string;
  capture?: (method: string, value: unknown) => void;
  integrationsResult?: () => QueryResult;
} = {}) {
  let integrationsCall = 0;
  return {
    from: vi.fn((table: string) => {
      if (table === 'organizations') {
        return mockQuery({
          data: opts.org === undefined ? { verification_status: 'VERIFIED', suspended: false } : opts.org,
          error: null,
        });
      }
      if (table === 'profiles') {
        return mockQuery({ data: opts.profile ?? null, error: null });
      }
      if (table === 'org_members') {
        return mockQuery({ data: { role: opts.memberRole ?? 'admin' }, error: null });
      }
      if (table === 'org_integrations') {
        integrationsCall++;
        return mockQuery(opts.integrationsResult?.() ?? { data: { id: 'integration-1' }, error: null }, opts.capture);
      }
      if (table === 'integration_events') {
        return mockQuery({ data: null, error: null }, opts.capture);
      }
      return mockQuery({ data: null, error: null }, opts.capture);
    }),
    _integrationsCall: () => integrationsCall,
  };
}

describe('Drive OAuth router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: caller is an admin of a VERIFIED, active org.
    allowVerifiedOrgAdmin();
  });

  // SCRUM-1236 (AUDIT-0424-11): state HMAC must come from a dedicated env var
  // and fail closed when unset. Falling back to supabaseJwtSecret /
  // supabaseServiceKey couples OAuth state validity to unrelated rotations.
  it('SCRUM-1236: fails closed when neither stateSecret nor INTEGRATION_STATE_HMAC_SECRET is set', () => {
    const db = { from: vi.fn() };
    expect(() =>
      createDriveOAuthRouter({
        db,
        // No stateSecret. Empty env (no INTEGRATION_STATE_HMAC_SECRET).
        env: {
          GOOGLE_OAUTH_CLIENT_ID: 'google-client',
          GOOGLE_OAUTH_CLIENT_SECRET: 'google-secret',
        },
        frontendUrl: 'http://localhost:5173',
      }),
    ).toThrow(/INTEGRATION_STATE_HMAC_SECRET/);
  });

  it('SCRUM-1236: uses INTEGRATION_STATE_HMAC_SECRET from env when provided', async () => {
    const db = makeRouteDb();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { userId: string }).userId = TEST_USER_ID;
      next();
    });
    app.use('/api/v1/integrations', createDriveOAuthRouter({
      db,
      env: {
        GOOGLE_OAUTH_CLIENT_ID: 'google-client',
        GOOGLE_OAUTH_CLIENT_SECRET: 'google-secret',
        INTEGRATION_STATE_HMAC_SECRET: 'env-state-secret',
      },
      frontendUrl: 'http://localhost:5173',
      now: () => new Date('2026-04-24T12:00:00.000Z'),
    }));

    const res = await request(app)
      .post('/api/v1/integrations/google_drive/oauth/start')
      .set('host', 'worker.test')
      .send({ org_id: TEST_ORG_ID });

    expect(res.status).toBe(200);
    expect(res.body.authorizationUrl).toContain('accounts.google.com');
  });

  it('SCRUM-1236: state HMAC does NOT fall back to supabaseJwtSecret', async () => {
    // Build a state using supabaseJwtSecret (the old fallback) — verify
    // should reject because the new code requires the dedicated secret.
    const db = makeRouteDb();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { userId: string }).userId = TEST_USER_ID;
      next();
    });
    app.use('/api/v1/integrations', createDriveOAuthRouter({
      db,
      env: {
        GOOGLE_OAUTH_CLIENT_ID: 'google-client',
        GOOGLE_OAUTH_CLIENT_SECRET: 'google-secret',
        INTEGRATION_STATE_HMAC_SECRET: 'dedicated-secret',
      },
      frontendUrl: 'http://localhost:5173',
      now: () => new Date('2026-04-24T12:00:00.000Z'),
    }));

    // Forge a state signed by the old fallback (supabaseJwtSecret = 'jwt-secret').
    const { createHmac } = await import('node:crypto');
    const payload = Buffer.from(JSON.stringify({
      orgId: TEST_ORG_ID, userId: TEST_USER_ID, nonce: 'n',
      returnTo: 'http://localhost:5173/organizations/x?tab=settings',
      iat: new Date('2026-04-24T12:00:00.000Z').getTime(),
    }), 'utf8').toString('base64url');
    const sig = createHmac('sha256', 'jwt-secret').update(payload).digest('base64url');
    const forgedState = `${payload}.${sig}`;

    const res = await request(app)
      .get('/api/v1/integrations/google_drive/oauth/callback')
      .set('host', 'worker.test')
      .query({ code: 'x', state: forgedState });

    // Forged state must redirect with invalid_state — not be accepted.
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('drive_error=invalid_state');
  });

  it('starts OAuth for org admins and returns a Google authorization URL', async () => {
    const db = makeRouteDb();
    const app = createApp(db);

    const res = await request(app)
      .post('/api/v1/integrations/google_drive/oauth/start')
      .set('host', 'worker.test')
      .send({
        org_id: TEST_ORG_ID,
        return_to: 'http://localhost:5173/organizations/org-1?tab=settings',
      });

    expect(res.status).toBe(200);
    expect(res.body.authorizationUrl).toContain('https://accounts.google.com/o/oauth2/v2/auth');
    const url = new URL(res.body.authorizationUrl);
    expect(url.searchParams.get('client_id')).toBe('google-client');
    expect(url.searchParams.get('redirect_uri')).toBe('http://worker.test/api/v1/integrations/google_drive/oauth/callback');
    expect(url.searchParams.get('state')).toBeTruthy();
  });

  it('rejects OAuth start when the caller is not an org admin', async () => {
    // Canonical resolver reports non-admin → gate denies with reason not_admin.
    mockAdmin.mockResolvedValue({ value: false, error: false });
    const db = makeRouteDb({ memberRole: 'member' });
    const app = createApp(db);

    const res = await request(app)
      .post('/api/v1/integrations/google_drive/oauth/start')
      .send({ org_id: TEST_ORG_ID });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('not_authorized');
    // Routed through the canonical owner-inclusive resolver, not org_members.
    expect(mockAdmin).toHaveBeenCalledWith(TEST_USER_ID, TEST_ORG_ID);
  });

  it('exchanges callback code, encrypts tokens, stores integration state, and redirects to settings', async () => {
    const captured: Record<string, unknown[]> = {};
    const capture = (method: string, value: unknown) => {
      captured[method] = [...(captured[method] ?? []), value];
    };
    const db = {
      from: vi.fn((table: string) => {
        if (table === 'organizations') return mockQuery({ data: { verification_status: 'VERIFIED', suspended: false }, error: null });
        if (table === 'org_members') return mockQuery({ data: { role: 'owner' }, error: null });
        if (table === 'org_integrations') return mockQuery({ data: { id: 'integration-1' }, error: null }, capture);
        if (table === 'integration_events') return mockQuery({ data: null, error: null }, capture);
        return mockQuery({ data: null, error: null }, capture);
      }),
    };

    // GH #1836 review round 3 (typecheck fix): declared with a second
    // `init?: RequestInit` param so a caller inspecting `.mock.calls[n][1]`
    // type-checks as `RequestInit | undefined` — the mock always DID capture
    // the real second arg at runtime (JS doesn't enforce declared arity),
    // the original single-param signature just didn't say so.
    const fetchImpl = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({
          access_token: 'access-token-secret',
          expires_in: 3600,
          refresh_token: 'refresh-token-secret',
          scope: 'https://www.googleapis.com/auth/drive.file email',
          token_type: 'Bearer',
        }), { status: 200 });
      }
      if (url === 'https://www.googleapis.com/oauth2/v3/userinfo') {
        return new Response(JSON.stringify({ sub: 'google-sub-1', email: 'admin@example.com' }), { status: 200 });
      }
      if (url.includes('/changes/startPageToken')) {
        return new Response(JSON.stringify({ startPageToken: 'page-token' }), { status: 200 });
      }
      if (url.includes('/changes/watch')) {
        return new Response(JSON.stringify({
          resourceId: 'drive-resource-1',
          expiration: String(new Date('2026-04-30T12:00:00.000Z').getTime()),
        }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { userId: string }).userId = TEST_USER_ID;
      next();
    });
    app.use('/api/v1/integrations', createDriveOAuthRouter({
      db,
      env: {
        GOOGLE_OAUTH_CLIENT_ID: 'google-client',
        GOOGLE_OAUTH_CLIENT_SECRET: 'google-secret',
        GCP_KMS_INTEGRATION_TOKEN_KEY: 'projects/p/locations/l/keyRings/r/cryptoKeys/k',
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      stateSecret: 'test-state-secret',
      frontendUrl: 'http://localhost:5173',
      now: () => new Date('2026-04-24T12:00:00.000Z'),
      kms: {
        async encrypt({ plaintext }) {
          expect(plaintext.toString('utf8')).toContain('refresh-token-secret');
          return Buffer.from('encrypted-token-payload');
        },
        async decrypt() {
          return Buffer.from('{}');
        },
      },
    }));

    const start = await request(app)
      .post('/api/v1/integrations/google_drive/oauth/start')
      .set('host', 'worker.test')
      .send({
        org_id: TEST_ORG_ID,
        return_to: 'http://localhost:5173/organizations/org-1?tab=settings',
      });
    const state = new URL(start.body.authorizationUrl).searchParams.get('state');

    const callback = await request(app)
      .get('/api/v1/integrations/google_drive/oauth/callback')
      .set('host', 'worker.test')
      .query({ code: 'google-code', state });

    expect(callback.status).toBe(302);
    expect(callback.headers.location).toBe('http://localhost:5173/organizations/org-1?tab=settings&drive=connected');
    const upsert = captured.upsert?.[0] as Record<string, unknown>;
    expect(upsert.provider).toBe('google_drive');
    expect(upsert.account_id).toBe('google-sub-1');
    const label = JSON.parse(upsert.account_label as string);
    expect(label.email).toBe('admin@example.com');
    // GH #1836 (SECURITY): the channel token must NOT be the org UUID — an
    // org UUID is not a secret (it appears in URLs, API responses, and
    // client-side state), so reusing it let anyone who learned/guessed an
    // org UUID forge a push notification past the webhook's token check.
    // It must instead be a high-entropy random value distinct from the org id.
    expect(label.channel_token).not.toBe(TEST_ORG_ID);
    expect(typeof label.channel_token).toBe('string');
    expect(label.channel_token.length).toBeGreaterThanOrEqual(32);
    expect(label.resource_id).toBe('drive-resource-1');
    // The SAME random token must be what Drive actually verifies against —
    // not silently mismatched from what we store.
    const watchCall = fetchImpl.mock.calls.find(([input]) => String(input).includes('/changes/watch'));
    const watchBody = watchCall ? JSON.parse(String((watchCall[1] as RequestInit).body)) : null;
    expect(watchBody?.token).toBe(label.channel_token);
    expect(upsert.encrypted_tokens).toBe('\\x656e637279707465642d746f6b656e2d7061796c6f6164');
    // subscription_id must be the channel UUID we generated (not Google's resourceId)
    expect(upsert.subscription_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(upsert.subscription_id).not.toBe('drive-resource-1');
    // DRIVE B1 — the changes cursor MUST be seeded at connect time.
    // `advancePageToken` is the only other writer of `last_page_token`, and it
    // is reachable only from `processDriveChanges`, which itself refuses to run
    // without a token (`drive-changes-runner.ts` `no_page_token` skip). Dropping
    // the `startPageToken` that `createChangesWatch` returns therefore made the
    // whole Drive changes pipeline unreachable by construction: a freshly
    // connected org would skip forever.
    expect(upsert.last_page_token).toBe('page-token');
    expect(JSON.stringify(upsert)).not.toContain('access-token-secret');
    // SCRUM-1241 (AUDIT-0424-17): conflict target must include org_id so an
    // upsert from one org cannot collide with another org sharing the same
    // Google account_id. The base UNIQUE constraint declares (org_id,
    // provider, account_id) — the onConflict must match exactly.
    const upsertOptions = captured.upsertOptions?.[0] as Record<string, unknown> | undefined;
    expect(upsertOptions).toEqual({ onConflict: 'org_id,provider,account_id' });
    expect(captured.insert?.[0]).toMatchObject({
      org_id: TEST_ORG_ID,
      provider: 'google_drive',
      event_type: 'oauth_connected',
      status: 'success',
    });
  });

  it('DRIVE B1: leaves last_page_token untouched when changes.watch fails, so an existing cursor is not wiped', async () => {
    const captured: Record<string, unknown[]> = {};
    const capture = (method: string, value: unknown) => {
      captured[method] = [...(captured[method] ?? []), value];
    };
    const db = {
      from: vi.fn((table: string) => {
        if (table === 'organizations') return mockQuery({ data: { verification_status: 'VERIFIED', suspended: false }, error: null });
        if (table === 'org_members') return mockQuery({ data: { role: 'owner' }, error: null });
        if (table === 'org_integrations') return mockQuery({ data: { id: 'integration-1' }, error: null }, capture);
        return mockQuery({ data: null, error: null }, capture);
      }),
    };

    // GH #1836 review round 3 (typecheck fix): declared with a second
    // `init?: RequestInit` param so a caller inspecting `.mock.calls[n][1]`
    // type-checks as `RequestInit | undefined` — the mock always DID capture
    // the real second arg at runtime (JS doesn't enforce declared arity),
    // the original single-param signature just didn't say so.
    const fetchImpl = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({
          access_token: 'access-token-secret',
          expires_in: 3600,
          refresh_token: 'refresh-token-secret',
          scope: 'https://www.googleapis.com/auth/drive.file email',
          token_type: 'Bearer',
        }), { status: 200 });
      }
      if (url === 'https://www.googleapis.com/oauth2/v3/userinfo') {
        return new Response(JSON.stringify({ sub: 'google-sub-1', email: 'admin@example.com' }), { status: 200 });
      }
      // The watch registration fails — the connection is still saved.
      if (url.includes('/changes/startPageToken') || url.includes('/changes/watch')) {
        return new Response(JSON.stringify({ error: 'backend error' }), { status: 500 });
      }
      return new Response('{}', { status: 404 });
    });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { userId: string }).userId = TEST_USER_ID;
      next();
    });
    app.use('/api/v1/integrations', createDriveOAuthRouter({
      db,
      env: {
        GOOGLE_OAUTH_CLIENT_ID: 'google-client',
        GOOGLE_OAUTH_CLIENT_SECRET: 'google-secret',
        GCP_KMS_INTEGRATION_TOKEN_KEY: 'projects/p/locations/l/keyRings/r/cryptoKeys/k',
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      stateSecret: 'test-state-secret',
      frontendUrl: 'http://localhost:5173',
      now: () => new Date('2026-04-24T12:00:00.000Z'),
      kms: {
        async encrypt() { return Buffer.from('encrypted-token-payload'); },
        async decrypt() { return Buffer.from('{}'); },
      },
    }));

    const start = await request(app)
      .post('/api/v1/integrations/google_drive/oauth/start')
      .set('host', 'worker.test')
      .send({ org_id: TEST_ORG_ID, return_to: 'http://localhost:5173/organizations/org-1?tab=settings' });
    const state = new URL(start.body.authorizationUrl).searchParams.get('state');

    const callback = await request(app)
      .get('/api/v1/integrations/google_drive/oauth/callback')
      .set('host', 'worker.test')
      .query({ code: 'google-code', state });

    expect(callback.status).toBe(302);
    const upsert = captured.upsert?.[0] as Record<string, unknown>;
    expect(upsert.subscription_id).toBeNull();
    // The KEY assertion: the column is OMITTED, not written as null. This is an
    // upsert — writing null here would wipe a working org's changes cursor on a
    // failed re-watch, and nothing else can re-seed it, so every change made
    // from then on would be skipped silently.
    expect(upsert).not.toHaveProperty('last_page_token');
  });

  it('SCRUM-1237: disconnects active Drive integration without revoking the OAuth token at Google', async () => {
    const captured: Record<string, unknown[]> = {};
    const capture = (method: string, value: unknown) => {
      captured[method] = [...(captured[method] ?? []), value];
    };

    const existingIntegration = {
      id: 'integration-1',
      subscription_id: 'channel-uuid-123',
      account_label: JSON.stringify({ email: 'user@example.com', channel_token: TEST_ORG_ID, resource_id: 'drive-resource-1' }),
      encrypted_tokens: '\\x656e63',
      token_kms_key_id: 'projects/p/locations/l/keyRings/r/cryptoKeys/k',
    };

    let dbCallCount = 0;
    const db = {
      from: vi.fn((table: string) => {
        if (table === 'org_members') return mockQuery({ data: { role: 'admin' }, error: null });
        if (table === 'org_integrations') {
          dbCallCount++;
          // First call: select existing row. Second call: update.
          if (dbCallCount === 1) return mockQuery({ data: existingIntegration, error: null }, capture);
          return mockQuery({ data: [{ id: 'integration-1' }], error: null }, capture);
        }
        if (table === 'integration_events') return mockQuery({ data: null, error: null }, capture);
        return mockQuery({ data: null, error: null });
      }),
    };

    const fetchCalls: string[] = [];
    // GH #1836 review round 3 (typecheck fix): declared with a second
    // `init?: RequestInit` param so a caller inspecting `.mock.calls[n][1]`
    // type-checks as `RequestInit | undefined` — the mock always DID capture
    // the real second arg at runtime (JS doesn't enforce declared arity),
    // the original single-param signature just didn't say so.
    const fetchImpl = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push(url);
      if (url.includes('channels/stop')) {
        return new Response('{}', { status: 204 });
      }
      if (url.includes('revoke')) {
        return new Response('{}', { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { userId: string }).userId = TEST_USER_ID;
      next();
    });
    app.use('/api/v1/integrations', createDriveOAuthRouter({
      db,
      env: {
        GOOGLE_OAUTH_CLIENT_ID: 'google-client',
        GOOGLE_OAUTH_CLIENT_SECRET: 'google-secret',
        GCP_KMS_INTEGRATION_TOKEN_KEY: 'projects/p/locations/l/keyRings/r/cryptoKeys/k',
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      stateSecret: 'test-state-secret',
      frontendUrl: 'http://localhost:5173',
      now: () => new Date('2026-04-24T12:00:00.000Z'),
      kms: {
        async encrypt() { return Buffer.from('encrypted'); },
        async decrypt() {
          return Buffer.from(JSON.stringify({ access_token: 'at-secret', refresh_token: 'rt-secret' }));
        },
      },
    }));

    const res = await request(app)
      .post('/api/v1/integrations/google_drive/disconnect')
      .send({ org_id: TEST_ORG_ID });

    expect(res.status).toBe(200);
    expect(res.body.disconnected).toBe(true);
    // SCRUM-1237: stopChannel still happens (per-org channel) — but we must NOT
    // revoke the Google OAuth token. Refresh tokens are scoped per (Google
    // account, OAuth client), not per Arkova org. Calling revoke would
    // invalidate every other Arkova org that has the same Google account
    // connected.
    expect(fetchCalls.some(u => u.includes('channels/stop'))).toBe(true);
    expect(fetchCalls.some(u => u.includes('oauth2.googleapis.com/revoke'))).toBe(false);
    expect(captured.update?.[0]).toMatchObject({
      encrypted_tokens: null,
      token_kms_key_id: null,
      subscription_id: null,
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // DRIVE-01 (SCRUM-2366): verified-only connect gate WIRED into start+callback.
  // Before the fix the eligibility resolver had zero production importers and
  // the route gated on org_members.role alone — unverified/free could connect
  // and a stale state token could bypass a lapsed entitlement.
  // ──────────────────────────────────────────────────────────────────────────
  describe('DRIVE-01 verified-only connect gate', () => {
    it('org path: allows an admin of a VERIFIED, active org (routes through the canonical resolver)', async () => {
      mockOrgId.mockResolvedValue({ value: TEST_ORG_ID, error: false });
      mockAdmin.mockResolvedValue({ value: true, error: false });
      const db = makeRouteDb({ org: { verification_status: 'VERIFIED', suspended: false } });
      const app = createApp(db);

      const res = await request(app)
        .post('/api/v1/integrations/google_drive/oauth/start')
        .set('host', 'worker.test')
        .send({ org_id: TEST_ORG_ID });

      expect(res.status).toBe(200);
      expect(res.body.authorizationUrl).toContain('accounts.google.com');
      expect(mockAdmin).toHaveBeenCalledWith(TEST_USER_ID, TEST_ORG_ID);
    });

    it('org path: DENIES an admin of an UNVERIFIED org (verified-only gate)', async () => {
      mockOrgId.mockResolvedValue({ value: TEST_ORG_ID, error: false });
      mockAdmin.mockResolvedValue({ value: true, error: false });
      const db = makeRouteDb({ org: { verification_status: 'UNVERIFIED', suspended: false } });
      const app = createApp(db);

      const res = await request(app)
        .post('/api/v1/integrations/google_drive/oauth/start')
        .set('host', 'worker.test')
        .send({ org_id: TEST_ORG_ID });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('org_unverified');
    });

    /**
     * FD-D1 (CTO ruling 2026-08-12). This used to return 200 and an
     * `accounts.google.com` authorization URL. The user then granted Google
     * access to their whole Drive, and the callback bounced them with
     * `personal_connect_unavailable`, because `org_integrations.org_id` is NOT
     * NULL. A paying customer paid a real privacy cost for a capability that
     * did not exist.
     *
     * Now: denied at START, so no consent screen is ever shown.
     */
    it('individual path: DENIES a paid + identity-verified solo user BEFORE any Google consent', async () => {
      // No org supplied → resolver reports the caller has no org.
      mockOrgId.mockResolvedValue({ value: null, error: false });
      const db = makeRouteDb({
        profile: { subscription_tier: 'professional', identity_verified_at: '2026-01-01T00:00:00Z' },
      });
      const app = createApp(db);

      const res = await request(app)
        .post('/api/v1/integrations/google_drive/oauth/start')
        .set('host', 'worker.test')
        .send({}); // no org_id → personal-Drive path

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('individual_scope_unsupported');
      // The whole point: no authorization URL is minted, so the user is never
      // walked into a Google consent that cannot be honoured.
      expect(res.body.authorizationUrl).toBeUndefined();
      // Personal path must NOT consult the admin resolver.
      expect(mockAdmin).not.toHaveBeenCalled();
    });

    it('individual path: gives a FREE solo user the SAME reason — paying does not unlock it', async () => {
      mockOrgId.mockResolvedValue({ value: null, error: false });
      const db = makeRouteDb({
        profile: { subscription_tier: 'free', identity_verified_at: '2026-01-01T00:00:00Z' },
      });
      const app = createApp(db);

      const res = await request(app)
        .post('/api/v1/integrations/google_drive/oauth/start')
        .set('host', 'worker.test')
        .send({});

      expect(res.status).toBe(403);
      // NOT `needs_paid_plan` — that was an upsell for something unbuildable.
      expect(res.body.code).toBe('individual_scope_unsupported');
    });

    it('individual path: logs the denial with the reason, so the user-facing "why" has a server-side twin', async () => {
      mockOrgId.mockResolvedValue({ value: null, error: false });
      const app = createApp(makeRouteDb({ profile: { subscription_tier: 'professional' } }));

      await request(app)
        .post('/api/v1/integrations/google_drive/oauth/start')
        .set('host', 'worker.test')
        .send({});

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          leg: 'start',
          reason: 'individual_scope_unsupported',
          requestedScope: 'individual',
        }),
        expect.stringContaining('DENIED'),
      );
    });

    it('callback re-check: a stale-but-valid state token cannot bypass an entitlement that lapsed after start', async () => {
      // Start leg: admin of a VERIFIED org → issues a valid state token.
      mockOrgId.mockResolvedValue({ value: TEST_ORG_ID, error: false });
      mockAdmin.mockResolvedValue({ value: true, error: false });

      const startDb = makeRouteDb({ org: { verification_status: 'VERIFIED', suspended: false } });
      const startApp = createApp(startDb);
      const start = await request(startApp)
        .post('/api/v1/integrations/google_drive/oauth/start')
        .set('host', 'worker.test')
        .send({ org_id: TEST_ORG_ID, return_to: 'http://localhost:5173/organizations/org-1?tab=settings' });
      expect(start.status).toBe(200);
      const state = new URL(start.body.authorizationUrl).searchParams.get('state');
      expect(state).toBeTruthy();

      // Between start and callback the org was SUSPENDED. The token is still
      // signature-valid + within TTL, but the callback re-evaluates the gate and
      // must deny persistence.
      const exchangeSpy = vi.fn();
      const callbackDb = makeRouteDb({ org: { verification_status: 'VERIFIED', suspended: true } });
      const callbackApp = express();
      callbackApp.use(express.json());
      callbackApp.use((req, _res, next) => {
        (req as unknown as { userId: string }).userId = TEST_USER_ID;
        next();
      });
      callbackApp.use('/api/v1/integrations', createDriveOAuthRouter({
        db: callbackDb,
        env: {
          GOOGLE_OAUTH_CLIENT_ID: 'google-client',
          GOOGLE_OAUTH_CLIENT_SECRET: 'google-secret',
          GCP_KMS_INTEGRATION_TOKEN_KEY: 'projects/p/locations/l/keyRings/r/cryptoKeys/k',
        },
        // If the gate were bypassed we'd reach token exchange — this fetch would
        // fire. Asserting it never runs proves the gate blocked BEFORE exchange.
        fetchImpl: exchangeSpy as unknown as typeof fetch,
        stateSecret: 'test-state-secret',
        frontendUrl: 'http://localhost:5173',
        now: () => new Date('2026-04-24T12:00:00.000Z'),
        kms: {
          async encrypt() { return Buffer.from('x'); },
          async decrypt() { return Buffer.from('{}'); },
        },
      }));

      const callback = await request(callbackApp)
        .get('/api/v1/integrations/google_drive/oauth/callback')
        .set('host', 'worker.test')
        .query({ code: 'google-code', state });

      expect(callback.status).toBe(302);
      expect(callback.headers.location).toContain('drive_error=org_suspended');
      // No token exchange happened — the lapsed entitlement was caught first.
      expect(exchangeSpy).not.toHaveBeenCalled();
      // Nothing was persisted.
      expect(callbackDb._integrationsCall()).toBe(0);
    });
  });
});
