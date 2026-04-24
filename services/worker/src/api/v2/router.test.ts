import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import type { Request } from 'express';
import request from 'supertest';

vi.mock('../../config.js', () => ({
  config: { nodeEnv: 'test', apiKeyHmacSecret: 'test-secret' },
}));

vi.mock('../../middleware/featureGate.js', () => ({
  verificationApiGate: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('./auth.js', () => ({
  apiKeyAuthV2: () => (req: Request, _res: unknown, next: () => void) => {
    req.apiKey = {
      keyId: 'key-1',
      orgId: 'org-1',
      userId: 'user-1',
      scopes: ['read:search'],
      rateLimitTier: 'paid',
      keyPrefix: 'ak_test_',
    };
    next();
  },
}));

vi.mock('./rateLimit.js', () => ({
  v2ApiKeyRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
  createV2ScopeRateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../../utils/db.js', () => ({
  db: { from: vi.fn(), rpc: vi.fn() },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('../../middleware/errorSanitizer.js', () => ({
  sanitizeErrorMessage: (m: string) => m,
}));

import { apiV2Router } from './router.js';

function buildApp() {
  const app = express();
  app.use('/api/v2', apiV2Router);
  return app;
}

describe('apiV2Router', () => {
  it('serves the OpenAPI 3.1 spec before API-key auth', async () => {
    const res = await request(buildApp()).get('/api/v2/openapi.json');

    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.1.0');
    expect(res.body.paths['/search'].get['x-agent-usage']).toBeTruthy();
  });

  it('returns problem+json for unmatched v2 routes', async () => {
    const res = await request(buildApp()).get('/api/v2/nope');

    expect(res.status).toBe(404);
    expect(res.type).toBe('application/problem+json');
    expect(res.body.type).toContain('/not-found');
  });
});
