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

vi.mock('../../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../../utils/db.js', () => ({
  db: {},
}));

import { createDriveOAuthRouter } from './drive-oauth.js';

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
  chain.upsert = vi.fn((value: unknown) => {
    capture?.('upsert', value);
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

describe('Drive OAuth router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    const db = {
      from: vi.fn(() => mockQuery({ data: { role: 'admin' }, error: null })),
    };
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
    const db = {
      from: vi.fn(() => mockQuery({ data: { role: 'admin' }, error: null })),
    };
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
    const db = {
      from: vi.fn(() => mockQuery({ data: { role: 'admin' }, error: null })),
    };
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
    const db = {
      from: vi.fn(() => mockQuery({ data: { role: 'member' }, error: null })),
    };
    const app = createApp(db);

    const res = await request(app)
      .post('/api/v1/integrations/google_drive/oauth/start')
      .send({ org_id: TEST_ORG_ID });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('org admin');
  });

  it('exchanges callback code, encrypts tokens, stores integration state, and redirects to settings', async () => {
    const captured: Record<string, unknown[]> = {};
    const capture = (method: string, value: unknown) => {
      captured[method] = [...(captured[method] ?? []), value];
    };
    const db = {
      from: vi.fn((table: string) => {
        if (table === 'org_members') return mockQuery({ data: { role: 'owner' }, error: null });
        if (table === 'org_integrations') return mockQuery({ data: { id: 'integration-1' }, error: null }, capture);
        if (table === 'integration_events') return mockQuery({ data: null, error: null }, capture);
        return mockQuery({ data: null, error: null }, capture);
      }),
    };

    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
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
    expect(label.channel_token).toBe(TEST_ORG_ID);
    expect(label.resource_id).toBe('drive-resource-1');
    expect(upsert.encrypted_tokens).toBe('\\x656e637279707465642d746f6b656e2d7061796c6f6164');
    // subscription_id must be the channel UUID we generated (not Google's resourceId)
    expect(upsert.subscription_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(upsert.subscription_id).not.toBe('drive-resource-1');
    expect(JSON.stringify(upsert)).not.toContain('access-token-secret');
    expect(captured.insert?.[0]).toMatchObject({
      org_id: TEST_ORG_ID,
      provider: 'google_drive',
      event_type: 'oauth_connected',
      status: 'success',
    });
  });

  it('disconnects active Drive integrations and calls stopChannel + revokeOAuthToken', async () => {
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
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
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
    expect(fetchCalls.some(u => u.includes('channels/stop'))).toBe(true);
    expect(fetchCalls.some(u => u.includes('revoke'))).toBe(true);
    expect(captured.update?.[0]).toMatchObject({
      encrypted_tokens: null,
      token_kms_key_id: null,
      subscription_id: null,
    });
  });
});
