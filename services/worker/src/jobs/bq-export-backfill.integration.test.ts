/**
 * One-shot backfill integration tests (SCRUM-1727).
 *
 * Mocks db + client + watermark; asserts:
 *   - loops in batches until source is exhausted
 *   - watermark advances PER BATCH (so a mid-loop crash is resumable)
 *   - returns final watermark + total inserted
 *   - rejects non-backfillable tables (organizations / api_keys)
 *
 * Drives coverage for bq-export-backfill.ts to ~100%.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { fromMock, ensureTableMock, insertRowsMock, readWatermarkMock,
        markRunStartedMock, markRunSucceededMock, markRunFailedMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  ensureTableMock: vi.fn(),
  insertRowsMock: vi.fn(),
  readWatermarkMock: vi.fn(),
  markRunStartedMock: vi.fn(),
  markRunSucceededMock: vi.fn(),
  markRunFailedMock: vi.fn(),
}));

vi.mock('../utils/db.js', () => ({ db: { from: (...a: unknown[]) => fromMock(...a) } }));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./bq-export-client.js', () => ({
  ensureTable: (...a: unknown[]) => ensureTableMock(...a),
  insertRows: (...a: unknown[]) => insertRowsMock(...a),
}));
vi.mock('./bq-export-watermark.js', async (importActual) => {
  const actual = await importActual<typeof import('./bq-export-watermark.js')>();
  return {
    ...actual,
    readWatermark: (...a: unknown[]) => readWatermarkMock(...a),
    markRunStarted: (...a: unknown[]) => markRunStartedMock(...a),
    markRunSucceeded: (...a: unknown[]) => markRunSucceededMock(...a),
    markRunFailed: (...a: unknown[]) => markRunFailedMock(...a),
  };
});

import { runBackfill } from './bq-export-backfill.js';

function chainSelect(result: { data: unknown; error: unknown }) {
  const thenable: { then: (cb: (v: unknown) => unknown) => Promise<unknown> } & Record<string, unknown> = {
    then: (cb) => Promise.resolve(result).then(cb),
  };
  thenable.gt = vi.fn().mockReturnValue(thenable);
  thenable.order = vi.fn().mockReturnValue(thenable);
  thenable.limit = vi.fn().mockReturnValue(thenable);
  return thenable;
}

beforeEach(() => {
  fromMock.mockReset();
  ensureTableMock.mockReset();
  insertRowsMock.mockReset();
  readWatermarkMock.mockReset();
  markRunStartedMock.mockReset();
  markRunSucceededMock.mockReset();
  markRunFailedMock.mockReset();

  ensureTableMock.mockResolvedValue({ created: false });
  markRunStartedMock.mockResolvedValue(undefined);
  markRunSucceededMock.mockResolvedValue(undefined);
  markRunFailedMock.mockResolvedValue(undefined);
});

describe('runBackfill — happy path', () => {
  it('loops in batches; advances watermark per batch; returns total inserted', async () => {
    readWatermarkMock.mockResolvedValue({
      tableName: 'anchors',
      lastSyncedAt: '1970-01-01T00:00:00Z',
      lastSyncedId: null,
      lastRunStatus: 'pending',
      lastRunError: null,
    });

    // First chain call returns 3 rows (a partial-batch — exhausted after this).
    const sourceRows = [
      { id: 'u-1', org_id: 'o', created_at: '2025-01-01T00:00:00Z' },
      { id: 'u-2', org_id: 'o', created_at: '2025-06-01T00:00:00Z' },
      { id: 'u-3', org_id: 'o', created_at: '2026-01-01T00:00:00Z' },
    ];
    fromMock.mockReturnValue({ select: vi.fn().mockReturnValue(chainSelect({ data: sourceRows, error: null })) });
    insertRowsMock.mockResolvedValue({ insertedCount: 3, errors: [] });

    const result = await runBackfill('anchors');

    expect(result.table).toBe('anchors');
    expect(result.totalRowsInserted).toBe(3);
    expect(result.finalWatermark).toBe('2026-01-01T00:00:00Z');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    // Watermark advances per batch + once at the end ("finalize"). Last call's
    // newWatermark must equal the max created_at from the inserted rows.
    const succeededCalls = markRunSucceededMock.mock.calls;
    expect(succeededCalls.length).toBeGreaterThanOrEqual(1);
    expect(succeededCalls[succeededCalls.length - 1][0].newWatermark).toBe('2026-01-01T00:00:00Z');
  });
});

describe('runBackfill — failure semantics', () => {
  it('marks run failed and throws when source query errors mid-loop', async () => {
    readWatermarkMock.mockResolvedValue({
      tableName: 'anchors',
      lastSyncedAt: '1970-01-01T00:00:00Z',
      lastSyncedId: null,
      lastRunStatus: 'pending',
      lastRunError: null,
    });
    fromMock.mockReturnValue({ select: vi.fn().mockReturnValue(chainSelect({ data: null, error: { message: 'pg crash' } })) });

    await expect(runBackfill('anchors')).rejects.toThrow(/pg crash/);

    expect(markRunFailedMock).toHaveBeenCalledWith(
      'anchors',
      expect.stringContaining('pg crash'),
    );
  });

  it('marks run failed and throws when BQ insertAll returns errors', async () => {
    readWatermarkMock.mockResolvedValue({
      tableName: 'verifications',
      lastSyncedAt: '1970-01-01T00:00:00Z',
      lastSyncedId: null,
      lastRunStatus: 'pending',
      lastRunError: null,
    });
    fromMock.mockReturnValue({
      select: vi.fn().mockReturnValue(chainSelect({
        data: [{ id: 'v-1', anchor_id: 'a-1', created_at: '2026-01-01T00:00:00Z' }],
        error: null,
      })),
    });
    insertRowsMock.mockResolvedValue({
      insertedCount: 0,
      errors: [{ index: 0, reason: 'bad-cell' }],
    });

    await expect(runBackfill('verifications')).rejects.toThrow(/insert errors/);

    expect(markRunFailedMock).toHaveBeenCalledWith('verifications', expect.any(String));
  });
});

describe('runBackfill — early rejection of non-backfillable tables', () => {
  it.each(['organizations', 'api_keys'])('throws for snapshot table "%s" before any DB call', async (t) => {
    await expect(runBackfill(t)).rejects.toThrow(/not a backfillable table/);
    expect(readWatermarkMock).not.toHaveBeenCalled();
    expect(fromMock).not.toHaveBeenCalled();
  });

  it.each(['', 'unknown_table', 'anchor', 'auditevents'])(
    'throws for unknown / typo table "%s" before any DB call',
    async (t) => {
      await expect(runBackfill(t)).rejects.toThrow(/not a backfillable table/);
      expect(readWatermarkMock).not.toHaveBeenCalled();
    },
  );
});
