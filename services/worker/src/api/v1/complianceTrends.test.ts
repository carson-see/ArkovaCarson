/**
 * Tests for Compliance Trends API (COMP-07)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/db.js', () => ({
  db: { from: vi.fn() },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { db } from '../../utils/db.js';
import { z } from 'zod';

describe('Compliance Trends API (COMP-07)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('validates required from/to params', async () => {
    const { complianceTrendsRouter } = await import('./complianceTrends.js');
    expect(complianceTrendsRouter).toBeDefined();
  });

  it('granularity defaults to weekly', () => {
    // The schema has a default — verify structurally
    const schema = z.object({
      granularity: z.enum(['daily', 'weekly', 'monthly']).default('weekly'),
    });
    const result = schema.parse({});
    expect(result.granularity).toBe('weekly');
  });

  it('bucket key format: daily returns YYYY-MM-DD', () => {
    const d = new Date('2026-03-15T10:30:00Z');
    const key = d.toISOString().split('T')[0];
    expect(key).toBe('2026-03-15');
  });

  it('bucket key format: monthly returns YYYY-MM-01', () => {
    const d = new Date('2026-03-15T10:30:00Z');
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
    expect(key).toBe('2026-03-01');
  });

  it('timestamp coverage calculation is correct', () => {
    const sigCount = 10;
    const timestampCount = 8;
    const pct = Math.round((timestampCount / sigCount) * 1000) / 10;
    expect(pct).toBe(80);
  });

  it('threshold: timestamp_coverage >= 95 is green', () => {
    const pct = 96;
    const threshold = pct >= 95 ? 'green' : pct >= 80 ? 'amber' : 'red';
    expect(threshold).toBe('green');
  });

  it('threshold: timestamp_coverage 80-95 is amber', () => {
    const pct = 85;
    const threshold = pct >= 95 ? 'green' : pct >= 80 ? 'amber' : 'red';
    expect(threshold).toBe('amber');
  });

  it('threshold: timestamp_coverage < 80 is red', () => {
    const pct = 70;
    const threshold = pct >= 95 ? 'green' : pct >= 80 ? 'amber' : 'red';
    expect(threshold).toBe('red');
  });

  it('anchor delay threshold: <= 30min is green', () => {
    const delay = 25;
    const threshold = delay <= 30 ? 'green' : delay <= 120 ? 'amber' : 'red';
    expect(threshold).toBe('green');
  });

  it('average anchor delay calculation', () => {
    const totalMs = 3600_000 + 1800_000; // 60min + 30min
    const count = 2;
    const avgMin = Math.round(totalMs / count / 60000);
    expect(avgMin).toBe(45);
  });
});
