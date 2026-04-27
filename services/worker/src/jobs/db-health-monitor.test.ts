/**
 * Unit tests for db-health-monitor (SCRUM-1254 / R0-8).
 *
 * Locks the alert-computation logic without hitting real Supabase.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sentryCapture } = vi.hoisted(() => ({ sentryCapture: vi.fn() }));

vi.mock('../utils/db.js', () => {
  const rpc = vi.fn();
  const from = vi.fn(() => ({
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn(),
  }));
  return { db: { rpc, from } };
});

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../utils/sentry.js', () => ({
  Sentry: { captureMessage: sentryCapture },
}));

import { runDbHealthMonitor } from './db-health-monitor.js';
import { db } from '../utils/db.js';

beforeEach(() => {
  vi.clearAllMocks();
  sentryCapture.mockReset();
});

function mockSmokeChain(rows: Array<{ created_at: string; details: string }>) {
  (db.from as ReturnType<typeof vi.fn>).mockReturnValueOnce({
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue({ data: rows, error: null }),
  });
}

function mockRpcs(opts: {
  cronFailures?: Array<{ jobid: number; return_message?: string; start_time: string }>;
  deadTuples?: Array<{ schemaname: string; relname: string; n_live_tup: number; n_dead_tup: number; last_autovacuum: string | null }>;
}) {
  (db.rpc as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
    if (name === 'get_recent_cron_failures') {
      return Promise.resolve({ data: opts.cronFailures ?? [], error: null });
    }
    if (name === 'get_table_bloat_stats') {
      return Promise.resolve({ data: opts.deadTuples ?? [], error: null });
    }
    return Promise.resolve({ data: null, error: { message: 'unknown rpc' } });
  });
}

describe('runDbHealthMonitor (R0-8)', () => {
  it('returns no alerts when DB is healthy', async () => {
    mockRpcs({ deadTuples: [{ schemaname: 'public', relname: 'anchors', n_live_tup: 1_000_000, n_dead_tup: 100, last_autovacuum: new Date().toISOString() }] });
    mockSmokeChain([]);
    const result = await runDbHealthMonitor();
    expect(result.alerts).toHaveLength(0);
    expect(sentryCapture).not.toHaveBeenCalled();
  });

  it('alerts on dead-tuple ratio > 0.5', async () => {
    mockRpcs({
      deadTuples: [
        { schemaname: 'public', relname: 'anchors', n_live_tup: 3_000_000, n_dead_tup: 7_000_000, last_autovacuum: new Date().toISOString() },
      ],
    });
    mockSmokeChain([]);
    const result = await runDbHealthMonitor();
    expect(result.alerts.some((a) => a.includes('Dead-tuple ratio on anchors'))).toBe(true);
    expect(sentryCapture).toHaveBeenCalled();
  });

  it('alerts on autovacuum > 24h with > 100k dead tuples', async () => {
    const longAgo = new Date(Date.now() - 36 * 3_600_000).toISOString();
    mockRpcs({
      deadTuples: [
        { schemaname: 'public', relname: 'job_queue', n_live_tup: 5_000_000, n_dead_tup: 200_000, last_autovacuum: longAgo },
      ],
    });
    mockSmokeChain([]);
    const result = await runDbHealthMonitor();
    expect(result.alerts.some((a) => a.includes('autovacuum'))).toBe(true);
  });

  it('alerts on pg_cron job failures', async () => {
    mockRpcs({
      cronFailures: [{ jobid: 3, return_message: 'statement timeout', start_time: new Date().toISOString() }],
    });
    mockSmokeChain([]);
    const result = await runDbHealthMonitor();
    expect(result.alerts.some((a) => a.includes('jobid=3'))).toBe(true);
  });

  it('alerts on smoke fail-streak >= 3', async () => {
    const failed = JSON.stringify({ failed: 1, results: [{ durationMs: 5000 }] });
    mockRpcs({});
    mockSmokeChain([
      { created_at: new Date().toISOString(), details: failed },
      { created_at: new Date().toISOString(), details: failed },
      { created_at: new Date().toISOString(), details: failed },
    ]);
    const result = await runDbHealthMonitor();
    expect(result.smokeFailStreak).toBe(3);
    expect(result.alerts.some((a) => a.includes('fail-streak'))).toBe(true);
  });

  it('does not alert on isolated smoke failure (streak < 3)', async () => {
    const failed = JSON.stringify({ failed: 1, results: [{ durationMs: 5000 }] });
    const passed = JSON.stringify({ failed: 0, results: [{ durationMs: 1000 }] });
    mockRpcs({});
    mockSmokeChain([
      { created_at: new Date().toISOString(), details: failed },
      { created_at: new Date().toISOString(), details: passed },
    ]);
    const result = await runDbHealthMonitor();
    expect(result.smokeFailStreak).toBe(1);
    expect(result.alerts.some((a) => a.includes('fail-streak'))).toBe(false);
  });
});
