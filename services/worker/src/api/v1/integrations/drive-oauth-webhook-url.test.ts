/**
 * SCRUM-1209 regression test
 *
 * Asserts that the webhook URL `drive-oauth` registers with Google's
 * `changes.watch` resolves to a live route on the v1 router. The original bug
 * was that `drive-oauth` registered `/webhooks/integrations/google_drive`
 * while the v1 router mounted the handler at `/api/v1/webhooks/drive` —
 * Google posted to a 404 and the worker silently lost every Drive event.
 */
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../../config.js', () => ({
  config: {
    frontendUrl: 'http://localhost:5173',
    supabaseJwtSecret: 'jwt-secret',
    supabaseServiceKey: 'service-secret',
  },
}));

vi.mock('../../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../utils/db.js', () => ({ db: {} }));

import { createDriveOAuthRouter } from './drive-oauth.js';
import { driveWebhookRouter } from '../webhooks/drive.js';
import { API_V1_PREFIX, WEBHOOK_PATHS, relativeTo } from '../../../constants/webhook-paths.js';

const TEST_ORG_ID = '11111111-1111-4111-8111-111111111111';
const TEST_USER_ID = '22222222-2222-4222-8222-222222222222';

function mockQuery(result: { data?: unknown; error?: unknown }) {
  const chain: Record<string, unknown> = {};
  const terminal = () => Promise.resolve(result);
  chain.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
    terminal().then(resolve, reject);
  chain.select = vi.fn(() => chain);
  chain.eq = vi.fn(() => chain);
  chain.is = vi.fn(() => chain);
  chain.update = vi.fn(() => chain);
  chain.insert = vi.fn(() => chain);
  chain.upsert = vi.fn(() => chain);
  chain.single = vi.fn().mockImplementation(terminal);
  chain.maybeSingle = vi.fn().mockImplementation(terminal);
  return chain;
}

describe('Drive webhook address registration', () => {
  it('registers a URL that resolves to the live driveWebhookRouter (no 404)', async () => {
    let watchAddress: string | null = null;
    const db = {
      from: vi.fn((table: string) => {
        if (table === 'org_members') return mockQuery({ data: { role: 'owner' }, error: null });
        if (table === 'org_integrations') return mockQuery({ data: { id: 'integration-1' }, error: null });
        return mockQuery({ data: null, error: null });
      }),
    };

    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({
          access_token: 't', expires_in: 3600, refresh_token: 'r',
          scope: 'https://www.googleapis.com/auth/drive.file', token_type: 'Bearer',
        }), { status: 200 });
      }
      if (url === 'https://www.googleapis.com/oauth2/v3/userinfo') {
        return new Response(JSON.stringify({ sub: 's', email: 'a@b.c' }), { status: 200 });
      }
      if (url.includes('/changes/startPageToken')) {
        return new Response(JSON.stringify({ startPageToken: 'p' }), { status: 200 });
      }
      if (url.includes('/changes/watch')) {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        watchAddress = body.address;
        return new Response(JSON.stringify({
          resourceId: 'r', expiration: String(Date.now() + 86_400_000),
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
        GOOGLE_OAUTH_CLIENT_ID: 'c',
        GOOGLE_OAUTH_CLIENT_SECRET: 's',
        GCP_KMS_INTEGRATION_TOKEN_KEY: 'projects/p/locations/l/keyRings/r/cryptoKeys/k',
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      stateSecret: 'test-state-secret',
      frontendUrl: 'http://localhost:5173',
      kms: {
        async encrypt() { return Buffer.from('e'); },
        async decrypt() { return Buffer.from('{}'); },
      },
    }));
    // Mount the real Drive webhook router under the v1 prefix using the same
    // path the OAuth handler will derive — if these drift, the test fails.
    app.use(API_V1_PREFIX + relativeTo(WEBHOOK_PATHS.GOOGLE_DRIVE, API_V1_PREFIX), driveWebhookRouter);

    const start = await request(app)
      .post('/api/v1/integrations/google_drive/oauth/start')
      .set('host', 'worker.test')
      .send({ org_id: TEST_ORG_ID });
    const state = new URL(start.body.authorizationUrl).searchParams.get('state')!;

    const callback = await request(app)
      .get('/api/v1/integrations/google_drive/oauth/callback')
      .set('host', 'worker.test')
      .query({ code: 'x', state });
    expect(callback.status).toBe(302);

    expect(watchAddress).not.toBeNull();
    const parsed = new URL(watchAddress!);
    expect(parsed.pathname).toBe(WEBHOOK_PATHS.GOOGLE_DRIVE);

    // Critical assertion: posting to that exact path on the live app must NOT
    // 404. (404 would mean Google sends events nowhere — the original bug.)
    const ping = await request(app)
      .post(parsed.pathname)
      .set('host', 'worker.test');
    expect(ping.status).not.toBe(404);
  });
});
