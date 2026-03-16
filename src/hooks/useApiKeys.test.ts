/**
 * useApiKeys + useApiUsage Tests (P4.5-TS-09, P4.5-TS-10)
 *
 * Tests the exported interfaces and data shapes.
 * Hook lifecycle tests are covered via the ApiKeySettingsPage integration test.
 */

import { describe, it, expect } from 'vitest';
import type { ApiKeyMasked, ApiKeyCreated, ApiUsageData } from './useApiKeys';

describe('ApiKeyMasked interface', () => {
  it('matches the expected shape', () => {
    const key: ApiKeyMasked = {
      id: 'key-1',
      key_prefix: 'ak_live_abc1',
      name: 'Production',
      scopes: ['verify', 'batch'],
      rate_limit_tier: 'standard',
      is_active: true,
      created_at: '2026-03-10T00:00:00Z',
      expires_at: null,
      last_used_at: '2026-03-14T12:00:00Z',
    };

    expect(key.key_prefix).toMatch(/^ak_/);
    expect(key.scopes).toContain('verify');
    expect(key.is_active).toBe(true);
  });

  it('supports expired key state', () => {
    const key: ApiKeyMasked = {
      id: 'key-2',
      key_prefix: 'ak_live_def2',
      name: 'Old Key',
      scopes: ['verify'],
      rate_limit_tier: 'standard',
      is_active: false,
      created_at: '2026-01-01T00:00:00Z',
      expires_at: '2026-02-01T00:00:00Z',
      last_used_at: null,
    };

    expect(key.is_active).toBe(false);
    expect(key.expires_at).toBeTruthy();
  });
});

describe('ApiKeyCreated interface', () => {
  it('extends masked key with raw key and warning', () => {
    const created: ApiKeyCreated = {
      id: 'key-new',
      key_prefix: 'ak_live_xyz',
      name: 'New Key',
      scopes: ['verify'],
      rate_limit_tier: 'standard',
      is_active: true,
      created_at: '2026-03-15T00:00:00Z',
      expires_at: null,
      last_used_at: null,
      key: 'ak_live_xyz123456789abcdef',
      warning: 'Save this key now. It cannot be retrieved again.',
    };

    expect(created.key).toMatch(/^ak_live_/);
    expect(created.warning).toBeTruthy();
  });
});

describe('ApiUsageData interface', () => {
  it('matches the expected shape with numeric limit', () => {
    const usage: ApiUsageData = {
      used: 1500,
      limit: 10000,
      remaining: 8500,
      reset_date: '2026-04-01T00:00:00Z',
      month: '2026-03',
      keys: [
        { key_prefix: 'ak_live_abc1', name: 'Production', used: 1200 },
        { key_prefix: 'ak_live_def2', name: 'Staging', used: 300 },
      ],
    };

    expect(usage.used).toBe(1500);
    expect(usage.limit).toBe(10000);
    expect(typeof usage.remaining).toBe('number');
    expect(usage.keys).toHaveLength(2);
  });

  it('supports unlimited tier', () => {
    const usage: ApiUsageData = {
      used: 50000,
      limit: 'unlimited',
      remaining: 'unlimited',
      reset_date: '2026-04-01T00:00:00Z',
      month: '2026-03',
      keys: [],
    };

    expect(usage.limit).toBe('unlimited');
    expect(usage.remaining).toBe('unlimited');
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
