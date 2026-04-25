/**
 * GRC OAuth route tests (SCRUM-1238 / AUDIT-0424-13).
 *
 * Focus: state HMAC must be issued at /connect and verified at /callback.
 * The audit found that /connect returned `state = crypto.randomUUID()` and
 * /callback never verified it — letting an attacker forge a state and have
 * the server trust the body's `org_id`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'node:crypto';

const TEST_ORG_ID = '11111111-1111-4111-8111-111111111111';
const TEST_USER_ID = '22222222-2222-4222-8222-222222222222';

const dbFromMock = vi.fn();

vi.mock('../../utils/db.js', () => ({
  db: {
    from: (...args: unknown[]) => dbFromMock(...args),
  },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../integrations/grc/adapters.js', () => ({
  loadGrcCredentials: () => ({
    vanta: { clientId: 'v', clientSecret: 'vs' },
    drata: { clientId: 'd', clientSecret: 'ds' },
    anecdotes: { clientId: 'a', clientSecret: 'as' },
  }),
  createGrcAdapter: () => ({
    platform: 'vanta',
    getAuthUrl: (redirectUri: string, state: string) =>
      `https://app.vanta.com/oauth/authorize?redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}`,
    exchangeAuthCode: async () => ({
      access_token: 'at-secret',
      refresh_token: 'rt-secret',
      expires_in: 3600,
      scope: 'read:evidence',
    }),
    testConnection: async () => ({ valid: true, orgName: 'Acme Vanta' }),
  }),
}));

vi.mock('../../integrations/oauth/crypto.js', () => ({
  createDefaultKmsClient: async () => ({
    encrypt: async () => Buffer.from('ct'),
    decrypt: async () => Buffer.from('{}'),
  }),
  encryptTokens: async () => ({ ciphertext: Buffer.from('ct'), keyId: 'k' }),
  decryptTokens: async () => ({ access_token: 'at', refresh_token: 'rt' }),
  getIntegrationTokenKeyName: () => 'projects/p/locations/l/keyRings/r/cryptoKeys/k',
}));

import { grcRouter } from './grc.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { authUserId: string }).authUserId = TEST_USER_ID;
    next();
  });
  app.use('/api/v1/grc', grcRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  // /connect requires INTEGRATION_STATE_HMAC_SECRET; we set it for tests so
  // the router can sign.
  process.env.INTEGRATION_STATE_HMAC_SECRET = 'grc-test-state-secret';
});

describe('GRC OAuth route', () => {
  it('SCRUM-1238: /connect returns a signed state (encoded payload + HMAC)', async () => {
    // org_members lookup returns admin
    dbFromMock.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { org_id: TEST_ORG_ID, role: 'admin' } }),
    });

    const res = await request(createApp())
      .post('/api/v1/grc/connect')
      .send({
        platform: 'vanta',
        redirect_uri: 'http://localhost:5173/grc/callback',
      });

    expect(res.status).toBe(200);
    expect(typeof res.body.state).toBe('string');
    // Signed state has a "<encoded>.<sig>" shape — not just a UUID.
    expect(res.body.state).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    // Make sure it's NOT a bare UUID (the old, vulnerable shape).
    expect(res.body.state).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('SCRUM-1238: /callback rejects an unsigned UUID state (the old shape)', async () => {
    dbFromMock.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { org_id: TEST_ORG_ID, role: 'admin' } }),
    });

    const res = await request(createApp())
      .post('/api/v1/grc/callback')
      .send({
        platform: 'vanta',
        code: 'oauth-code-123',
        redirect_uri: 'http://localhost:5173/grc/callback',
        org_id: TEST_ORG_ID,
        state: crypto.randomUUID(),
      });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/state/i);
  });

  it('SCRUM-1238: /callback rejects a state signed with a different secret', async () => {
    // Forge a state signed with a wrong secret.
    const payload = Buffer.from(JSON.stringify({
      orgId: TEST_ORG_ID,
      userId: TEST_USER_ID,
      platform: 'vanta',
      nonce: 'n',
      iat: Date.now(),
    }), 'utf8').toString('base64url');
    const sig = crypto.createHmac('sha256', 'wrong-secret').update(payload).digest('base64url');
    const forged = `${payload}.${sig}`;

    dbFromMock.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { org_id: TEST_ORG_ID, role: 'admin' } }),
    });

    const res = await request(createApp())
      .post('/api/v1/grc/callback')
      .send({
        platform: 'vanta',
        code: 'oauth-code-123',
        redirect_uri: 'http://localhost:5173/grc/callback',
        org_id: TEST_ORG_ID,
        state: forged,
      });

    expect(res.status).toBe(400);
  });

  it('SCRUM-1238: /callback rejects when state.userId does not match the caller', async () => {
    // State signed for a *different* user.
    const payload = Buffer.from(JSON.stringify({
      orgId: TEST_ORG_ID,
      userId: '99999999-9999-4999-8999-999999999999',
      platform: 'vanta',
      nonce: 'n',
      iat: Date.now(),
    }), 'utf8').toString('base64url');
    const sig = crypto.createHmac('sha256', 'grc-test-state-secret').update(payload).digest('base64url');
    const wrongUserState = `${payload}.${sig}`;

    dbFromMock.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { org_id: TEST_ORG_ID, role: 'admin' } }),
    });

    const res = await request(createApp())
      .post('/api/v1/grc/callback')
      .send({
        platform: 'vanta',
        code: 'oauth-code-123',
        redirect_uri: 'http://localhost:5173/grc/callback',
        org_id: TEST_ORG_ID,
        state: wrongUserState,
      });

    expect(res.status).toBe(400);
  });

  it('SCRUM-1238: /callback rejects expired state (>10 minutes old)', async () => {
    const payload = Buffer.from(JSON.stringify({
      orgId: TEST_ORG_ID,
      userId: TEST_USER_ID,
      platform: 'vanta',
      nonce: 'n',
      iat: Date.now() - 11 * 60 * 1000, // 11 minutes ago
    }), 'utf8').toString('base64url');
    const sig = crypto.createHmac('sha256', 'grc-test-state-secret').update(payload).digest('base64url');
    const expired = `${payload}.${sig}`;

    dbFromMock.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { org_id: TEST_ORG_ID, role: 'admin' } }),
    });

    const res = await request(createApp())
      .post('/api/v1/grc/callback')
      .send({
        platform: 'vanta',
        code: 'oauth-code-123',
        redirect_uri: 'http://localhost:5173/grc/callback',
        org_id: TEST_ORG_ID,
        state: expired,
      });

    expect(res.status).toBe(400);
  });
});
