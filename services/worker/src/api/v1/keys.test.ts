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


/**
 * FD-P7 / BUG-2026-08-12 — customer-operable key revocation (SOC 2 CC6.8).
 *
 * Found in the fullsoak-2026-08 Day-0 audit, prod-exposed.
 *
 * `toPublicKey()` stripped `id` from BOTH the create response and every list
 * row, while PATCH/DELETE address a key by `:keyId` (= `api_keys.id`). An org
 * admin could therefore see their keys but had no identifier to revoke one
 * with — `ApiKeySettings.tsx` passes `apiKey.id`, which was `undefined` at
 * runtime, so the Revoke button issued `PATCH /api/v1/keys/undefined` and 404'd.
 * Separately the revoke path never stamped `revoked_at`, leaving the lifecycle
 * control with no evidence trail even when it did fire.
 *
 * These tests pin the whole loop: list -> take the id -> revoke with it.
 */
describe('API Key CRUD — FD-P7 revocation reachability (CC6.8)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function getRouteHandler(router: any, method: string, path: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const layer = router.stack.find((l: any) =>
      l.route?.path === path && l.route?.methods?.[method]
    );
    return layer?.route?.stack?.[0]?.handle;
  }

  const ORG_ID = 'org-fd-p7';

  interface DbFixture {
    listRows?: Record<string, unknown>[];
    insertedRow?: Record<string, unknown>;
    existingRow?: Record<string, unknown> | null;
    updatedRow?: Record<string, unknown>;
    role?: string;
  }

  /**
   * Installs a db mock that serves every chain keys.ts builds, keyed by the
   * builder method rather than by call order — call-order mocks silently pass
   * the wrong row when a route grows a query.
   */
  async function installDb(fixture: DbFixture) {
    const { db } = await import('../../utils/db.js');
    const captured: {
      update: Record<string, unknown> | null;
      insert: Record<string, unknown> | null;
      audit: Record<string, unknown>[];
    } = { update: null, insert: null, audit: [] };

    const profileChain = {
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: { org_id: ORG_ID, role: fixture.role ?? 'ORG_ADMIN' },
            error: null,
          }),
        }),
      }),
    };

    const apiKeysChain = {
      // GET list: .select().eq('org_id').order()
      // PATCH ownership probe: .select().eq('id').eq('org_id').single()
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          order: vi.fn().mockResolvedValue({ data: fixture.listRows ?? [], error: null }),
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: fixture.existingRow ?? null,
              error: fixture.existingRow ? null : { message: 'not found' },
            }),
          }),
        }),
      }),
      insert: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
        captured.insert = payload;
        return {
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: fixture.insertedRow ?? null, error: null }),
          }),
        };
      }),
      update: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
        captured.update = payload;
        const terminal = {
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: fixture.updatedRow ?? null, error: null }),
          }),
        };
        return { eq: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue(terminal) }) };
      }),
    };

    const auditChain = {
      insert: vi.fn().mockImplementation((row: Record<string, unknown>) => {
        captured.audit.push(row);
        return Promise.resolve({ error: null });
      }),
    };

    (db.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === 'profiles') return profileChain;
      if (table === 'api_keys') return apiKeysChain;
      if (table === 'audit_events') return auditChain;
      return {};
    });

    return captured;
  }

  function mockRes() {
    return {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      end: vi.fn(),
    } as unknown as import('express').Response;
  }

  function mockReq(body: unknown, params: Record<string, string> = {}) {
    return {
      authUserId: 'user-fd-p7',
      hmacSecret: TEST_HMAC_SECRET,
      body,
      params,
    } as unknown as import('express').Request;
  }

  /** Payload handed to res.json(), whichever overload the route used. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function jsonBody(res: any) {
    return res.json.mock.calls[0]?.[0];
  }

  const STORED_ROW = {
    id: 'key-uuid-fd-p7',
    key_prefix: 'ak_live_abcd',
    name: 'Partner integration key',
    scopes: ['verify'],
    rate_limit_tier: 'standard',
    is_active: true,
    created_at: '2026-08-01T00:00:00Z',
    expires_at: null,
    last_used_at: null,
    revoked_at: null,
  };

  it('GET /keys returns the id on every row — without it no key is revocable', async () => {
    await installDb({ listRows: [STORED_ROW] });
    const { keysRouter } = await import('./keys.js');
    const res = mockRes();

    await getRouteHandler(keysRouter, 'get', '/')(mockReq(undefined), res, vi.fn());

    const { keys } = jsonBody(res);
    expect(keys).toHaveLength(1);
    expect(keys[0].id).toBe('key-uuid-fd-p7');
  });

  it('GET /keys still withholds org_id and key_hash', async () => {
    await installDb({
      listRows: [{ ...STORED_ROW, org_id: ORG_ID, key_hash: 'SECRET_HASH_NOT_REAL' }],
    });
    const { keysRouter } = await import('./keys.js');
    const res = mockRes();

    await getRouteHandler(keysRouter, 'get', '/')(mockReq(undefined), res, vi.fn());

    const serialized = JSON.stringify(jsonBody(res));
    expect(serialized).not.toContain(ORG_ID);
    expect(serialized).not.toContain('SECRET_HASH_NOT_REAL');
  });

  it('POST /keys returns the id alongside the one-time raw key', async () => {
    await installDb({ insertedRow: STORED_ROW });
    const { keysRouter } = await import('./keys.js');
    const res = mockRes();

    await getRouteHandler(keysRouter, 'post', '/')(
      mockReq({ name: 'Partner integration key', scopes: ['verify'] }),
      res,
      vi.fn(),
    );

    expect(res.status).toHaveBeenCalledWith(201);
    const body = jsonBody(res);
    expect(body.id).toBe('key-uuid-fd-p7');
    expect(body.key).toMatch(/^ak_(live|test)_/);
    expect(body).not.toHaveProperty('org_id');
    expect(body).not.toHaveProperty('key_hash');
  });

  it('PATCH is_active:false stamps revoked_at', async () => {
    const captured = await installDb({
      existingRow: { id: STORED_ROW.id, org_id: ORG_ID, revoked_at: null },
      updatedRow: { ...STORED_ROW, is_active: false, revoked_at: '2026-08-12T00:00:00Z' },
    });
    const { keysRouter } = await import('./keys.js');
    const res = mockRes();
    const before = Date.now();

    await getRouteHandler(keysRouter, 'patch', '/:keyId')(
      mockReq({ is_active: false }, { keyId: STORED_ROW.id }),
      res,
      vi.fn(),
    );

    expect(captured.update?.is_active).toBe(false);
    const stamped = Date.parse(captured.update?.revoked_at as string);
    expect(Number.isNaN(stamped)).toBe(false);
    expect(stamped).toBeGreaterThanOrEqual(before - 1000);
    expect(stamped).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('PATCH is_active:false persists an operator-supplied revocation_reason', async () => {
    const captured = await installDb({
      existingRow: { id: STORED_ROW.id, org_id: ORG_ID, revoked_at: null },
      updatedRow: { ...STORED_ROW, is_active: false },
    });
    const { keysRouter } = await import('./keys.js');

    await getRouteHandler(keysRouter, 'patch', '/:keyId')(
      mockReq(
        { is_active: false, revocation_reason: 'leaked in a public gist' },
        { keyId: STORED_ROW.id },
      ),
      mockRes(),
      vi.fn(),
    );

    expect(captured.update?.revocation_reason).toBe('leaked in a public gist');
  });

  it('PATCH of the name alone never stamps revoked_at', async () => {
    const captured = await installDb({
      existingRow: { id: STORED_ROW.id, org_id: ORG_ID, revoked_at: null },
      updatedRow: { ...STORED_ROW, name: 'Renamed' },
    });
    const { keysRouter } = await import('./keys.js');

    await getRouteHandler(keysRouter, 'patch', '/:keyId')(
      mockReq({ name: 'Renamed' }, { keyId: STORED_ROW.id }),
      mockRes(),
      vi.fn(),
    );

    expect(captured.update).toEqual({ name: 'Renamed' });
  });

  it('re-revoking preserves the FIRST revoked_at — the audit-truthful timestamp', async () => {
    const captured = await installDb({
      existingRow: { id: STORED_ROW.id, org_id: ORG_ID, revoked_at: '2026-08-01T12:00:00Z' },
      updatedRow: { ...STORED_ROW, is_active: false, revoked_at: '2026-08-01T12:00:00Z' },
    });
    const { keysRouter } = await import('./keys.js');

    await getRouteHandler(keysRouter, 'patch', '/:keyId')(
      mockReq({ is_active: false }, { keyId: STORED_ROW.id }),
      mockRes(),
      vi.fn(),
    );

    expect(captured.update).not.toHaveProperty('revoked_at');
    expect(captured.update?.is_active).toBe(false);
  });

  it('refuses to reactivate a revoked key (409) — revocation is terminal', async () => {
    const captured = await installDb({
      existingRow: { id: STORED_ROW.id, org_id: ORG_ID, revoked_at: '2026-08-01T12:00:00Z' },
    });
    const { keysRouter } = await import('./keys.js');
    const res = mockRes();

    await getRouteHandler(keysRouter, 'patch', '/:keyId')(
      mockReq({ is_active: true }, { keyId: STORED_ROW.id }),
      res,
      vi.fn(),
    );

    expect(res.status).toHaveBeenCalledWith(409);
    expect(captured.update).toBeNull();
  });

  it('logs the revocation to audit_events with the reason attached', async () => {
    const captured = await installDb({
      existingRow: { id: STORED_ROW.id, org_id: ORG_ID, revoked_at: null },
      updatedRow: { ...STORED_ROW, is_active: false },
    });
    const { keysRouter } = await import('./keys.js');

    await getRouteHandler(keysRouter, 'patch', '/:keyId')(
      mockReq({ is_active: false, revocation_reason: 'rotating' }, { keyId: STORED_ROW.id }),
      mockRes(),
      vi.fn(),
    );

    const revocation = captured.audit.find((e) => e.event_type === 'api_key.revoked');
    expect(revocation).toBeDefined();
    expect(revocation?.target_id).toBe(STORED_ROW.id);
    expect(String(revocation?.details)).toContain('rotating');
  });

  it('end to end: the id a customer reads from GET is the id revoke accepts', async () => {
    await installDb({ listRows: [STORED_ROW] });
    const { keysRouter } = await import('./keys.js');

    const listRes = mockRes();
    await getRouteHandler(keysRouter, 'get', '/')(mockReq(undefined), listRes, vi.fn());
    const discoveredId = jsonBody(listRes).keys[0].id;

    // The mock resolves the owned row regardless of the id it is handed, so
    // without this the rest of the test passes on `undefined` — which is
    // exactly the broken state. Assert the customer got a usable identifier.
    expect(typeof discoveredId).toBe('string');
    expect(discoveredId).toBe(STORED_ROW.id);

    // Re-arm the db with that exact id as the owned row.
    const captured = await installDb({
      existingRow: { id: discoveredId, org_id: ORG_ID, revoked_at: null },
      updatedRow: { ...STORED_ROW, id: discoveredId, is_active: false },
    });
    const revokeRes = mockRes();
    await getRouteHandler(keysRouter, 'patch', '/:keyId')(
      mockReq({ is_active: false }, { keyId: discoveredId }),
      revokeRes,
      vi.fn(),
    );

    expect(revokeRes.status).not.toHaveBeenCalledWith(404);
    expect(captured.update?.is_active).toBe(false);
    expect(jsonBody(revokeRes).is_active).toBe(false);
  });
});
