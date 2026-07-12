/**
 * Batch-drain dead-man's-switch — unit tests (Lane-1 S3.5 / BTC-real).
 *
 * TDD red-first. Written BEFORE the evaluator exists.
 *
 * WHY THIS EXISTS (diagnosis 2026-07-07):
 * The nightly ~3am Bitcoin batch-drain cron IS correctly wired to Cloud
 * Scheduler (daily-anchor-flush → POST /jobs/batch-anchors?force=true) — the
 * silent node-cron-on-throttled-Cloud-Run trap does NOT apply, so the prime
 * "3am cron never fires" suspect is REFUTED. But the founders' worry is real
 * in a different way: a HEALTHY flush (empty queue → HTTP 200 + EMPTY) and a
 * STALLED pipeline (Scheduler stops POSTing, or the drain silently no-ops
 * while a real backlog ages) are INDISTINGUISHABLE at the /health surface —
 * `anchoring.status` is hardcoded to 'ok' regardless. There is no loud signal.
 *
 * This dead-man's-switch is that loud signal. It flips anchoring health to
 * 'warning' when the drain has demonstrably stalled:
 *   (a) a real PENDING backlog exists (pendingCount > 0), AND
 *   (b) either the oldest pending anchor has aged past the drain's own age
 *       ceiling (MAX_ANCHOR_AGE_MS — a drain should have swept it by now),
 *       OR no batch has completed in > STALE_BATCH_MAX_MS (24h) — i.e. the
 *       nightly 3am flush is not landing.
 *
 * An EMPTY queue is NEVER a warning — that is the correct steady state given
 * 2,972,263 SECURED / 0 PENDING in prod. This test pins that: no false alarm
 * on the exact prod shape the diagnosis observed.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  evaluateBatchDrainHealth,
  STALE_BATCH_MAX_MS,
  DRAIN_AGE_CEILING_MS,
  type BatchDrainSignal,
} from './batch-drain-deadman.js';

// The pin test below imports MAX_ANCHOR_AGE_MS from ../jobs/batch-anchor.js,
// which transitively loads config/db/chain and would trip loadConfig() at
// import time. Mock those side-effect modules so ONLY the constant resolves —
// same pattern as batch-anchor.audit.test.ts. The pure evaluator itself has
// NO batch-anchor import (DRAIN_AGE_CEILING_MS is local), keeping the /health
// import path free of the job graph.
vi.mock('../config.js', () => ({ config: { maxFeeThresholdSatPerVbyte: 50 } }));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../utils/db.js', () => ({
  db: { from: vi.fn(), rpc: vi.fn() },
  withDbTimeout: vi.fn(),
}));
vi.mock('../chain/client.js', () => ({ getChainClient: vi.fn(), getChainClientAsync: vi.fn() }));

const MAX_ANCHOR_AGE_MS = DRAIN_AGE_CEILING_MS;

const NOW = Date.parse('2026-07-07T12:00:00Z');

function signal(overrides: Partial<BatchDrainSignal> = {}): BatchDrainSignal {
  return {
    pendingCount: 0,
    oldestPendingAt: null,
    lastBatchAt: null,
    nowMs: NOW,
    ...overrides,
  };
}

describe('evaluateBatchDrainHealth — dead-man\'s-switch', () => {
  it('exports STALE_BATCH_MAX_MS pinned to 24 hours', () => {
    expect(STALE_BATCH_MAX_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('DRAIN_AGE_CEILING_MS stays equal to batch-anchor MAX_ANCHOR_AGE_MS (source of truth)', async () => {
    // Coupled-by-assertion: the monitoring ceiling must track the drain's own
    // Trigger-B age ceiling. If batch-anchor changes MAX_ANCHOR_AGE_MS, this
    // fails and forces the mirror to be updated deliberately.
    const { MAX_ANCHOR_AGE_MS: sourceOfTruth } = await import('../jobs/batch-anchor.js');
    expect(DRAIN_AGE_CEILING_MS).toBe(sourceOfTruth);
  });

  describe('empty queue is the correct steady state (no false alarm)', () => {
    it('OK when queue empty and no batch ever ran (fresh / backfilled prod shape)', () => {
      // Exact prod shape 2026-07-07: 0 PENDING, last batch days ago.
      const result = evaluateBatchDrainHealth(
        signal({ pendingCount: 0, oldestPendingAt: null, lastBatchAt: null }),
      );
      expect(result.status).toBe('ok');
      expect(result.stalled).toBe(false);
    });

    it('OK when queue empty even if last batch was > 24h ago', () => {
      // Newest prod anchor ~2026-06-30; days since last batch. Empty queue ⇒ nothing to drain.
      const result = evaluateBatchDrainHealth(
        signal({
          pendingCount: 0,
          oldestPendingAt: null,
          lastBatchAt: new Date(NOW - 8 * 24 * 60 * 60 * 1000).toISOString(),
        }),
      );
      expect(result.status).toBe('ok');
      expect(result.stalled).toBe(false);
    });
  });

  describe('aged backlog fires the switch (drain silently not sweeping)', () => {
    it('WARNING when pending > 0 and oldest pending aged past MAX_ANCHOR_AGE_MS', () => {
      const result = evaluateBatchDrainHealth(
        signal({
          pendingCount: 42,
          oldestPendingAt: new Date(NOW - (MAX_ANCHOR_AGE_MS + 60_000)).toISOString(),
          lastBatchAt: new Date(NOW - 30 * 60_000).toISOString(), // batches "running" but not draining
        }),
      );
      expect(result.status).toBe('warning');
      expect(result.stalled).toBe(true);
      expect(result.reason).toBe('backlog_aged');
    });

    it('OK when pending > 0 but oldest pending still within the age ceiling', () => {
      const result = evaluateBatchDrainHealth(
        signal({
          pendingCount: 9_999,
          oldestPendingAt: new Date(NOW - (MAX_ANCHOR_AGE_MS - 60_000)).toISOString(),
          lastBatchAt: new Date(NOW - 5 * 60_000).toISOString(),
        }),
      );
      expect(result.status).toBe('ok');
      expect(result.stalled).toBe(false);
    });
  });

  describe('nightly flush not landing fires the switch', () => {
    it('WARNING when pending > 0 and no batch completed in > 24h (3am flush stopped)', () => {
      const result = evaluateBatchDrainHealth(
        signal({
          pendingCount: 3,
          // young backlog so age ceiling alone would NOT fire — isolates the stale-batch path
          oldestPendingAt: new Date(NOW - 10 * 60_000).toISOString(),
          lastBatchAt: new Date(NOW - (STALE_BATCH_MAX_MS + 60_000)).toISOString(),
        }),
      );
      expect(result.status).toBe('warning');
      expect(result.stalled).toBe(true);
      expect(result.reason).toBe('batch_stale');
    });

    it('WARNING when pending > 0 and NO batch has EVER completed (lastBatchAt null)', () => {
      // A pipeline that never once drained, with a real backlog, is stalled.
      const result = evaluateBatchDrainHealth(
        signal({
          pendingCount: 1,
          oldestPendingAt: new Date(NOW - 10 * 60_000).toISOString(),
          lastBatchAt: null,
        }),
      );
      expect(result.status).toBe('warning');
      expect(result.stalled).toBe(true);
      expect(result.reason).toBe('batch_stale');
    });

    it('OK when pending > 0, young backlog, and a batch completed within 24h', () => {
      const result = evaluateBatchDrainHealth(
        signal({
          pendingCount: 500,
          oldestPendingAt: new Date(NOW - 10 * 60_000).toISOString(),
          lastBatchAt: new Date(NOW - 2 * 60 * 60 * 1000).toISOString(),
        }),
      );
      expect(result.status).toBe('ok');
      expect(result.stalled).toBe(false);
    });
  });

  describe('degraded observability never masks a real backlog', () => {
    it('WARNING when pending > 0 but oldestPendingAt is unknown (null) — cannot prove freshness', () => {
      // If we have a backlog but the age probe failed, fail LOUD, not silent.
      const result = evaluateBatchDrainHealth(
        signal({
          pendingCount: 7,
          oldestPendingAt: null,
          lastBatchAt: new Date(NOW - 5 * 60_000).toISOString(),
        }),
      );
      expect(result.status).toBe('warning');
      expect(result.stalled).toBe(true);
      expect(result.reason).toBe('backlog_age_unknown');
    });

    it('OK when pendingCount is unknown (null) — no proven backlog to alarm on', () => {
      // pendingCount null means the count probe failed; without a proven backlog
      // we do not raise a false alarm (avoids flapping on transient DB blips).
      const result = evaluateBatchDrainHealth(
        signal({ pendingCount: null, oldestPendingAt: null, lastBatchAt: null }),
      );
      expect(result.status).toBe('ok');
      expect(result.stalled).toBe(false);
    });
  });
});
