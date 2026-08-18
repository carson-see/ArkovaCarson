/**
 * Condition-B COUNT FLOOR + honest backlog reporting (2026-08 alert storm).
 *
 * The incident this pins
 * ----------------------
 * Prod `public_records` on 2026-08-17: 3,538,743 rows, 3,538,742 linked,
 * exactly ONE unlinked. That single orphan was ~388h old, so condition B —
 * which fired purely on the AGE of the oldest unlinked record, with no
 * minimum-count floor — mapped it to the `t168h` bucket and returned `fatal`.
 * The monitor runs every ~30 minutes, so it emitted a FATAL Sentry event every
 * half hour for ~16 days (~670 events) over one stuck row.
 *
 * The alert text also contradicted itself:
 *
 *   "oldest unlinked public record is 388h old ... (total unlinked backlog 0)"
 *
 * `unlinked_total` comes from `pipeline_dashboard_cache.pipeline_stats
 * .pending_record_links`, which the deployed `refresh_cache_pipeline_stats()`
 * computes as `round(pg_class.reltuples * pg_stats.null_frac)` — a SAMPLED
 * ESTIMATE, not a count (the same jsonb row self-declares
 * `pending_record_links_approximate: true`). At 3.5M rows an ANALYZE sample of
 * ~30k rows cannot see a single null, so `null_frac` is 0 and the estimate is
 * 0 — while the monitor's own LIMIT-1 live probe is holding the row that
 * proves otherwise.
 *
 * Three properties are pinned here:
 *   1. A trivially small backlog cannot escalate on age alone; a genuinely
 *      stalled one at the SAME age still must.
 *   2. The message may never assert a zero backlog while reporting a stuck
 *      record, and may never present the sampled estimate as a count.
 *   3. The floor clears the estimator's MINIMUM EXPRESSIBLE non-zero value.
 *      `null_frac` is quantized to multiples of 1/sample_size, so one sampled
 *      stuck row estimates round(3.5M / 30k) ≈ 118 — never anything in
 *      1..117. A floor below that quantum (the original 100) re-armed the
 *      fatal storm in every ANALYZE epoch whose sample caught the stuck row
 *      (~1% of cycles per stuck row).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockCapture = vi.fn();
vi.mock('../utils/sentry.js', () => ({
  capturePipelineThroughputAlert: (...args: unknown[]) => mockCapture(...args),
}));

import {
  decidePipelineThroughputAlert,
  runPipelineThroughputMonitor,
  DEFAULT_LINKER_STALL_MIN_BACKLOG,
  type ThroughputAlertInput,
} from './pipelineThroughputMonitor.js';
import { logger } from '../utils/logger.js';

const NOW = new Date('2026-08-17T12:00:00Z');

/** The observed age of the single stuck prod row at triage time. */
const STUCK_AGE_HOURS = 388;

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

/**
 * The exact prod shape: one ancient unlinked row (so newest === oldest), other
 * anchor paths securing normally, cache reporting an estimated backlog of 0.
 */
function alertStormInput(overrides: Partial<ThroughputAlertInput> = {}): ThroughputAlertInput {
  return input({
    latest_unlinked_age_hours: STUCK_AGE_HOURS,
    oldest_unlinked_age_hours: STUCK_AGE_HOURS,
    last_secured_age_hours: 1,
    unlinked_total: 0,
    unlinked_total_approximate: true,
    ...overrides,
  });
}

describe('condition B minimum-count floor', () => {
  it('the 2026-08 alert-storm shape (ONE 388h-old stuck record) does NOT escalate to fatal', () => {
    const decision = decidePipelineThroughputAlert(alertStormInput());

    // It is still a finding — the row IS stuck and must stay visible…
    expect(decision.should_fire).toBe(true);
    expect(decision.below_backlog_floor).toBe(true);
    // …but a single orphan is an operational nuisance, not a pipeline outage.
    expect(decision.severity).not.toBe('fatal');
    expect(decision.severity).not.toBe('error');
    expect(decision.severity).toBe('warning');
  });

  it('a genuinely stalled backlog at the SAME 388h age still escalates to fatal', () => {
    // Same age, same threshold — only the magnitude differs. This is the
    // 2026-07 incident class (259k unlinked aging for weeks) and it must keep
    // paging exactly as loudly as before.
    const decision = decidePipelineThroughputAlert(
      alertStormInput({ unlinked_total: 259_000 }),
    );

    expect(decision.should_fire).toBe(true);
    expect(decision.below_backlog_floor).toBe(false);
    expect(decision.severity).toBe('fatal');
    expect(decision.sustained_bucket).toBe('t168h');
  });

  it('an UNAVAILABLE backlog figure does not suppress escalation (fail loud, not "no data therefore healthy")', () => {
    // `unlinked_total` is best-effort cache context; a cache miss maps to null.
    // Treating "unknown" as "small" would be the same bug `sustainedBucketFor`
    // already guards against by escalating a null duration to the top bucket.
    const decision = decidePipelineThroughputAlert(
      alertStormInput({ unlinked_total: null, unlinked_total_approximate: false }),
    );

    expect(decision.should_fire).toBe(true);
    expect(decision.below_backlog_floor).toBe(false);
    expect(decision.severity).toBe('fatal');
  });

  it('the floor is inclusive at its boundary: at the floor escalates, one below does not', () => {
    const atFloor = decidePipelineThroughputAlert(
      alertStormInput({ unlinked_total: DEFAULT_LINKER_STALL_MIN_BACKLOG }),
    );
    const belowFloor = decidePipelineThroughputAlert(
      alertStormInput({ unlinked_total: DEFAULT_LINKER_STALL_MIN_BACKLOG - 1 }),
    );

    expect(atFloor.below_backlog_floor).toBe(false);
    expect(atFloor.severity).toBe('fatal');
    expect(belowFloor.below_backlog_floor).toBe(true);
    expect(belowFloor.severity).toBe('warning');
  });

  it('an ANALYZE epoch that samples the single stuck row (estimate ≈ 117) still does NOT page', () => {
    // The estimator is QUANTIZED, not merely noisy: `null_frac` can only take
    // multiples of 1/sample_size, so the smallest non-zero estimate it can emit
    // at prod scale is round(3,538,743 / 30,000) ≈ 118 — ONE sampled stuck row
    // produces ~117–118, never anything in 1..117. The original floor (100) sat
    // BELOW that quantum: in the ~1% of ANALYZE cycles whose sample caught the
    // stuck row, the cache read ≈117 ≥ 100 and the exact fatal-every-30-minutes
    // storm this floor exists to kill re-armed for that ANALYZE epoch.
    for (const minimumExpressibleEstimate of [117, 118]) {
      const decision = decidePipelineThroughputAlert(
        alertStormInput({ unlinked_total: minimumExpressibleEstimate }),
      );

      expect(decision.should_fire).toBe(true);
      expect(decision.below_backlog_floor).toBe(true);
      expect(decision.severity).toBe('warning');
    }
  });

  it('the floor is overridable per call without touching the default', () => {
    const decision = decidePipelineThroughputAlert(
      alertStormInput({ unlinked_total: 50, linker_stall_min_backlog: 10 }),
    );
    expect(decision.below_backlog_floor).toBe(false);
    expect(decision.severity).toBe('fatal');
  });

  it('the floor does NOT gate condition A — total securing death is severe at any volume', () => {
    // Condition A means nothing secured network-wide inside the window while
    // feeders demonstrably produced a record. That is an outage regardless of
    // how many records are waiting, so the count floor must not touch it.
    const decision = decidePipelineThroughputAlert(
      input({
        latest_unlinked_age_hours: 2,
        oldest_unlinked_age_hours: 3,
        last_secured_age_hours: 90,
        unlinked_total: 1,
        unlinked_total_approximate: true,
      }),
    );

    expect(decision.should_fire).toBe(true);
    expect(decision.below_backlog_floor).toBe(false);
    expect(decision.severity).toBe('fatal');
    expect(decision.reason).toMatch(/network-wide/i);
  });

  it("the default floor clears the estimator's minimum expressible estimate, with growth headroom, while sitting far below one batch drain", () => {
    // Lower bound: the estimator's smallest NON-ZERO output is
    // round(rows / sample_size) — one sampled stuck row, ≈118 at prod's ~3.5M
    // rows with a ~30k ANALYZE sample. The floor must clear that quantum or a
    // single stuck row re-arms the storm whenever ANALYZE samples it. The
    // quantum grows linearly with the table, so the floor also needs headroom:
    // at 500 it stays above one quantum until ~15M rows (~4x today).
    // Upper bound: the nightly flush moves ~10k anchors and the motivating
    // 2026-07 incident was 259k, so a real linker stall crosses this floor on
    // its first missed cycle — no lost sensitivity.
    const PROD_ROWS = 3_538_743;
    const ANALYZE_SAMPLE_ROWS = 30_000;
    const minimumExpressibleEstimate = Math.round(PROD_ROWS / ANALYZE_SAMPLE_ROWS); // ≈118

    expect(DEFAULT_LINKER_STALL_MIN_BACKLOG).toBeGreaterThan(minimumExpressibleEstimate);
    // Growth headroom: still above the quantum at 4x today's table size.
    expect(DEFAULT_LINKER_STALL_MIN_BACKLOG).toBeGreaterThanOrEqual(
      4 * minimumExpressibleEstimate,
    );
    expect(DEFAULT_LINKER_STALL_MIN_BACKLOG).toBeLessThan(10_000);
  });
});

describe('backlog reporting honesty', () => {
  it('never claims a zero backlog while reporting a stuck record', () => {
    const decision = decidePipelineThroughputAlert(alertStormInput());

    expect(decision.reason).toMatch(/linker stall/i);
    expect(decision.reason).toContain(String(STUCK_AGE_HOURS));
    // The self-contradiction that made the alert untriageable.
    expect(decision.reason).not.toMatch(/unlinked backlog 0\b/);
    expect(decision.reason).not.toMatch(/backlog (of )?0\b/);
    // It must state the floor the live probe proves instead.
    expect(decision.reason).toMatch(/at least 1/i);
  });

  it('marks an approximate cache figure as approximate rather than presenting it as a count', () => {
    const decision = decidePipelineThroughputAlert(
      alertStormInput({ unlinked_total: 259_000 }),
    );
    expect(decision.reason).toMatch(/~259000/);
  });

  it('reports an exact cache figure without an approximation marker', () => {
    const decision = decidePipelineThroughputAlert(
      alertStormInput({ unlinked_total: 259_000, unlinked_total_approximate: false }),
    );
    expect(decision.reason).toContain('259000');
    expect(decision.reason).not.toMatch(/~259000/);
  });

  it('says the backlog figure is unavailable rather than silently omitting it', () => {
    const decision = decidePipelineThroughputAlert(
      alertStormInput({ unlinked_total: null }),
    );
    expect(decision.reason).toMatch(/unavailable/i);
  });
});

// ─── Cron entry point ───

interface CacheResult {
  data: { cache_value: Record<string, unknown> } | null;
  error: unknown;
}

function mockDb(opts: {
  oldestUnlinked?: string | null;
  newestUnlinked?: string | null;
  lastSecured?: string | null;
  pipelineStats?: CacheResult;
}) {
  const caches: Record<string, CacheResult> = {
    pipeline_stats: opts.pipelineStats ?? { data: null, error: { message: 'miss' } },
    anchor_status_counts: { data: { cache_value: { SECURED: 2_972_264 } }, error: null },
  };

  return {
    from(table: string) {
      if (table === 'public_records') {
        let ascending = true;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const chain: any = {};
        chain.select = () => chain;
        chain.is = () => chain;
        chain.order = (_col: string, o?: { ascending?: boolean }) => {
          ascending = o?.ascending !== false;
          return chain;
        };
        chain.limit = () => {
          const ts = ascending ? opts.oldestUnlinked : opts.newestUnlinked;
          return Promise.resolve({ data: ts ? [{ created_at: ts }] : [], error: null });
        };
        return chain;
      }
      if (table === 'anchors') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const chain: any = {};
        chain.select = () => chain;
        chain.eq = () => chain;
        chain.is = () => chain;
        chain.not = () => chain;
        chain.order = () => chain;
        chain.limit = () =>
          Promise.resolve({
            data: opts.lastSecured ? [{ chain_timestamp: opts.lastSecured }] : [],
            error: null,
          });
        return chain;
      }
      let key = '';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {};
      chain.select = () => chain;
      chain.eq = (_col: string, value: string) => {
        key = value;
        return chain;
      };
      chain.single = () =>
        Promise.resolve(caches[key] ?? { data: null, error: { message: 'miss' } });
      return chain;
    },
  };
}

/** The prod DB shape at triage: one 388h-old orphan, cache estimating zero. */
function alertStormDb() {
  return mockDb({
    oldestUnlinked: hoursAgo(STUCK_AGE_HOURS),
    newestUnlinked: hoursAgo(STUCK_AGE_HOURS),
    lastSecured: hoursAgo(1),
    pipelineStats: {
      data: {
        cache_value: {
          pending_record_links: 0,
          pending_record_links_approximate: true,
        },
      },
      error: null,
    },
  });
}

describe('runPipelineThroughputMonitor — sub-floor routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('a sub-floor stuck record emits NO Sentry alert (this is the ~670-event storm)', async () => {
    const result = await runPipelineThroughputMonitor(alertStormDb(), { now: NOW });

    expect(result.alertFired).toBe(false);
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('…but stays visible as a warn-level structured log — it is not silenced', async () => {
    await runPipelineThroughputMonitor(alertStormDb(), { now: NOW });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ belowBacklogFloor: true, oldestUnlinkedAgeHours: STUCK_AGE_HOURS }),
      expect.stringMatching(/linker stall/i),
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('reports the sub-floor verdict and the floor itself in the result body', async () => {
    const result = await runPipelineThroughputMonitor(alertStormDb(), { now: NOW });

    expect(result.belowBacklogFloor).toBe(true);
    expect(result.linkerStallMinBacklog).toBe(DEFAULT_LINKER_STALL_MIN_BACKLOG);
    expect(result.unlinkedTotal).toBe(0);
    expect(result.unlinkedTotalApproximate).toBe(true);
    // The finding is real, so the run is not "healthy" — it is just not a page.
    expect(result.healthy).toBe(false);
    expect(result.reason).not.toMatch(/unlinked backlog 0\b/);
  });

  it('the sampled-stuck-row ANALYZE epoch (cache estimate ≈117) emits NO Sentry alert either', async () => {
    // End-to-end version of the quantization regression: same single stuck
    // row, but this ANALYZE epoch happened to sample it, so the cache holds
    // the estimator's minimum expressible value instead of 0. Must route to
    // the warn log exactly like the estimate-0 epochs — the storm must not
    // re-arm for ~1% of cycles.
    const db = mockDb({
      oldestUnlinked: hoursAgo(STUCK_AGE_HOURS),
      newestUnlinked: hoursAgo(STUCK_AGE_HOURS),
      lastSecured: hoursAgo(1),
      pipelineStats: {
        data: {
          cache_value: {
            pending_record_links: 117,
            pending_record_links_approximate: true,
          },
        },
        error: null,
      },
    });

    const result = await runPipelineThroughputMonitor(db, { now: NOW });

    expect(result.belowBacklogFloor).toBe(true);
    expect(result.healthy).toBe(false);
    expect(result.alertFired).toBe(false);
    expect(mockCapture).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ belowBacklogFloor: true, unlinkedTotal: 117 }),
      expect.stringMatching(/linker stall/i),
    );
  });

  it('a genuine 259k stall at the same age still fires the Sentry alert at fatal', async () => {
    const db = mockDb({
      oldestUnlinked: hoursAgo(STUCK_AGE_HOURS),
      newestUnlinked: hoursAgo(1),
      lastSecured: hoursAgo(1),
      pipelineStats: {
        data: {
          cache_value: {
            pending_record_links: 259_000,
            pending_record_links_approximate: true,
          },
        },
        error: null,
      },
    });

    const result = await runPipelineThroughputMonitor(db, { now: NOW });

    expect(result.belowBacklogFloor).toBe(false);
    expect(result.alertFired).toBe(true);
    expect(mockCapture).toHaveBeenCalledTimes(1);
    const [, , escalation] = mockCapture.mock.calls[0] as [
      string,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(escalation).toEqual(
      expect.objectContaining({ sustainedBucket: 't168h', level: 'fatal' }),
    );
  });

  it('honours a caller-supplied floor override', async () => {
    const result = await runPipelineThroughputMonitor(alertStormDb(), {
      now: NOW,
      linkerStallMinBacklog: 1,
    });

    expect(result.linkerStallMinBacklog).toBe(1);
    expect(result.belowBacklogFloor).toBe(false);
    expect(result.alertFired).toBe(true);
  });
});
