import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { API_V2_SCOPES, type ApiV2Scope } from '../apiScopes.js';
import {
  DEFAULT_V2_SCOPE_RATE_LIMITS,
  MemoryV2RateLimitStore,
  createV2ApiKeyRateLimit,
  createV2ScopeRateLimit,
  getV2ScopeRateLimitConfig,
  resetV2ApiKeyRateLimit,
} from './rateLimit.js';
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

function buildScopedApp(scope: ApiV2Scope, now: () => number, quota = 2) {
  const app = express();
  const store = new MemoryV2RateLimitStore();
  app.use((req, _res, next) => {
    req.apiKey = {
      keyId: 'key-1',
      orgId: 'org-1',
      userId: 'user-1',
      scopes: [scope],
      rateLimitTier: 'paid',
      keyPrefix: 'ak_test_',
    };
    next();
  });
  app.get('/probe', createV2ScopeRateLimit(scope, {
    quotas: { [scope]: quota },
    windowMs: 60_000,
    now,
    store,
  }), (_req, res) => res.json({ ok: true }));
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

describe('scope-aware v2 rate limits', () => {
  it('uses the documented default per-scope quotas', () => {
    expect(getV2ScopeRateLimitConfig({})).toEqual(DEFAULT_V2_SCOPE_RATE_LIMITS);
  });

  it('allows env overrides without changing unspecified defaults', () => {
    expect(getV2ScopeRateLimitConfig({
      API_V2_RATE_LIMIT_READ_RECORDS_PER_MIN: '750',
      API_V2_RATE_LIMIT_ADMIN_RULES_PER_MIN: '25',
    })).toMatchObject({
      'read:search': 1_000,
      'read:records': 750,
      'read:orgs': 500,
      'write:anchors': 100,
      'admin:rules': 25,
    });
  });

  it.each(API_V2_SCOPES)('enforces threshold and reset for %s', async (scope) => {
    let now = 1_000;
    const app = buildScopedApp(scope, () => now);

    await request(app).get('/probe').expect(200);
    const second = await request(app).get('/probe').expect(200);
    expect(second.header['x-ratelimit-limit']).toBe('2');
    expect(second.header['x-ratelimit-remaining']).toBe('0');

    const blocked = await request(app).get('/probe').expect(429);
    expect(blocked.header['retry-after']).toBe('60');
    expect(blocked.header['x-ratelimit-remaining']).toBe('0');
    expect(blocked.body.type).toContain('/rate-limited');

    now += 60_001;
    const reset = await request(app).get('/probe').expect(200);
    expect(reset.header['x-ratelimit-remaining']).toBe('1');
  });
});
