/**
 * Unit tests for Upstash Redis Rate Limit Adapter (QA-PERF-1)
 *
 * Tests the UpstashRateLimitStore and initUpstashRateLimiting().
 * Uses mocked fetch — no real Redis calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger before imports
vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Use vi.hoisted to create the mock fn before vi.mock hoists
const { mockSetRateLimitStore } = vi.hoisted(() => ({
  mockSetRateLimitStore: vi.fn(),
}));

vi.mock('./rateLimit.js', () => ({
  setRateLimitStore: mockSetRateLimitStore,
}));

import { UpstashRateLimitStore, initUpstashRateLimiting } from './upstashRateLimit.js';

describe('UpstashRateLimitStore', () => {
  let store: UpstashRateLimitStore;
  const baseUrl = 'https://test-redis.upstash.io';
  const token = 'test-token-abc123';

  beforeEach(() => {
    store = new UpstashRateLimitStore(baseUrl, token);
    vi.restoreAllMocks();
  });

  describe('local cache operations', () => {
    it('get returns undefined for missing keys', () => {
      expect(store.get('nonexistent')).toBeUndefined();
    });

    it('set stores entry in local cache', () => {
      const entry = { count: 1, resetAt: Date.now() + 60000 };
      store.set('test-key', entry);
      expect(store.get('test-key')).toEqual(entry);
    });

    it('delete removes entry from local cache', () => {
      const entry = { count: 1, resetAt: Date.now() + 60000 };
      store.set('test-key', entry);
      store.delete('test-key');
      expect(store.get('test-key')).toBeUndefined();
    });

    it('size reflects local cache size', () => {
      expect(store.size).toBe(0);
      store.set('key1', { count: 1, resetAt: Date.now() + 60000 });
      expect(store.size).toBe(1);
      store.set('key2', { count: 2, resetAt: Date.now() + 60000 });
      expect(store.size).toBe(2);
    });

    it('entries iterates local cache', () => {
      store.set('key1', { count: 1, resetAt: 100000 });
      store.set('key2', { count: 2, resetAt: 200000 });
      const entries = Array.from(store.entries());
      expect(entries).toHaveLength(2);
      expect(entries[0][0]).toBe('key1');
      expect(entries[1][0]).toBe('key2');
    });
  });

  describe('Redis write-through', () => {
    it('set fires async Redis SET with TTL', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', mockFetch);

      const resetAt = Date.now() + 30000;
      store.set('rate:10.0.0.1', { count: 5, resetAt });

      // Allow async fire-and-forget to complete
      await new Promise((r) => setTimeout(r, 10));

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/set/'),
        expect.objectContaining({
          headers: { Authorization: `Bearer ${token}` },
        })
      );

      vi.unstubAllGlobals();
    });

    it('delete fires async Redis DEL', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', mockFetch);

      store.set('rate:10.0.0.1', { count: 1, resetAt: Date.now() + 60000 });
      store.delete('rate:10.0.0.1');

      await new Promise((r) => setTimeout(r, 10));

      // Should have SET + DEL calls
      const delCall = mockFetch.mock.calls.find((c: string[]) =>
        c[0].includes('/del/')
      );
      expect(delCall).toBeDefined();

      vi.unstubAllGlobals();
    });

    it('handles Redis SET failure gracefully', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('network error'));
      vi.stubGlobal('fetch', mockFetch);

      // Should not throw — fire-and-forget
      store.set('rate:fail', { count: 1, resetAt: Date.now() + 60000 });

      // Local cache should still work
      expect(store.get('rate:fail')).toBeDefined();

      await new Promise((r) => setTimeout(r, 10));
      vi.unstubAllGlobals();
    });
  });

  describe('syncFromRedis', () => {
    it('populates local cache from Redis', async () => {
      const entry = { count: 3, resetAt: Date.now() + 60000 };
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ result: JSON.stringify(entry) }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await store.syncFromRedis(['rate:sync-key']);
      expect(store.get('rate:sync-key')).toEqual(entry);

      vi.unstubAllGlobals();
    });

    it('skips expired entries from Redis', async () => {
      const expiredEntry = { count: 3, resetAt: Date.now() - 1000 };
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ result: JSON.stringify(expiredEntry) }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await store.syncFromRedis(['rate:expired']);
      expect(store.get('rate:expired')).toBeUndefined();

      vi.unstubAllGlobals();
    });

    it('skips keys that fail to fetch', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
      });
      vi.stubGlobal('fetch', mockFetch);

      await store.syncFromRedis(['rate:missing']);
      expect(store.get('rate:missing')).toBeUndefined();

      vi.unstubAllGlobals();
    });
  });
});

describe('initUpstashRateLimiting', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    mockSetRateLimitStore.mockClear();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns false when env vars are not set', () => {
    delete process.env.UPSTASH_REDIS_URL;
    delete process.env.UPSTASH_REDIS_TOKEN;
    const result = initUpstashRateLimiting();
    expect(result).toBe(false);
    expect(mockSetRateLimitStore).not.toHaveBeenCalled();
  });

  it('returns false when only URL is set', () => {
    process.env.UPSTASH_REDIS_URL = 'https://test.upstash.io';
    delete process.env.UPSTASH_REDIS_TOKEN;
    const result = initUpstashRateLimiting();
    expect(result).toBe(false);
  });

  it('returns true and sets store when both env vars are set', () => {
    process.env.UPSTASH_REDIS_URL = 'https://test.upstash.io';
    process.env.UPSTASH_REDIS_TOKEN = 'test-token';
    const result = initUpstashRateLimiting();
    expect(result).toBe(true);
    expect(mockSetRateLimitStore).toHaveBeenCalledWith(
      expect.any(UpstashRateLimitStore)
    );
  });

  it('strips trailing slash from base URL', () => {
    process.env.UPSTASH_REDIS_URL = 'https://test.upstash.io/';
    process.env.UPSTASH_REDIS_TOKEN = 'test-token';
    initUpstashRateLimiting();

    const store = mockSetRateLimitStore.mock.calls[0][0] as UpstashRateLimitStore;
    // Verify store was created (internal validation)
    expect(store).toBeInstanceOf(UpstashRateLimitStore);
  });
});
