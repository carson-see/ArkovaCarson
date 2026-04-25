import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createV2ApiKeyRateLimit, resetV2ApiKeyRateLimit } from './rateLimit.js';
import { v2ErrorHandler } from './problem.js';

vi.mock('../../config.js', () => ({
  config: { nodeEnv: 'test' },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('../../middleware/errorSanitizer.js', () => ({
  sanitizeErrorMessage: (m: string) => m,
}));

function buildApp(now: () => number) {
  const app = express();
  app.use((req, _res, next) => {
    req.apiKey = {
      keyId: 'key-1',
      orgId: 'org-1',
      userId: 'user-1',
      scopes: ['read:search'],
      rateLimitTier: 'paid',
      keyPrefix: 'ak_test_',
    };
    next();
  });
  app.use(createV2ApiKeyRateLimit({ maxRequests: 2, windowMs: 60_000, now }));
  app.get('/search', (_req, res) => res.json({ ok: true }));
  app.use(v2ErrorHandler);
  return app;
}

describe('createV2ApiKeyRateLimit', () => {
  beforeEach(() => {
    resetV2ApiKeyRateLimit();
  });

  it('allows requests within the API key policy and emits rate headers', async () => {
    const app = buildApp(() => 1_000);

    const res = await request(app).get('/search');

    expect(res.status).toBe(200);
    expect(res.header['x-ratelimit-limit']).toBe('2');
    expect(res.header['x-ratelimit-remaining']).toBe('1');
  });

  it('returns RFC 7807 problem+json when the key exceeds its minute bucket', async () => {
    const app = buildApp(() => 1_000);

    await request(app).get('/search');
    await request(app).get('/search');
    const res = await request(app).get('/search');

    expect(res.status).toBe(429);
    expect(res.type).toBe('application/problem+json');
    expect(res.header['retry-after']).toBe('60');
    expect(res.body.type).toContain('/rate-limited');
  });
});
