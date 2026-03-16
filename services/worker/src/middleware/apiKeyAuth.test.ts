/**
 * Tests for API Key Authentication Middleware (P4.5-TS-03)
 *
 * Constitution 1.4: Raw API keys are NEVER stored. Only HMAC-SHA256 hashes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hashApiKey, generateApiKey, apiKeyAuth } from './apiKeyAuth.js';
import type { Request, Response } from 'express';

// Mock DB + logger
vi.mock('../utils/db.js', () => ({
  db: {
    from: vi.fn(),
  },
}));

vi.mock('../utils/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

import { db } from '../utils/db.js';

const TEST_HMAC_SECRET = 'test-hmac-secret-for-api-key-hashing';

function createMockReq(headers: Record<string, string> = {}): Request {
  return {
    headers,
    apiKey: undefined,
  } as unknown as Request;
}

function createMockRes() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
}

function mockKeyLookup(result: Record<string, unknown> | null, error: unknown = null) {
  const singleMock = vi.fn().mockResolvedValue({ data: result, error });
  const eqHashMock = vi.fn().mockReturnValue({ single: singleMock });
  const selectMock = vi.fn().mockReturnValue({ eq: eqHashMock });
  (db.from as ReturnType<typeof vi.fn>).mockReturnValue({
    select: selectMock,
    update: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue(Promise.resolve()),
    }),
  });
}

describe('hashApiKey', () => {
  it('produces a deterministic hex hash', () => {
    const hash1 = hashApiKey('ak_live_abc123', TEST_HMAC_SECRET);
    const hash2 = hashApiKey('ak_live_abc123', TEST_HMAC_SECRET);
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/);
  });

  it('produces different hashes for different keys', () => {
    const hash1 = hashApiKey('ak_live_key1', TEST_HMAC_SECRET);
    const hash2 = hashApiKey('ak_live_key2', TEST_HMAC_SECRET);
    expect(hash1).not.toBe(hash2);
  });

  it('produces different hashes with different secrets', () => {
    const hash1 = hashApiKey('ak_live_same', 'secret-a');
    const hash2 = hashApiKey('ak_live_same', 'secret-b');
    expect(hash1).not.toBe(hash2);
  });
});

describe('generateApiKey', () => {
  it('generates a live key with correct prefix', () => {
    const { raw, hash, prefix } = generateApiKey(TEST_HMAC_SECRET, false);
    expect(raw).toMatch(/^ak_live_[a-f0-9]{64}$/);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(prefix).toBe(raw.substring(0, 12));
  });

  it('generates a test key with correct prefix', () => {
    const { raw } = generateApiKey(TEST_HMAC_SECRET, true);
    expect(raw).toMatch(/^ak_test_[a-f0-9]{64}$/);
  });

  it('generates unique keys on each call', () => {
    const key1 = generateApiKey(TEST_HMAC_SECRET);
    const key2 = generateApiKey(TEST_HMAC_SECRET);
    expect(key1.raw).not.toBe(key2.raw);
    expect(key1.hash).not.toBe(key2.hash);
  });

  it('hash matches hashApiKey for the same raw key', () => {
    const { raw, hash } = generateApiKey(TEST_HMAC_SECRET);
    expect(hashApiKey(raw, TEST_HMAC_SECRET)).toBe(hash);
  });
});

describe('apiKeyAuth middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows anonymous requests when required=false', async () => {
    const req = createMockReq({});
    const res = createMockRes();
    const next = vi.fn();

    const middleware = apiKeyAuth(TEST_HMAC_SECRET);
    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.apiKey).toBeUndefined();
  });

  it('rejects anonymous requests when required=true', async () => {
    const req = createMockReq({});
    const res = createMockRes();
    const next = vi.fn();

    const middleware = apiKeyAuth(TEST_HMAC_SECRET, { required: true });
    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'authentication_required' }),
    );
  });

  it('authenticates valid key via Authorization header', async () => {
    const { raw } = generateApiKey(TEST_HMAC_SECRET);
    mockKeyLookup({
      id: 'key-uuid-1',
      org_id: 'org-uuid-1',
      scopes: ['verify'],
      rate_limit_tier: 'free',
      key_prefix: raw.substring(0, 12),
      is_active: true,
      expires_at: null,
    });

    const req = createMockReq({ authorization: `Bearer ${raw}` });
    const res = createMockRes();
    const next = vi.fn();

    const middleware = apiKeyAuth(TEST_HMAC_SECRET);
    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.apiKey).toEqual({
      keyId: 'key-uuid-1',
      orgId: 'org-uuid-1',
      scopes: ['verify'],
      rateLimitTier: 'free',
      keyPrefix: raw.substring(0, 12),
    });
  });

  it('authenticates valid key via X-API-Key header', async () => {
    const { raw } = generateApiKey(TEST_HMAC_SECRET);
    mockKeyLookup({
      id: 'key-uuid-2',
      org_id: 'org-uuid-2',
      scopes: ['verify', 'search'],
      rate_limit_tier: 'paid',
      key_prefix: raw.substring(0, 12),
      is_active: true,
      expires_at: null,
    });

    const req = createMockReq({ 'x-api-key': raw });
    const res = createMockRes();
    const next = vi.fn();

    const middleware = apiKeyAuth(TEST_HMAC_SECRET);
    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.apiKey?.rateLimitTier).toBe('paid');
  });

  it('rejects invalid key (not in DB)', async () => {
    mockKeyLookup(null, { message: 'not found' });

    const req = createMockReq({ authorization: 'Bearer ak_live_invalidkey123' });
    const res = createMockRes();
    const next = vi.fn();

    const middleware = apiKeyAuth(TEST_HMAC_SECRET);
    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'invalid_api_key' }),
    );
  });

  it('rejects revoked key', async () => {
    mockKeyLookup({
      id: 'key-revoked',
      org_id: 'org-1',
      scopes: ['verify'],
      rate_limit_tier: 'free',
      key_prefix: 'ak_live_rev',
      is_active: false,
      expires_at: null,
    });

    const req = createMockReq({ authorization: 'Bearer ak_live_revokedkey456' });
    const res = createMockRes();
    const next = vi.fn();

    const middleware = apiKeyAuth(TEST_HMAC_SECRET);
    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'api_key_revoked' }),
    );
  });

  it('rejects expired key', async () => {
    mockKeyLookup({
      id: 'key-expired',
      org_id: 'org-1',
      scopes: ['verify'],
      rate_limit_tier: 'free',
      key_prefix: 'ak_live_exp',
      is_active: true,
      expires_at: '2020-01-01T00:00:00Z', // far in the past
    });

    const req = createMockReq({ authorization: 'Bearer ak_live_expiredkey789' });
    const res = createMockRes();
    const next = vi.fn();

    const middleware = apiKeyAuth(TEST_HMAC_SECRET);
    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'api_key_expired' }),
    );
  });

  it('ignores non-ak_ Authorization headers (passes through)', async () => {
    const req = createMockReq({ authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.jwt_token' });
    const res = createMockRes();
    const next = vi.fn();

    const middleware = apiKeyAuth(TEST_HMAC_SECRET);
    await middleware(req, res, next);

    // Should pass through as anonymous (JWT is not an API key)
    expect(next).toHaveBeenCalled();
    expect(req.apiKey).toBeUndefined();
  });

  it('handles DB errors gracefully', async () => {
    (db.from as ReturnType<typeof vi.fn>).mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockRejectedValue(new Error('DB connection failed')),
        }),
      }),
    });

    const req = createMockReq({ authorization: 'Bearer ak_live_somekey' });
    const res = createMockRes();
    const next = vi.fn();

    const middleware = apiKeyAuth(TEST_HMAC_SECRET);
    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'internal_error' }),
    );
  });
});
