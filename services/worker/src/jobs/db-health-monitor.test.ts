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

import { runDbHealthMonitor, classifyAlert } from './db-health-monitor.js';
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

describe('classifyAlert (SCRUM-1308)', () => {
  // The Sentry rules in infra/sentry/alert-rules.json filter on `alert_type`.
  // Drift between the alert text emitted by computeAlerts() and these
  // classifications would silently miscategorize events.
  it.each([
    ['pg_cron jobid=3 failed: statement timeout', 'pg_cron_failure'],
    ['Dead-tuple ratio on anchors: 0.92 (> 0.5)', 'dead_tuple_ratio'],
    // Codex P1 (PR #690): the autovacuum-age signal gets its own type so a
    // single hot table can't fan-trigger the dead_tuple_ratio Sentry rule
    // (which is bucketed at 12 events / 1h) twice in the same 5-minute pass.
    ['anchors: 200,000 dead tuples + autovacuum 36h ago (snapshot held?)', 'dead_tuple_autovacuum_age'],
    ['Smoke test fail-streak: 3 consecutive failures', 'smoke_fail_streak'],
    ['Smoke test runtime 75000ms exceeds 60000ms (PostgREST timeout risk)', 'smoke_runtime'],
    ['Some unknown shape', 'unclassified'],
  ])('classifies %j as %s', (alert, expected) => {
    expect(classifyAlert(alert)).toBe(expected);
  });
});

function getCallTags(call: unknown[]): Record<string, string> | undefined {
  const opts = call[1];
  if (typeof opts !== 'object' || opts === null || !('tags' in opts)) return undefined;
  return (opts as { tags?: Record<string, string> }).tags;
}

describe('emitSentry tag emission (SCRUM-1308)', () => {
  it('emits alert_type tag distinct per alert class', async () => {
    mockRpcs({
      cronFailures: [{ jobid: 7, return_message: 'oom', start_time: new Date().toISOString() }],
      deadTuples: [
        { schemaname: 'public', relname: 'anchors', n_live_tup: 1_000_000, n_dead_tup: 800_000, last_autovacuum: new Date().toISOString() },
      ],
    });
    const failed = JSON.stringify({ failed: 1, results: [{ durationMs: 5000 }] });
    mockSmokeChain([
      { created_at: new Date().toISOString(), details: failed },
      { created_at: new Date().toISOString(), details: failed },
      { created_at: new Date().toISOString(), details: failed },
    ]);

    await runDbHealthMonitor();

    const alertTypes = sentryCapture.mock.calls.map((call) => getCallTags(call)?.alert_type);
    expect(alertTypes).toEqual(expect.arrayContaining(['pg_cron_failure', 'dead_tuple_ratio', 'smoke_fail_streak']));
    for (const call of sentryCapture.mock.calls) {
      const tags = getCallTags(call);
      expect(tags).toMatchObject({ source: 'db-health-monitor', story: 'SCRUM-1254' });
      expect(tags?.alert_type).toBeDefined();
    }
  });

  // CodeRabbit P1 (PR #690): alert-rules.json Slack actions reference `jobid`
  // and `table_name` tags. Without these on the captured event, the action
  // can't render them. Pin the extraction so a future alert-text rewording
  // surfaces here, not silently in #ops Slack messages.
  it('extracts jobid + table_name from alert text into Sentry tags', async () => {
    mockRpcs({
      cronFailures: [{ jobid: 42, return_message: 'lock timeout', start_time: new Date().toISOString() }],
      deadTuples: [
        { schemaname: 'public', relname: 'anchors', n_live_tup: 1_000_000, n_dead_tup: 800_000, last_autovacuum: new Date().toISOString() },
      ],
    });
    mockSmokeChain([]);

    await runDbHealthMonitor();

    const tagsByType: Record<string, Record<string, string>> = {};
    for (const call of sentryCapture.mock.calls) {
      const tags = getCallTags(call);
      if (tags?.alert_type) tagsByType[tags.alert_type] = tags;
    }

    expect(tagsByType.pg_cron_failure?.jobid).toBe('42');
    expect(tagsByType.dead_tuple_ratio?.table_name).toBe('anchors');
  });
});
