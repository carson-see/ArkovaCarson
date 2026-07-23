/**
 * Unit tests for database client (QA-PERF-3)
 *
 * Tests PgBouncer pooler detection, connection info masking,
 * circuit breaker, and timeout wrapper.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies before imports
vi.mock('../config.js', () => ({
  config: {
    supabaseUrl: 'https://test.supabase.co',
    supabaseServiceKey: 'test-service-key',
  },
}));

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: vi.fn(() => ({
      select: vi.fn(() => ({ limit: vi.fn(() => ({ data: [], error: null })) })),
    })),
  })),
}));

describe('db', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('getConnectionInfo', () => {
    it('returns direct mode when SUPABASE_POOLER_URL is not set', async () => {
      delete process.env.SUPABASE_POOLER_URL;
      const { getConnectionInfo } = await import('./db.js');
      const info = getConnectionInfo();
      expect(info.mode).toBe('direct');
    });

    it('returns pooler mode when an http(s) SUPABASE_POOLER_URL is set', async () => {
      // WH-2: only http(s) pooler URLs are accepted; getConnectionInfo now
      // reflects the actual applied state (poolerActive), not env presence.
      process.env.SUPABASE_POOLER_URL = 'https://pooler.supabase.co:6543/rest/v1';
      const { getConnectionInfo, getDb } = await import('./db.js');
      getDb(); // apply the pooler URL
      const info = getConnectionInfo();
      expect(info.mode).toBe('pooler');
    });

    it('reports direct mode when a postgres:// pooler URL is rejected (WH-2)', async () => {
      process.env.SUPABASE_POOLER_URL = 'postgres://user:pass@db.supabase.co:6543/postgres';
      const { getConnectionInfo, getDb } = await import('./db.js');
      getDb();
      // Rejected as a REST base → falls back to direct; must NOT claim 'pooler'.
      expect(getConnectionInfo().mode).toBe('direct');
    });

    it('masks credentials in URL', async () => {
      process.env.SUPABASE_POOLER_URL = 'https://user:secretpass@pooler.supabase.co:6543/rest/v1';
      const { getConnectionInfo, getDb } = await import('./db.js');
      getDb();
      const info = getConnectionInfo();
      expect(info.url).not.toContain('secretpass');
      expect(info.url).toContain('***');
    });
  });

  describe('isPoolerActive', () => {
    it('returns false when pooler URL is not set', async () => {
      delete process.env.SUPABASE_POOLER_URL;
      const { isPoolerActive } = await import('./db.js');
      expect(isPoolerActive()).toBe(false);
    });

    it('returns true when an http(s) pooler URL is set', async () => {
      // WH-2: only http(s) pooler URLs are accepted as the PostgREST REST base.
      process.env.SUPABASE_POOLER_URL = 'https://pooler.supabase.co:6543/rest/v1';
      const { isPoolerActive, getDb } = await import('./db.js');
      getDb(); // trigger initialization
      expect(isPoolerActive()).toBe(true);
    });
  });

  describe('pooler URL validation', () => {
    it('warns when an http(s) pooler URL does not use port 6543', async () => {
      process.env.SUPABASE_POOLER_URL = 'https://pooler.supabase.co:5432/rest/v1';
      const loggerMod = await import('./logger.js');
      const { getDb } = await import('./db.js');
      getDb(); // trigger initialization
      expect(loggerMod.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ port: '5432' }),
        expect.stringContaining('does not use port 6543')
      );
    });

    it('does not warn about port when pooler URL uses port 6543', async () => {
      process.env.SUPABASE_POOLER_URL = 'https://pooler.supabase.co:6543/rest/v1';
      const loggerMod = await import('./logger.js');
      vi.mocked(loggerMod.logger.warn).mockClear();
      const { getDb } = await import('./db.js');
      getDb(); // trigger initialization
      // Check that no warn call mentions port 6543 issue
      const warnCalls = vi.mocked(loggerMod.logger.warn).mock.calls as unknown as unknown[][];
      const portWarn = warnCalls.find(
        (call) => typeof call[1] === 'string' && (call[1] as string).includes('does not use port 6543')
      );
      expect(portWarn).toBeUndefined();
    });

    // ─── WH-2 (SCRUM-2899): reject postgres:// as the REST base ───────────
    it('rejects a postgres:// SUPABASE_POOLER_URL as the REST base and falls back to direct', async () => {
      process.env.SUPABASE_POOLER_URL = 'postgres://user:pass@db.supabase.co:6543/postgres';
      const loggerMod = await import('./logger.js');
      const { getDb, isPoolerActive } = await import('./db.js');
      getDb();
      // Not treated as an active pooler REST base (the footgun that produced
      // `fetch failed` on every PostgREST call is now guarded).
      expect(isPoolerActive()).toBe(false);
      expect(loggerMod.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ scheme: 'postgres:' }),
        expect.stringContaining('cannot be a PostgREST REST base'),
      );
    });

    it('rejects a postgresql:// SUPABASE_POOLER_URL as the REST base', async () => {
      process.env.SUPABASE_POOLER_URL = 'postgresql://user:pass@db.supabase.co:6543/postgres';
      const { getDb, isPoolerActive } = await import('./db.js');
      getDb();
      expect(isPoolerActive()).toBe(false);
    });
  });

  // ─── WH-1 (SCRUM-2899 / ARKOVA-WORKER-C): resilient fetch ──────────────
  describe('isTransientConnectionError', () => {
    it('classifies "TypeError: fetch failed" as transient', async () => {
      const { isTransientConnectionError } = await import('./db.js');
      expect(isTransientConnectionError(new TypeError('fetch failed'))).toBe(true);
    });

    it('classifies a nested ECONNRESET cause as transient', async () => {
      const { isTransientConnectionError } = await import('./db.js');
      const err = new TypeError('fetch failed');
      (err as { cause?: unknown }).cause = Object.assign(new Error('read ECONNRESET'), {
        code: 'ECONNRESET',
      });
      expect(isTransientConnectionError(err)).toBe(true);
    });

    it('classifies an undici UND_ERR_SOCKET code as transient', async () => {
      const { isTransientConnectionError } = await import('./db.js');
      const err = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
      expect(isTransientConnectionError(err)).toBe(true);
    });

    it('does NOT classify a generic application error as transient', async () => {
      const { isTransientConnectionError } = await import('./db.js');
      expect(isTransientConnectionError(new Error('duplicate key value'))).toBe(false);
    });

    it('returns false for null/undefined', async () => {
      const { isTransientConnectionError } = await import('./db.js');
      expect(isTransientConnectionError(null)).toBe(false);
      expect(isTransientConnectionError(undefined)).toBe(false);
    });
  });

  describe('createResilientFetch', () => {
    it('retries ONCE on a connection-level failure and succeeds on the fresh socket', async () => {
      const { createResilientFetch } = await import('./db.js');
      const sentinel = { ok: true, status: 200 };
      const baseFetch = vi
        .fn()
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(sentinel);
      // dispatcher is only spread into opts and handed to baseFetch (mocked here).
      const resilient = createResilientFetch(baseFetch as never, {} as never);
      const res = await resilient('https://x.supabase.co/rest/v1/foo' as never, {} as never);
      expect(res).toBe(sentinel);
      expect(baseFetch).toHaveBeenCalledTimes(2);
    });

    it('does NOT retry a non-idempotent write (POST) even on a transient error — treasury double-apply guard', async () => {
      const { createResilientFetch } = await import('./db.js');
      const baseFetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
      const resilient = createResilientFetch(baseFetch as never, {} as never);
      await expect(
        resilient('https://x.supabase.co/rest/v1/anchors' as never, { method: 'POST' } as never),
      ).rejects.toThrow('fetch failed');
      // A retried POST could double-apply a credit deduction / billing row.
      expect(baseFetch).toHaveBeenCalledTimes(1);
    });

    it('does NOT retry a PATCH/RPC write on a transient error', async () => {
      const { createResilientFetch } = await import('./db.js');
      const baseFetch = vi.fn().mockRejectedValue(
        Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
      );
      const resilient = createResilientFetch(baseFetch as never, {} as never);
      await expect(
        resilient('https://x.supabase.co/rest/v1/rpc/deduct_org_credit' as never, {
          method: 'POST',
        } as never),
      ).rejects.toThrow('other side closed');
      expect(baseFetch).toHaveBeenCalledTimes(1);
    });

    it('does NOT retry a non-transient error and rethrows it', async () => {
      const { createResilientFetch } = await import('./db.js');
      const baseFetch = vi.fn().mockRejectedValue(new Error('400 Bad Request'));
      const resilient = createResilientFetch(baseFetch as never, {} as never);
      await expect(
        resilient('https://x.supabase.co/rest/v1/foo' as never, {} as never),
      ).rejects.toThrow('400 Bad Request');
      expect(baseFetch).toHaveBeenCalledTimes(1);
    });

    it('does NOT retry when the first call succeeds', async () => {
      const { createResilientFetch } = await import('./db.js');
      const sentinel = { ok: true, status: 204 };
      const baseFetch = vi.fn().mockResolvedValue(sentinel);
      const resilient = createResilientFetch(baseFetch as never, {} as never);
      await resilient('https://x.supabase.co/rest/v1/foo' as never, {} as never);
      expect(baseFetch).toHaveBeenCalledTimes(1);
    });

    it('passes the dispatcher through to the base fetch', async () => {
      const { createResilientFetch } = await import('./db.js');
      const baseFetch = vi.fn().mockResolvedValue({ ok: true });
      const dispatcher = { marker: 'agent' };
      const resilient = createResilientFetch(baseFetch as never, dispatcher as never);
      await resilient('https://x.supabase.co/rest/v1/foo' as never, { method: 'GET' } as never);
      expect(baseFetch).toHaveBeenCalledWith(
        'https://x.supabase.co/rest/v1/foo',
        expect.objectContaining({ method: 'GET', dispatcher }),
      );
    });
  });

  describe('circuit breaker', () => {
    it('starts healthy', async () => {
      delete process.env.SUPABASE_POOLER_URL;
      const { isDbHealthy } = await import('./db.js');
      expect(isDbHealthy()).toBe(true);
    });

    it('opens after consecutive failures', async () => {
      delete process.env.SUPABASE_POOLER_URL;
      const { isDbHealthy, recordDbFailure } = await import('./db.js');
      for (let i = 0; i < 5; i++) {
        recordDbFailure(new Error('connection refused'));
      }
      expect(isDbHealthy()).toBe(false);
    });

    it('resets on success', async () => {
      delete process.env.SUPABASE_POOLER_URL;
      const { isDbHealthy, recordDbFailure, recordDbSuccess, resetDbCircuit } = await import('./db.js');
      resetDbCircuit();
      for (let i = 0; i < 5; i++) {
        recordDbFailure(new Error('fail'));
      }
      recordDbSuccess();
      expect(isDbHealthy()).toBe(true);
    });

    it('returns circuit state for diagnostics', async () => {
      delete process.env.SUPABASE_POOLER_URL;
      const { getDbCircuitState, resetDbCircuit } = await import('./db.js');
      resetDbCircuit();
      const state = getDbCircuitState();
      expect(state).toEqual({
        healthy: true,
        consecutiveFailures: 0,
        lastError: null,
      });
    });
  });

  describe('withDbTimeout', () => {
    it('resolves when operation completes within timeout', async () => {
      delete process.env.SUPABASE_POOLER_URL;
      const { withDbTimeout, resetDbCircuit } = await import('./db.js');
      resetDbCircuit();
      const result = await withDbTimeout(() => Promise.resolve('ok'), 5000);
      expect(result).toBe('ok');
    });

    it('rejects when operation exceeds timeout', async () => {
      delete process.env.SUPABASE_POOLER_URL;
      const { withDbTimeout, resetDbCircuit } = await import('./db.js');
      resetDbCircuit();
      await expect(
        withDbTimeout(() => new Promise((resolve) => setTimeout(resolve, 5000)), 50)
      ).rejects.toThrow('timed out');
    });

    it('records failure on operation error', async () => {
      delete process.env.SUPABASE_POOLER_URL;
      const { withDbTimeout, getDbCircuitState, resetDbCircuit } = await import('./db.js');
      resetDbCircuit();
      await expect(
        withDbTimeout(() => Promise.reject(new Error('db error')), 5000)
      ).rejects.toThrow('db error');
      expect(getDbCircuitState().consecutiveFailures).toBe(1);
    });
  });
});
