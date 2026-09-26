import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const { verifyMock } = vi.hoisted(() => ({ verifyMock: vi.fn() }));
vi.mock('../auth.js', () => ({ verifyAuthToken: verifyMock }));
vi.mock('../config.js', () => ({ config: {} }));
vi.mock('../utils/logger.js', () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));
import { requireAgentLifecycleAuth } from './agentLifecycleAuth.js';

const meta = { keyId: 'key', orgId: 'org', userId: 'owner', keyPrefix: 'ak_live_one', scopes: ['agents:manage'], rateLimitTier: 'paid' as const };
function app(apiKey: typeof meta | undefined) {
  const result = express();
  result.use((req, _res, next) => { req.apiKey = apiKey; next(); });
  result.use(requireAgentLifecycleAuth);
  result.post('/', (_req, res) => res.json({ ok: true }));
  return result;
}
beforeEach(() => { vi.clearAllMocks(); verifyMock.mockResolvedValue('user'); });

describe('agent lifecycle dual auth', () => {
  it('rejects invalid JWT even when a valid X API key resolved', async () => {
    verifyMock.mockResolvedValue(null);
    const res = await request(app(meta)).post('/').set('Authorization', 'Bearer invalid.jwt').set('X-API-Key', 'ak_live_one');
    expect(res.status).toBe(401);
  });
  it('rejects a valid JWT plus valid API key as ambiguous', async () => {
    const res = await request(app(meta)).post('/').set('Authorization', 'Bearer valid.jwt').set('X-API-Key', 'ak_live_one');
    expect(res.status).toBe(409);
  });
  it.each(['', 'malformed'] as const)('rejects a valid JWT plus malformed X API key %j', async (value) => {
    const res = await request(app(undefined)).post('/').set('Authorization', 'Bearer valid.jwt').set('X-API-Key', value);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_api_key');
  });
  it('rejects bearer API key plus a conflicting malformed X key', async () => {
    const res = await request(app(meta)).post('/').set('Authorization', 'Bearer ak_live_one').set('X-API-Key', 'malformed');
    expect(res.status).toBe(409);
  });
  it('denies insufficient scope before downstream body handling', async () => {
    const res = await request(app({ ...meta, scopes: ['verify'] })).post('/').set('X-API-Key', 'ak_live_one').send('{bad');
    expect(res.status).toBe(403);
  });
  it('accepts one valid JWT or one agents:manage key', async () => {
    expect((await request(app(undefined)).post('/').set('Authorization', 'Bearer valid.jwt')).status).toBe(200);
    expect((await request(app(meta)).post('/').set('X-API-Key', 'ak_live_one')).status).toBe(200);
  });
  it.each(['Basic abc', 'Bearer '])('rejects malformed Authorization %j instead of falling back to a valid X key', async (authorization) => {
    const res = await request(app(meta)).post('/').set('Authorization', authorization).set('X-API-Key', 'ak_live_one');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_authorization');
    expect(res.body.message).toBe('Authorization header is malformed or empty.');
  });

});
