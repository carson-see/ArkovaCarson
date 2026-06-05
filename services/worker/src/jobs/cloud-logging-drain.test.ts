/**
 * Regression tests for bumpRetryCounts (SCRUM-2251 / HARDEN-1-H).
 *
 * Locks the N+1-free contract restored under SCRUM-1296 (commit ab28ed75):
 *   - The happy path issues exactly ONE `db.rpc('bump_cloud_logging_retry_counts')`
 *     call carrying ALL audit ids — never one RPC (or one UPDATE) per row.
 *   - When the RPC is unavailable, the fallback does <= ceil(N / 100) reads and
 *     grouped updates (batched per distinct retry_count), never per-row.
 *   - The fallback actually INCREMENTS retry_count (current + 1) — guarding the
 *     historical bug where it only set last_error and rows retried forever.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockLogger, dbState } = vi.hoisted(() => {
  const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  // Mutable state the mock db reads from / records into.
  const dbState: {
    rpcResult: { error: unknown } | (() => never);
    rpcCalls: Array<{ fn: string; args: unknown }>;
    // queue rows keyed by audit_id -> current retry_count (used by fallback read)
    queueRows: Map<string, number>;
    selectInCalls: number;
    updateCalls: Array<{ payload: Record<string, unknown>; ids: string[] }>;
  } = {
    rpcResult: { error: null },
    rpcCalls: [],
    queueRows: new Map(),
    selectInCalls: 0,
    updateCalls: [],
  };

  return { mockLogger, dbState };
});

vi.mock('../utils/logger.js', () => ({ logger: mockLogger }));

vi.mock('../utils/db.js', () => {
  const db = {
    rpc: vi.fn((fn: string, args: unknown) => {
      dbState.rpcCalls.push({ fn, args });
      if (typeof dbState.rpcResult === 'function') {
        // Simulate the RPC throwing (network failure / not deployed).
        return (dbState.rpcResult as () => never)();
      }
      return Promise.resolve(dbState.rpcResult);
    }),
    from: vi.fn((_table: string) => ({
      // .select('audit_id, retry_count').in('audit_id', chunk)
      select: vi.fn((_cols: string) => ({
        in: vi.fn((_col: string, ids: string[]) => {
          dbState.selectInCalls += 1;
          const rows = ids
            .filter((id) => dbState.queueRows.has(id))
            .map((id) => ({ audit_id: id, retry_count: dbState.queueRows.get(id) }));
          return Promise.resolve({ data: rows, error: null });
        }),
      })),
      // .update(payload).in('audit_id', ids)
      update: vi.fn((payload: Record<string, unknown>) => ({
        in: vi.fn((_col: string, ids: string[]) => {
          dbState.updateCalls.push({ payload, ids });
          return Promise.resolve({ error: null });
        }),
      })),
    })),
  };
  return { db };
});

// ---- System under test ----
import { bumpRetryCounts } from './cloud-logging-drain.js';

function resetDbState() {
  dbState.rpcResult = { error: null };
  dbState.rpcCalls = [];
  dbState.queueRows = new Map();
  dbState.selectInCalls = 0;
  dbState.updateCalls = [];
}

describe('bumpRetryCounts (SCRUM-2251 / HARDEN-1-H) — N+1 elimination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDbState();
  });

  it('no-ops on empty input (zero DB round-trips)', async () => {
    await bumpRetryCounts([]);
    expect(dbState.rpcCalls).toHaveLength(0);
    expect(dbState.selectInCalls).toBe(0);
    expect(dbState.updateCalls).toHaveLength(0);
  });

  it('issues exactly ONE rpc call carrying all ids for N entries (no per-row fan-out)', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `audit-${i}`);

    await bumpRetryCounts(ids, 'cloud logging 503');

    // Single bulk RPC — not one per row, not one per 100-chunk.
    expect(dbState.rpcCalls).toHaveLength(1);
    expect(dbState.rpcCalls[0].fn).toBe('bump_cloud_logging_retry_counts');
    expect(dbState.rpcCalls[0].args).toEqual({
      p_audit_ids: ids,
      p_error_msg: 'cloud logging 503',
    });

    // RPC succeeded → fallback path must NOT run.
    expect(dbState.selectInCalls).toBe(0);
    expect(dbState.updateCalls).toHaveLength(0);
  });

  it('truncates the error message to 1000 chars in the rpc payload', async () => {
    const longErr = 'x'.repeat(5000);
    await bumpRetryCounts(['a'], longErr);
    expect(dbState.rpcCalls).toHaveLength(1);
    expect((dbState.rpcCalls[0].args as { p_error_msg: string }).p_error_msg).toHaveLength(1000);
  });

  it('passes null error message through to the rpc when none provided', async () => {
    await bumpRetryCounts(['a', 'b']);
    expect(dbState.rpcCalls[0].args).toEqual({
      p_audit_ids: ['a', 'b'],
      p_error_msg: null,
    });
  });

  describe('fallback when RPC is unavailable', () => {
    it('does <= ceil(N/100) reads + grouped updates, never per-row, and increments retry_count', async () => {
      // RPC returns an error → fall through to chunked fallback.
      dbState.rpcResult = { error: { message: 'function does not exist' } };

      const N = 250; // -> ceil(250/100) = 3 chunks
      const ids = Array.from({ length: N }, (_, i) => `audit-${i}`);
      // Seed two distinct retry_count values so each chunk groups into <= 2 updates.
      ids.forEach((id, i) => dbState.queueRows.set(id, i % 2 === 0 ? 0 : 3));

      await bumpRetryCounts(ids, 'boom');

      // RPC attempted once before fallback.
      expect(dbState.rpcCalls).toHaveLength(1);

      // Reads: one per 100-chunk, never per-row.
      const expectedChunks = Math.ceil(N / 100);
      expect(dbState.selectInCalls).toBe(expectedChunks);
      expect(dbState.selectInCalls).toBeLessThanOrEqual(expectedChunks);

      // Updates: grouped by distinct retry_count per chunk (2 groups here),
      // so <= 2 * chunks — and far fewer than N (the per-row count).
      expect(dbState.updateCalls.length).toBeLessThanOrEqual(2 * expectedChunks);
      expect(dbState.updateCalls.length).toBeLessThan(N);

      // Every update INCREMENTS retry_count (current + 1) and stamps last_error.
      const totalIdsUpdated = dbState.updateCalls.reduce((sum, c) => sum + c.ids.length, 0);
      expect(totalIdsUpdated).toBe(N);
      for (const call of dbState.updateCalls) {
        const newCount = call.payload.retry_count as number;
        // Each id in this group had the same prior count; assert +1.
        for (const id of call.ids) {
          expect(newCount).toBe((dbState.queueRows.get(id) as number) + 1);
        }
        expect(call.payload.last_error).toBe('boom');
      }
    });

    it('falls back when the RPC throws (e.g. network failure), not just on error result', async () => {
      dbState.rpcResult = () => {
        throw new Error('network down');
      };
      const ids = ['a', 'b', 'c'];
      ids.forEach((id) => dbState.queueRows.set(id, 1));

      await bumpRetryCounts(ids, 'net');

      expect(dbState.rpcCalls).toHaveLength(1);
      expect(dbState.selectInCalls).toBe(1); // single chunk
      // All three share retry_count=1 -> single grouped update.
      expect(dbState.updateCalls).toHaveLength(1);
      expect(dbState.updateCalls[0].ids).toEqual(ids);
      expect(dbState.updateCalls[0].payload.retry_count).toBe(2);
    });
  });
});
