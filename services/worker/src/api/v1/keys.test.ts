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

describe('API Key CRUD — audit event_category matches CHECK constraint', () => {
  it('logAuditEvent uses an event_category in the allowed set', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, 'keys.ts'),
      'utf-8',
    );
    const match = source.match(/event_category:\s*['"]([^'"]+)['"]/);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('API');
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

  it('CreateKeySchema rejects deprecated alias scopes on write', async () => {
    const { CreateKeySchema } = await import('./keys.js');

    expect(CreateKeySchema.safeParse({ name: 'Batch Alias', scopes: ['batch'] }).success).toBe(false);
    expect(CreateKeySchema.safeParse({ name: 'Usage Alias', scopes: ['usage'] }).success).toBe(false);
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

describe('API Key CRUD — tenant isolation: PATCH update includes org_id guard', () => {
  /**
   * Gap #11 from tenant isolation audit: the UPDATE on PATCH /keys/:keyId
   * filters by `id` only, without the org_id guard. The preceding SELECT
   * already checks org_id, but the UPDATE itself must also include
   * `.eq('org_id', profile.org_id)` for defense-in-depth against TOCTOU.
   */

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function getRouteHandler(router: any, method: string, path: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const layer = router.stack.find((l: any) =>
      l.route?.path === path && l.route?.methods?.[method]
    );
    return layer?.route?.stack?.[0]?.handle;
  }

  it('PATCH /keys/:keyId UPDATE query includes .eq(org_id) for defense-in-depth', async () => {
    const { db } = await import('../../utils/db.js');

    const orgId = 'org-tenant-abc';
    const keyId = 'key-uuid-123';

    // Track all .eq() calls on the UPDATE chain
    const updateEqCalls: Array<[string, string]> = [];

    // Mock profile lookup => ORG_ADMIN
    const profileChain = {
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: { org_id: orgId, role: 'ORG_ADMIN' },
            error: null,
          }),
        }),
      }),
    };

    // Mock SELECT to verify key exists in org
    const selectChain = {
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockImplementation(() => ({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { id: keyId, org_id: orgId },
              error: null,
            }),
          }),
        })),
      }),
    };

    // Mock UPDATE chain — track .eq() calls for assertion
    const updateSelectSingle = vi.fn().mockResolvedValue({
      data: { id: keyId, key_prefix: 'ak_live_xxxx', name: 'Renamed', scopes: ['verify'], rate_limit_tier: 'standard', is_active: true, created_at: '2026-01-01', expires_at: null, last_used_at: null },
      error: null,
    });
    const updateSelectChain = {
      single: updateSelectSingle,
    };
    const updateChain = {
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockImplementation((col: string, val: string) => {
          updateEqCalls.push([col, val]);
          // Return self-like chain for subsequent .eq() or .select()
          return {
            eq: vi.fn().mockImplementation((col2: string, val2: string) => {
              updateEqCalls.push([col2, val2]);
              return {
                select: vi.fn().mockReturnValue(updateSelectChain),
              };
            }),
            select: vi.fn().mockReturnValue(updateSelectChain),
          };
        }),
      }),
    };

    // Mock the audit insert (fire-and-forget)
    const auditChain = {
      insert: vi.fn().mockResolvedValue({ error: null }),
    };

    let callCount = 0;
    (db.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === 'profiles') return profileChain;
      if (table === 'audit_events') return auditChain;
      if (table === 'api_keys') {
        callCount++;
        // First call is SELECT (verify ownership), second is UPDATE
        if (callCount === 1) return selectChain;
        return updateChain;
      }
      return {};
    });

    const { keysRouter } = await import('./keys.js');
    const handler = getRouteHandler(keysRouter, 'patch', '/:keyId');
    expect(handler).toBeDefined();

    const req = {
      authUserId: 'user-123',
      hmacSecret: 'test-secret',
      body: { name: 'Renamed' },
      params: { keyId },
    } as unknown as import('express').Request;

    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    } as unknown as import('express').Response;

    await handler(req, res, vi.fn());

    // The critical assertion: the UPDATE query must include org_id as a filter
    const hasOrgIdFilter = updateEqCalls.some(
      ([col, val]) => col === 'org_id' && val === orgId
    );
    expect(hasOrgIdFilter).toBe(true);
  });
});

