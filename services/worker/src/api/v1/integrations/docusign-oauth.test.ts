import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { KmsClient } from '../../../integrations/oauth/crypto.js';

const TEST_ORG_ID = '11111111-1111-4111-8111-111111111111';
const TEST_ORG_PUBLIC_ID = 'ORG-ARKOVA-TEST';
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

import { createDocusignOAuthRouter } from './docusign-oauth.js';
import { logger } from '../../../utils/logger.js';

type DocusignRouterDeps = NonNullable<Parameters<typeof createDocusignOAuthRouter>[0]>;
type FetchInput = string | URL | Request;

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

function asTestDb(db: unknown): DocusignRouterDeps['db'] {
  return db as DocusignRouterDeps['db'];
}

/**
 * SCRUM-2361 (DS-01): the connect path now performs TWO lookups —
 * `org_members` (admin gate) then `organizations` (verified-org gate). This
 * table-aware mock satisfies both for the happy path; pass a role and an
 * org verification status. Unknown tables resolve empty (success, no rows).
 */
function verifiedConnectDb(
  role: 'admin' | 'owner' | 'member' = 'admin',
  verificationStatus: 'VERIFIED' | 'PENDING' | 'UNVERIFIED' = 'VERIFIED',
  suspended = false,
) {
  return {
    from: vi.fn((table: string) => {
      if (table === 'org_members') return mockQuery({ data: { role }, error: null });
      if (table === 'organizations') {
        return mockQuery({ data: { id: TEST_ORG_ID, verification_status: verificationStatus, suspended }, error: null });
      }
      return mockQuery({ data: null, error: null });
    }),
  };
}

function createApp(db: unknown, overrides: Partial<DocusignRouterDeps> = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { userId: string }).userId = TEST_USER_ID;
    next();
  });
  app.use(
    '/api/v1/integrations',
    createDocusignOAuthRouter({
      db: asTestDb(db),
      env: {
        DOCUSIGN_INTEGRATION_KEY: 'docusign-client',
        DOCUSIGN_CLIENT_SECRET: 'docusign-client-secret',
        DOCUSIGN_DEMO: 'true',
        GCP_SECRET_MANAGER_PROJECT_ID: 'test-project',
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
      ...overrides,
    }),
  );
  return app;
}

function createUnauthenticatedApp(db: unknown, overrides: Partial<DocusignRouterDeps> = {}) {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/v1/integrations',
    createDocusignOAuthRouter({
      db: asTestDb(db),
      env: {
        DOCUSIGN_INTEGRATION_KEY: 'docusign-client',
        DOCUSIGN_CLIENT_SECRET: 'docusign-client-secret',
        DOCUSIGN_DEMO: 'true',
        GCP_SECRET_MANAGER_PROJECT_ID: 'test-project',
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
      ...overrides,
    }),
  );
  return app;
}

describe('DocuSign OAuth router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // 2026-04-24 forensic audit finding H1 (same class as Drive SCRUM-1236 /
  // AUDIT-0424-11): the OAuth `state` HMAC must come from a dedicated env var
  // and fail closed when unset. The previous `?? config.supabaseJwtSecret ??
  // config.supabaseServiceKey` fallback collapsed the user-auth and OAuth-CSRF
  // trust boundaries — a leaked Supabase JWT secret would make every DocuSign
  // OAuth `state` forgeable. Drive was fixed under SCRUM-1236; DocuSign was the
  // remaining half of H1.
  it('H1: fails closed when neither stateSecret nor INTEGRATION_STATE_HMAC_SECRET is set', () => {
    const db = { from: vi.fn() };
    expect(() =>
      createDocusignOAuthRouter({
        db: asTestDb(db),
        // No stateSecret. Empty env (no INTEGRATION_STATE_HMAC_SECRET).
        env: {
          DOCUSIGN_INTEGRATION_KEY: 'docusign-client',
          DOCUSIGN_CLIENT_SECRET: 'docusign-client-secret',
          DOCUSIGN_DEMO: 'true',
        },
        frontendUrl: 'http://localhost:5173',
      }),
    ).toThrow(/INTEGRATION_STATE_HMAC_SECRET/);
  });

  it('H1: uses INTEGRATION_STATE_HMAC_SECRET from env when provided', async () => {
    const db = verifiedConnectDb('admin');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { userId: string }).userId = TEST_USER_ID;
      next();
    });
    app.use('/api/v1/integrations', createDocusignOAuthRouter({
      db: asTestDb(db),
      env: {
        DOCUSIGN_INTEGRATION_KEY: 'docusign-client',
        DOCUSIGN_CLIENT_SECRET: 'docusign-client-secret',
        DOCUSIGN_DEMO: 'true',
        INTEGRATION_STATE_HMAC_SECRET: 'env-state-secret',
      },
      frontendUrl: 'http://localhost:5173',
      now: () => new Date('2026-04-24T12:00:00.000Z'),
    }));

    const res = await request(app)
      .post('/api/v1/integrations/docusign/oauth/start')
      .set('host', 'worker.test')
      .send({ org_id: TEST_ORG_ID });

    expect(res.status).toBe(200);
    expect(res.body.authorizationUrl).toContain('account-d.docusign.com');
  });

  it('H1: state HMAC does NOT fall back to supabaseJwtSecret', async () => {
    // Build a state using supabaseJwtSecret (the old fallback) — verify should
    // reject because the new code requires the dedicated secret.
    const db = {
      from: vi.fn(() => mockQuery({ data: { role: 'admin' }, error: null })),
    };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { userId: string }).userId = TEST_USER_ID;
      next();
    });
    app.use('/api/v1/integrations', createDocusignOAuthRouter({
      db: asTestDb(db),
      env: {
        DOCUSIGN_INTEGRATION_KEY: 'docusign-client',
        DOCUSIGN_CLIENT_SECRET: 'docusign-client-secret',
        DOCUSIGN_DEMO: 'true',
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
      .get('/api/v1/integrations/docusign/oauth/callback')
      .set('host', 'worker.test')
      .query({ code: 'x', state: forgedState });

    // Forged state must redirect with invalid_state — not be accepted.
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('docusign_error=invalid_state');
  });

  it('starts OAuth for org admins and returns a DocuSign authorization URL', async () => {
    const db = verifiedConnectDb('admin');
    const app = createApp(db);

    const res = await request(app)
      .post('/api/v1/integrations/docusign/oauth/start')
      .set('host', 'worker.test')
      .send({
        org_id: TEST_ORG_ID,
        return_to: 'http://localhost:5173/organizations/org-1?tab=settings',
      });

    expect(res.status).toBe(200);
    expect(res.body.authorizationUrl).toContain('https://account-d.docusign.com/oauth/auth');
    const url = new URL(res.body.authorizationUrl);
    expect(url.searchParams.get('client_id')).toBe('docusign-client');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://worker.test/api/v1/integrations/docusign/oauth/callback',
    );
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('scope')).toBe('signature extended openid email');
  });

  it('rejects OAuth start when the caller is not an org admin', async () => {
    const db = {
      from: vi.fn(() => mockQuery({ data: { role: 'member' }, error: null })),
    };
    const app = createApp(db);

    const res = await request(app)
      .post('/api/v1/integrations/docusign/oauth/start')
      .send({ org_id: TEST_ORG_ID });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('org admin');
  });

  it('exchanges callback code, stores the refresh token in Secret Manager, stores only the handle in Postgres, and redirects to settings', async () => {
    const captured: Record<string, unknown[]> = {};
    const capture = (method: string, value: unknown) => {
      captured[method] = [...(captured[method] ?? []), value];
    };
    const secretWrites: Array<{ name: string; value: string }> = [];
    const db = {
      from: vi.fn((table: string) => {
        if (table === 'org_members') return mockQuery({ data: { role: 'owner' }, error: null });
        if (table === 'organizations') return mockQuery({ data: { id: TEST_ORG_ID, verification_status: 'VERIFIED' }, error: null }, capture);
        if (table === 'org_integrations') return mockQuery({ data: { id: 'integration-1' }, error: null }, capture);
        if (table === 'integration_events') return mockQuery({ data: null, error: null }, capture);
        return mockQuery({ data: null, error: null }, capture);
      }),
    };

    const fetchImpl = vi.fn(async (input: FetchInput) => {
      const url = String(input);
      if (url === 'https://account-d.docusign.com/oauth/token') {
        return new Response(JSON.stringify({
          access_token: 'access-token-aaaaaaaa',
          expires_in: 3600,
          refresh_token: 'refresh-token-aaaaaaaa',
          scope: 'signature extended',
          token_type: 'Bearer',
        }), { status: 200 });
      }
      if (url === 'https://account-d.docusign.com/oauth/userinfo') {
        return new Response(JSON.stringify({
          sub: 'docusign-sub-1',
          email: 'admin@example.com',
          accounts: [{
            account_id: 'docusign-account-1',
            base_uri: 'https://demo.docusign.net',
            is_default: true,
          }],
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
    const deps = {
      db: asTestDb(db),
      env: {
        DOCUSIGN_INTEGRATION_KEY: 'docusign-client',
        DOCUSIGN_CLIENT_SECRET: 'docusign-client-secret',
        DOCUSIGN_DEMO: 'true',
        GCP_SECRET_MANAGER_PROJECT_ID: 'test-project',
        GCP_KMS_INTEGRATION_TOKEN_KEY: 'projects/p/locations/l/keyRings/r/cryptoKeys/k',
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      stateSecret: 'test-state-secret',
      frontendUrl: 'http://localhost:5173',
      now: () => new Date('2026-04-24T12:00:00.000Z'),
      kms: {
        async encrypt({ plaintext }: { plaintext: Buffer }) {
          // Access token metadata may be encrypted, but the long-lived refresh
          // token must live in Secret Manager rather than DB ciphertext.
          expect(plaintext.toString('utf8')).not.toContain('refresh-token-aaaaaaaa');
          return Buffer.from('encrypted-token-payload');
        },
        async decrypt() {
          return Buffer.from('{}');
        },
      },
      refreshTokenStore: {
        async put({ name, value }: { name: string; value: string }) {
          secretWrites.push({ name, value });
        },
        async get() {
          return null;
        },
        async delete() {
          return undefined;
        },
      },
    };
    app.use('/api/v1/integrations', createDocusignOAuthRouter(deps));

    const start = await request(app)
      .post('/api/v1/integrations/docusign/oauth/start')
      .set('host', 'worker.test')
      .send({
        org_id: TEST_ORG_ID,
        return_to: 'http://localhost:5173/organizations/org-1?tab=settings',
      });
    const state = new URL(start.body.authorizationUrl).searchParams.get('state');

    const callback = await request(app)
      .get('/api/v1/integrations/docusign/oauth/callback')
      .set('host', 'worker.test')
      .query({ code: 'docusign-code', state });

    expect(callback.status).toBe(302);
    expect(callback.headers.location).toBe(
      'http://localhost:5173/organizations/org-1?tab=settings&docusign=connected',
    );
    const upsert = captured.upsert?.[0] as Record<string, unknown>;
    expect(upsert.provider).toBe('docusign');
    expect(upsert.account_id).toBe('docusign-account-1');
    expect(upsert.account_label).toBe('docusign-account-1');
    expect(upsert.base_uri).toBe('https://demo.docusign.net');
    expect(upsert.encrypted_tokens).toBe('\\x656e637279707465642d746f6b656e2d7061796c6f6164');
    expect(upsert.token_secret_name).toMatch(/^projects\/test-project\/secrets\/arkova-docusign-/);
    expect(secretWrites).toEqual([
      {
        name: upsert.token_secret_name as string,
        value: 'refresh-token-aaaaaaaa',
      },
    ]);
    expect(JSON.stringify(upsert)).not.toContain('refresh-token-aaaaaaaa');
    expect(JSON.stringify(upsert)).not.toContain('access-token-aaaaaaaa');
    expect(captured.insert?.[0]).toMatchObject({
      org_id: TEST_ORG_ID,
      provider: 'docusign',
      event_type: 'oauth_connected',
      status: 'success',
      details: {
        account_id: 'docusign-account-1',
        account_label: 'docusign-account-1',
      },
    });
  });

  it('redirects with invalid_state when the state token is forged', async () => {
    const db = {
      from: vi.fn(() => mockQuery({ data: { role: 'admin' }, error: null })),
    };
    const app = createApp(db);

    const res = await request(app)
      .get('/api/v1/integrations/docusign/oauth/callback')
      .set('host', 'worker.test')
      .query({ code: 'docusign-code', state: 'tampered.state' });

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('docusign_error=invalid_state');
  });

  it('disconnects active DocuSign integrations for org admins', async () => {
    const captured: Record<string, unknown[]> = {};
    const deletedSecrets: string[] = [];
    const capture = (method: string, value: unknown) => {
      captured[method] = [...(captured[method] ?? []), value];
    };
    const db = {
      from: vi.fn((table: string) => {
        if (table === 'org_members') return mockQuery({ data: { role: 'admin' }, error: null });
        if (table === 'org_integrations') {
          return mockQuery({
            data: [{
              id: 'integration-1',
              token_secret_name: 'projects/test-project/secrets/arkova-docusign-refresh-token',
            }],
            error: null,
          }, capture);
        }
        if (table === 'integration_events') return mockQuery({ data: null, error: null }, capture);
        return mockQuery({ data: null, error: null });
      }),
    };
    const app = createApp(db, {
      refreshTokenStore: {
        async put() { return undefined; },
        async get() { return null; },
        async delete({ name }: { name: string }) {
          deletedSecrets.push(name);
        },
      },
    });

    const res = await request(app)
      .post('/api/v1/integrations/docusign/disconnect')
      .send({ org_id: TEST_ORG_ID });

    expect(res.status).toBe(200);
    expect(res.body.disconnected).toBe(true);
    expect(deletedSecrets).toEqual([
      'projects/test-project/secrets/arkova-docusign-refresh-token',
    ]);
    expect(captured.update?.[0]).toMatchObject({
      encrypted_tokens: null,
      token_kms_key_id: null,
      token_secret_name: null,
    });
    expect(captured.insert?.[0]).toMatchObject({
      event_type: 'oauth_disconnected',
      status: 'success',
    });
  });

  it('writes audit_events on successful disconnect (SCRUM-2039, SOC 2 CC7.2)', async () => {
    const auditInserts: unknown[] = [];
    const db = {
      from: vi.fn((table: string) => {
        if (table === 'org_members') return mockQuery({ data: { role: 'admin' }, error: null });
        if (table === 'org_integrations') {
          return mockQuery({
            data: [{
              id: 'integration-1',
              token_secret_name: 'projects/test-project/secrets/arkova-docusign-refresh-token',
            }],
            error: null,
          });
        }
        if (table === 'integration_events') return mockQuery({ data: null, error: null });
        if (table === 'audit_events') {
          return mockQuery({ data: null, error: null }, (method, value) => {
            if (method === 'insert') auditInserts.push(value);
          });
        }
        return mockQuery({ data: null, error: null });
      }),
    };
    const app = createApp(db, {
      refreshTokenStore: {
        async put() { return undefined; },
        async get() { return null; },
        async delete() { /* no-op */ },
      },
    });

    const res = await request(app)
      .post('/api/v1/integrations/docusign/disconnect')
      .send({ org_id: TEST_ORG_ID });

    expect(res.status).toBe(200);
    expect(res.body.disconnected).toBe(true);
    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0]).toMatchObject({
      event_type: 'integration.docusign_disconnected',
      event_category: 'SECURITY',
      actor_id: TEST_USER_ID,
      org_id: TEST_ORG_ID,
      target_type: 'integration',
      target_id: 'integration-1',
    });
    const details = JSON.parse((auditInserts[0] as Record<string, string>).details);
    expect(details.provider).toBe('docusign');
  });

  it('logs but does not fail disconnect when audit_events insert errors (SCRUM-2039)', async () => {
    const db = {
      from: vi.fn((table: string) => {
        if (table === 'org_members') return mockQuery({ data: { role: 'admin' }, error: null });
        if (table === 'org_integrations') {
          return mockQuery({
            data: [{ id: 'integration-1', token_secret_name: 'projects/p/secrets/s' }],
            error: null,
          });
        }
        if (table === 'integration_events') return mockQuery({ data: null, error: null });
        if (table === 'audit_events') return mockQuery({ data: null, error: { message: 'DB write failed' } });
        return mockQuery({ data: null, error: null });
      }),
    };
    const app = createApp(db, {
      refreshTokenStore: {
        async put() { return undefined; },
        async get() { return null; },
        async delete() { /* no-op */ },
      },
    });

    const res = await request(app)
      .post('/api/v1/integrations/docusign/disconnect')
      .send({ org_id: TEST_ORG_ID });

    expect(res.status).toBe(200);
    expect(res.body.disconnected).toBe(true);
    await vi.waitFor(() => expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: TEST_ORG_ID }),
      'Failed to write DocuSign disconnect audit event',
    ));
  });

  it('surfaces refresh-token secret deletion failures during disconnect', async () => {
    const captured: Record<string, unknown[]> = {};
    const capture = (method: string, value: unknown) => {
      captured[method] = [...(captured[method] ?? []), value];
    };
    const db = {
      from: vi.fn((table: string) => {
        if (table === 'org_members') return mockQuery({ data: { role: 'admin' }, error: null });
        if (table === 'org_integrations') {
          return mockQuery({
            data: [{
              id: 'integration-1',
              token_secret_name: 'projects/test-project/secrets/arkova-docusign-refresh-token',
            }],
            error: null,
          }, capture);
        }
        if (table === 'integration_events') return mockQuery({ data: null, error: null }, capture);
        return mockQuery({ data: null, error: null });
      }),
    };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { userId: string }).userId = TEST_USER_ID;
      next();
    });
    app.use('/api/v1/integrations', createDocusignOAuthRouter({
      db: asTestDb(db),
      env: {
        DOCUSIGN_INTEGRATION_KEY: 'docusign-client',
        DOCUSIGN_CLIENT_SECRET: 'docusign-client-secret',
        DOCUSIGN_DEMO: 'true',
        GCP_SECRET_MANAGER_PROJECT_ID: 'test-project',
        GCP_KMS_INTEGRATION_TOKEN_KEY: 'projects/p/locations/l/keyRings/r/cryptoKeys/k',
      },
      stateSecret: 'test-state-secret',
      frontendUrl: 'http://localhost:5173',
      now: () => new Date('2026-04-24T12:00:00.000Z'),
      kms: {
        async encrypt() { return Buffer.from('encrypted-token-payload'); },
        async decrypt() { return Buffer.from('{}'); },
      },
      refreshTokenStore: {
        async put() { return undefined; },
        async get() { return null; },
        async delete() { throw new Error('secret delete failed'); },
      },
    }));

    const res = await request(app)
      .post('/api/v1/integrations/docusign/disconnect')
      .send({ org_id: TEST_ORG_ID });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to delete DocuSign refresh token secret');
    expect(captured.update).toBeUndefined();
    expect(captured.insert).toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: TEST_ORG_ID,
        tokenSecretNames: ['projects/test-project/secrets/arkova-docusign-refresh-token'],
      }),
      'DocuSign refresh-token secret deletion failed during disconnect',
    );
  });

  it('fails disconnect when the existing integration lookup errors before secret cleanup', async () => {
    const captured: Record<string, unknown[]> = {};
    const capture = (method: string, value: unknown) => {
      captured[method] = [...(captured[method] ?? []), value];
    };
    let integrationQueryCount = 0;
    const db = {
      from: vi.fn((table: string) => {
        if (table === 'org_members') return mockQuery({ data: { role: 'admin' }, error: null });
        if (table === 'org_integrations') {
          integrationQueryCount += 1;
          if (integrationQueryCount === 1) {
            return mockQuery({ data: null, error: { message: 'db unavailable' } }, capture);
          }
          return mockQuery({ data: [{ id: 'integration-1' }], error: null }, capture);
        }
        if (table === 'integration_events') return mockQuery({ data: null, error: null }, capture);
        return mockQuery({ data: null, error: null });
      }),
    };
    const app = createApp(db);

    const res = await request(app)
      .post('/api/v1/integrations/docusign/disconnect')
      .send({ org_id: TEST_ORG_ID });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to disconnect DocuSign');
    expect(captured.update).toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: TEST_ORG_ID }),
      'DocuSign disconnect existing integration lookup failed',
    );
  });

  it('logs and redirects when refresh-token cleanup fails after an upsert error', async () => {
    const captured: Record<string, unknown[]> = {};
    const capture = (method: string, value: unknown) => {
      captured[method] = [...(captured[method] ?? []), value];
    };
    const secretDeletes: string[] = [];
    const db = {
      from: vi.fn((table: string) => {
        if (table === 'org_members') return mockQuery({ data: { role: 'owner' }, error: null });
        if (table === 'organizations') return mockQuery({ data: { id: TEST_ORG_ID, verification_status: 'VERIFIED' }, error: null }, capture);
        if (table === 'org_integrations') return mockQuery({ data: null, error: { message: 'upsert failed' } }, capture);
        if (table === 'integration_events') return mockQuery({ data: null, error: null }, capture);
        return mockQuery({ data: null, error: null }, capture);
      }),
    };

    const fetchImpl = vi.fn(async (input: FetchInput) => {
      const url = String(input);
      if (url === 'https://account-d.docusign.com/oauth/token') {
        return new Response(JSON.stringify({
          access_token: 'access-token-upsert-fail',
          expires_in: 3600,
          refresh_token: 'refresh-token-upsert-fail',
          scope: 'signature extended',
          token_type: 'Bearer',
        }), { status: 200 });
      }
      if (url === 'https://account-d.docusign.com/oauth/userinfo') {
        return new Response(JSON.stringify({
          sub: 'docusign-sub-1',
          email: 'admin@example.com',
          accounts: [{
            account_id: 'docusign-account-1',
            account_name: 'Acme Legal',
            base_uri: 'https://demo.docusign.net',
            is_default: true,
          }],
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
    app.use('/api/v1/integrations', createDocusignOAuthRouter({
      db: asTestDb(db),
      env: {
        DOCUSIGN_INTEGRATION_KEY: 'docusign-client',
        DOCUSIGN_CLIENT_SECRET: 'docusign-client-secret',
        DOCUSIGN_DEMO: 'true',
        GCP_SECRET_MANAGER_PROJECT_ID: 'test-project',
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
      refreshTokenStore: {
        async put() { return undefined; },
        async get() { return null; },
        async delete({ name }: { name: string }) {
          secretDeletes.push(name);
          throw new Error('secret delete failed');
        },
      },
    }));

    const start = await request(app)
      .post('/api/v1/integrations/docusign/oauth/start')
      .set('host', 'worker.test')
      .send({
        org_id: TEST_ORG_ID,
        return_to: 'http://localhost:5173/organizations/org-1?tab=settings',
      });
    const state = new URL(start.body.authorizationUrl).searchParams.get('state');

    const callback = await request(app)
      .get('/api/v1/integrations/docusign/oauth/callback')
      .set('host', 'worker.test')
      .query({ code: 'docusign-code', state });

    expect(callback.status).toBe(302);
    expect(callback.headers.location).toContain('docusign_error=save_failed');
    expect(secretDeletes).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: TEST_ORG_ID,
        tokenSecretName: secretDeletes[0],
      }),
      'DocuSign refresh-token secret cleanup failed after upsert error',
    );
  });

  it('provisions a Connect listener after successful OAuth callback', async () => {
    const captured: Record<string, unknown[]> = {};
    const capture = (method: string, value: unknown) => {
      captured[method] = [...(captured[method] ?? []), value];
    };
    const db = {
      from: vi.fn((table: string) => {
        if (table === 'org_members') return mockQuery({ data: { role: 'owner' }, error: null });
        if (table === 'organizations') return mockQuery({ data: { id: TEST_ORG_ID, verification_status: 'VERIFIED' }, error: null }, capture);
        if (table === 'org_integrations') return mockQuery({ data: { id: 'integration-1' }, error: null }, capture);
        if (table === 'integration_events') return mockQuery({ data: null, error: null }, capture);
        return mockQuery({ data: null, error: null }, capture);
      }),
    };

    const fetchImpl = vi.fn(async (input: FetchInput, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://account-d.docusign.com/oauth/token') {
        return new Response(JSON.stringify({
          access_token: 'access-token-provision',
          expires_in: 3600,
          refresh_token: 'refresh-token-provision',
          scope: 'signature extended',
          token_type: 'Bearer',
        }), { status: 200 });
      }
      if (url === 'https://account-d.docusign.com/oauth/userinfo') {
        return new Response(JSON.stringify({
          sub: 'docusign-sub-1',
          email: 'admin@example.com',
          accounts: [{
            account_id: 'docusign-account-1',
            account_name: 'Acme Legal',
            base_uri: 'https://demo.docusign.net',
            is_default: true,
          }],
        }), { status: 200 });
      }
      // Connect list — no existing listeners (GET request)
      if (url.includes('/connect') && (!init?.method || init.method === 'GET')) {
        return new Response(JSON.stringify({ configurations: [] }), { status: 200 });
      }
      // Connect create (POST request)
      if (url.includes('/connect') && init?.method === 'POST') {
        return new Response(JSON.stringify({ connectId: '99001' }), { status: 201 });
      }
      return new Response('{}', { status: 404 });
    });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { userId: string }).userId = TEST_USER_ID;
      next();
    });
    app.use('/api/v1/integrations', createDocusignOAuthRouter({
      db: asTestDb(db),
      env: {
        DOCUSIGN_INTEGRATION_KEY: 'docusign-client',
        DOCUSIGN_CLIENT_SECRET: 'docusign-client-secret',
        DOCUSIGN_DEMO: 'true',
        DOCUSIGN_CONNECT_HMAC_SECRET: 'hmac-secret-123',
        WORKER_PUBLIC_URL: 'https://arkova-worker.example.com',
        GCP_SECRET_MANAGER_PROJECT_ID: 'test-project',
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
      refreshTokenStore: {
        async put() { return undefined; },
        async get() { return null; },
        async delete() { return undefined; },
      },
    }));

    const start = await request(app)
      .post('/api/v1/integrations/docusign/oauth/start')
      .set('host', 'worker.test')
      .send({
        org_id: TEST_ORG_ID,
        return_to: 'http://localhost:5173/organizations/org-1?tab=settings',
      });
    const state = new URL(start.body.authorizationUrl).searchParams.get('state');

    const callback = await request(app)
      .get('/api/v1/integrations/docusign/oauth/callback')
      .set('host', 'worker.test')
      .query({ code: 'docusign-code', state });

    expect(callback.status).toBe(302);
    expect(callback.headers.location).toContain('docusign=connected');

    // Provisioning is fire-and-forget — wait for the async promise to settle
    await vi.waitFor(() => {
      const connectCalls = fetchImpl.mock.calls.filter(
        (call) => String(call[0]).includes('/connect'),
      );
      expect(connectCalls.length).toBeGreaterThanOrEqual(1);
    }, { timeout: 2000 });

    // Verify connect_listener_provisioned event was recorded
    await vi.waitFor(() => {
      const events = captured.insert ?? [];
      const provisionEvent = events.find(
        (e) => (e as Record<string, unknown>).event_type === 'connect_listener_provisioned',
      );
      expect(provisionEvent).toBeDefined();
    }, { timeout: 2000 });
  });

  it('OAuth callback succeeds even when Connect provisioning fails', async () => {
    const captured: Record<string, unknown[]> = {};
    const capture = (method: string, value: unknown) => {
      captured[method] = [...(captured[method] ?? []), value];
    };
    const db = {
      from: vi.fn((table: string) => {
        if (table === 'org_members') return mockQuery({ data: { role: 'owner' }, error: null });
        if (table === 'organizations') return mockQuery({ data: { id: TEST_ORG_ID, verification_status: 'VERIFIED' }, error: null }, capture);
        if (table === 'org_integrations') return mockQuery({ data: { id: 'integration-1' }, error: null }, capture);
        if (table === 'integration_events') return mockQuery({ data: null, error: null }, capture);
        return mockQuery({ data: null, error: null }, capture);
      }),
    };

    const fetchImpl = vi.fn(async (input: FetchInput) => {
      const url = String(input);
      if (url === 'https://account-d.docusign.com/oauth/token') {
        return new Response(JSON.stringify({
          access_token: 'access-token-fail-provision',
          expires_in: 3600,
          refresh_token: 'refresh-token-fail-provision',
          scope: 'signature extended',
          token_type: 'Bearer',
        }), { status: 200 });
      }
      if (url === 'https://account-d.docusign.com/oauth/userinfo') {
        return new Response(JSON.stringify({
          sub: 'docusign-sub-1',
          email: 'admin@example.com',
          accounts: [{
            account_id: 'docusign-account-1',
            account_name: 'Acme Legal',
            base_uri: 'https://demo.docusign.net',
            is_default: true,
          }],
        }), { status: 200 });
      }
      // Connect API calls all fail with 500
      if (url.includes('/connect')) {
        return new Response(
          JSON.stringify({ errorCode: 'INTERNAL_ERROR', message: 'Server error' }),
          { status: 500 },
        );
      }
      return new Response('{}', { status: 404 });
    });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { userId: string }).userId = TEST_USER_ID;
      next();
    });
    app.use('/api/v1/integrations', createDocusignOAuthRouter({
      db: asTestDb(db),
      env: {
        DOCUSIGN_INTEGRATION_KEY: 'docusign-client',
        DOCUSIGN_CLIENT_SECRET: 'docusign-client-secret',
        DOCUSIGN_DEMO: 'true',
        DOCUSIGN_CONNECT_HMAC_SECRET: 'hmac-secret-123',
        WORKER_PUBLIC_URL: 'https://arkova-worker.example.com',
        GCP_SECRET_MANAGER_PROJECT_ID: 'test-project',
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
      refreshTokenStore: {
        async put() { return undefined; },
        async get() { return null; },
        async delete() { return undefined; },
      },
    }));

    const start = await request(app)
      .post('/api/v1/integrations/docusign/oauth/start')
      .set('host', 'worker.test')
      .send({
        org_id: TEST_ORG_ID,
        return_to: 'http://localhost:5173/organizations/org-1?tab=settings',
      });
    const state = new URL(start.body.authorizationUrl).searchParams.get('state');

    const callback = await request(app)
      .get('/api/v1/integrations/docusign/oauth/callback')
      .set('host', 'worker.test')
      .query({ code: 'docusign-code', state });

    // OAuth still succeeds — redirect to connected
    expect(callback.status).toBe(302);
    expect(callback.headers.location).toContain('docusign=connected');

    // Provisioning is fire-and-forget — wait for the async failure path to settle
    await vi.waitFor(() => {
      const events = captured.insert ?? [];
      const failEvent = events.find(
        (e) => (e as Record<string, unknown>).event_type === 'connect_listener_failed',
      );
      expect(failEvent).toBeDefined();
    }, { timeout: 2000 });
  });

  it('reprovisions an active Connect listener with a refreshed token and base URI', async () => {
    const captured: Record<string, unknown[]> = {};
    const capture = (method: string, value: unknown) => {
      captured[method] = [...(captured[method] ?? []), value];
    };
    const db = {
      from: vi.fn((table: string) => {
        if (table === 'organizations') return mockQuery({ data: { id: TEST_ORG_ID }, error: null }, capture);
        if (table === 'org_members') return mockQuery({ data: { role: 'owner' }, error: null });
        if (table === 'org_integrations') {
          return mockQuery({
            data: [{
              id: 'integration-1',
              account_id: 'docusign-account-1',
              base_uri: null,
              token_secret_name: 'projects/test-project/secrets/arkova-docusign-refresh-token',
            }],
            error: null,
          }, capture);
        }
        if (table === 'integration_events') return mockQuery({ data: null, error: null }, capture);
        return mockQuery({ data: null, error: null }, capture);
      }),
    };
    const secretReads: string[] = [];
    const secretWrites: Array<{ name: string; value: string }> = [];
    const outboundSignals: AbortSignal[] = [];
    const fetchImpl = vi.fn(async (input: FetchInput, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://account-d.docusign.com/oauth/token' || url === 'https://account-d.docusign.com/oauth/userinfo') {
        outboundSignals.push(init?.signal as AbortSignal);
      }
      if (url === 'https://account-d.docusign.com/oauth/token') {
        return new Response(JSON.stringify({
          access_token: 'access-token-reprovision',
          expires_in: 3600,
          refresh_token: 'refresh-token-rotated',
          scope: 'signature extended',
          token_type: 'Bearer',
        }), { status: 200 });
      }
      if (url === 'https://account-d.docusign.com/oauth/userinfo') {
        return new Response(JSON.stringify({
          sub: 'docusign-sub-1',
          email: 'admin@example.com',
          accounts: [{
            account_id: 'docusign-account-1',
            account_name: 'Acme Legal',
            base_uri: 'https://demo.docusign.net',
            is_default: true,
          }],
        }), { status: 200 });
      }
      if (url.includes('/connect') && (!init?.method || init.method === 'GET')) {
        return new Response(JSON.stringify({ configurations: [] }), { status: 200 });
      }
      if (url.includes('/connect') && init?.method === 'POST') {
        return new Response(JSON.stringify({ connectId: 'connect-123' }), { status: 201 });
      }
      return new Response('{}', { status: 404 });
    });
    const app = createApp(db, {
      env: {
        DOCUSIGN_INTEGRATION_KEY: 'docusign-client',
        DOCUSIGN_CLIENT_SECRET: 'docusign-client-secret',
        DOCUSIGN_DEMO: 'true',
        DOCUSIGN_CONNECT_HMAC_SECRET: 'hmac-secret-123',
        WORKER_PUBLIC_URL: 'https://arkova-worker.example.com',
        GCP_SECRET_MANAGER_PROJECT_ID: 'test-project',
        GCP_KMS_INTEGRATION_TOKEN_KEY: 'projects/p/locations/l/keyRings/r/cryptoKeys/k',
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      refreshTokenStore: {
        async put({ name, value }: { name: string; value: string }) {
          secretWrites.push({ name, value });
        },
        async get({ name }: { name: string }) {
          secretReads.push(name);
          return 'refresh-token-reprovision';
        },
        async delete() { return undefined; },
      },
    });

    const res = await request(app)
      .post('/api/v1/integrations/docusign/connect/reprovision')
      .send({ org_public_id: TEST_ORG_PUBLIC_ID });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ attempted: 1, succeeded: 1, failed: 0 });
    expect(outboundSignals).toHaveLength(2);
    expect(outboundSignals.every((signal) => signal instanceof AbortSignal)).toBe(true);
    expect(secretReads).toEqual(['projects/test-project/secrets/arkova-docusign-refresh-token']);
    expect(secretWrites).toEqual([{
      name: 'projects/test-project/secrets/arkova-docusign-refresh-token',
      value: 'refresh-token-rotated',
    }]);
    expect(captured.update?.[0]).toMatchObject({
      base_uri: 'https://demo.docusign.net',
      token_secret_name: 'projects/test-project/secrets/arkova-docusign-refresh-token',
    });
    expect(JSON.stringify(captured.update?.[0])).not.toContain('access-token-reprovision');
    expect(JSON.stringify(captured.update?.[0])).not.toContain('refresh-token-rotated');
    expect(captured.insert?.some((event) =>
      (event as Record<string, unknown>).event_type === 'connect_listener_reprovisioned',
    )).toBe(true);
  });

  it('rejects unauthenticated Connect reprovision requests', async () => {
    const db = {
      from: vi.fn(() => mockQuery({ data: null, error: null })),
    };
    const app = createUnauthenticatedApp(db);

    const res = await request(app)
      .post('/api/v1/integrations/docusign/connect/reprovision')
      .send({ org_public_id: TEST_ORG_PUBLIC_ID });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Authentication required');
    expect(db.from).not.toHaveBeenCalled();
  });

  it('blocks Connect reprovision with no DB access when ENABLE_VERIFICATION_API is false', async () => {
    const db = {
      from: vi.fn(() => mockQuery({ data: null, error: null })),
    };
    const app = createApp(db, {
      env: {
        DOCUSIGN_INTEGRATION_KEY: 'docusign-client',
        DOCUSIGN_CLIENT_SECRET: 'docusign-client-secret',
        DOCUSIGN_DEMO: 'true',
        ENABLE_VERIFICATION_API: 'false',
        GCP_SECRET_MANAGER_PROJECT_ID: 'test-project',
        GCP_KMS_INTEGRATION_TOKEN_KEY: 'projects/p/locations/l/keyRings/r/cryptoKeys/k',
      },
    });

    const res = await request(app)
      .post('/api/v1/integrations/docusign/connect/reprovision')
      .send({ org_public_id: TEST_ORG_PUBLIC_ID });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Not found');
    expect(db.from).not.toHaveBeenCalled();
  });

  it('rejects Connect reprovision requests from non-org-admin members', async () => {
    const db = {
      from: vi.fn((table: string) => {
        if (table === 'organizations') return mockQuery({ data: { id: TEST_ORG_ID }, error: null });
        if (table === 'org_members') return mockQuery({ data: { role: 'member' }, error: null });
        return mockQuery({ data: null, error: null });
      }),
    };
    const app = createApp(db);

    const res = await request(app)
      .post('/api/v1/integrations/docusign/connect/reprovision')
      .send({ org_public_id: TEST_ORG_PUBLIC_ID });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('org admin');
    expect(db.from).toHaveBeenCalledTimes(2);
  });

  it('returns zero attempted reprovisions when the org has no active DocuSign integrations', async () => {
    const getRefreshToken = vi.fn();
    const db = {
      from: vi.fn((table: string) => {
        if (table === 'organizations') return mockQuery({ data: { id: TEST_ORG_ID }, error: null });
        if (table === 'org_members') return mockQuery({ data: { role: 'owner' }, error: null });
        if (table === 'org_integrations') return mockQuery({ data: [], error: null });
        return mockQuery({ data: null, error: null });
      }),
    };
    const app = createApp(db, {
      refreshTokenStore: {
        async put() { return undefined; },
        get: getRefreshToken,
        async delete() { return undefined; },
      },
    });

    const res = await request(app)
      .post('/api/v1/integrations/docusign/connect/reprovision')
      .send({ org_public_id: TEST_ORG_PUBLIC_ID });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      attempted: 0,
      succeeded: 0,
      failed: 0,
      results: [],
    });
    expect(getRefreshToken).not.toHaveBeenCalled();
  });

  it('returns 502 when DocuSign token refresh hangs during Connect reprovision', async () => {
    const captured: Record<string, unknown[]> = {};
    const capture = (method: string, value: unknown) => {
      captured[method] = [...(captured[method] ?? []), value];
    };
    const db = {
      from: vi.fn((table: string) => {
        if (table === 'organizations') return mockQuery({ data: { id: TEST_ORG_ID }, error: null }, capture);
        if (table === 'org_members') return mockQuery({ data: { role: 'admin' }, error: null });
        if (table === 'org_integrations') {
          return mockQuery({
            data: [{
              id: 'integration-1',
              account_id: 'docusign-account-1',
              token_secret_name: 'projects/test-project/secrets/arkova-docusign-refresh-token',
            }],
            error: null,
          }, capture);
        }
        if (table === 'integration_events') return mockQuery({ data: null, error: null }, capture);
        return mockQuery({ data: null, error: null }, capture);
      }),
    };
    const fetchImpl = vi.fn((input: FetchInput, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://account-d.docusign.com/oauth/token') {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        });
      }
      return Promise.resolve(new Response('{}', { status: 404 }));
    });
    const app = createApp(db, {
      env: {
        DOCUSIGN_INTEGRATION_KEY: 'docusign-client',
        DOCUSIGN_CLIENT_SECRET: 'docusign-client-secret',
        DOCUSIGN_DEMO: 'true',
        DOCUSIGN_REPROVISION_TIMEOUT_MS: '25',
        ENABLE_VERIFICATION_API: 'true',
        GCP_SECRET_MANAGER_PROJECT_ID: 'test-project',
        GCP_KMS_INTEGRATION_TOKEN_KEY: 'projects/p/locations/l/keyRings/r/cryptoKeys/k',
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      refreshTokenStore: {
        async put() { return undefined; },
        async get() { return 'refresh-token-reprovision'; },
        async delete() { return undefined; },
      },
    });

    const res = await request(app)
      .post('/api/v1/integrations/docusign/connect/reprovision')
      .send({ org_public_id: TEST_ORG_PUBLIC_ID });

    expect(res.status).toBe(502);
    expect(res.body.results[0]).toMatchObject({
      integration_id: 'integration-1',
      status: 'error',
      error: 'DocuSign token refresh request timed out after 0.025s',
    });
    expect(captured.insert?.[0]).toMatchObject({
      event_type: 'connect_listener_reprovision_failed',
      details: {
        error: 'DocuSign token refresh request timed out after 0.025s',
      },
    });
  });

  it('returns 502 and records failure events when every active Connect reprovision fails', async () => {
    const captured: Record<string, unknown[]> = {};
    const capture = (method: string, value: unknown) => {
      captured[method] = [...(captured[method] ?? []), value];
    };
    const db = {
      from: vi.fn((table: string) => {
        if (table === 'organizations') return mockQuery({ data: { id: TEST_ORG_ID }, error: null }, capture);
        if (table === 'org_members') return mockQuery({ data: { role: 'admin' }, error: null });
        if (table === 'org_integrations') {
          return mockQuery({
            data: [{
              id: 'integration-1',
              account_id: 'docusign-account-1',
              base_uri: 'https://demo.docusign.net',
              token_secret_name: 'projects/test-project/secrets/arkova-docusign-refresh-token',
            }],
            error: null,
          }, capture);
        }
        if (table === 'integration_events') return mockQuery({ data: null, error: null }, capture);
        return mockQuery({ data: null, error: null }, capture);
      }),
    };
    const app = createApp(db, {
      refreshTokenStore: {
        async put() { return undefined; },
        async get() { return null; },
        async delete() { return undefined; },
      },
    });

    const res = await request(app)
      .post('/api/v1/integrations/docusign/connect/reprovision')
      .send({ org_public_id: TEST_ORG_PUBLIC_ID });

    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({
      attempted: 1,
      succeeded: 0,
      failed: 1,
      results: [{
        integration_id: 'integration-1',
        status: 'error',
        error: 'DocuSign refresh-token secret is empty or missing',
      }],
    });
    expect(captured.update).toBeUndefined();
    expect(captured.insert?.[0]).toMatchObject({
      org_id: TEST_ORG_ID,
      integration_id: 'integration-1',
      provider: 'docusign',
      event_type: 'connect_listener_reprovision_failed',
      status: 'error',
      details: {
        error: 'DocuSign refresh-token secret is empty or missing',
      },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// SCRUM-2361 (DS-01) — verified-organization entitlement gate.
//
// AC: the backend DENIES the DocuSign connect for unverified orgs and for
// free individual users; the org-admin connection path is scoped to that org;
// a paid verified individual routes to the personal/member queue (TODO PAY-01,
// not yet shipped — the org path here keys off org KYB verification); and the
// UI denial copy must match the backend. These tests pin the backend half:
// every persona resolves to the expected status/code at `start` and the
// callback enforces the same gate as a security backstop.
// ─────────────────────────────────────────────────────────────────────
describe('DocuSign OAuth — DS-01 verified-org entitlement gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function startConnect(db: ReturnType<typeof verifiedConnectDb>) {
    return request(createApp(db))
      .post('/api/v1/integrations/docusign/oauth/start')
      .set('host', 'worker.test')
      .send({ org_id: TEST_ORG_ID });
  }

  it('PERSONA org admin + VERIFIED org → allows connect (200, authorization URL)', async () => {
    const res = await startConnect(verifiedConnectDb('admin', 'VERIFIED'));
    expect(res.status).toBe(200);
    expect(res.body.authorizationUrl).toContain('account-d.docusign.com');
  });

  it('PERSONA org owner + VERIFIED org → allows connect (200)', async () => {
    const res = await startConnect(verifiedConnectDb('owner', 'VERIFIED'));
    expect(res.status).toBe(200);
    expect(res.body.authorizationUrl).toBeTruthy();
  });

  it('PERSONA org admin + UNVERIFIED org → DENIES connect (403, org_unverified)', async () => {
    const res = await startConnect(verifiedConnectDb('admin', 'UNVERIFIED'));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('org_unverified');
    // No DocuSign authorization URL is leaked on denial.
    expect(res.body.authorizationUrl).toBeUndefined();
    expect(res.body.url).toBeUndefined();
  });

  it('PERSONA org admin + PENDING org → DENIES connect (403, org_unverified)', async () => {
    const res = await startConnect(verifiedConnectDb('admin', 'PENDING'));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('org_unverified');
  });

  it('PERSONA org admin + VERIFIED but SUSPENDED org → DENIES connect (403, org_suspended)', async () => {
    // Worker/UI gate parity (code-review must-fix): the authoritative worker gate
    // must not be narrower than useCanIssueCredential, which bars suspended orgs.
    // A suspended-but-VERIFIED org must not connect via a direct /oauth/start call.
    const res = await startConnect(verifiedConnectDb('admin', 'VERIFIED', true));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('org_suspended');
  });

  it('VERIFIED org with null/legacy suspended (pre-0289) → still allowed (parity with the hook)', async () => {
    const db = {
      from: vi.fn((table: string) => {
        if (table === 'org_members') return mockQuery({ data: { role: 'admin' }, error: null });
        if (table === 'organizations') {
          return mockQuery({ data: { id: TEST_ORG_ID, verification_status: 'VERIFIED', suspended: null }, error: null });
        }
        return mockQuery({ data: null, error: null });
      }),
    };
    const res = await startConnect(db);
    expect(res.status).toBe(200);
  });

  it('PERSONA org member (not admin) → DENIES connect at admin gate (403) before verification check', async () => {
    // Free individual / non-admin member: denied at the admin gate. The
    // organizations lookup must NOT run (admin gate short-circuits first).
    const db = verifiedConnectDb('member', 'VERIFIED');
    const res = await startConnect(db);
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('org admin');
    // Verification lookup never reached — admin gate denied first.
    const tablesQueried = db.from.mock.calls.map((c) => c[0]);
    expect(tablesQueried).toContain('org_members');
    expect(tablesQueried).not.toContain('organizations');
  });

  it('PERSONA unverified individual (admin of an UNVERIFIED org) → denial code is stable for UI copy mapping', async () => {
    // The frontend maps `code: 'org_unverified'` to CONNECTIONS_LABELS.
    // DOCUSIGN_NOT_VERIFIED. Pin the contract so the copy stays in lockstep.
    const res = await startConnect(verifiedConnectDb('admin', 'UNVERIFIED'));
    expect(res.body).toMatchObject({ code: 'org_unverified' });
    expect(typeof res.body.error).toBe('string');
    expect(res.body.error.length).toBeGreaterThan(0);
  });

  it('verification lookup failure → fails closed (500) with a distinct retry code, not a "get verified" dead-end', async () => {
    const db = {
      from: vi.fn((table: string) => {
        if (table === 'org_members') return mockQuery({ data: { role: 'admin' }, error: null });
        if (table === 'organizations') return mockQuery({ data: null, error: { message: 'db unavailable' } });
        return mockQuery({ data: null, error: null });
      }),
    };
    const res = await startConnect(db);
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('verification_lookup_failed');
  });

  it('CALLBACK backstop: a signed state for an org that is no longer VERIFIED is rejected (no connection persisted, no rule seeded)', async () => {
    const captured: Record<string, unknown[]> = {};
    const capture = (method: string, value: unknown) => {
      captured[method] = [...(captured[method] ?? []), value];
    };
    // Start succeeds (org VERIFIED at start time) to mint a real signed state…
    const startDb = verifiedConnectDb('admin', 'VERIFIED');
    const startApp = createApp(startDb);
    const start = await request(startApp)
      .post('/api/v1/integrations/docusign/oauth/start')
      .set('host', 'worker.test')
      .send({ org_id: TEST_ORG_ID, return_to: 'http://localhost:5173/organizations/org-1?tab=settings' });
    expect(start.status).toBe(200);
    const state = new URL(start.body.authorizationUrl).searchParams.get('state');

    // …but by callback time the org is UNVERIFIED (revoked). The callback must
    // redirect with org_unverified and never reach the token upsert.
    const callbackDb = {
      from: vi.fn((table: string) => {
        if (table === 'org_members') return mockQuery({ data: { role: 'admin' }, error: null });
        if (table === 'organizations') return mockQuery({ data: { id: TEST_ORG_ID, verification_status: 'UNVERIFIED' }, error: null });
        if (table === 'org_integrations') return mockQuery({ data: { id: 'integration-1' }, error: null }, capture);
        return mockQuery({ data: null, error: null }, capture);
      }),
    };
    const callbackApp = express();
    callbackApp.use(express.json());
    callbackApp.use((req, _res, next) => {
      (req as unknown as { userId: string }).userId = TEST_USER_ID;
      next();
    });
    callbackApp.use('/api/v1/integrations', createDocusignOAuthRouter({
      db: asTestDb(callbackDb),
      env: {
        DOCUSIGN_INTEGRATION_KEY: 'docusign-client',
        DOCUSIGN_CLIENT_SECRET: 'docusign-client-secret',
        DOCUSIGN_DEMO: 'true',
      },
      stateSecret: 'test-state-secret',
      frontendUrl: 'http://localhost:5173',
      now: () => new Date('2026-04-24T12:00:00.000Z'),
    }));

    const callback = await request(callbackApp)
      .get('/api/v1/integrations/docusign/oauth/callback')
      .set('host', 'worker.test')
      .query({ code: 'docusign-code', state });

    expect(callback.status).toBe(302);
    expect(callback.headers.location).toContain('docusign_error=org_unverified');
    // No token upsert happened — the connection was not persisted.
    expect(captured.upsert).toBeUndefined();
    // …and the auto-seed never ran (denied before persist).
    const tablesQueried = callbackDb.from.mock.calls.map((c) => c[0]);
    expect(tablesQueried).not.toContain('organization_rules');
  });
});

// ─────────────────────────────────────────────────────────────────────
// SCRUM-3027 — auto-seed the "DocuSign Completion" rule on org connect.
//
// Founder-confirmed default-on behavior: a successful org DocuSign connect
// auto-seeds the ESIGN_COMPLETED → AUTO_ANCHOR (queue-mode, enabled) rule so
// contracts flow with zero further clicks. The seed is idempotent + non-stomping
// (skips when the org already has ANY ESIGN_COMPLETED rule) and never breaks the
// connect flow (failure isolation). Unit coverage of the seeder lives in
// `integrations/connectors/docusign-rule-seed.test.ts`; these tests pin the
// wiring at the OAuth callback seam.
// ─────────────────────────────────────────────────────────────────────
describe('DocuSign OAuth — SCRUM-3027 auto-seed DocuSign Completion rule', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** organization_rules chain that distinguishes the idempotency SELECT from the seed INSERT. */
  function orgRulesChain(opts: {
    selectResult: QueryResult;
    insertResult: QueryResult;
    onInsert?: (row: Record<string, unknown>) => void;
  }) {
    const selectBuilder: Record<string, unknown> = {};
    selectBuilder.eq = vi.fn(() => selectBuilder);
    selectBuilder.limit = vi.fn(() => Promise.resolve(opts.selectResult));
    return {
      select: vi.fn(() => selectBuilder),
      insert: vi.fn((row: Record<string, unknown>) => {
        opts.onInsert?.(row);
        return Promise.resolve(opts.insertResult);
      }),
    };
  }

  function connectFetchImpl() {
    return vi.fn(async (input: FetchInput, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://account-d.docusign.com/oauth/token') {
        return new Response(JSON.stringify({
          access_token: 'access-token-seed',
          expires_in: 3600,
          refresh_token: 'refresh-token-seed',
          scope: 'signature extended',
          token_type: 'Bearer',
        }), { status: 200 });
      }
      if (url === 'https://account-d.docusign.com/oauth/userinfo') {
        return new Response(JSON.stringify({
          sub: 'docusign-sub-1',
          email: 'admin@example.com',
          accounts: [{
            account_id: 'docusign-account-1',
            account_name: 'Acme Legal',
            base_uri: 'https://demo.docusign.net',
            is_default: true,
          }],
        }), { status: 200 });
      }
      if (url.includes('/connect') && (!init?.method || init.method === 'GET')) {
        return new Response(JSON.stringify({ configurations: [] }), { status: 200 });
      }
      if (url.includes('/connect') && init?.method === 'POST') {
        return new Response(JSON.stringify({ connectId: '99001' }), { status: 201 });
      }
      return new Response('{}', { status: 404 });
    });
  }

  function buildSeedApp(db: unknown, fetchImpl: ReturnType<typeof connectFetchImpl>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { userId: string }).userId = TEST_USER_ID;
      next();
    });
    app.use('/api/v1/integrations', createDocusignOAuthRouter({
      db: asTestDb(db),
      env: {
        DOCUSIGN_INTEGRATION_KEY: 'docusign-client',
        DOCUSIGN_CLIENT_SECRET: 'docusign-client-secret',
        DOCUSIGN_DEMO: 'true',
        DOCUSIGN_CONNECT_HMAC_SECRET: 'hmac-secret-123',
        WORKER_PUBLIC_URL: 'https://arkova-worker.example.com',
        GCP_SECRET_MANAGER_PROJECT_ID: 'test-project',
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
      refreshTokenStore: {
        async put() { return undefined; },
        async get() { return null; },
        async delete() { return undefined; },
      },
    }));
    return app;
  }

  async function runConnect(app: express.Express) {
    const start = await request(app)
      .post('/api/v1/integrations/docusign/oauth/start')
      .set('host', 'worker.test')
      .send({ org_id: TEST_ORG_ID, return_to: 'http://localhost:5173/organizations/org-1?tab=settings' });
    const state = new URL(start.body.authorizationUrl).searchParams.get('state');
    return request(app)
      .get('/api/v1/integrations/docusign/oauth/callback')
      .set('host', 'worker.test')
      .query({ code: 'docusign-code', state });
  }

  it('auto-seeds the DocuSign Completion rule (enabled, ESIGN_COMPLETED → AUTO_ANCHOR) when the org has none', async () => {
    const seededRows: Array<Record<string, unknown>> = [];
    const integrationEvents: Array<Record<string, unknown>> = [];
    const db = {
      from: vi.fn((table: string) => {
        if (table === 'org_members') return mockQuery({ data: { role: 'owner' }, error: null });
        if (table === 'organizations') return mockQuery({ data: { id: TEST_ORG_ID, verification_status: 'VERIFIED' }, error: null });
        if (table === 'org_integrations') return mockQuery({ data: { id: 'integration-1' }, error: null });
        if (table === 'integration_events') {
          return mockQuery({ data: null, error: null }, (m, v) => {
            if (m === 'insert') integrationEvents.push(v as Record<string, unknown>);
          });
        }
        if (table === 'organization_rules') {
          return orgRulesChain({
            selectResult: { data: [], error: null },
            insertResult: { data: { id: 'seeded-rule-1' }, error: null },
            onInsert: (row) => seededRows.push(row),
          });
        }
        return mockQuery({ data: null, error: null });
      }),
    };

    const callback = await runConnect(buildSeedApp(db, connectFetchImpl()));

    expect(callback.status).toBe(302);
    expect(callback.headers.location).toContain('docusign=connected');

    // Fire-and-forget seed — wait for it to settle.
    await vi.waitFor(() => expect(seededRows).toHaveLength(1), { timeout: 2000 });
    const row = seededRows[0];
    expect(row.org_id).toBe(TEST_ORG_ID);
    expect(row.trigger_type).toBe('ESIGN_COMPLETED');
    expect(row.action_type).toBe('AUTO_ANCHOR');
    expect(row.trigger_config).toEqual({ vendors: ['docusign'] });
    expect(row.action_config).toEqual({ tag: 'docusign' });
    expect(row.enabled).toBe(true);
    expect(row.schema_version).toBe(1);
    expect(row.created_by_user_id).toBe(TEST_USER_ID);

    await vi.waitFor(() => {
      expect(integrationEvents.some((e) => e.event_type === 'docusign_completion_rule_seeded')).toBe(true);
    }, { timeout: 2000 });
  });

  it('seeds NOTHING on re-connect when the org already has an ESIGN_COMPLETED rule (non-stomping)', async () => {
    const seededRows: Array<Record<string, unknown>> = [];
    const db = {
      from: vi.fn((table: string) => {
        if (table === 'org_members') return mockQuery({ data: { role: 'owner' }, error: null });
        if (table === 'organizations') return mockQuery({ data: { id: TEST_ORG_ID, verification_status: 'VERIFIED' }, error: null });
        if (table === 'org_integrations') return mockQuery({ data: { id: 'integration-1' }, error: null });
        if (table === 'integration_events') return mockQuery({ data: null, error: null });
        if (table === 'organization_rules') {
          // Admin already chose an ESIGN_COMPLETED rule (any action) — must not stomp it.
          return orgRulesChain({
            selectResult: { data: [{ id: 'admin-existing-rule' }], error: null },
            insertResult: { data: null, error: null },
            onInsert: (row) => seededRows.push(row),
          });
        }
        return mockQuery({ data: null, error: null });
      }),
    };

    const callback = await runConnect(buildSeedApp(db, connectFetchImpl()));

    expect(callback.status).toBe(302);
    expect(callback.headers.location).toContain('docusign=connected');

    // Let the fire-and-forget seed settle, then prove no insert occurred.
    await vi.waitFor(() => {
      const queried = (db.from.mock.calls.map((c) => c[0]) as string[]);
      expect(queried).toContain('organization_rules');
    }, { timeout: 2000 });
    expect(seededRows).toHaveLength(0);
  });

  it('connect still succeeds (failure isolation) when the rule seed insert errors', async () => {
    const integrationEvents: Array<Record<string, unknown>> = [];
    const db = {
      from: vi.fn((table: string) => {
        if (table === 'org_members') return mockQuery({ data: { role: 'owner' }, error: null });
        if (table === 'organizations') return mockQuery({ data: { id: TEST_ORG_ID, verification_status: 'VERIFIED' }, error: null });
        if (table === 'org_integrations') return mockQuery({ data: { id: 'integration-1' }, error: null });
        if (table === 'integration_events') {
          return mockQuery({ data: null, error: null }, (m, v) => {
            if (m === 'insert') integrationEvents.push(v as Record<string, unknown>);
          });
        }
        if (table === 'organization_rules') {
          return orgRulesChain({
            selectResult: { data: [], error: null },
            insertResult: { data: null, error: { message: 'insert boom' } },
          });
        }
        return mockQuery({ data: null, error: null });
      }),
    };

    const callback = await runConnect(buildSeedApp(db, connectFetchImpl()));

    // Connect is unaffected by the seed failure.
    expect(callback.status).toBe(302);
    expect(callback.headers.location).toContain('docusign=connected');

    // The failure is surfaced (loud log inside the seeder + a warning event).
    await vi.waitFor(() => {
      expect(integrationEvents.some((e) => e.event_type === 'docusign_completion_rule_seed_failed')).toBe(true);
    }, { timeout: 2000 });
    await vi.waitFor(() => {
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: TEST_ORG_ID }),
        expect.stringContaining('DocuSign Completion rule auto-seed'),
      );
    }, { timeout: 2000 });
  });
});
