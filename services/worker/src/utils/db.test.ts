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

    it('returns pooler mode when SUPABASE_POOLER_URL is set', async () => {
      process.env.SUPABASE_POOLER_URL = 'postgresql://user:pass@db.supabase.co:6543/postgres';
      const { getConnectionInfo } = await import('./db.js');
      const info = getConnectionInfo();
      expect(info.mode).toBe('pooler');
    });

    it('masks credentials in URL', async () => {
      process.env.SUPABASE_POOLER_URL = 'postgresql://user:secretpass@db.supabase.co:6543/postgres';
      const { getConnectionInfo } = await import('./db.js');
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

    it('returns true when pooler URL is set', async () => {
      process.env.SUPABASE_POOLER_URL = 'postgresql://user:pass@db.supabase.co:6543/postgres';
      const { isPoolerActive, getDb } = await import('./db.js');
      getDb(); // trigger initialization
      expect(isPoolerActive()).toBe(true);
    });
  });

  describe('pooler URL validation', () => {
    it('warns when pooler URL does not use port 6543', async () => {
      process.env.SUPABASE_POOLER_URL = 'postgresql://user:pass@db.supabase.co:5432/postgres';
      const loggerMod = await import('./logger.js');
      const { getDb } = await import('./db.js');
      getDb(); // trigger initialization
      expect(loggerMod.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ port: '5432' }),
        expect.stringContaining('does not use port 6543')
      );
    });

    it('does not warn about port when pooler URL uses port 6543', async () => {
      process.env.SUPABASE_POOLER_URL = 'postgresql://user:pass@db.supabase.co:6543/postgres';
      const loggerMod = await import('./logger.js');
      vi.mocked(loggerMod.logger.warn).mockClear();
      const { getDb } = await import('./db.js');
      getDb(); // trigger initialization
      // Check that no warn call mentions port 6543 issue
      const warnCalls = vi.mocked(loggerMod.logger.warn).mock.calls;
      const portWarn = warnCalls.find(
        (call) => typeof call[1] === 'string' && call[1].includes('does not use port 6543')
      );
      expect(portWarn).toBeUndefined();
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
