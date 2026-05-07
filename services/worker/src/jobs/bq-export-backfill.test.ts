/**
 * Pure-function tests for the one-shot backfill job.
 *
 * SCRUM-1727. Pins `isBackfillable` so backfill can never be invoked on
 * snapshot tables (organizations, api_keys) — those have a different
 * write-mode contract and would corrupt the partition layout.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../utils/db.js', () => ({ db: {} }));
vi.mock('../utils/gcp-auth.js', () => ({ getGcpAccessToken: vi.fn() }));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { __testing, runBackfill } from './bq-export-backfill.js';

const { BATCH_SIZE, BACKFILLABLE, isBackfillable } = __testing;

describe('bq-export-backfill: BACKFILLABLE allowlist', () => {
  it('contains exactly the three append-only tables', () => {
    expect([...BACKFILLABLE].sort((a, b) => a.localeCompare(b))).toEqual([
      'anchors',
      'audit_events',
      'verifications',
    ]);
  });

  it.each(['anchors', 'verifications', 'audit_events'])('isBackfillable("%s") returns true', (t) => {
    expect(isBackfillable(t)).toBe(true);
  });

  it.each(['organizations', 'api_keys'])(
    'isBackfillable("%s") returns FALSE — snapshot tables must use the snapshot job',
    (t) => {
      expect(isBackfillable(t)).toBe(false);
    },
  );

  it.each(['', 'unknown', 'anchor', 'auditevents', 'foo'])(
    'isBackfillable("%s") returns false for typo / unknown',
    (t) => {
      expect(isBackfillable(t)).toBe(false);
    },
  );
});

describe('bq-export-backfill: runBackfill rejects non-backfillable tables fast', () => {
  it('throws for organizations (snapshot table)', async () => {
    await expect(runBackfill('organizations')).rejects.toThrow(/not a backfillable table/);
  });

  it('throws for api_keys (snapshot table)', async () => {
    await expect(runBackfill('api_keys')).rejects.toThrow(/not a backfillable table/);
  });

  it('throws for an unknown table name', async () => {
    await expect(runBackfill('not_a_real_table')).rejects.toThrow(/not a backfillable table/);
  });
});

describe('bq-export-backfill: batch size sanity', () => {
  it('BATCH_SIZE is between 100 and 100_000 (BQ insertAll cap)', () => {
    expect(BATCH_SIZE).toBeGreaterThanOrEqual(100);
    expect(BATCH_SIZE).toBeLessThanOrEqual(100_000);
  });
});
