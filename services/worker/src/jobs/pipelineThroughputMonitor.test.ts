/**
 * Tests for the Pipeline Throughput Monitor (SCRUM-2901 / PI-0.5).
 *
 * Motivation (verified 2026-07-17): prod /health reports anchoring:"ok" while
 * the pending-anchoring backlog GROWS — the health check is shallow liveness,
 * not throughput. Feeder Cloud Scheduler jobs fire 200 but records don't
 * convert to secured anchors, and nobody gets alerted. This monitor is the
 * dead-man switch on pipeline THROUGHPUT: it compares "new unlinked public
 * records in the window" (feeders producing) against "anchors secured in the
 * window" (pipeline converting) using existing timestamps only — no snapshot
 * table, no migration.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const mockCapturePipelineThroughputAlert = vi.fn();
vi.mock('../utils/sentry.js', () => ({
  capturePipelineThroughputAlert: (...args: unknown[]) =>
    mockCapturePipelineThroughputAlert(...args),
}));

import {
  decidePipelineThroughputAlert,
  runPipelineThroughputMonitor,
  DEFAULT_THROUGHPUT_WINDOW_HOURS,
  type ThroughputAlertInput,
} from './pipelineThroughputMonitor.js';
import { logger } from '../utils/logger.js';

const NOW = new Date('2026-07-17T12:00:00Z');

function input(overrides: Partial<ThroughputAlertInput> = {}): ThroughputAlertInput {
  return {
    new_unlinked_in_window: 0,
    anchors_secured_in_window: 0,
    records_created_in_window: 0,
    anchors_created_in_window: 0,
    unlinked_total: null,
    window_hours: 24,
    ...overrides,
  };
}

describe('decidePipelineThroughputAlert', () => {
  it('does not fire when feeders are idle (no new unlinked records, nothing secured)', () => {
    const decision = decidePipelineThroughputAlert(
      input({ new_unlinked_in_window: 0, anchors_secured_in_window: 0 }),
    );
    expect(decision.should_fire).toBe(false);
    expect(decision.severity).toBe('info');
    expect(decision.reason).toMatch(/no new unlinked/i);
  });

  it('does not fire when the pipeline is converting (backlog grows but anchors secure)', () => {
    const decision = decidePipelineThroughputAlert(
      input({ new_unlinked_in_window: 500, anchors_secured_in_window: 120 }),
    );
    expect(decision.should_fire).toBe(false);
    expect(decision.severity).toBe('info');
  });

  it('fires at error severity when the backlog grows and NOTHING secures in the window', () => {
    const decision = decidePipelineThroughputAlert(
      input({
        new_unlinked_in_window: 812,
        anchors_secured_in_window: 0,
        unlinked_total: 259_000,
        window_hours: 24,
      }),
    );
    expect(decision.should_fire).toBe(true);
    expect(decision.severity).toBe('error');
    // Reason carries aggregate counts only — no ids, emails, or fingerprints.
    expect(decision.reason).toContain('812');
    expect(decision.reason).toContain('24');
    expect(decision.reason).toMatch(/throughput|stall|dead/i);
  });

  it('still fires when the unlinked-total cache context is unavailable (window counts are the signal)', () => {
    const decision = decidePipelineThroughputAlert(
      input({ new_unlinked_in_window: 10, anchors_secured_in_window: 0, unlinked_total: null }),
    );
    expect(decision.should_fire).toBe(true);
  });

  it('does not fire when only a single secured anchor proves the pipeline is alive', () => {
    const decision = decidePipelineThroughputAlert(
      input({ new_unlinked_in_window: 10_000, anchors_secured_in_window: 1 }),
    );
    expect(decision.should_fire).toBe(false);
  });
});

// ─── Cron entry point ───

interface CountResult {
  count: number | null;
  error: unknown;
}

interface CacheResult {
  data: { cache_value: Record<string, unknown> } | null;
  error: unknown;
}

/**
 * Minimal chainable Supabase stub covering the monitor's four bounded count
 * probes plus the two best-effort pipeline_dashboard_cache reads:
 *   public_records: .select(count/head).gte('created_at', …)[.is('anchor_id', null)]
 *   anchors:        .select(count/head).is('deleted_at', null).gte('created_at', …)[.not('chain_timestamp','is',null)]
 *   cache:          .select('cache_value').eq('cache_key', key).single()
 */
function mockDb(opts: {
  newUnlinked?: CountResult;
  recordsCreated?: CountResult;
  anchorsCreated?: CountResult;
  anchorsSecured?: CountResult;
  pipelineStats?: CacheResult;
  statusCounts?: CacheResult;
} = {}) {
  const newUnlinked = opts.newUnlinked ?? { count: 0, error: null };
  const recordsCreated = opts.recordsCreated ?? { count: 0, error: null };
  const anchorsCreated = opts.anchorsCreated ?? { count: 0, error: null };
  const anchorsSecured = opts.anchorsSecured ?? { count: 0, error: null };
  const caches: Record<string, CacheResult> = {
    pipeline_stats:
      opts.pipelineStats ??
      { data: { cache_value: { pending_record_links: 0 } }, error: null },
    anchor_status_counts:
      opts.statusCounts ??
      { data: { cache_value: { PENDING: 0, SECURED: 0 } }, error: null },
  };

  function countChain(resolve: (state: { filteredUnlinked: boolean; filteredSecured: boolean }) => CountResult) {
    const state = { filteredUnlinked: false, filteredSecured: false };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.gte = vi.fn(() => chain);
    chain.is = vi.fn((column: string) => {
      if (column === 'anchor_id') state.filteredUnlinked = true;
      return chain;
    });
    chain.not = vi.fn((column: string) => {
      if (column === 'chain_timestamp') state.filteredSecured = true;
      return chain;
    });
    chain.then = (onFulfilled: (v: CountResult) => unknown, onRejected: (e: unknown) => unknown) =>
      Promise.resolve().then(() => resolve(state)).then(onFulfilled, onRejected);
    return chain;
  }

  return {
    from(table: string) {
      if (table === 'public_records') {
        return countChain((s) => (s.filteredUnlinked ? newUnlinked : recordsCreated));
      }
      if (table === 'anchors') {
        return countChain((s) => (s.filteredSecured ? anchorsSecured : anchorsCreated));
      }
      if (table === 'pipeline_dashboard_cache') {
        let key = '';
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const chain: any = {};
        chain.select = vi.fn(() => chain);
        chain.eq = vi.fn((_column: string, value: string) => {
          key = value;
          return chain;
        });
        chain.single = vi.fn(() =>
          Promise.resolve(caches[key] ?? { data: null, error: { message: `no cache row ${key}` } }),
        );
        return chain;
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

describe('runPipelineThroughputMonitor', () => {
  it('(a) healthy pipeline — records arrive AND anchors secure → no alert', async () => {
    mockCapturePipelineThroughputAlert.mockClear();
    const db = mockDb({
      newUnlinked: { count: 400, error: null },
      recordsCreated: { count: 450, error: null },
      anchorsCreated: { count: 300, error: null },
      anchorsSecured: { count: 250, error: null },
      pipelineStats: { data: { cache_value: { pending_record_links: 259_000 } }, error: null },
      statusCounts: { data: { cache_value: { PENDING: 1000, SECURED: 2_972_264 } }, error: null },
    });

    const result = await runPipelineThroughputMonitor(db, { now: NOW, windowHours: 24 });

    expect(result.healthy).toBe(true);
    expect(result.alertFired).toBe(false);
    expect(result.newUnlinkedInWindow).toBe(400);
    expect(result.anchorsSecuredInWindow).toBe(250);
    expect(result.unlinkedTotal).toBe(259_000);
    expect(result.batchProgress).toEqual({ PENDING: 1000, SECURED: 2_972_264 });
    expect(result.checkedAt).toBe(NOW.toISOString());
    expect(mockCapturePipelineThroughputAlert).not.toHaveBeenCalled();
  });

  it('(b) backlog growing + zero secured → alert fired ONCE through the stable-fingerprint helper', async () => {
    mockCapturePipelineThroughputAlert.mockClear();
    const db = mockDb({
      newUnlinked: { count: 812, error: null },
      recordsCreated: { count: 900, error: null },
      anchorsCreated: { count: 0, error: null },
      anchorsSecured: { count: 0, error: null },
      pipelineStats: { data: { cache_value: { pending_record_links: 259_812 } }, error: null },
    });

    const result = await runPipelineThroughputMonitor(db, { now: NOW, windowHours: 24 });

    expect(result.healthy).toBe(false);
    expect(result.alertFired).toBe(true);

    // Exactly one capture per run, via the stable-fingerprint helper (re-fires
    // collapse into one Sentry issue — mirrors captureStuckAnchorAlert).
    expect(mockCapturePipelineThroughputAlert).toHaveBeenCalledTimes(1);
    const [message, extra, level] = mockCapturePipelineThroughputAlert.mock.calls[0] as [
      string,
      Record<string, unknown>,
      string,
    ];
    expect(message).toMatch(/throughput|stall|dead/i);
    expect(level).toBe('error');
    expect(extra.source).toBe('pipeline-throughput-monitor');
    expect(extra.story).toBe('SCRUM-2901');
    expect(extra.new_unlinked_in_window).toBe(812);
    expect(extra.anchors_secured_in_window).toBe(0);
    expect(extra.unlinked_total).toBe(259_812);
    expect(extra.window_hours).toBe(24);
    // PII rules (§1.4): aggregates only — no emails, fingerprints, keys, or ids.
    const serialized = JSON.stringify({ message, extra });
    expect(serialized).not.toMatch(/[a-f0-9]{64}/i);
    expect(serialized).not.toMatch(/@/);

    // And an error-level structured log.
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ newUnlinkedInWindow: 812, anchorsSecuredInWindow: 0 }),
      expect.stringMatching(/throughput|stall|dead/i),
    );
  });

  it('(c) DB error on a core window probe → rejects (route returns 500-safe body, Scheduler retries)', async () => {
    mockCapturePipelineThroughputAlert.mockClear();
    const db = mockDb({
      newUnlinked: { count: null, error: { message: 'statement timeout' } },
    });

    await expect(
      runPipelineThroughputMonitor(db, { now: NOW, windowHours: 24 }),
    ).rejects.toThrow(/throughput probe/i);
    expect(mockCapturePipelineThroughputAlert).not.toHaveBeenCalled();
  });

  it('rejects when a probe returns neither count nor error (never silently reads 0)', async () => {
    const db = mockDb({
      anchorsSecured: { count: null, error: null },
    });
    await expect(
      runPipelineThroughputMonitor(db, { now: NOW, windowHours: 24 }),
    ).rejects.toThrow(/throughput probe/i);
  });

  it('cache reads are best-effort: a cache miss neither blocks the run nor the alert', async () => {
    mockCapturePipelineThroughputAlert.mockClear();
    const db = mockDb({
      newUnlinked: { count: 55, error: null },
      anchorsSecured: { count: 0, error: null },
      pipelineStats: { data: null, error: { message: 'cache miss' } },
      statusCounts: { data: null, error: { message: 'cache miss' } },
    });

    const result = await runPipelineThroughputMonitor(db, { now: NOW, windowHours: 24 });

    expect(result.healthy).toBe(false);
    expect(result.alertFired).toBe(true);
    expect(result.unlinkedTotal).toBeNull();
    expect(result.batchProgress).toBeNull();
    expect(mockCapturePipelineThroughputAlert).toHaveBeenCalledTimes(1);
  });

  it('treats the -1 refresh-timeout sentinel in pipeline_stats as unavailable, not a real count', async () => {
    const db = mockDb({
      pipelineStats: { data: { cache_value: { pending_record_links: -1 } }, error: null },
    });
    const result = await runPipelineThroughputMonitor(db, { now: NOW, windowHours: 24 });
    expect(result.unlinkedTotal).toBeNull();
  });

  it('defaults the window to DEFAULT_THROUGHPUT_WINDOW_HOURS (covers the nightly 3am batch flush)', async () => {
    const db = mockDb();
    const result = await runPipelineThroughputMonitor(db, { now: NOW });
    expect(result.windowHours).toBe(DEFAULT_THROUGHPUT_WINDOW_HOURS);
    // ≥ 24h so a healthy pipeline that only secures at the nightly 3am batch
    // drain always shows at least one flush inside the window (no false page).
    expect(DEFAULT_THROUGHPUT_WINDOW_HOURS).toBeGreaterThanOrEqual(24);
  });
});
