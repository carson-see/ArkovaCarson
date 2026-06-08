/**
 * Tests for the Stuck Anchor Monitor (incident 2026-06-01).
 *
 * The daily 3am flush (`daily-anchor-flush`) silently 401'd for ~6 weeks
 * (OIDC audience bug), so ~2,962 PENDING anchors never drained and nothing
 * alerted. This monitor catches a stalled pipeline by the age of the OLDEST
 * non-deleted PENDING anchor — a signal the existing pipeline-health monitor
 * (which keys off `updated_at`, not `created_at`, and pages via email) does
 * not surface.
 */

import { describe, it, expect, vi } from 'vitest';

const mockConfig = vi.hoisted(() => ({
  stuckAnchorAlertHours: 24,
}));

vi.mock('../config.js', () => ({
  config: mockConfig,
}));

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const mockCaptureStuckAnchorAlert = vi.fn();
vi.mock('../utils/sentry.js', () => ({
  captureStuckAnchorAlert: (...args: unknown[]) => mockCaptureStuckAnchorAlert(...args),
}));

import {
  decideStuckAnchorAlert,
  runStuckAnchorCheck,
  DEFAULT_STUCK_ANCHOR_ALERT_HOURS,
  type StuckAnchorAlertInput,
} from './stuck-anchor-monitor.js';
import { logger } from '../utils/logger.js';

const NOW = new Date('2026-06-01T12:00:00Z');

function input(overrides: Partial<StuckAnchorAlertInput> = {}): StuckAnchorAlertInput {
  return {
    oldest_pending_created_at: null,
    pending_count: null,
    threshold_hours: 24,
    now: NOW,
    ...overrides,
  };
}

describe('decideStuckAnchorAlert', () => {
  it('does not fire when there are no PENDING anchors', () => {
    const decision = decideStuckAnchorAlert(input({ oldest_pending_created_at: null }));
    expect(decision.should_fire).toBe(false);
    expect(decision.oldest_age_hours).toBeNull();
    expect(decision.reason).toMatch(/no pending/i);
  });

  it('does not fire when the oldest PENDING anchor is younger than the threshold', () => {
    const oneHourAgo = new Date(NOW.getTime() - 1 * 60 * 60 * 1000).toISOString();
    const decision = decideStuckAnchorAlert(
      input({ oldest_pending_created_at: oneHourAgo, threshold_hours: 24 }),
    );
    expect(decision.should_fire).toBe(false);
    expect(decision.oldest_age_hours).toBe(1);
    expect(decision.reason).toMatch(/within .*threshold/i);
  });

  it('fires at error severity when the oldest PENDING anchor exceeds the threshold', () => {
    const thirtyHoursAgo = new Date(NOW.getTime() - 30 * 60 * 60 * 1000).toISOString();
    const decision = decideStuckAnchorAlert(
      input({ oldest_pending_created_at: thirtyHoursAgo, threshold_hours: 24, pending_count: 2962 }),
    );
    expect(decision.should_fire).toBe(true);
    expect(decision.severity).toBe('error');
    expect(decision.oldest_age_hours).toBe(30);
    expect(decision.pending_count).toBe(2962);
    expect(decision.reason).toContain('30');
    expect(decision.reason).toContain('24');
  });

  it('does not fire exactly at the threshold boundary (strictly greater)', () => {
    const exactly24h = new Date(NOW.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const decision = decideStuckAnchorAlert(
      input({ oldest_pending_created_at: exactly24h, threshold_hours: 24 }),
    );
    expect(decision.should_fire).toBe(false);
    expect(decision.oldest_age_hours).toBe(24);
  });

  it('honors a custom threshold', () => {
    const twoHoursAgo = new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString();
    const decision = decideStuckAnchorAlert(
      input({ oldest_pending_created_at: twoHoursAgo, threshold_hours: 1 }),
    );
    expect(decision.should_fire).toBe(true);
    expect(decision.oldest_age_hours).toBe(2);
  });

  it('does not fire on an unparseable timestamp (fail safe — no spurious page)', () => {
    const decision = decideStuckAnchorAlert(
      input({ oldest_pending_created_at: 'not-a-date', threshold_hours: 24 }),
    );
    expect(decision.should_fire).toBe(false);
    expect(decision.oldest_age_hours).toBeNull();
    expect(decision.reason).toMatch(/unparseable|invalid/i);
  });
});

// ─── Cron entry point ───

interface OldestRow {
  created_at: string;
}

/**
 * Minimal chainable Supabase stub. The oldest-PENDING query is:
 *   db.from('anchors').select('created_at').eq(...).is(...).order(...).limit(1)
 * resolving to { data: OldestRow[], error }.
 * The pending-count read is:
 *   db.from('pipeline_dashboard_cache').select('cache_value').eq(...).single()
 */
function mockDb(opts: {
  oldest?: { data: OldestRow[] | null; error?: unknown };
  cache?: { data: { cache_value: Record<string, unknown> } | null; error?: unknown };
} = {}) {
  const oldest = opts.oldest ?? { data: [], error: null };
  const cache = opts.cache ?? { data: { cache_value: { PENDING: 0 } }, error: null };
  return {
    from(table: string) {
      if (table === 'anchors') {
        const chain: Record<string, unknown> = {};
        chain.select = vi.fn(() => chain);
        chain.eq = vi.fn(() => chain);
        chain.is = vi.fn(() => chain);
        chain.order = vi.fn(() => chain);
        chain.limit = vi.fn(() => Promise.resolve(oldest));
        return chain;
      }
      if (table === 'pipeline_dashboard_cache') {
        const chain: Record<string, unknown> = {};
        chain.select = vi.fn(() => chain);
        chain.eq = vi.fn(() => chain);
        chain.single = vi.fn(() => Promise.resolve(cache));
        return chain;
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

describe('runStuckAnchorCheck', () => {
  it('returns healthy + does not alert when no PENDING anchors exist', async () => {
    mockCaptureStuckAnchorAlert.mockClear();
    const db = mockDb({ oldest: { data: [], error: null } });

    const result = await runStuckAnchorCheck(db, { now: NOW, thresholdHours: 24 });

    expect(result.healthy).toBe(true);
    expect(result.alertFired).toBe(false);
    expect(result.oldestAgeHours).toBeNull();
    expect(mockCaptureStuckAnchorAlert).not.toHaveBeenCalled();
  });

  it('returns healthy when the oldest PENDING anchor is within threshold', async () => {
    mockCaptureStuckAnchorAlert.mockClear();
    const twoHoursAgo = new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString();
    const db = mockDb({ oldest: { data: [{ created_at: twoHoursAgo }], error: null } });

    const result = await runStuckAnchorCheck(db, { now: NOW, thresholdHours: 24 });

    expect(result.healthy).toBe(true);
    expect(result.alertFired).toBe(false);
    expect(result.oldestAgeHours).toBe(2);
    expect(mockCaptureStuckAnchorAlert).not.toHaveBeenCalled();
  });

  it('logs at error level and fires a Sentry alert when stuck beyond threshold', async () => {
    mockCaptureStuckAnchorAlert.mockClear();
    const thirtyHoursAgo = new Date(NOW.getTime() - 30 * 60 * 60 * 1000).toISOString();
    const db = mockDb({
      oldest: { data: [{ created_at: thirtyHoursAgo }], error: null },
      cache: { data: { cache_value: { PENDING: 2962 } }, error: null },
    });

    const result = await runStuckAnchorCheck(db, { now: NOW, thresholdHours: 24 });

    expect(result.healthy).toBe(false);
    expect(result.alertFired).toBe(true);
    expect(result.oldestAgeHours).toBe(30);
    expect(result.pendingCount).toBe(2962);

    // Sentry alert carries aggregate context through the stable-fingerprint helper.
    expect(mockCaptureStuckAnchorAlert).toHaveBeenCalledTimes(1);
    const [message, extra, level] = mockCaptureStuckAnchorAlert.mock.calls[0] as [
      string,
      Record<string, unknown>,
      string,
    ];
    expect(message).toMatch(/stuck/i);
    expect(level).toBe('error');
    expect(extra.source).toBe('stuck-anchor-monitor');
    expect(extra.story).toBe('SCRUM-2234');
    expect(extra.oldest_age_hours).toBe(30);
    expect(extra.pending_count).toBe(2962);

    // And an error-level structured log.
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ oldestAgeHours: 30, pendingCount: 2962 }),
      expect.stringMatching(/stuck/i),
    );
  });

  it('still alerts when the pending-count context read fails (count is best-effort)', async () => {
    mockCaptureStuckAnchorAlert.mockClear();
    const thirtyHoursAgo = new Date(NOW.getTime() - 30 * 60 * 60 * 1000).toISOString();
    const db = mockDb({
      oldest: { data: [{ created_at: thirtyHoursAgo }], error: null },
      cache: { data: null, error: { message: 'cache miss' } },
    });

    const result = await runStuckAnchorCheck(db, { now: NOW, thresholdHours: 24 });

    expect(result.healthy).toBe(false);
    expect(result.alertFired).toBe(true);
    expect(result.pendingCount).toBeNull();
    expect(mockCaptureStuckAnchorAlert).toHaveBeenCalledTimes(1);
  });

  it('throws when the oldest-PENDING query errors (Cloud Scheduler retries on 500)', async () => {
    const db = mockDb({ oldest: { data: null, error: { message: 'statement timeout' } } });
    await expect(runStuckAnchorCheck(db, { now: NOW, thresholdHours: 24 })).rejects.toThrow(
      /oldest pending/i,
    );
  });

  it('reads the threshold from STUCK_ANCHOR_ALERT_HOURS when no override is given', async () => {
    mockCaptureStuckAnchorAlert.mockClear();
    const prev = mockConfig.stuckAnchorAlertHours;
    mockConfig.stuckAnchorAlertHours = 2;
    try {
      const threeHoursAgo = new Date(NOW.getTime() - 3 * 60 * 60 * 1000).toISOString();
      const db = mockDb({ oldest: { data: [{ created_at: threeHoursAgo }], error: null } });

      const result = await runStuckAnchorCheck(db, { now: NOW });

      expect(result.thresholdHours).toBe(2);
      expect(result.healthy).toBe(false);
      expect(result.alertFired).toBe(true);
    } finally {
      mockConfig.stuckAnchorAlertHours = prev;
    }
  });

  it('falls back to the default threshold on an invalid config value', async () => {
    const prev = mockConfig.stuckAnchorAlertHours;
    mockConfig.stuckAnchorAlertHours = Number.NaN;
    try {
      const db = mockDb({ oldest: { data: [], error: null } });
      const result = await runStuckAnchorCheck(db, { now: NOW });
      expect(result.thresholdHours).toBe(DEFAULT_STUCK_ANCHOR_ALERT_HOURS);
    } finally {
      mockConfig.stuckAnchorAlertHours = prev;
    }
  });
});
