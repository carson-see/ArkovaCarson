/**
 * SCRUM-1307 — Tests for db-health-monitor RPC function signatures.
 *
 * Validates that the RPC calls in db-health-monitor.ts match the function
 * signatures defined in migration 0264_db_health_rpcs.sql. These are
 * mock-based tests — they confirm the function names, parameter shapes,
 * and expected return types align between the worker code and the SQL RPCs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock setup — mirrors db-health-monitor.test.ts pattern
// ---------------------------------------------------------------------------

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));

vi.mock('../utils/db.js', () => {
  const from = vi.fn(() => ({
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue({ data: [], error: null }),
  }));
  return { db: { rpc: rpcMock, from } };
});

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../utils/sentry.js', () => ({
  Sentry: { captureMessage: vi.fn() },
}));

import { runDbHealthMonitor, type DbHealthSnapshot } from './db-health-monitor.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Capture the RPC calls made during a runDbHealthMonitor() invocation. */
async function captureRpcCalls(): Promise<Array<{ name: string; args: Record<string, unknown> }>> {
  rpcMock.mockImplementation(() => Promise.resolve({ data: [], error: null }));

  await runDbHealthMonitor();

  return rpcMock.mock.calls.map(([name, args]: [string, Record<string, unknown>]) => ({
    name,
    args: args ?? {},
  }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('db-health RPC signatures (SCRUM-1307)', () => {
  describe('get_recent_cron_failures', () => {
    it('is called with the correct function name', async () => {
      const calls = await captureRpcCalls();
      const cronCall = calls.find((c) => c.name === 'get_recent_cron_failures');
      expect(cronCall).toBeDefined();
    });

    it('passes since_minutes as an integer parameter', async () => {
      const calls = await captureRpcCalls();
      const cronCall = calls.find((c) => c.name === 'get_recent_cron_failures');
      expect(cronCall).toBeDefined();
      expect(cronCall!.args).toHaveProperty('since_minutes');
      expect(typeof cronCall!.args.since_minutes).toBe('number');
      expect(Number.isInteger(cronCall!.args.since_minutes)).toBe(true);
    });

    it('returns CronFailure[] shape with expected columns', async () => {
      const mockRow = {
        jobid: 3,
        jobname: 'anchor_sweep',
        return_message: 'statement timeout',
        start_time: '2026-04-26T00:00:00Z',
        end_time: '2026-04-26T00:01:00Z',
      };

      rpcMock.mockImplementation((name: string) => {
        if (name === 'get_recent_cron_failures') {
          return Promise.resolve({ data: [mockRow], error: null });
        }
        return Promise.resolve({ data: [], error: null });
      });

      const result: DbHealthSnapshot = await runDbHealthMonitor();
      expect(result.cronFailures).toHaveLength(1);

      const failure = result.cronFailures[0];
      expect(failure).toHaveProperty('jobid');
      expect(failure).toHaveProperty('start_time');
      // These are the columns the SQL function returns
      expect(typeof failure.jobid).toBe('number');
      expect(typeof failure.start_time).toBe('string');
    });
  });

  describe('get_table_bloat_stats', () => {
    it('is called with the correct function name', async () => {
      const calls = await captureRpcCalls();
      const bloatCall = calls.find((c) => c.name === 'get_table_bloat_stats');
      expect(bloatCall).toBeDefined();
    });

    it('passes table_names as a string array parameter', async () => {
      const calls = await captureRpcCalls();
      const bloatCall = calls.find((c) => c.name === 'get_table_bloat_stats');
      expect(bloatCall).toBeDefined();
      expect(bloatCall!.args).toHaveProperty('table_names');
      expect(Array.isArray(bloatCall!.args.table_names)).toBe(true);
      // Each element should be a string (table name)
      for (const name of bloatCall!.args.table_names as string[]) {
        expect(typeof name).toBe('string');
      }
    });

    it('requests the expected HOT_TABLES', async () => {
      const calls = await captureRpcCalls();
      const bloatCall = calls.find((c) => c.name === 'get_table_bloat_stats');
      const tableNames = bloatCall!.args.table_names as string[];
      // Must include the four hot tables from db-health-monitor.ts
      expect(tableNames).toContain('anchors');
      expect(tableNames).toContain('public_records');
      expect(tableNames).toContain('audit_events');
      expect(tableNames).toContain('job_queue');
    });

    it('returns DeadTupleRow[] shape with expected columns', async () => {
      const mockRow = {
        schemaname: 'public',
        relname: 'anchors',
        n_live_tup: 1_000_000,
        n_dead_tup: 50_000,
        last_autovacuum: '2026-04-26T00:00:00Z',
      };

      rpcMock.mockImplementation((name: string) => {
        if (name === 'get_table_bloat_stats') {
          return Promise.resolve({ data: [mockRow], error: null });
        }
        return Promise.resolve({ data: [], error: null });
      });

      const result: DbHealthSnapshot = await runDbHealthMonitor();
      expect(result.deadTuples).toHaveLength(1);

      const dt = result.deadTuples[0];
      // The monitor maps relname -> table, and computes ratio + vacuumAgeHours
      expect(dt).toHaveProperty('table', 'anchors');
      expect(dt).toHaveProperty('ratio');
      expect(dt).toHaveProperty('deadTuples', 50_000);
      expect(dt).toHaveProperty('vacuumAgeHours');
      expect(typeof dt.ratio).toBe('number');
    });

    it('handles null last_autovacuum gracefully', async () => {
      const mockRow = {
        schemaname: 'public',
        relname: 'anchors',
        n_live_tup: 1_000_000,
        n_dead_tup: 50_000,
        last_autovacuum: null,
      };

      rpcMock.mockImplementation((name: string) => {
        if (name === 'get_table_bloat_stats') {
          return Promise.resolve({ data: [mockRow], error: null });
        }
        return Promise.resolve({ data: [], error: null });
      });

      const result: DbHealthSnapshot = await runDbHealthMonitor();
      expect(result.deadTuples[0].vacuumAgeHours).toBeNull();
    });
  });

  describe('RPC error resilience', () => {
    it('continues when get_recent_cron_failures returns an error', async () => {
      rpcMock.mockImplementation((name: string) => {
        if (name === 'get_recent_cron_failures') {
          return Promise.resolve({ data: null, error: { message: 'function not found' } });
        }
        return Promise.resolve({ data: [], error: null });
      });

      const result: DbHealthSnapshot = await runDbHealthMonitor();
      // Should return empty failures, not throw
      expect(result.cronFailures).toEqual([]);
    });

    it('continues when get_table_bloat_stats returns an error', async () => {
      rpcMock.mockImplementation((name: string) => {
        if (name === 'get_table_bloat_stats') {
          return Promise.resolve({ data: null, error: { message: 'function not found' } });
        }
        return Promise.resolve({ data: [], error: null });
      });

      const result: DbHealthSnapshot = await runDbHealthMonitor();
      // Should return empty dead tuples, not throw
      expect(result.deadTuples).toEqual([]);
    });
  });
});
