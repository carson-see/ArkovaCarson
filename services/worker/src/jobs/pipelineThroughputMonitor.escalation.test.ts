/**
 * Dead-man ESCALATION contract (SCRUM-3050 — silent-failure hardening).
 *
 * The 2026-08-01 finding: this monitor WORKED. It detected the 70h anchoring
 * outage correctly and fired every ~30 minutes for 70+ hours with an accurate
 * diagnosis — and nobody saw it. Because every re-fire carried one stable
 * fingerprint, all ~140 events collapsed into a SINGLE Sentry issue that was
 * created once, aged quietly, and never re-notified. A monitor whose output
 * gets quieter the longer the outage lasts is not a dead-man switch.
 *
 * Fix under test: the fingerprint carries a DURATION BUCKET, so crossing
 * 24h/48h/72h/168h opens a genuinely NEW Sentry issue (re-triggering any
 * `FirstSeenEventCondition` rule), and the level escalates error -> fatal so a
 * separate, louder alert rule can key on the sustained case alone.
 *
 * The duration is derived purely from inputs the monitor already measures
 * (`last_secured_age_hours` for condition A, `oldest_unlinked_age_hours` for
 * condition B) — no state table, no migration, preserving the module's
 * DB-stateless design.
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
  sustainedBucketFor,
  severityForSustainedBucket,
  runPipelineThroughputMonitor,
  type ThroughputAlertInput,
} from './pipelineThroughputMonitor.js';

const NOW = new Date('2026-08-01T12:00:00Z');

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

describe('sustained-failure bucketing', () => {
  it('maps durations to escalating buckets', () => {
    expect(sustainedBucketFor(0)).toBe('t0');
    expect(sustainedBucketFor(23)).toBe('t0');
    expect(sustainedBucketFor(24)).toBe('t24h');
    expect(sustainedBucketFor(47)).toBe('t24h');
    expect(sustainedBucketFor(48)).toBe('t48h');
    expect(sustainedBucketFor(71)).toBe('t48h');
    expect(sustainedBucketFor(72)).toBe('t72h');
    expect(sustainedBucketFor(167)).toBe('t72h');
    expect(sustainedBucketFor(168)).toBe('t168h');
    expect(sustainedBucketFor(10_000)).toBe('t168h');
  });

  it('fails LOUD on an unbounded duration: null escalates to the TOP bucket, not the bottom', () => {
    // "Nothing has ever secured" is the worst case, not the mildest. Resolving
    // an unknown duration to t0 would be the classic "no data -> looks healthy"
    // bug (cf. ce-key-expiry-alert's SENTINEL path).
    expect(sustainedBucketFor(null)).toBe('t168h');
  });

  it('escalates level from error to fatal once the condition is 72h old', () => {
    expect(severityForSustainedBucket('t0')).toBe('error');
    expect(severityForSustainedBucket('t24h')).toBe('error');
    expect(severityForSustainedBucket('t48h')).toBe('error');
    expect(severityForSustainedBucket('t72h')).toBe('fatal');
    expect(severityForSustainedBucket('t168h')).toBe('fatal');
  });
});

describe('decidePipelineThroughputAlert escalation fields', () => {
  it('condition A: derives sustained duration from time since last securing', () => {
    // The 70h anchoring outage shape: records arriving, nothing securing.
    const d = decidePipelineThroughputAlert(
      input({ latest_unlinked_age_hours: 1, last_secured_age_hours: 70 }),
    );
    expect(d.should_fire).toBe(true);
    expect(d.sustained_hours).toBe(70);
    expect(d.sustained_bucket).toBe('t48h');
    expect(d.severity).toBe('error');
  });

  it('condition A at 72h escalates to fatal and a NEW fingerprint bucket', () => {
    const at48 = decidePipelineThroughputAlert(
      input({ latest_unlinked_age_hours: 1, last_secured_age_hours: 50 }),
    );
    const at72 = decidePipelineThroughputAlert(
      input({ latest_unlinked_age_hours: 1, last_secured_age_hours: 73 }),
    );
    expect(at48.sustained_bucket).not.toBe(at72.sustained_bucket);
    expect(at72.severity).toBe('fatal');
  });

  it('condition A with no securing ever observed escalates to the top bucket', () => {
    const d = decidePipelineThroughputAlert(
      input({ latest_unlinked_age_hours: 2, last_secured_age_hours: null }),
    );
    expect(d.should_fire).toBe(true);
    expect(d.sustained_hours).toBeNull();
    expect(d.sustained_bucket).toBe('t168h');
    expect(d.severity).toBe('fatal');
  });

  it('condition B: derives sustained duration from the oldest unlinked record age', () => {
    const d = decidePipelineThroughputAlert(
      input({
        latest_unlinked_age_hours: 100,
        oldest_unlinked_age_hours: 200,
        last_secured_age_hours: 1,
      }),
    );
    expect(d.should_fire).toBe(true);
    expect(d.sustained_hours).toBe(200);
    expect(d.sustained_bucket).toBe('t168h');
    expect(d.severity).toBe('fatal');
  });

  it('a healthy pipeline reports the t0 bucket and does not fire', () => {
    const d = decidePipelineThroughputAlert(
      input({
        latest_unlinked_age_hours: 1,
        oldest_unlinked_age_hours: 2,
        last_secured_age_hours: 1,
      }),
    );
    expect(d.should_fire).toBe(false);
    expect(d.sustained_bucket).toBe('t0');
    expect(d.severity).toBe('info');
  });
});

describe('runPipelineThroughputMonitor escalation dispatch', () => {
  beforeEach(() => {
    mockCapture.mockClear();
  });

  function dbFor(rows: {
    oldestUnlinked: string | null;
    newestUnlinked: string | null;
    lastSecured: string | null;
  }) {
    return {
      from(table: string) {
        if (table === 'public_records') {
          const q: Record<string, unknown> = {};
          let ascending = true;
          const chain = {
            select: () => chain,
            is: () => chain,
            not: () => chain,
            eq: () => chain,
            order: (_col: string, opts: { ascending: boolean }) => {
              ascending = opts.ascending;
              return chain;
            },
            limit: () => {
              const ts = ascending ? rows.oldestUnlinked : rows.newestUnlinked;
              return Promise.resolve({ data: ts ? [{ created_at: ts }] : [], error: null });
            },
          };
          void q;
          return chain;
        }
        if (table === 'anchors') {
          const chain = {
            select: () => chain,
            eq: () => chain,
            is: () => chain,
            not: () => chain,
            order: () => chain,
            limit: () =>
              Promise.resolve({
                data: rows.lastSecured ? [{ chain_timestamp: rows.lastSecured }] : [],
                error: null,
              }),
          };
          return chain;
        }
        // pipeline_dashboard_cache — best-effort, return a miss.
        const chain = {
          select: () => chain,
          eq: () => chain,
          single: () => Promise.resolve({ data: null, error: { message: 'miss' } }),
        };
        return chain;
      },
    };
  }

  it('passes the duration bucket into the Sentry fingerprint and escalates the level', async () => {
    const db = dbFor({
      oldestUnlinked: hoursAgo(3),
      newestUnlinked: hoursAgo(1),
      lastSecured: hoursAgo(80),
    });

    const result = await runPipelineThroughputMonitor(db, { now: NOW });

    expect(result.alertFired).toBe(true);
    expect(result.sustainedBucket).toBe('t72h');
    expect(mockCapture).toHaveBeenCalledTimes(1);
    const [, extra, escalation] = mockCapture.mock.calls[0] as [
      string,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(extra.sustained_bucket).toBe('t72h');
    expect(escalation).toEqual(
      expect.objectContaining({ sustainedBucket: 't72h', level: 'fatal' }),
    );
  });
});
