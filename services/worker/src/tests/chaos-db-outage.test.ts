/**
 * QA-CHAOS-01: Supabase Outage Simulation
 *
 * Validates that the DB circuit breaker correctly detects consecutive failures,
 * opens the circuit (reporting unhealthy via /health), and recovers when
 * the database becomes available again (half-open → closed).
 *
 * Also validates the timeout wrapper rejects hung operations and feeds
 * failures into the circuit breaker.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config and supabase to avoid env var validation
vi.mock('../config.js', () => ({
  config: {
    supabaseUrl: 'https://test.supabase.co',
    supabaseServiceKey: 'test-service-key',
  },
}));

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({ from: vi.fn() })),
}));

import {
  recordDbSuccess,
  recordDbFailure,
  isDbHealthy,
  getDbCircuitState,
  resetDbCircuit,
  withDbTimeout,
} from '../utils/db.js';

describe('QA-CHAOS-01: Supabase Outage Simulation', () => {
  beforeEach(() => {
    resetDbCircuit();
  });

  describe('circuit breaker state machine', () => {
    it('starts in healthy/closed state', () => {
      expect(isDbHealthy()).toBe(true);
      const state = getDbCircuitState();
      expect(state.healthy).toBe(true);
      expect(state.consecutiveFailures).toBe(0);
      expect(state.lastError).toBeNull();
    });

    it('stays healthy for fewer than 5 failures', () => {
      for (let i = 0; i < 4; i++) {
        recordDbFailure(new Error(`failure ${i + 1}`));
      }
      expect(isDbHealthy()).toBe(true);
      const state = getDbCircuitState();
      expect(state.consecutiveFailures).toBe(4);
      expect(state.lastError).toBe('failure 4');
    });

    it('opens circuit after 5 consecutive failures (simulated outage)', () => {
      for (let i = 0; i < 5; i++) {
        recordDbFailure(new Error('connection refused'));
      }
      expect(isDbHealthy()).toBe(false);
      const state = getDbCircuitState();
      expect(state.consecutiveFailures).toBe(5);
      expect(state.lastError).toBe('connection refused');
    });

    it('stays open for additional failures beyond threshold', () => {
      for (let i = 0; i < 10; i++) {
        recordDbFailure(new Error('still down'));
      }
      expect(isDbHealthy()).toBe(false);
      expect(getDbCircuitState().consecutiveFailures).toBe(10);
    });

    it('resets to healthy on first success after outage', () => {
      for (let i = 0; i < 7; i++) {
        recordDbFailure(new Error('outage'));
      }
      expect(isDbHealthy()).toBe(false);

      recordDbSuccess();
      expect(isDbHealthy()).toBe(true);
      const state = getDbCircuitState();
      expect(state.consecutiveFailures).toBe(0);
      expect(state.lastError).toBeNull();
    });

    it('handles intermittent failures (reset between bursts)', () => {
      for (let i = 0; i < 3; i++) recordDbFailure(new Error('blip'));
      recordDbSuccess();
      expect(isDbHealthy()).toBe(true);

      for (let i = 0; i < 3; i++) recordDbFailure(new Error('blip'));
      recordDbSuccess();
      expect(isDbHealthy()).toBe(true);
    });

    it('handles rapid failure-success-failure sequences', () => {
      recordDbFailure(new Error('f1'));
      recordDbSuccess();
      recordDbFailure(new Error('f2'));
      recordDbFailure(new Error('f3'));
      recordDbSuccess();
      expect(isDbHealthy()).toBe(true);
      expect(getDbCircuitState().consecutiveFailures).toBe(0);
    });

    it('records non-Error failure reasons as strings', () => {
      recordDbFailure('string error');
      expect(getDbCircuitState().lastError).toBe('string error');

      recordDbFailure(42);
      expect(getDbCircuitState().lastError).toBe('42');

      recordDbFailure({ message: 'object' });
      expect(getDbCircuitState().lastError).toBe('[object Object]');
    });
  });

  describe('timeout wrapper under simulated latency', () => {
    it('resolves fast operations within timeout', async () => {
      const result = await withDbTimeout(async () => 'fast', 5000);
      expect(result).toBe('fast');
    });

    it('rejects operations that exceed timeout', async () => {
      await expect(
        withDbTimeout(
          () => new Promise((resolve) => setTimeout(resolve, 500)),
          50,
        ),
      ).rejects.toThrow('timed out');
    });

    it('records timeout as circuit breaker failure', async () => {
      resetDbCircuit();

      try {
        await withDbTimeout(
          () => new Promise((resolve) => setTimeout(resolve, 500)),
          10,
        );
      } catch {
        // expected
      }

      expect(getDbCircuitState().consecutiveFailures).toBe(1);
      expect(getDbCircuitState().lastError).toContain('timed out');
    });

    it('records non-timeout errors as circuit breaker failures', async () => {
      resetDbCircuit();

      try {
        await withDbTimeout(async () => {
          throw new Error('connection refused');
        });
      } catch {
        // expected
      }

      expect(getDbCircuitState().consecutiveFailures).toBe(1);
      expect(getDbCircuitState().lastError).toBe('connection refused');
    });

    it('records success and resets circuit on successful operation', async () => {
      recordDbFailure(new Error('f1'));
      recordDbFailure(new Error('f2'));
      expect(getDbCircuitState().consecutiveFailures).toBe(2);

      await withDbTimeout(async () => 'ok');
      expect(getDbCircuitState().consecutiveFailures).toBe(0);
    });

    it('simulated sustained outage opens circuit via timeouts', async () => {
      resetDbCircuit();

      for (let i = 0; i < 5; i++) {
        try {
          await withDbTimeout(
            () => new Promise((resolve) => setTimeout(resolve, 500)),
            10,
          );
        } catch {
          // expected
        }
      }

      expect(isDbHealthy()).toBe(false);
      expect(getDbCircuitState().consecutiveFailures).toBe(5);
    });
  });
});
