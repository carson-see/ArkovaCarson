/**
 * QA Audit Tests: ERR-1 — Database Circuit Breaker
 *
 * Validates the circuit breaker tracks consecutive failures,
 * reports unhealthy after threshold, and resets on success.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../config.js', () => ({
  config: {
    supabaseUrl: 'http://localhost:54321',
    supabaseServiceKey: 'test-key',
  },
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({})),
}));

import {
  recordDbSuccess,
  recordDbFailure,
  isDbHealthy,
  getDbCircuitState,
  resetDbCircuit,
} from './db.js';

describe('ERR-1: Database Circuit Breaker', () => {
  beforeEach(() => {
    resetDbCircuit();
  });

  it('starts healthy with zero failures', () => {
    expect(isDbHealthy()).toBe(true);
    expect(getDbCircuitState()).toEqual({
      healthy: true,
      consecutiveFailures: 0,
      lastError: null,
    });
  });

  it('stays healthy after fewer than threshold failures', () => {
    for (let i = 0; i < 4; i++) {
      recordDbFailure(new Error(`fail ${i}`));
    }
    expect(isDbHealthy()).toBe(true);
    expect(getDbCircuitState().consecutiveFailures).toBe(4);
  });

  it('becomes unhealthy after 5 consecutive failures', () => {
    for (let i = 0; i < 5; i++) {
      recordDbFailure(new Error(`fail ${i}`));
    }
    expect(isDbHealthy()).toBe(false);
    expect(getDbCircuitState().consecutiveFailures).toBe(5);
    expect(getDbCircuitState().lastError).toBe('fail 4');
  });

  it('resets to healthy after a successful operation', () => {
    for (let i = 0; i < 5; i++) {
      recordDbFailure(new Error('fail'));
    }
    expect(isDbHealthy()).toBe(false);

    recordDbSuccess();

    expect(isDbHealthy()).toBe(true);
    expect(getDbCircuitState().consecutiveFailures).toBe(0);
    expect(getDbCircuitState().lastError).toBeNull();
  });

  it('tracks string errors as well as Error objects', () => {
    recordDbFailure('string error');
    expect(getDbCircuitState().lastError).toBe('string error');
  });
});
