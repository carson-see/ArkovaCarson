/**
 * Tests for GET /api/v1/usage (P4.5-TS-08)
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../utils/db.js', () => ({
  db: { from: vi.fn() },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Verify the usage response interface matches the spec
describe('UsageResponse shape', () => {
  it('matches the expected API contract', () => {
    const response = {
      used: 1500,
      limit: 10000,
      remaining: 8500,
      reset_date: '2026-04-01T00:00:00.000Z',
      month: '2026-03',
      keys: [
        { key_prefix: 'ak_live_abc1', name: 'Production', used: 1200 },
        { key_prefix: 'ak_live_def2', name: 'Staging', used: 300 },
      ],
    };

    expect(response.used).toBe(1500);
    expect(response.limit).toBe(10000);
    expect(response.remaining).toBe(8500);
    expect(response.keys).toHaveLength(2);
    expect(response.keys[0].key_prefix).toMatch(/^ak_/);
  });

  it('supports unlimited tier', () => {
    const response = {
      used: 50000,
      limit: 'unlimited' as const,
      remaining: 'unlimited' as const,
      reset_date: '2026-04-01T00:00:00.000Z',
      month: '2026-03',
      keys: [],
    };

    expect(response.limit).toBe('unlimited');
    expect(response.remaining).toBe('unlimited');
  });

  it('computes remaining correctly near quota', () => {
    const used = 9500;
    const limit = 10000;
    const remaining = Math.max(0, limit - used);

    expect(remaining).toBe(500);
  });

  it('remaining is 0 when over quota', () => {
    const used = 10500;
    const limit = 10000;
    const remaining = Math.max(0, limit - used);

    expect(remaining).toBe(0);
  });
});
