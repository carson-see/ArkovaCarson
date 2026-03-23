/**
 * Tests for DB timeout wrapper (SCALE-3)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the module dependencies
vi.mock('../config.js', () => ({
  config: {
    supabaseUrl: 'https://test.supabase.co',
    supabaseServiceKey: 'test-key',
  },
}));

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
  },
}));

import { withDbTimeout, resetDbCircuit, getDbCircuitState } from './db.js';

describe('withDbTimeout', () => {
  beforeEach(() => {
    resetDbCircuit();
  });

  it('resolves fast operations normally', async () => {
    const result = await withDbTimeout(() => Promise.resolve('ok'));
    expect(result).toBe('ok');
  });

  it('rejects when operation exceeds timeout', async () => {
    const slowOp = () => new Promise<string>((resolve) => setTimeout(() => resolve('late'), 5000));
    await expect(withDbTimeout(slowOp, 50)).rejects.toThrow('timed out');
  });

  it('records failure on timeout', async () => {
    const slowOp = () => new Promise<string>((resolve) => setTimeout(() => resolve('late'), 5000));
    try {
      await withDbTimeout(slowOp, 50);
    } catch {
      // expected
    }
    const state = getDbCircuitState();
    expect(state.consecutiveFailures).toBeGreaterThan(0);
  });

  it('records success on successful operation', async () => {
    // First cause a failure to set consecutiveFailures > 0
    const slowOp = () => new Promise<string>((resolve) => setTimeout(() => resolve('late'), 5000));
    try {
      await withDbTimeout(slowOp, 50);
    } catch {
      // expected
    }

    // Then a success should reset it
    await withDbTimeout(() => Promise.resolve('ok'));
    const state = getDbCircuitState();
    expect(state.consecutiveFailures).toBe(0);
  });
});
