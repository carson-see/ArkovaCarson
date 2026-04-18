/**
 * Regulatory Change Scan Job — tests (NCA-FU1 #1)
 *
 * Covers:
 *   - Returns zero when no stale rules
 *   - Scans stale rules and creates audit_events alerts
 *   - Throws on query failure
 *   - Gracefully handles partial insert failures
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/db.js', () => ({
  db: { from: vi.fn() },
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { runRegulatoryChangeScan } from './regulatory-change-scan.js';
import { db } from '../utils/db.js';

function mockChain(overrides: {
  data?: unknown;
  error?: unknown;
  insertError?: unknown;
} = {}) {
  const insertFn = vi.fn().mockResolvedValue({
    error: overrides.insertError ?? null,
  });

  const builder = {
    select: vi.fn().mockReturnThis(),
    or: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue({
      data: overrides.data ?? [],
      error: overrides.error ?? null,
    }),
    insert: insertFn,
  };
  return { builder, insertFn };
}

describe('runRegulatoryChangeScan', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns zero counts when no stale rules found', async () => {
    const { builder } = mockChain({ data: [] });
    vi.mocked(db.from).mockReturnValue(builder as never);

    const result = await runRegulatoryChangeScan();

    expect(result).toEqual({ scanned: 0, alertsCreated: 0 });
    expect(db.from).toHaveBeenCalledWith('jurisdiction_rules');
  });

  it('scans stale rules and creates audit_events alerts', async () => {
    const staleRules = [
      { id: 'r1', jurisdiction_code: 'US-CA', rule_name: 'CA-CPA', regulatory_reference: 'CPC 5000', updated_at: '2020-01-01T00:00:00Z' },
      { id: 'r2', jurisdiction_code: 'US-NY', rule_name: 'NY-LAW', regulatory_reference: null, updated_at: null },
    ];

    const insertFn = vi.fn().mockResolvedValue({ error: null });

    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'jurisdiction_rules') {
        return {
          select: vi.fn().mockReturnValue({
            or: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue({ data: staleRules, error: null }),
            }),
          }),
        } as never;
      }
      if (table === 'audit_events') {
        return { insert: insertFn } as never;
      }
      return { select: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue({ data: [], error: null }) } as never;
    });

    const result = await runRegulatoryChangeScan();

    expect(result.scanned).toBe(2);
    expect(result.alertsCreated).toBe(2);
    expect(insertFn).toHaveBeenCalledTimes(2);
    expect(insertFn.mock.calls[0][0]).toMatchObject({
      event_type: 'regulatory.rule_stale',
      event_category: 'COMPLIANCE',
    });
  });

  it('throws when jurisdiction_rules query fails', async () => {
    const { builder } = mockChain({ error: { message: 'DB down' } });
    vi.mocked(db.from).mockReturnValue(builder as never);

    await expect(runRegulatoryChangeScan()).rejects.toThrow('Regulatory change scan query failed');
  });

  it('counts partial insert failures gracefully', async () => {
    const staleRules = [
      { id: 'r1', jurisdiction_code: 'US-CA', rule_name: 'CA-CPA', regulatory_reference: null, updated_at: null },
      { id: 'r2', jurisdiction_code: 'US-NY', rule_name: 'NY-LAW', regulatory_reference: null, updated_at: null },
    ];

    let callCount = 0;
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'jurisdiction_rules') {
        return {
          select: vi.fn().mockReturnValue({
            or: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue({ data: staleRules, error: null }),
            }),
          }),
        } as never;
      }
      if (table === 'audit_events') {
        callCount++;
        if (callCount === 1) {
          return { insert: vi.fn().mockRejectedValue(new Error('insert failed')) } as never;
        }
        return { insert: vi.fn().mockResolvedValue({ error: null }) } as never;
      }
      return { select: vi.fn().mockReturnThis() } as never;
    });

    const result = await runRegulatoryChangeScan();

    expect(result.scanned).toBe(2);
    expect(result.alertsCreated).toBe(1);
  });
});
