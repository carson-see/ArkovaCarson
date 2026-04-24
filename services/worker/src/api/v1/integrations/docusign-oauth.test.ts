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

import { createDocusignOAuthRouter } from './docusign-oauth.js';

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
    createDocusignOAuthRouter({
      db,
      env: {
        DOCUSIGN_INTEGRATION_KEY: 'docusign-client',
        DOCUSIGN_CLIENT_SECRET: 'docusign-client-secret',
        DOCUSIGN_DEMO: 'true',
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

describe('DocuSign OAuth router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts OAuth for org admins and returns a DocuSign authorization URL', async () => {
    const db = {
      from: vi.fn(() => mockQuery({ data: { role: 'admin' }, error: null })),
    };
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
      db,
      env: {
        DOCUSIGN_INTEGRATION_KEY: 'docusign-client',
        DOCUSIGN_CLIENT_SECRET: 'docusign-client-secret',
        DOCUSIGN_DEMO: 'true',
        GCP_KMS_INTEGRATION_TOKEN_KEY: 'projects/p/locations/l/keyRings/r/cryptoKeys/k',
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      stateSecret: 'test-state-secret',
      frontendUrl: 'http://localhost:5173',
      now: () => new Date('2026-04-24T12:00:00.000Z'),
      kms: {
        async encrypt({ plaintext }) {
          // Tokens MUST reach KMS, never Postgres or logs in cleartext.
          expect(plaintext.toString('utf8')).toContain('refresh-token-aaaaaaaa');
          return Buffer.from('encrypted-token-payload');
        },
        async decrypt() {
          return Buffer.from('{}');
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
    expect(callback.headers.location).toBe(
      'http://localhost:5173/organizations/org-1?tab=settings&docusign=connected',
    );
    const upsert = captured.upsert?.[0] as Record<string, unknown>;
    expect(upsert.provider).toBe('docusign');
    expect(upsert.account_id).toBe('docusign-account-1');
    expect(upsert.account_label).toBe('Acme Legal');
    expect(upsert.base_uri).toBe('https://demo.docusign.net');
    expect(upsert.encrypted_tokens).toBe('\\x656e637279707465642d746f6b656e2d7061796c6f6164');
    expect(JSON.stringify(upsert)).not.toContain('refresh-token-aaaaaaaa');
    expect(JSON.stringify(upsert)).not.toContain('access-token-aaaaaaaa');
    expect(captured.insert?.[0]).toMatchObject({
      org_id: TEST_ORG_ID,
      provider: 'docusign',
      event_type: 'oauth_connected',
      status: 'success',
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
    const capture = (method: string, value: unknown) => {
      captured[method] = [...(captured[method] ?? []), value];
    };
    const db = {
      from: vi.fn((table: string) => {
        if (table === 'org_members') return mockQuery({ data: { role: 'admin' }, error: null });
        if (table === 'org_integrations') return mockQuery({ data: [{ id: 'integration-1' }], error: null }, capture);
        if (table === 'integration_events') return mockQuery({ data: null, error: null }, capture);
        return mockQuery({ data: null, error: null });
      }),
    };
    const app = createApp(db);

    const res = await request(app)
      .post('/api/v1/integrations/docusign/disconnect')
      .send({ org_id: TEST_ORG_ID });

    expect(res.status).toBe(200);
    expect(res.body.disconnected).toBe(true);
    expect(captured.update?.[0]).toMatchObject({
      encrypted_tokens: null,
      token_kms_key_id: null,
    });
    expect(captured.insert?.[0]).toMatchObject({
      event_type: 'oauth_disconnected',
      status: 'success',
    });
  });
});
