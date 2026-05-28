import { describe, it, expect, vi } from 'vitest';

vi.mock('../config.js', () => ({
  config: {},
}));

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { sweepExpiredNonces, type NonceSweepDb } from './nonce-sweep.js';

function createMockDb(deleteCounts: Record<string, number>): NonceSweepDb {
  return {
    deleteOlderThan: vi.fn(async (table: string) => {
      const count = deleteCounts[table] ?? 0;
      return { table, deleted: count, error: null };
    }),
  };
}

function createFailingDb(failTable: string): NonceSweepDb {
  return {
    deleteOlderThan: vi.fn(async (table: string) => {
      if (table === failTable) {
        return { table, deleted: 0, error: 'relation does not exist' };
      }
      return { table, deleted: 0, error: null };
    }),
  };
}

describe('sweepExpiredNonces', () => {
  it('sweeps all four nonce tables and returns per-table counts', async () => {
    const db = createMockDb({
      docusign_webhook_nonces: 42,
      drive_webhook_nonces: 7,
      ats_webhook_nonces: 3,
      microsoft_graph_webhook_nonces: 0,
    });

    const result = await sweepExpiredNonces(db);

    expect(result.ok).toBe(true);
    expect(result.swept).toEqual({
      docusign_webhook_nonces: 42,
      drive_webhook_nonces: 7,
      ats_webhook_nonces: 3,
      microsoft_graph_webhook_nonces: 0,
    });
    expect(result.totalDeleted).toBe(52);
    expect(result.errors).toEqual([]);
    expect(db.deleteOlderThan).toHaveBeenCalledTimes(4);
  });

  it('reports partial success when one table fails', async () => {
    const db = createFailingDb('ats_webhook_nonces');

    const result = await sweepExpiredNonces(db);

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      table: 'ats_webhook_nonces',
      error: 'relation does not exist',
    });
    expect(result.swept.ats_webhook_nonces).toBe(0);
  });

  it('uses 14-day retention by default', async () => {
    const db = createMockDb({});
    await sweepExpiredNonces(db);

    for (const call of (db.deleteOlderThan as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[1]).toBe(14);
    }
  });
});
