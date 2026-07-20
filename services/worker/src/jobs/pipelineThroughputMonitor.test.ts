/**
 * Tests for the Pipeline Throughput Monitor (SCRUM-2901 / PI-0.5).
 *
 * Motivation (verified 2026-07-17): prod /health reports anchoring:"ok" while
 * the pending-anchoring backlog GROWS — the health check is shallow liveness,
 * not throughput. Feeder Cloud Scheduler jobs fire 200 but records don't
 * convert to secured anchors, and nobody gets alerted.
 *
 * Two fire conditions (independent dead-man switches, one stable Sentry
 * fingerprint), all driven by LIMIT-1 timestamp probes — NO count queries
 * (R0-8 / SCRUM-1254 forbids new `count: 'exact'` callsites; zero-vs-nonzero
 * decisions come from row existence, magnitudes from the dashboard cache):
 *   A — total securing death: a new unlinked record arrived inside the window
 *       while NO anchor secured network-wide inside it (last-secured
 *       chain_timestamp older than the window).
 *   B — linker stall: the OLDEST unlinked public record's age exceeds the
 *       stall threshold. This is the exact 2026-07 incident shape: the 255k+
 *       backlog sits unlinked for weeks while OTHER paths keep securing, so
 *       condition A alone would never fire (independent-review CRITICAL).
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
  DEFAULT_LINKER_STALL_THRESHOLD_HOURS,
  type ThroughputAlertInput,
} from './pipelineThroughputMonitor.js';
import { logger } from '../utils/logger.js';

const NOW = new Date('2026-07-17T12:00:00Z');

function hoursAgo(h: number): string {
  return new Date(NOW.getTime() - h * 60 * 60 * 1000).toISOString();
}

function input(overrides: Partial<ThroughputAlertInput> = {}): ThroughputAlertInput {
  return {
    latest_unlinked_age_hours: null,
    oldest_unlinked_age_hours: null,
    last_secured_age_hours: null,
    unlinked_total: null,
    window_hours: 24,
    linker_stall_threshold_hours: 48,
    ...overrides,
  };
}

describe('decidePipelineThroughputAlert', () => {
  it('does not fire when feeders are idle and no unlinked backlog exists', () => {
    const decision = decidePipelineThroughputAlert(
      input({ latest_unlinked_age_hours: null, oldest_unlinked_age_hours: null }),
    );
    expect(decision.should_fire).toBe(false);
    expect(decision.severity).toBe('info');
  });

  it('does not fire on a healthy pipeline (young backlog, securing active)', () => {
    const decision = decidePipelineThroughputAlert(
      input({
        latest_unlinked_age_hours: 1,
        oldest_unlinked_age_hours: 2,
        last_secured_age_hours: 3,
      }),
    );
    expect(decision.should_fire).toBe(false);
    expect(decision.severity).toBe('info');
  });

  it('INCIDENT SHAPE (condition B): fires linker-stall when the backlog is old even though OTHER anchors still secure', () => {
    // The exact motivating incident: 255k+ unlinked records aging for weeks,
    // while unrelated anchor paths keep securing (recent last_secured).
    // Condition A alone would stay silent forever here.
    const decision = decidePipelineThroughputAlert(
      input({
        latest_unlinked_age_hours: 1,
        oldest_unlinked_age_hours: 700,
        last_secured_age_hours: 2,
        unlinked_total: 259_000,
      }),
    );
    expect(decision.should_fire).toBe(true);
    expect(decision.severity).toBe('error');
    expect(decision.reason).toMatch(/linker stall/i);
    expect(decision.reason).toContain('700');
    expect(decision.reason).toContain('48');
  });

  it('TOTAL DEATH (condition A): fires when a new unlinked record arrived and NO anchor secured network-wide in the window', () => {
    const decision = decidePipelineThroughputAlert(
      input({
        latest_unlinked_age_hours: 2,
        oldest_unlinked_age_hours: 3,
        last_secured_age_hours: 90,
        unlinked_total: 259_000,
        window_hours: 24,
      }),
    );
    expect(decision.should_fire).toBe(true);
    expect(decision.severity).toBe('error');
    expect(decision.reason).not.toMatch(/linker stall/i);
    expect(decision.reason).toMatch(/network-wide/i);
    expect(decision.reason).toContain('24');
  });

  it('condition A also fires when NOTHING has ever secured (last_secured unavailable)', () => {
    const decision = decidePipelineThroughputAlert(
      input({
        latest_unlinked_age_hours: 2,
        oldest_unlinked_age_hours: 3,
        last_secured_age_hours: null,
      }),
    );
    expect(decision.should_fire).toBe(true);
    expect(decision.reason).toMatch(/network-wide/i);
  });

  it('condition A takes precedence when both conditions hold (total death is the more severe finding)', () => {
    const decision = decidePipelineThroughputAlert(
      input({
        latest_unlinked_age_hours: 2,
        oldest_unlinked_age_hours: 700,
        last_secured_age_hours: 90,
      }),
    );
    expect(decision.should_fire).toBe(true);
    expect(decision.reason).toMatch(/network-wide/i);
  });

  it('does not fire condition B exactly at the threshold boundary (strictly greater)', () => {
    const at = decidePipelineThroughputAlert(
      input({ oldest_unlinked_age_hours: 48, last_secured_age_hours: 1 }),
    );
    expect(at.should_fire).toBe(false);

    const over = decidePipelineThroughputAlert(
      input({ oldest_unlinked_age_hours: 49, last_secured_age_hours: 1 }),
    );
    expect(over.should_fire).toBe(true);
    expect(over.reason).toMatch(/linker stall/i);
  });

  it('still fires when the unlinked-total cache context is unavailable (probes are the signal)', () => {
    const decision = decidePipelineThroughputAlert(
      input({
        latest_unlinked_age_hours: 2,
        oldest_unlinked_age_hours: 3,
        last_secured_age_hours: 90,
        unlinked_total: null,
      }),
    );
    expect(decision.should_fire).toBe(true);
  });

  it('does not fire condition A when securing happened inside the window (path alive)', () => {
    const decision = decidePipelineThroughputAlert(
      input({
        latest_unlinked_age_hours: 2,
        oldest_unlinked_age_hours: 5,
        last_secured_age_hours: 23,
      }),
    );
    expect(decision.should_fire).toBe(false);
  });

  it('does not fire condition A when no NEW unlinked record arrived in the window (feeders idle — SCRUM-2900 surface)', () => {
    const decision = decidePipelineThroughputAlert(
      input({
        latest_unlinked_age_hours: 30, // newest unlinked record predates the 24h window
        oldest_unlinked_age_hours: 40, // below the 48h stall threshold
        last_secured_age_hours: 90,
      }),
    );
    expect(decision.should_fire).toBe(false);
  });
});

// ─── Cron entry point ───

interface TimestampRowResult {
  data: Array<{ created_at?: string | null; chain_timestamp?: string | null }> | null;
  error: unknown;
}

interface CacheResult {
  data: { cache_value: Record<string, unknown> } | null;
  error: unknown;
}

/**
 * Minimal chainable Supabase stub covering the monitor's three LIMIT-1
 * timestamp probes plus the two best-effort pipeline_dashboard_cache reads:
 *   public_records oldest: .select('created_at').is('anchor_id', null).order('created_at', {ascending:true}).limit(1)
 *   public_records newest: same with {ascending:false}
 *   anchors last secured:  .select('chain_timestamp').eq('status','SECURED').is('deleted_at', null)
 *                          .not('chain_timestamp','is',null).order('chain_timestamp', {ascending:false, …}).limit(1)
 *   cache:                 .select('cache_value').eq('cache_key', key).single()
 */
function mockDb(opts: {
  oldestUnlinked?: TimestampRowResult;
  newestUnlinked?: TimestampRowResult;
  lastSecured?: TimestampRowResult;
  pipelineStats?: CacheResult;
  statusCounts?: CacheResult;
} = {}) {
  const oldestUnlinked = opts.oldestUnlinked ?? { data: [], error: null };
  const newestUnlinked = opts.newestUnlinked ?? { data: [], error: null };
  const lastSecured = opts.lastSecured ?? { data: [], error: null };
  const caches: Record<string, CacheResult> = {
    pipeline_stats:
      opts.pipelineStats ??
      { data: { cache_value: { pending_record_links: 0 } }, error: null },
    anchor_status_counts:
      opts.statusCounts ??
      { data: { cache_value: { PENDING: 0, SECURED: 0 } }, error: null },
  };

  function recordsChain() {
    let ascending = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.is = vi.fn(() => chain);
    chain.order = vi.fn((_column: string, options?: { ascending?: boolean }) => {
      ascending = options?.ascending !== false;
      return chain;
    });
    chain.limit = vi.fn(() => Promise.resolve(ascending ? oldestUnlinked : newestUnlinked));
    return chain;
  }

  function anchorsChain() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.is = vi.fn(() => chain);
    chain.not = vi.fn(() => chain);
    chain.order = vi.fn(() => chain);
    chain.limit = vi.fn(() => Promise.resolve(lastSecured));
    return chain;
  }

  return {
    from(table: string) {
      if (table === 'public_records') return recordsChain();
      if (table === 'anchors') return anchorsChain();
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
  it('(a) healthy pipeline — fresh records, young backlog, recent securing → no alert', async () => {
    mockCapturePipelineThroughputAlert.mockClear();
    const db = mockDb({
      oldestUnlinked: { data: [{ created_at: hoursAgo(3) }], error: null },
      newestUnlinked: { data: [{ created_at: hoursAgo(1) }], error: null },
      lastSecured: { data: [{ chain_timestamp: hoursAgo(2) }], error: null },
      pipelineStats: { data: { cache_value: { pending_record_links: 1200 } }, error: null },
      statusCounts: { data: { cache_value: { PENDING: 1000, SECURED: 2_972_264 } }, error: null },
    });

    const result = await runPipelineThroughputMonitor(db, { now: NOW, windowHours: 24 });

    expect(result.healthy).toBe(true);
    expect(result.alertFired).toBe(false);
    expect(result.latestUnlinkedAgeHours).toBe(1);
    expect(result.oldestUnlinkedAgeHours).toBe(3);
    expect(result.lastSecuredAgeHours).toBe(2);
    expect(result.unlinkedTotal).toBe(1200);
    expect(result.batchProgress).toEqual({ PENDING: 1000, SECURED: 2_972_264 });
    expect(result.checkedAt).toBe(NOW.toISOString());
    expect(mockCapturePipelineThroughputAlert).not.toHaveBeenCalled();
  });

  it('INCIDENT STATE — old growing backlog while other anchors still secure → FIRES with linker-stall reason', async () => {
    // Flipped from the original "healthy" assertion after independent review:
    // recent securing with a weeks-old 259k unlinked backlog IS the incident,
    // not health. Condition B must page here.
    mockCapturePipelineThroughputAlert.mockClear();
    const db = mockDb({
      oldestUnlinked: { data: [{ created_at: hoursAgo(700) }], error: null },
      newestUnlinked: { data: [{ created_at: hoursAgo(1) }], error: null },
      lastSecured: { data: [{ chain_timestamp: hoursAgo(2) }], error: null },
      pipelineStats: { data: { cache_value: { pending_record_links: 259_000 } }, error: null },
    });

    const result = await runPipelineThroughputMonitor(db, { now: NOW, windowHours: 24 });

    expect(result.healthy).toBe(false);
    expect(result.alertFired).toBe(true);
    expect(result.oldestUnlinkedAgeHours).toBe(700);
    expect(mockCapturePipelineThroughputAlert).toHaveBeenCalledTimes(1);
    const [message] = mockCapturePipelineThroughputAlert.mock.calls[0] as [string];
    expect(message).toMatch(/linker stall/i);
  });

  it('(b) fresh unlinked records + no securing in the window → alert fired ONCE via the stable-fingerprint helper', async () => {
    mockCapturePipelineThroughputAlert.mockClear();
    const db = mockDb({
      oldestUnlinked: { data: [{ created_at: hoursAgo(4) }], error: null },
      newestUnlinked: { data: [{ created_at: hoursAgo(1) }], error: null },
      lastSecured: { data: [{ chain_timestamp: hoursAgo(90) }], error: null },
      pipelineStats: { data: { cache_value: { pending_record_links: 259_812 } }, error: null },
    });

    const result = await runPipelineThroughputMonitor(db, { now: NOW, windowHours: 24 });

    expect(result.healthy).toBe(false);
    expect(result.alertFired).toBe(true);

    expect(mockCapturePipelineThroughputAlert).toHaveBeenCalledTimes(1);
    const [message, extra] = mockCapturePipelineThroughputAlert.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(message).toMatch(/network-wide/i);
    expect(extra.source).toBe('pipeline-throughput-monitor');
    expect(extra.story).toBe('SCRUM-2901');
    expect(extra.latest_unlinked_age_hours).toBe(1);
    expect(extra.oldest_unlinked_age_hours).toBe(4);
    expect(extra.last_secured_age_hours).toBe(90);
    expect(extra.unlinked_total).toBe(259_812);
    expect(extra.window_hours).toBe(24);
    expect(extra.linker_stall_threshold_hours).toBe(DEFAULT_LINKER_STALL_THRESHOLD_HOURS);
    // PII rules (§1.4): aggregates only — no emails, fingerprints, keys, or ids.
    const serialized = JSON.stringify({ message, extra });
    expect(serialized).not.toMatch(/[a-f0-9]{64}/i);
    expect(serialized).not.toMatch(/@/);

    // And an error-level structured log.
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ latestUnlinkedAgeHours: 1, lastSecuredAgeHours: 90 }),
      expect.stringMatching(/throughput|stall|dead/i),
    );
  });

  it('(c) DB error on the newest-unlinked probe → rejects (route returns 500-safe body, Scheduler retries)', async () => {
    mockCapturePipelineThroughputAlert.mockClear();
    const db = mockDb({
      newestUnlinked: { data: null, error: { message: 'statement timeout' } },
    });

    await expect(
      runPipelineThroughputMonitor(db, { now: NOW, windowHours: 24 }),
    ).rejects.toThrow(/throughput probe/i);
    expect(mockCapturePipelineThroughputAlert).not.toHaveBeenCalled();
  });

  it('(c2) DB error on the oldest-unlinked probe → rejects (condition B must not silently degrade)', async () => {
    const db = mockDb({
      oldestUnlinked: { data: null, error: { message: 'connection reset' } },
    });
    await expect(
      runPipelineThroughputMonitor(db, { now: NOW, windowHours: 24 }),
    ).rejects.toThrow(/throughput probe/i);
  });

  it('(c3) DB error on the last-secured probe → rejects (condition A must not silently degrade)', async () => {
    const db = mockDb({
      lastSecured: { data: null, error: { message: 'connection reset' } },
    });
    await expect(
      runPipelineThroughputMonitor(db, { now: NOW, windowHours: 24 }),
    ).rejects.toThrow(/throughput probe/i);
  });

  it('treats an unparseable timestamp as unavailable (no spurious page, loud warn)', async () => {
    mockCapturePipelineThroughputAlert.mockClear();
    const db = mockDb({
      oldestUnlinked: { data: [{ created_at: 'not-a-date' }], error: null },
      newestUnlinked: { data: [{ created_at: 'not-a-date' }], error: null },
      lastSecured: { data: [{ chain_timestamp: hoursAgo(2) }], error: null },
    });
    const result = await runPipelineThroughputMonitor(db, { now: NOW, windowHours: 24 });
    expect(result.oldestUnlinkedAgeHours).toBeNull();
    expect(result.latestUnlinkedAgeHours).toBeNull();
    expect(result.alertFired).toBe(false);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('cache reads are best-effort: a cache miss neither blocks the run nor the alert', async () => {
    mockCapturePipelineThroughputAlert.mockClear();
    const db = mockDb({
      oldestUnlinked: { data: [{ created_at: hoursAgo(2) }], error: null },
      newestUnlinked: { data: [{ created_at: hoursAgo(1) }], error: null },
      lastSecured: { data: [], error: null }, // nothing ever secured
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

  it('defaults window and linker-stall threshold from the exported constants', async () => {
    const db = mockDb();
    const result = await runPipelineThroughputMonitor(db, { now: NOW });
    expect(result.windowHours).toBe(DEFAULT_THROUGHPUT_WINDOW_HOURS);
    expect(result.linkerStallThresholdHours).toBe(DEFAULT_LINKER_STALL_THRESHOLD_HOURS);
    // ≥ 24h so a healthy pipeline that only secures at the nightly 3am batch
    // drain always shows at least one flush inside the window (no false page).
    expect(DEFAULT_THROUGHPUT_WINDOW_HOURS).toBeGreaterThanOrEqual(24);
  });
});
