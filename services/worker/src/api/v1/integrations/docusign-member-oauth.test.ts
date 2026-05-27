/**
 * SCRUM-2044 — Member-level DocuSign OAuth tests.
 *
 * TDD: these tests are written first and must fail before the
 * implementation exists.
 */
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

import { createDocusignMemberOAuthRouter } from './docusign-member-oauth.js';
import { logger } from '../../../utils/logger.js';

type MemberOAuthDeps = NonNullable<Parameters<typeof createDocusignMemberOAuthRouter>[0]>;

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

function createApp(db: unknown, overrides: Partial<MemberOAuthDeps> = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { userId: string }).userId = TEST_USER_ID;
    next();
  });
  app.use(
    '/api/v1/integrations',
    createDocusignMemberOAuthRouter({
      db: db as unknown as MemberOAuthDeps['db'],
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

describe('Member-level DocuSign OAuth router (SCRUM-2044)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /docusign/member/oauth/start', () => {
    it('starts member OAuth for any org member (not just admins)', async () => {
      const db = {
        from: vi.fn(() => mockQuery({ data: { role: 'member' }, error: null })),
      };
      const app = createApp(db);

      const res = await request(app)
        .post('/api/v1/integrations/docusign/member/oauth/start')
        .set('host', 'worker.test')
        .send({
          org_id: TEST_ORG_ID,
          return_to: 'http://localhost:5173/organizations/org-1?tab=settings',
        });

      expect(res.status).toBe(200);
      expect(res.body.authorizationUrl).toContain('https://account-d.docusign.com/oauth/auth');
      const url = new URL(res.body.authorizationUrl);
      expect(url.searchParams.get('redirect_uri')).toBe(
        'http://worker.test/api/v1/integrations/docusign/member/oauth/callback',
      );
      // State includes member scope
      const state = url.searchParams.get('state');
      expect(state).toBeTruthy();
    });

    it('rejects when the caller has no org membership', async () => {
      const db = {
        from: vi.fn(() => mockQuery({ data: null, error: null })),
      };
      const app = createApp(db);

      const res = await request(app)
        .post('/api/v1/integrations/docusign/member/oauth/start')
        .send({ org_id: TEST_ORG_ID });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('org member');
    });

    it('rejects unauthenticated requests', async () => {
      const db = {
        from: vi.fn(() => mockQuery({ data: { role: 'member' }, error: null })),
      };
      const app = express();
      app.use(express.json());
      // No userId middleware — unauthenticated
      app.use(
        '/api/v1/integrations',
        createDocusignMemberOAuthRouter({
          db: db as unknown as MemberOAuthDeps['db'],
          stateSecret: 'test-state-secret',
          frontendUrl: 'http://localhost:5173',
        }),
      );

      const res = await request(app)
        .post('/api/v1/integrations/docusign/member/oauth/start')
        .send({ org_id: TEST_ORG_ID });

      expect(res.status).toBe(401);
    });

    it('validates org_id is a UUID', async () => {
      const db = {
        from: vi.fn(() => mockQuery({ data: { role: 'member' }, error: null })),
      };
      const app = createApp(db);

      const res = await request(app)
        .post('/api/v1/integrations/docusign/member/oauth/start')
        .send({ org_id: 'not-a-uuid' });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /docusign/member/oauth/callback', () => {
    it('exchanges code and writes to member_integrations (not org_integrations)', async () => {
      const captured: Record<string, unknown[]> = {};
      const capture = (method: string, value: unknown) => {
        captured[method] = [...(captured[method] ?? []), value];
      };
      const secretWrites: Array<{ name: string; value: string }> = [];
      const tablesWritten: string[] = [];
      const db = {
        from: vi.fn((table: string) => {
          tablesWritten.push(table);
          if (table === 'org_members') return mockQuery({ data: { role: 'member' }, error: null });
          if (table === 'member_integrations') return mockQuery({ data: { id: 'member-int-1' }, error: null }, capture);
          if (table === 'integration_events') return mockQuery({ data: null, error: null }, capture);
          if (table === 'audit_events') return mockQuery({ data: null, error: null }, capture);
          return mockQuery({ data: null, error: null }, capture);
        }),
      };

      const fetchImpl = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === 'https://account-d.docusign.com/oauth/token') {
          return new Response(JSON.stringify({
            access_token: 'access-token-member',
            expires_in: 3600,
            refresh_token: 'refresh-token-member',
            scope: 'signature extended',
            token_type: 'Bearer',
          }), { status: 200 });
        }
        if (url === 'https://account-d.docusign.com/oauth/userinfo') {
          return new Response(JSON.stringify({
            sub: 'docusign-sub-member',
            email: 'member@example.com',
            accounts: [{
              account_id: 'docusign-member-acct-1',
              account_name: 'Personal Legal',
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
        db: db as unknown as MemberOAuthDeps['db'],
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
            expect(plaintext.toString('utf8')).not.toContain('refresh-token-member');
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
          async get() { return null; },
          async delete() { return undefined; },
        },
      };
      app.use('/api/v1/integrations', createDocusignMemberOAuthRouter(deps));

      const start = await request(app)
        .post('/api/v1/integrations/docusign/member/oauth/start')
        .set('host', 'worker.test')
        .send({
          org_id: TEST_ORG_ID,
          return_to: 'http://localhost:5173/organizations/org-1?tab=settings',
        });
      const state = new URL(start.body.authorizationUrl).searchParams.get('state');

      const callback = await request(app)
        .get('/api/v1/integrations/docusign/member/oauth/callback')
        .set('host', 'worker.test')
        .query({ code: 'docusign-code', state });

      expect(callback.status).toBe(302);
      expect(callback.headers.location).toBe(
        'http://localhost:5173/organizations/org-1?tab=settings&docusign=connected',
      );

      // Verify it writes to member_integrations, not org_integrations
      expect(tablesWritten).toContain('member_integrations');
      expect(tablesWritten).not.toContain('org_integrations');

      const upsert = captured.upsert?.[0] as Record<string, unknown>;
      expect(upsert.provider).toBe('docusign');
      expect(upsert.account_id).toBe('docusign-member-acct-1');
      expect(upsert.user_id).toBe(TEST_USER_ID);
      expect(upsert.org_id).toBe(TEST_ORG_ID);

      // Secret name uses member-level naming convention
      expect(upsert.token_secret_name).toMatch(/arkova-docusign-member-/);

      // Refresh token goes to Secret Manager, not DB
      expect(secretWrites).toHaveLength(1);
      expect(secretWrites[0].value).toBe('refresh-token-member');
      expect(JSON.stringify(upsert)).not.toContain('refresh-token-member');
    });

    it('redirects with invalid_state when the state token is forged', async () => {
      const db = {
        from: vi.fn(() => mockQuery({ data: { role: 'member' }, error: null })),
      };
      const app = createApp(db);

      const res = await request(app)
        .get('/api/v1/integrations/docusign/member/oauth/callback')
        .set('host', 'worker.test')
        .query({ code: 'docusign-code', state: 'tampered.state' });

      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('docusign_error=invalid_state');
    });
  });

  describe('POST /docusign/member/disconnect', () => {
    it('disconnects the member integration and cleans up secrets', async () => {
      const captured: Record<string, unknown[]> = {};
      const deletedSecrets: string[] = [];
      const capture = (method: string, value: unknown) => {
        captured[method] = [...(captured[method] ?? []), value];
      };
      const db = {
        from: vi.fn((table: string) => {
          if (table === 'org_members') return mockQuery({ data: { role: 'member' }, error: null });
          if (table === 'member_integrations') {
            return mockQuery({
              data: [{
                id: 'member-int-1',
                token_secret_name: 'projects/test-project/secrets/arkova-docusign-member-refresh-token',
              }],
              error: null,
            }, capture);
          }
          if (table === 'integration_events') return mockQuery({ data: null, error: null }, capture);
          if (table === 'audit_events') return mockQuery({ data: null, error: null }, capture);
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
        .post('/api/v1/integrations/docusign/member/disconnect')
        .send({ org_id: TEST_ORG_ID });

      expect(res.status).toBe(200);
      expect(res.body.disconnected).toBe(true);
      expect(deletedSecrets).toEqual([
        'projects/test-project/secrets/arkova-docusign-member-refresh-token',
      ]);
      expect(captured.update?.[0]).toMatchObject({
        encrypted_tokens: null,
        token_kms_key_id: null,
        token_secret_name: null,
      });
    });

    it('writes audit_events with member-specific event type on disconnect', async () => {
      const auditInserts: unknown[] = [];
      const db = {
        from: vi.fn((table: string) => {
          if (table === 'org_members') return mockQuery({ data: { role: 'member' }, error: null });
          if (table === 'member_integrations') {
            return mockQuery({
              data: [{
                id: 'member-int-1',
                token_secret_name: 'projects/test-project/secrets/arkova-docusign-member-rt',
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
        .post('/api/v1/integrations/docusign/member/disconnect')
        .send({ org_id: TEST_ORG_ID });

      expect(res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 10));
      expect(auditInserts).toHaveLength(1);
      expect(auditInserts[0]).toMatchObject({
        event_type: 'integration.docusign_member_disconnected',
        event_category: 'SECURITY',
        actor_id: TEST_USER_ID,
        org_id: TEST_ORG_ID,
        target_type: 'integration',
      });
    });

    it('rejects disconnect when user has no org membership', async () => {
      const db = {
        from: vi.fn((table: string) => {
          if (table === 'org_members') return mockQuery({ data: null, error: null });
          return mockQuery({ data: null, error: null });
        }),
      };
      const app = createApp(db);

      const res = await request(app)
        .post('/api/v1/integrations/docusign/member/disconnect')
        .send({ org_id: TEST_ORG_ID });

      expect(res.status).toBe(403);
    });
  });
});
