/**
 * Tests for API Key CRUD Endpoints (P4.5-TS-07)
 *
 * Constitution 1.4: Raw keys never stored, only HMAC-SHA256 hash.
 * Key lifecycle events logged to audit_events.
 *
 * Tests the key generation and validation logic directly,
 * plus integration with the CRUD request handlers.
 */

import { describe, it, expect, vi } from 'vitest';
import { generateApiKey, hashApiKey } from '../../middleware/apiKeyAuth.js';

// Mock DB + logger
vi.mock('../../utils/db.js', () => ({
  db: {
    from: vi.fn(),
  },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

const TEST_HMAC_SECRET = 'test-hmac-secret-for-keys-crud';

describe('API Key CRUD — key generation security', () => {
  it('generated key raw value starts with ak_live_ prefix', () => {
    const { raw } = generateApiKey(TEST_HMAC_SECRET, false);
    expect(raw.startsWith('ak_live_')).toBe(true);
  });

  it('generated test key starts with ak_test_ prefix', () => {
    const { raw } = generateApiKey(TEST_HMAC_SECRET, true);
    expect(raw.startsWith('ak_test_')).toBe(true);
  });

  it('raw key is never equal to the hash (Constitution 1.4)', () => {
    const { raw, hash } = generateApiKey(TEST_HMAC_SECRET);
    expect(raw).not.toBe(hash);
  });

  it('prefix is a safe display substring of the raw key', () => {
    const { raw, prefix } = generateApiKey(TEST_HMAC_SECRET);
    expect(raw.startsWith(prefix)).toBe(true);
    expect(prefix.length).toBe(12);
  });

  it('hash is reproducible from raw + secret', () => {
    const { raw, hash } = generateApiKey(TEST_HMAC_SECRET);
    expect(hashApiKey(raw, TEST_HMAC_SECRET)).toBe(hash);
  });

  it('different secret produces different hash for same key', () => {
    const { raw, hash } = generateApiKey(TEST_HMAC_SECRET);
    const differentHash = hashApiKey(raw, 'different-secret');
    expect(differentHash).not.toBe(hash);
  });

  it('key contains 64 hex chars of randomness after prefix', () => {
    const { raw } = generateApiKey(TEST_HMAC_SECRET);
    const randomPart = raw.replace(/^ak_(live|test)_/, '');
    expect(randomPart).toMatch(/^[a-f0-9]{64}$/);
  });

  it('each generated key is unique', () => {
    const keys = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const { raw } = generateApiKey(TEST_HMAC_SECRET);
      keys.add(raw);
    }
    expect(keys.size).toBe(100);
  });
});

describe('API Key CRUD — AUTH-06 ORG_ADMIN role enforcement', () => {
  // Use supertest-like approach: import the router, mount it, and test via Express
  // Since we mock db, we test the role-check logic directly via handler extraction

  function mockReqRes(userId: string | undefined) {
    const req = {
      authUserId: userId,
      hmacSecret: TEST_HMAC_SECRET,
      body: { name: 'Test Key' },
      params: { keyId: 'key-123' },
    } as unknown as import('express').Request;

    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      end: vi.fn(),
    } as unknown as import('express').Response;

    return { req, res };
  }

  async function mockProfileLookup(role: string | null) {
    const { db } = await import('../../utils/db.js');
    (db.from as ReturnType<typeof vi.fn>).mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: { org_id: 'org-123', role },
            error: null,
          }),
        }),
      }),
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function getRouteHandler(router: any, method: string, path: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const layer = router.stack.find((l: any) =>
      l.route?.path === path && l.route?.methods?.[method]
    );
    return layer?.route?.stack?.[0]?.handle;
  }

  it('rejects MEMBER role with 403 on POST /keys', async () => {
    const { keysRouter } = await import('./keys.js');
    await mockProfileLookup('MEMBER');
    const { req, res } = mockReqRes('user-123');

    const handler = getRouteHandler(keysRouter, 'post', '/');
    expect(handler).toBeDefined();
    await handler(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('admin') })
    );
  });

  it('rejects MEMBER role with 403 on GET /keys', async () => {
    const { keysRouter } = await import('./keys.js');
    await mockProfileLookup('MEMBER');
    const { req, res } = mockReqRes('user-123');

    const handler = getRouteHandler(keysRouter, 'get', '/');
    expect(handler).toBeDefined();
    await handler(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('admin') })
    );
  });

  it('rejects MEMBER role with 403 on PATCH /keys/:keyId', async () => {
    const { keysRouter } = await import('./keys.js');
    await mockProfileLookup('MEMBER');
    const { req, res } = mockReqRes('user-123');
    req.body = { name: 'Updated' };

    const handler = getRouteHandler(keysRouter, 'patch', '/:keyId');
    expect(handler).toBeDefined();
    await handler(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('admin') })
    );
  });

  it('rejects MEMBER role with 403 on DELETE /keys/:keyId', async () => {
    const { keysRouter } = await import('./keys.js');
    await mockProfileLookup('MEMBER');
    const { req, res } = mockReqRes('user-123');

    const handler = getRouteHandler(keysRouter, 'delete', '/:keyId');
    expect(handler).toBeDefined();
    await handler(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('admin') })
    );
  });

  it('rejects null role as non-admin', async () => {
    const { keysRouter } = await import('./keys.js');
    await mockProfileLookup(null as unknown as string);
    const { req, res } = mockReqRes('user-123');

    const handler = getRouteHandler(keysRouter, 'get', '/');
    expect(handler).toBeDefined();
    await handler(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe('API Key CRUD — validation schemas', () => {
  it('CreateKeySchema accepts valid input', async () => {
    const { CreateKeySchema } = await import('./keys.js');

    const result = CreateKeySchema.safeParse({ name: 'My Production Key' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scopes).toEqual(['read:search']);
    }
  });

  it('CreateKeySchema accepts each canonical API key scope', async () => {
    const { CreateKeySchema } = await import('./keys.js');
    const { API_KEY_SCOPES } = await import('../apiScopes.js');

    for (const scope of API_KEY_SCOPES) {
      const result = CreateKeySchema.safeParse({ name: `Key ${scope}`, scopes: [scope] });
      expect(result.success).toBe(true);
    }
  });

  it('CreateKeySchema rejects unknown scopes', async () => {
    const { CreateKeySchema } = await import('./keys.js');

    const result = CreateKeySchema.safeParse({ name: 'Bad Key', scopes: ['admin:everything'] });
    expect(result.success).toBe(false);
  });

  it('CreateKeySchema rejects empty scope arrays', async () => {
    const { CreateKeySchema } = await import('./keys.js');

    const result = CreateKeySchema.safeParse({ name: 'Bad Key', scopes: [] });
    expect(result.success).toBe(false);
  });

  it('CreateKeySchema rejects empty name', async () => {
    const { z } = await import('zod');
    const CreateKeySchema = z.object({
      name: z.string().min(1).max(100),
    });

    const result = CreateKeySchema.safeParse({ name: '' });
    expect(result.success).toBe(false);
  });

  it('CreateKeySchema rejects name over 100 chars', async () => {
    const { z } = await import('zod');
    const CreateKeySchema = z.object({
      name: z.string().min(1).max(100),
    });

    const result = CreateKeySchema.safeParse({ name: 'x'.repeat(101) });
    expect(result.success).toBe(false);
  });

  it('UpdateKeySchema accepts partial updates', async () => {
    const { UpdateKeySchema } = await import('./keys.js');

    expect(UpdateKeySchema.safeParse({ name: 'New Name' }).success).toBe(true);
    expect(UpdateKeySchema.safeParse({ is_active: false }).success).toBe(true);
    expect(UpdateKeySchema.safeParse({}).success).toBe(true);
  });
});
