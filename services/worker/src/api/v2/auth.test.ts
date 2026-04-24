import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { apiKeyAuthV2 } from './auth.js';
import { requireScopeV2 } from './scopeGuard.js';
import { v2ErrorHandler } from './problem.js';
import { hashApiKey } from '../../middleware/apiKeyAuth.js';

vi.mock('../../utils/db.js', () => ({
  db: { from: vi.fn() },
}));

vi.mock('../../config.js', () => ({
  config: { nodeEnv: 'test' },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('../../middleware/errorSanitizer.js', () => ({
  sanitizeErrorMessage: (m: string) => m,
}));

import { db } from '../../utils/db.js';

const SECRET = 'test-hmac-secret';

function mockKeyLookup(result: Record<string, unknown> | null, error: unknown = null) {
  const single = vi.fn().mockResolvedValue({ data: result, error });
  (db.from as ReturnType<typeof vi.fn>).mockReturnValue({
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single,
    update: vi.fn().mockReturnThis(),
  });
}

function buildApp() {
  const app = express();
  app.use(apiKeyAuthV2(SECRET));
  app.get('/protected', requireScopeV2('read:search'), (_req, res) => res.json({ ok: true }));
  app.use(v2ErrorHandler);
  return app;
}

describe('apiKeyAuthV2', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns problem+json when the key is missing and a scope is required', async () => {
    const res = await request(buildApp()).get('/protected');

    expect(res.status).toBe(401);
    expect(res.type).toBe('application/problem+json');
    expect(res.body.type).toContain('/authentication-required');
  });

  it('returns problem+json for invalid API keys', async () => {
    mockKeyLookup(null, { message: 'not found' });

    const res = await request(buildApp())
      .get('/protected')
      .set('Authorization', 'Bearer ak_test_invalid');

    expect(res.status).toBe(401);
    expect(res.type).toBe('application/problem+json');
    expect(res.body.type).toContain('/invalid-api-key');
  });

  it('returns problem+json for revoked API keys', async () => {
    mockKeyLookup({
      id: 'key-1',
      org_id: 'org-1',
      created_by: 'user-1',
      scopes: ['read:search'],
      rate_limit_tier: 'paid',
      key_prefix: 'ak_test_',
      is_active: false,
      expires_at: null,
    });

    const res = await request(buildApp())
      .get('/protected')
      .set('X-API-Key', 'ak_test_revoked');

    expect(res.status).toBe(401);
    expect(res.body.type).toContain('/api-key-revoked');
  });

  it('authenticates valid keys and updates last_used_at without blocking', async () => {
    const raw = 'ak_test_123';
    const expectedHash = hashApiKey(raw, SECRET);
    const eq = vi.fn().mockReturnThis();
    const single = vi.fn().mockResolvedValue({
      data: {
        id: 'key-1',
        org_id: 'org-1',
        created_by: 'user-1',
        scopes: ['read:search'],
        rate_limit_tier: 'paid',
        key_prefix: 'ak_test_',
        is_active: true,
        expires_at: null,
      },
      error: null,
    });
    (db.from as ReturnType<typeof vi.fn>).mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq,
      single,
      update: vi.fn().mockReturnThis(),
    });

    const res = await request(buildApp())
      .get('/protected')
      .set('Authorization', `Bearer ${raw}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(eq).toHaveBeenCalledWith('key_hash', expectedHash);
    expect(eq).toHaveBeenCalledWith('id', 'key-1');
  });
});
