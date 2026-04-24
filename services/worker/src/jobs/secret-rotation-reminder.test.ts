import { describe, it, expect, vi } from 'vitest';

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import {
  checkRotationStatus,
  formatSlackMessage,
  type SecretInventoryItem,
  type RotationCheckResult,
} from './secret-rotation-reminder.js';

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

describe('checkRotationStatus', () => {
  it('flags secrets older than 90 days as overdue', () => {
    const inventory: SecretInventoryItem[] = [
      { name: 'OLD_SECRET', lastRotatedAt: daysAgo(95), category: 'api-key' },
    ];
    const result = checkRotationStatus(inventory);
    expect(result.overdue).toHaveLength(1);
    expect(result.overdue[0].name).toBe('OLD_SECRET');
  });

  it('flags secrets at 83–89 days as expiring soon', () => {
    const inventory: SecretInventoryItem[] = [
      { name: 'AGING_SECRET', lastRotatedAt: daysAgo(85), category: 'token' },
    ];
    const result = checkRotationStatus(inventory);
    expect(result.expiringSoon).toHaveLength(1);
    expect(result.expiringSoon[0].name).toBe('AGING_SECRET');
  });

  it('counts healthy secrets correctly', () => {
    const inventory: SecretInventoryItem[] = [
      { name: 'FRESH', lastRotatedAt: daysAgo(10), category: 'api-key' },
      { name: 'OLD', lastRotatedAt: daysAgo(100), category: 'signing' },
    ];
    const result = checkRotationStatus(inventory);
    expect(result.healthy).toBe(1);
    expect(result.overdue).toHaveLength(1);
  });

  it('returns all healthy for fresh secrets', () => {
    const inventory: SecretInventoryItem[] = [
      { name: 'FRESH_1', lastRotatedAt: daysAgo(5), category: 'api-key' },
      { name: 'FRESH_2', lastRotatedAt: daysAgo(30), category: 'database' },
    ];
    const result = checkRotationStatus(inventory);
    expect(result.healthy).toBe(2);
    expect(result.overdue).toHaveLength(0);
    expect(result.expiringSoon).toHaveLength(0);
  });
});

describe('formatSlackMessage', () => {
  it('formats overdue secrets', () => {
    const result: RotationCheckResult = {
      checked: 2,
      overdue: [{ name: 'OLD_KEY', lastRotatedAt: daysAgo(100), category: 'api-key' }],
      expiringSoon: [],
      healthy: 1,
    };
    const msg = formatSlackMessage(result);
    expect(msg).toContain('OVERDUE');
    expect(msg).toContain('OLD_KEY');
  });

  it('formats all-healthy message', () => {
    const result: RotationCheckResult = {
      checked: 3,
      overdue: [],
      expiringSoon: [],
      healthy: 3,
    };
    const msg = formatSlackMessage(result);
    expect(msg).toContain('within rotation window');
  });

  it('formats expiring soon', () => {
    const result: RotationCheckResult = {
      checked: 1,
      overdue: [],
      expiringSoon: [{ name: 'AGING_KEY', lastRotatedAt: daysAgo(85), category: 'token' }],
      healthy: 0,
    };
    const msg = formatSlackMessage(result);
    expect(msg).toContain('Expiring soon');
    expect(msg).toContain('AGING_KEY');
  });
});
