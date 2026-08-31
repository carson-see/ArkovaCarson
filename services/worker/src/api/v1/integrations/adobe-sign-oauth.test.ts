/**
 * Adobe Sign OAuth router tests (SCRUM-1148 follow-up).
 *
 * Written before the implementation. Mirrors `docusign-oauth.test.ts`, with one
 * structural difference that is the entire point of this connector:
 *
 *   DocuSign discards its Connect `connectId` to an `integration_events` row
 *   and resolves deliveries by `account_id`. Adobe Sign's webhook handler
 *   (`api/v1/webhooks/adobe-sign.ts::findIntegration`) resolves by
 *   `org_integrations.webhook_id` and by nothing else — so if the id Adobe
 *   mints is not persisted onto the integration row IN THE SAME UPSERT, the
 *   connector is exactly as broken as it was before this router existed.
 *
 * The `webhook_id` assertions below are therefore not stylistic parity checks;
 * they are the regression guard for the bug this whole change closes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { KmsClient } from '../../../integrations/oauth/crypto.js';

const TEST_ORG_ID = '11111111-1111-4111-8111-111111111111';
const TEST_USER_ID = '22222222-2222-4222-8222-222222222222';
const TEST_INTEGRATION_ID = '33333333-3333-4333-8333-333333333333';
const ADOBE_WEBHOOK_ID = 'CBJCHBCAABAA-webhook-id';
const API_ACCESS_POINT = 'https://api.na2.adobesign.com/';

vi.mock('../../../config.js', () => ({
  config: {
    frontendUrl: 'http://localhost:5173',
    supabaseJwtSecret: 'jwt-secret',
    supabaseServiceKey: 'service-secret',
  },
}));

vi.mock('../../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../../utils/db.js', () => ({ db: {} }));

import { createAdobeSignOAuthRouter } from './adobe-sign-oauth.js';
import { logger } from '../../../utils/logger.js';

type RouterDeps = NonNullable<Parameters<typeof createAdobeSignOAuthRouter>[0]>;

const ROUTER_ENV: NodeJS.ProcessEnv = {
  ADOBE_SIGN_CLIENT_ID: 'adobe-client-id',
  ADOBE_SIGN_CLIENT_SECRET: 'adobe-client-secret',
  ADOBE_SIGN_OAUTH_BASE_URL: 'https://secure.na1.adobesign.com',
  WORKER_PUBLIC_URL: 'https://worker.arkova.test',
  GCP_SECRET_MANAGER_PROJECT_ID: 'test-project',
  GCP_KMS_INTEGRATION_TOKEN_KEY: 'projects/p/locations/l/keyRings/r/cryptoKeys/k',
};

interface QueryResult {
  data?: unknown;
  error?: unknown;
}

function mockQuery(result: QueryResult, capture?: (method: string, value: unknown) => void) {
  const chain: Record<string, unknown> = {};
  const terminal = () => Promise.resolve(result);
  chain.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) => terminal().then(resolve, reject);
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
    capture?.('upsert:options', options);
    return chain;
  });
  chain.single = vi.fn().mockImplementation(terminal);
  chain.maybeSingle = vi.fn().mockImplementation(terminal);
  return chain;
}

function asTestDb(db: unknown): RouterDeps['db'] {
  return db as RouterDeps['db'];
}

interface ConnectDbOptions {
  role?: 'admin' | 'owner' | 'member';
  verificationStatus?: 'VERIFIED' | 'PENDING' | 'UNVERIFIED';
  suspended?: boolean;
  orgLookupError?: unknown;
  upsertResult?: QueryResult;
  integrationRows?: unknown;
  integrationLookupError?: unknown;
  updateResult?: QueryResult;
}

/** Table-aware DB double: admin gate, verified-org gate, integration writes, events. */
function connectDb(options: ConnectDbOptions = {}) {
  const captures: Array<{ table: string; method: string; value: unknown }> = [];
  const from = vi.fn((table: string) => {
    const capture = (method: string, value: unknown) => captures.push({ table, method, value });
    if (table === 'org_members') {
      return mockQuery({ data: { role: options.role ?? 'admin' }, error: null }, capture);
    }
    if (table === 'organizations') {
      if (options.orgLookupError) return mockQuery({ data: null, error: options.orgLookupError }, capture);
      return mockQuery(
        {
          data: {
            id: TEST_ORG_ID,
            verification_status: options.verificationStatus ?? 'VERIFIED',
            suspended: options.suspended ?? false,
          },
          error: null,
        },
        capture,
      );
    }
    if (table === 'org_integrations') {
      if (options.integrationLookupError) {
        return mockQuery({ data: null, error: options.integrationLookupError }, capture);
      }
      // `upsert().select().single()` and `select()...` and `update()...select()`
      // all terminate on this same chain; the router only ever needs one shape
      // per request, so the caller picks it.
      if (options.updateResult) return mockQuery(options.updateResult, capture);
      if (options.integrationRows !== undefined) {
        return mockQuery({ data: options.integrationRows, error: null }, capture);
      }
      return mockQuery(options.upsertResult ?? { data: { id: TEST_INTEGRATION_ID }, error: null }, capture);
    }
    return mockQuery({ data: null, error: null }, capture);
  });
  return { from, captures };
}

function captured(db: { captures: Array<{ table: string; method: string; value: unknown }> }, table: string, method: string) {
  return db.captures.filter((c) => c.table === table && c.method === method).map((c) => c.value);
}

const kms: KmsClient = {
  async encrypt() {
    return Buffer.from('encrypted-token-payload');
  },
  async decrypt() {
    return Buffer.from('{}');
  },
};

function refreshTokenStoreDouble() {
  const store = {
    put: vi.fn(async () => undefined),
    get: vi.fn(async () => 'stored-refresh-token'),
    delete: vi.fn(async () => undefined),
  };
  return store;
}

function createApp(db: unknown, overrides: Partial<RouterDeps> = {}, authenticated = true) {
  const app = express();
  app.use(express.json());
  if (authenticated) {
    app.use((req, _res, next) => {
      (req as unknown as { userId: string }).userId = TEST_USER_ID;
      next();
    });
  }
  app.use(
    '/api/v1/integrations',
    createAdobeSignOAuthRouter({
      db: asTestDb(db),
      env: ROUTER_ENV,
      stateSecret: 'test-state-secret',
      frontendUrl: 'http://localhost:5173',
      now: () => new Date('2026-08-30T12:00:00.000Z'),
      kms,
      refreshTokenStore: refreshTokenStoreDouble(),
      ...overrides,
    }),
  );
  return app;
}

/** Drive `/oauth/start` and hand back the signed `state` the router minted. */
async function mintState(db: unknown, overrides: Partial<RouterDeps> = {}): Promise<string> {
  const res = await request(createApp(db, overrides))
    .post('/api/v1/integrations/adobe-sign/oauth/start')
    .send({ org_id: TEST_ORG_ID, return_to: 'http://localhost:5173/organizations/o?tab=settings' });
  expect(res.status).toBe(200);
  const url = new URL(res.body.authorizationUrl as string);
  return url.searchParams.get('state') as string;
}

/** Adobe fetch double: token exchange, userinfo, webhook create/delete, revoke. */
function adobeFetchDouble(
  overrides: {
    token?: () => Response;
    userinfo?: () => Response;
    webhookCreate?: () => Response;
    webhookDelete?: () => Response;
    revoke?: () => Response;
    refresh?: () => Response;
  } = {},
) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith('/oauth/v2/token')) {
      return (
        overrides.token?.() ??
        new Response(
          JSON.stringify({
            access_token: 'adobe-access-token',
            refresh_token: 'adobe-refresh-token',
            token_type: 'Bearer',
            expires_in: 3600,
            scope: 'webhook_write:account',
            api_access_point: API_ACCESS_POINT,
            web_access_point: 'https://secure.na2.adobesign.com/',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      );
    }
    if (url.endsWith('/oauth/v2/refresh')) {
      return (
        overrides.refresh?.() ??
        new Response(
          JSON.stringify({ access_token: 'refreshed-access-token', token_type: 'Bearer', expires_in: 3600 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      );
    }
    if (url.endsWith('/oauth/v2/revoke')) {
      return overrides.revoke?.() ?? new Response('', { status: 200 });
    }
    if (url.endsWith('/api/rest/v6/users/me')) {
      return (
        overrides.userinfo?.() ??
        new Response(JSON.stringify({ id: 'adobe-user-1', email: 'admin@example.test', company: 'Example Co' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );
    }
    if (url.endsWith('/api/rest/v6/webhooks') && init?.method === 'POST') {
      return (
        overrides.webhookCreate?.() ??
        new Response(JSON.stringify({ id: ADOBE_WEBHOOK_ID }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        })
      );
    }
    if (url.includes('/api/rest/v6/webhooks/') && init?.method === 'DELETE') {
      return overrides.webhookDelete?.() ?? new Response(null, { status: 204 });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  });
  return { impl: impl as unknown as typeof fetch, calls, raw: impl };
}

beforeEach(() => {
  vi.clearAllMocks();
});

/* ───────────────────────── POST /oauth/start ───────────────────────── */

describe('POST /adobe-sign/oauth/start', () => {
  it('401s an unauthenticated caller', async () => {
    const res = await request(createApp(connectDb(), {}, false))
      .post('/api/v1/integrations/adobe-sign/oauth/start')
      .send({ org_id: TEST_ORG_ID });
    expect(res.status).toBe(401);
  });

  it('400s a body without a valid org_id uuid', async () => {
    const res = await request(createApp(connectDb()))
      .post('/api/v1/integrations/adobe-sign/oauth/start')
      .send({ org_id: 'not-a-uuid' });
    expect(res.status).toBe(400);
  });

  it('403s a non-admin member', async () => {
    const res = await request(createApp(connectDb({ role: 'member' })))
      .post('/api/v1/integrations/adobe-sign/oauth/start')
      .send({ org_id: TEST_ORG_ID });
    expect(res.status).toBe(403);
  });

  it('allows an owner as well as an admin', async () => {
    const res = await request(createApp(connectDb({ role: 'owner' })))
      .post('/api/v1/integrations/adobe-sign/oauth/start')
      .send({ org_id: TEST_ORG_ID });
    expect(res.status).toBe(200);
  });

  it('403s an unverified org with code org_unverified', async () => {
    const res = await request(createApp(connectDb({ verificationStatus: 'PENDING' })))
      .post('/api/v1/integrations/adobe-sign/oauth/start')
      .send({ org_id: TEST_ORG_ID });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('org_unverified');
  });

  it('403s a suspended-but-VERIFIED org with code org_suspended', async () => {
    const res = await request(createApp(connectDb({ suspended: true })))
      .post('/api/v1/integrations/adobe-sign/oauth/start')
      .send({ org_id: TEST_ORG_ID });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('org_suspended');
  });

  it('500s a transient verification lookup failure with a retryable code, not a "get verified" dead-end', async () => {
    const res = await request(createApp(connectDb({ orgLookupError: { message: 'timeout' } })))
      .post('/api/v1/integrations/adobe-sign/oauth/start')
      .send({ org_id: TEST_ORG_ID });
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('verification_lookup_failed');
  });

  it('returns an Adobe consent URL carrying the webhook scopes and a signed state', async () => {
    const res = await request(createApp(connectDb()))
      .post('/api/v1/integrations/adobe-sign/oauth/start')
      .send({ org_id: TEST_ORG_ID });

    expect(res.status).toBe(200);
    const url = new URL(res.body.authorizationUrl as string);
    expect(url.origin).toBe('https://secure.na1.adobesign.com');
    expect(url.pathname).toBe('/public/oauth/v2');
    expect(url.searchParams.get('scope')).toContain('webhook_write:account');
    expect(url.searchParams.get('scope')).toContain('webhook_retention:account');
    // Signed state = base64url payload + '.' + hmac
    expect(url.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(res.body.url).toBe(res.body.authorizationUrl);
  });

  it('derives the redirect_uri from the request host so each fronting host works', async () => {
    const res = await request(createApp(connectDb()))
      .post('/api/v1/integrations/adobe-sign/oauth/start')
      .set('X-Forwarded-Proto', 'https')
      .set('X-Forwarded-Host', 'worker.arkova.ai')
      .send({ org_id: TEST_ORG_ID });

    const url = new URL(res.body.authorizationUrl as string);
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://worker.arkova.ai/api/v1/integrations/adobe-sign/oauth/callback',
    );
  });

  it('ignores an off-origin return_to instead of becoming an open redirect', async () => {
    const res = await request(createApp(connectDb()))
      .post('/api/v1/integrations/adobe-sign/oauth/start')
      .send({ org_id: TEST_ORG_ID, return_to: 'https://evil.example.com/steal' });

    expect(res.status).toBe(200);
    const state = new URL(res.body.authorizationUrl as string).searchParams.get('state') as string;
    const payload = JSON.parse(Buffer.from(state.split('.')[0], 'base64url').toString('utf8'));
    expect(payload.returnTo).toBe(`http://localhost:5173/organizations/${TEST_ORG_ID}?tab=settings`);
  });

  it('500s cleanly when no Adobe application is configured', async () => {
    // The live prod state as of 2026-08-30: no ADOBE_SIGN_CLIENT_ID anywhere.
    // This must be a clean 500, not an unhandled throw.
    const res = await request(createApp(connectDb(), { env: { ...ROUTER_ENV, ADOBE_SIGN_CLIENT_ID: undefined } }))
      .post('/api/v1/integrations/adobe-sign/oauth/start')
      .send({ org_id: TEST_ORG_ID });

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('adobe_sign_unconfigured');
  });

  it('never puts the client secret in the response body', async () => {
    const res = await request(createApp(connectDb()))
      .post('/api/v1/integrations/adobe-sign/oauth/start')
      .send({ org_id: TEST_ORG_ID });
    expect(JSON.stringify(res.body)).not.toContain('adobe-client-secret');
  });
});

/* ─────────────────────── GET /oauth/callback ───────────────────────── */

describe('GET /adobe-sign/oauth/callback', () => {
  it('redirects with invalid_state for a forged state', async () => {
    const res = await request(createApp(connectDb()))
      .get('/api/v1/integrations/adobe-sign/oauth/callback')
      .query({ state: 'forged.signature', code: 'c' });

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('adobe_sign_error=invalid_state');
  });

  it('reflects a provider-side error parameter', async () => {
    const db = connectDb();
    const state = await mintState(db);
    const res = await request(createApp(db))
      .get('/api/v1/integrations/adobe-sign/oauth/callback')
      .query({ state, error: 'access_denied' });

    expect(res.headers.location).toContain('adobe_sign_error=access_denied');
  });

  it('redirects with missing_code when Adobe returns no authorization code', async () => {
    const db = connectDb();
    const state = await mintState(db);
    const res = await request(createApp(db))
      .get('/api/v1/integrations/adobe-sign/oauth/callback')
      .query({ state });

    expect(res.headers.location).toContain('adobe_sign_error=missing_code');
  });

  it('re-checks org admin on the callback — a signed state is replayable inside its TTL', async () => {
    const db = connectDb();
    const state = await mintState(db);
    const demotedDb = connectDb({ role: 'member' });
    const res = await request(createApp(demotedDb))
      .get('/api/v1/integrations/adobe-sign/oauth/callback')
      .query({ state, code: 'auth-code' });

    expect(res.headers.location).toContain('adobe_sign_error=not_authorized');
  });

  it('re-checks org verification on the callback and never persists for a lapsed org', async () => {
    const db = connectDb();
    const state = await mintState(db);
    const lapsedDb = connectDb({ verificationStatus: 'UNVERIFIED' });
    const adobe = adobeFetchDouble();
    const res = await request(createApp(lapsedDb, { fetchImpl: adobe.impl }))
      .get('/api/v1/integrations/adobe-sign/oauth/callback')
      .query({ state, code: 'auth-code' });

    expect(res.headers.location).toContain('adobe_sign_error=org_unverified');
    expect(captured(lapsedDb, 'org_integrations', 'upsert')).toHaveLength(0);
    expect(adobe.calls).toHaveLength(0);
  });

  it('rejects an expired state rather than honouring it', async () => {
    const db = connectDb();
    const state = await mintState(db);
    // Same signing secret, clock advanced past the 10-minute TTL.
    const res = await request(
      createApp(db, { now: () => new Date('2026-08-30T12:20:00.000Z') }),
    )
      .get('/api/v1/integrations/adobe-sign/oauth/callback')
      .query({ state, code: 'auth-code' });

    expect(res.headers.location).toContain('adobe_sign_error=invalid_state');
  });

  describe('happy path', () => {
    it('PERSISTS THE ADOBE webhook_id ON THE INTEGRATION ROW IN THE SAME UPSERT', async () => {
      // The regression guard for this connector's original defect. Without
      // webhook_id on the row, webhooks/adobe-sign.ts::findIntegration()
      // resolves null for every delivery and the connector is inert.
      const db = connectDb();
      const state = await mintState(db);
      const adobe = adobeFetchDouble();

      const res = await request(createApp(db, { fetchImpl: adobe.impl }))
        .get('/api/v1/integrations/adobe-sign/oauth/callback')
        .query({ state, code: 'auth-code' });

      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('adobe_sign=connected');

      const upserts = captured(db, 'org_integrations', 'upsert') as Array<Record<string, unknown>>;
      expect(upserts).toHaveLength(1);
      expect(upserts[0].webhook_id).toBe(ADOBE_WEBHOOK_ID);
      expect(upserts[0].provider).toBe('adobe_sign');
      expect(upserts[0].org_id).toBe(TEST_ORG_ID);
      expect(upserts[0].revoked_at).toBeNull();
    });

    it('creates the Adobe webhook BEFORE the upsert, so a row never exists without an id', async () => {
      const db = connectDb();
      const state = await mintState(db);
      const adobe = adobeFetchDouble();
      await request(createApp(db, { fetchImpl: adobe.impl }))
        .get('/api/v1/integrations/adobe-sign/oauth/callback')
        .query({ state, code: 'auth-code' });

      const createCall = adobe.calls.find((c) => c.url.endsWith('/api/rest/v6/webhooks') && c.init?.method === 'POST');
      expect(createCall).toBeDefined();
      expect(createCall?.url).toBe(`${API_ACCESS_POINT}api/rest/v6/webhooks`);
    });

    it('targets the account shard from api_access_point, not a hardcoded host', async () => {
      const db = connectDb();
      const state = await mintState(db);
      const adobe = adobeFetchDouble();
      await request(createApp(db, { fetchImpl: adobe.impl }))
        .get('/api/v1/integrations/adobe-sign/oauth/callback')
        .query({ state, code: 'auth-code' });

      for (const call of adobe.calls.filter((c) => c.url.includes('/api/rest/v6/'))) {
        expect(call.url.startsWith(API_ACCESS_POINT)).toBe(true);
      }
    });

    it('stores the shard access point as base_uri so disconnect can reach the same account', async () => {
      const db = connectDb();
      const state = await mintState(db);
      await request(createApp(db, { fetchImpl: adobeFetchDouble().impl }))
        .get('/api/v1/integrations/adobe-sign/oauth/callback')
        .query({ state, code: 'auth-code' });

      const upsert = (captured(db, 'org_integrations', 'upsert')[0] ?? {}) as Record<string, unknown>;
      expect(upsert.base_uri).toBe(API_ACCESS_POINT);
    });

    it('writes only the Secret Manager resource name to Postgres, never the refresh token', async () => {
      const db = connectDb();
      const state = await mintState(db);
      const store = refreshTokenStoreDouble();
      await request(createApp(db, { fetchImpl: adobeFetchDouble().impl, refreshTokenStore: store }))
        .get('/api/v1/integrations/adobe-sign/oauth/callback')
        .query({ state, code: 'auth-code' });

      const upsert = (captured(db, 'org_integrations', 'upsert')[0] ?? {}) as Record<string, unknown>;
      expect(upsert.token_secret_name).toMatch(/^projects\/test-project\/secrets\/arkova-adobe-sign-/);
      expect(JSON.stringify(upsert)).not.toContain('adobe-refresh-token');
      expect(store.put).toHaveBeenCalledWith(
        expect.objectContaining({ value: 'adobe-refresh-token' }),
      );
    });

    it('stores the access token only as KMS ciphertext bytea', async () => {
      const db = connectDb();
      const state = await mintState(db);
      await request(createApp(db, { fetchImpl: adobeFetchDouble().impl }))
        .get('/api/v1/integrations/adobe-sign/oauth/callback')
        .query({ state, code: 'auth-code' });

      const upsert = (captured(db, 'org_integrations', 'upsert')[0] ?? {}) as Record<string, unknown>;
      expect(String(upsert.encrypted_tokens)).toMatch(/^\\x[0-9a-f]+$/);
      expect(JSON.stringify(upsert)).not.toContain('adobe-access-token');
      expect(upsert.token_kms_key_id).toBeTruthy();
    });

    it('upserts on the org_id,provider,account_id key so a reconnect updates in place', async () => {
      const db = connectDb();
      const state = await mintState(db);
      await request(createApp(db, { fetchImpl: adobeFetchDouble().impl }))
        .get('/api/v1/integrations/adobe-sign/oauth/callback')
        .query({ state, code: 'auth-code' });

      expect(captured(db, 'org_integrations', 'upsert:options')[0]).toMatchObject({
        onConflict: 'org_id,provider,account_id',
      });
    });

    it('labels the account without leaking the admin\'s email address', async () => {
      const db = connectDb();
      const state = await mintState(db);
      await request(createApp(db, { fetchImpl: adobeFetchDouble().impl }))
        .get('/api/v1/integrations/adobe-sign/oauth/callback')
        .query({ state, code: 'auth-code' });

      const upsert = (captured(db, 'org_integrations', 'upsert')[0] ?? {}) as Record<string, unknown>;
      expect(upsert.account_label).toBe('Example Co');
      // Org-wide settings render account_label; a personal email there is a PII leak.
      expect(JSON.stringify(upsert)).not.toContain('admin@example.test');
    });

    it('records an oauth_connected integration event carrying the webhook id', async () => {
      const db = connectDb();
      const state = await mintState(db);
      await request(createApp(db, { fetchImpl: adobeFetchDouble().impl }))
        .get('/api/v1/integrations/adobe-sign/oauth/callback')
        .query({ state, code: 'auth-code' });

      const events = captured(db, 'integration_events', 'insert') as Array<Record<string, unknown>>;
      const connected = events.find((e) => e.event_type === 'oauth_connected');
      expect(connected).toBeDefined();
      expect(connected?.provider).toBe('adobe_sign');
      expect((connected?.details as Record<string, unknown>).webhook_id).toBe(ADOBE_WEBHOOK_ID);
    });

    it('never logs the access or refresh token', async () => {
      const db = connectDb();
      const state = await mintState(db);
      await request(createApp(db, { fetchImpl: adobeFetchDouble().impl }))
        .get('/api/v1/integrations/adobe-sign/oauth/callback')
        .query({ state, code: 'auth-code' });

      const serialized = JSON.stringify(
        [logger.info, logger.warn, logger.error, logger.debug].flatMap(
          (fn) => (fn as unknown as { mock: { calls: unknown[] } }).mock.calls,
        ),
      );
      expect(serialized).not.toContain('adobe-access-token');
      expect(serialized).not.toContain('adobe-refresh-token');
      expect(serialized).not.toContain('adobe-client-secret');
    });
  });

  describe('failure paths', () => {
    it('refuses to persist when Adobe returns no refresh token', async () => {
      const db = connectDb();
      const state = await mintState(db);
      const adobe = adobeFetchDouble({
        token: () =>
          new Response(
            JSON.stringify({
              access_token: 'a',
              token_type: 'Bearer',
              expires_in: 3600,
              api_access_point: API_ACCESS_POINT,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      });

      const res = await request(createApp(db, { fetchImpl: adobe.impl }))
        .get('/api/v1/integrations/adobe-sign/oauth/callback')
        .query({ state, code: 'auth-code' });

      expect(res.headers.location).toContain('adobe_sign_error=missing_refresh_token');
      expect(captured(db, 'org_integrations', 'upsert')).toHaveLength(0);
    });

    it('refuses to persist when Adobe omits api_access_point — the shard is unknowable without it', async () => {
      const db = connectDb();
      const state = await mintState(db);
      const adobe = adobeFetchDouble({
        token: () =>
          new Response(
            JSON.stringify({ access_token: 'a', refresh_token: 'r', token_type: 'Bearer', expires_in: 3600 }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      });

      const res = await request(createApp(db, { fetchImpl: adobe.impl }))
        .get('/api/v1/integrations/adobe-sign/oauth/callback')
        .query({ state, code: 'auth-code' });

      expect(res.headers.location).toContain('adobe_sign_error=missing_access_point');
      expect(captured(db, 'org_integrations', 'upsert')).toHaveLength(0);
    });

    it('does NOT persist an integration when the webhook create fails', async () => {
      // A row with a null webhook_id is precisely the broken state this change
      // exists to end: the UI would say "Connected" while no delivery could
      // ever resolve. Fail the connect instead.
      const db = connectDb();
      const state = await mintState(db);
      const adobe = adobeFetchDouble({
        webhookCreate: () =>
          new Response(JSON.stringify({ code: 'PERMISSION_DENIED' }), {
            status: 403,
            headers: { 'content-type': 'application/json' },
          }),
      });

      const res = await request(createApp(db, { fetchImpl: adobe.impl }))
        .get('/api/v1/integrations/adobe-sign/oauth/callback')
        .query({ state, code: 'auth-code' });

      expect(res.headers.location).toContain('adobe_sign_error=webhook_registration_failed');
      expect(captured(db, 'org_integrations', 'upsert')).toHaveLength(0);
    });

    it('cleans up the stranded refresh-token secret when the webhook create fails', async () => {
      const db = connectDb();
      const state = await mintState(db);
      const store = refreshTokenStoreDouble();
      const adobe = adobeFetchDouble({
        webhookCreate: () => new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } }),
      });

      await request(createApp(db, { fetchImpl: adobe.impl, refreshTokenStore: store }))
        .get('/api/v1/integrations/adobe-sign/oauth/callback')
        .query({ state, code: 'auth-code' });

      expect(store.delete).toHaveBeenCalled();
    });

    it('records a webhook_registration_failed event so the failure is diagnosable', async () => {
      const db = connectDb();
      const state = await mintState(db);
      const adobe = adobeFetchDouble({
        webhookCreate: () =>
          new Response(JSON.stringify({ code: 'PERMISSION_DENIED' }), {
            status: 403,
            headers: { 'content-type': 'application/json' },
          }),
      });

      await request(createApp(db, { fetchImpl: adobe.impl }))
        .get('/api/v1/integrations/adobe-sign/oauth/callback')
        .query({ state, code: 'auth-code' });

      const events = captured(db, 'integration_events', 'insert') as Array<Record<string, unknown>>;
      const failed = events.find((e) => e.event_type === 'webhook_registration_failed');
      expect(failed).toBeDefined();
      expect(failed?.status).toBe('error');
      // The Adobe status is what tells an operator "the account tier lacks
      // webhook_write" rather than leaving a bare message.
      expect((failed?.details as Record<string, unknown>).adobe_status).toBe(403);
    });

    it('deletes the orphaned Adobe webhook when the DB upsert fails', async () => {
      // Otherwise Adobe keeps delivering to a webhook id no row will ever hold.
      const db = connectDb({ upsertResult: { data: null, error: { message: 'boom' } } });
      const state = await mintState(db);
      const adobe = adobeFetchDouble();
      const store = refreshTokenStoreDouble();

      const res = await request(createApp(db, { fetchImpl: adobe.impl, refreshTokenStore: store }))
        .get('/api/v1/integrations/adobe-sign/oauth/callback')
        .query({ state, code: 'auth-code' });

      expect(res.headers.location).toContain('adobe_sign_error=save_failed');
      expect(store.delete).toHaveBeenCalled();
      const deleteCall = adobe.calls.find((c) => c.init?.method === 'DELETE');
      expect(deleteCall?.url).toBe(`${API_ACCESS_POINT}api/rest/v6/webhooks/${encodeURIComponent(ADOBE_WEBHOOK_ID)}`);
    });

    it('surfaces the partial-unique-index collision as webhook_already_claimed, not a generic save error', async () => {
      // Migration 0426's partial unique index on (provider, webhook_id) WHERE
      // revoked_at IS NULL is the tenant-isolation invariant: one active
      // integration per Adobe webhook. A 23505 here means another org already
      // claims this id, which is a security-relevant condition, not a blip.
      const db = connectDb({ upsertResult: { data: null, error: { code: '23505', message: 'duplicate key' } } });
      const state = await mintState(db);
      const adobe = adobeFetchDouble();

      const res = await request(createApp(db, { fetchImpl: adobe.impl }))
        .get('/api/v1/integrations/adobe-sign/oauth/callback')
        .query({ state, code: 'auth-code' });

      expect(res.headers.location).toContain('adobe_sign_error=webhook_already_claimed');
    });

    it('redirects with callback_failed — never a 500 body — when the token exchange throws', async () => {
      const db = connectDb();
      const state = await mintState(db);
      const adobe = adobeFetchDouble({
        token: () =>
          new Response(JSON.stringify({ error: 'invalid_grant' }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          }),
      });

      const res = await request(createApp(db, { fetchImpl: adobe.impl }))
        .get('/api/v1/integrations/adobe-sign/oauth/callback')
        .query({ state, code: 'auth-code' });

      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('adobe_sign_error=callback_failed');
    });
  });
});

/* ────────────────────────── POST /disconnect ───────────────────────── */

describe('POST /adobe-sign/disconnect', () => {
  const activeIntegration = [
    {
      id: TEST_INTEGRATION_ID,
      account_id: 'adobe-user-1',
      token_secret_name: 'projects/test-project/secrets/arkova-adobe-sign-x-refresh-token',
      webhook_id: ADOBE_WEBHOOK_ID,
      base_uri: API_ACCESS_POINT,
    },
  ];

  function disconnectDb(rows: unknown = activeIntegration) {
    const captures: Array<{ table: string; method: string; value: unknown }> = [];
    let integrationCall = 0;
    const from = vi.fn((table: string) => {
      const capture = (method: string, value: unknown) => captures.push({ table, method, value });
      if (table === 'org_members') return mockQuery({ data: { role: 'admin' }, error: null }, capture);
      if (table === 'org_integrations') {
        integrationCall += 1;
        // 1st call = SELECT of active rows; 2nd = the revoking UPDATE.
        if (integrationCall === 1) return mockQuery({ data: rows, error: null }, capture);
        return mockQuery({ data: [{ id: TEST_INTEGRATION_ID }], error: null }, capture);
      }
      return mockQuery({ data: null, error: null }, capture);
    });
    return { from, captures };
  }

  it('401s an unauthenticated caller', async () => {
    const res = await request(createApp(disconnectDb(), {}, false))
      .post('/api/v1/integrations/adobe-sign/disconnect')
      .send({ org_id: TEST_ORG_ID });
    expect(res.status).toBe(401);
  });

  it('403s a non-admin', async () => {
    const db = {
      from: vi.fn(() => mockQuery({ data: { role: 'member' }, error: null })),
    };
    const res = await request(createApp(db))
      .post('/api/v1/integrations/adobe-sign/disconnect')
      .send({ org_id: TEST_ORG_ID });
    expect(res.status).toBe(403);
  });

  it('is NOT gated on org verification — a lapsed org must still be able to disconnect', async () => {
    const db = disconnectDb();
    const res = await request(createApp(db, { fetchImpl: adobeFetchDouble().impl }))
      .post('/api/v1/integrations/adobe-sign/disconnect')
      .send({ org_id: TEST_ORG_ID });

    expect(res.status).toBe(200);
    expect(captured(db, 'organizations', 'select')).toHaveLength(0);
  });

  it('deletes the Adobe-side webhook so a revoked org stops being delivered to', async () => {
    const db = disconnectDb();
    const adobe = adobeFetchDouble();
    const res = await request(createApp(db, { fetchImpl: adobe.impl }))
      .post('/api/v1/integrations/adobe-sign/disconnect')
      .send({ org_id: TEST_ORG_ID });

    expect(res.status).toBe(200);
    expect(res.body.disconnected).toBe(true);
    expect(res.body.adobe_webhook_removed).toBe(true);
    const del = adobe.calls.find((c) => c.init?.method === 'DELETE');
    expect(del?.url).toBe(`${API_ACCESS_POINT}api/rest/v6/webhooks/${encodeURIComponent(ADOBE_WEBHOOK_ID)}`);
  });

  it('refreshes the access token before the delete — the stored one is an hour old at best', async () => {
    const db = disconnectDb();
    const adobe = adobeFetchDouble();
    await request(createApp(db, { fetchImpl: adobe.impl }))
      .post('/api/v1/integrations/adobe-sign/disconnect')
      .send({ org_id: TEST_ORG_ID });

    const refreshIdx = adobe.calls.findIndex((c) => c.url.endsWith('/oauth/v2/refresh'));
    const deleteIdx = adobe.calls.findIndex((c) => c.init?.method === 'DELETE');
    expect(refreshIdx).toBeGreaterThanOrEqual(0);
    expect(deleteIdx).toBeGreaterThan(refreshIdx);
    const del = adobe.calls[deleteIdx];
    expect((del.init?.headers as Record<string, string>).Authorization).toBe('Bearer refreshed-access-token');
  });

  it('revokes the refresh token at Adobe and deletes the Secret Manager secret', async () => {
    const db = disconnectDb();
    const store = refreshTokenStoreDouble();
    const adobe = adobeFetchDouble();
    await request(createApp(db, { fetchImpl: adobe.impl, refreshTokenStore: store }))
      .post('/api/v1/integrations/adobe-sign/disconnect')
      .send({ org_id: TEST_ORG_ID });

    expect(adobe.calls.some((c) => c.url.endsWith('/oauth/v2/revoke'))).toBe(true);
    expect(store.delete).toHaveBeenCalledWith({ name: activeIntegration[0].token_secret_name });
  });

  it('clears webhook_id along with the credentials so the id cannot resolve again', async () => {
    const db = disconnectDb();
    await request(createApp(db, { fetchImpl: adobeFetchDouble().impl }))
      .post('/api/v1/integrations/adobe-sign/disconnect')
      .send({ org_id: TEST_ORG_ID });

    const update = (captured(db, 'org_integrations', 'update')[0] ?? {}) as Record<string, unknown>;
    expect(update.revoked_at).toBeTruthy();
    expect(update.webhook_id).toBeNull();
    expect(update.encrypted_tokens).toBeNull();
    expect(update.token_kms_key_id).toBeNull();
    expect(update.token_secret_name).toBeNull();
  });

  it('writes a SECURITY audit_events row (SOC 2 CC7.2)', async () => {
    const db = disconnectDb();
    await request(createApp(db, { fetchImpl: adobeFetchDouble().impl }))
      .post('/api/v1/integrations/adobe-sign/disconnect')
      .send({ org_id: TEST_ORG_ID });

    const audits = captured(db, 'audit_events', 'insert') as Array<Record<string, unknown>>;
    expect(audits[0]).toMatchObject({
      event_type: 'integration.adobe_sign_disconnected',
      event_category: 'SECURITY',
      actor_id: TEST_USER_ID,
      org_id: TEST_ORG_ID,
    });
  });

  it('still completes the local disconnect when Adobe webhook deletion fails, and says so', async () => {
    // Leaving the org permanently "connected" because Adobe is unreachable is
    // worse than a stranded webhook: the local teardown (tokens revoked,
    // secret deleted, row revoked) is the security-relevant half and always
    // completes. The stranded webhook is surfaced, not swallowed, because it
    // needs a manual cleanup in Adobe's console.
    const db = disconnectDb();
    const adobe = adobeFetchDouble({
      webhookDelete: () =>
        new Response(JSON.stringify({ code: 'PERMISSION_DENIED' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
    });

    const res = await request(createApp(db, { fetchImpl: adobe.impl }))
      .post('/api/v1/integrations/adobe-sign/disconnect')
      .send({ org_id: TEST_ORG_ID });

    expect(res.status).toBe(200);
    expect(res.body.disconnected).toBe(true);
    expect(res.body.adobe_webhook_removed).toBe(false);
    const update = (captured(db, 'org_integrations', 'update')[0] ?? {}) as Record<string, unknown>;
    expect(update.revoked_at).toBeTruthy();
    const events = captured(db, 'integration_events', 'insert') as Array<Record<string, unknown>>;
    expect(events.some((e) => e.event_type === 'webhook_teardown_failed' && e.status === 'warning')).toBe(true);
  });

  it('is idempotent when there is nothing connected', async () => {
    const db = disconnectDb([]);
    const adobe = adobeFetchDouble();
    const res = await request(createApp(db, { fetchImpl: adobe.impl }))
      .post('/api/v1/integrations/adobe-sign/disconnect')
      .send({ org_id: TEST_ORG_ID });

    expect(res.status).toBe(200);
    expect(res.body.disconnected).toBe(true);
    expect(adobe.calls).toHaveLength(0);
  });

  it('tears down a row that never got a webhook_id without calling Adobe DELETE', async () => {
    const db = disconnectDb([{ ...activeIntegration[0], webhook_id: null }]);
    const adobe = adobeFetchDouble();
    const res = await request(createApp(db, { fetchImpl: adobe.impl }))
      .post('/api/v1/integrations/adobe-sign/disconnect')
      .send({ org_id: TEST_ORG_ID });

    expect(res.status).toBe(200);
    expect(adobe.calls.some((c) => c.init?.method === 'DELETE')).toBe(false);
  });

  it('never logs the stored refresh token', async () => {
    const db = disconnectDb();
    await request(createApp(db, { fetchImpl: adobeFetchDouble().impl }))
      .post('/api/v1/integrations/adobe-sign/disconnect')
      .send({ org_id: TEST_ORG_ID });

    const serialized = JSON.stringify(
      [logger.info, logger.warn, logger.error, logger.debug].flatMap(
        (fn) => (fn as unknown as { mock: { calls: unknown[] } }).mock.calls,
      ),
    );
    expect(serialized).not.toContain('stored-refresh-token');
  });
});
