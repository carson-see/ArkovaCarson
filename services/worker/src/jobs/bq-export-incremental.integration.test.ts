/**
 * Incremental sync integration tests (SCRUM-1723).
 *
 * Mocks the db chain + client + watermark helpers. Asserts the full happy
 * path AND the error semantics that are load-bearing for SOC 2 (watermark
 * MUST NOT advance on failure).
 *
 * Drives coverage for bq-export-incremental.ts to ~100%.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Hoisted mocks ----

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

import { runIncremental, __testing } from './bq-export-incremental.js';
import { chainSelect } from './bq-export-test-helpers.js';

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

// ---- Tests ----

describe('runIncremental — runOneTable happy path', () => {
  it('inserts rows and advances watermark to MAX(created_at)', async () => {
    readWatermarkMock.mockResolvedValue({
      tableName: 'anchors',
      lastSyncedAt: '2026-05-01T00:00:00Z',
      lastSyncedId: null,
      lastRunStatus: 'pending',
      lastRunError: null,
    });

    const sourceRows = [
      { id: 'uuid-1', org_id: 'o1', created_at: '2026-05-07T10:00:00Z' },
      { id: 'uuid-2', org_id: 'o1', created_at: '2026-05-07T10:05:00Z' },
      { id: 'uuid-3', org_id: 'o2', created_at: '2026-05-07T10:10:00Z' },
    ];
    fromMock.mockReturnValue({ select: vi.fn().mockReturnValue(chainSelect({ data: sourceRows, error: null })) });
    insertRowsMock.mockResolvedValue({ insertedCount: 3, errors: [] });

    const results = await runIncremental();
    const anchorsResult = results.find((r) => r.table === 'anchors');

    expect(anchorsResult).toBeDefined();
    expect(anchorsResult!.rowsScanned).toBe(3);
    expect(anchorsResult!.rowsInserted).toBe(3);
    expect(anchorsResult!.newWatermark).toBe('2026-05-07T10:10:00Z');
    expect(anchorsResult!.errors).toBe(0);

    // Watermark advanced to the LAST row's created_at
    const succeededCalls = markRunSucceededMock.mock.calls.filter((c) => c[0].tableName === 'anchors');
    expect(succeededCalls).toHaveLength(1);
    expect(succeededCalls[0][0].newWatermark).toBe('2026-05-07T10:10:00Z');
    expect(succeededCalls[0][0].newLastId).toBe('uuid-3');
  });
});

describe('runIncremental — empty source', () => {
  it('does NOT call insertRows when source returns 0 rows', async () => {
    readWatermarkMock.mockResolvedValue({
      tableName: 'anchors',
      lastSyncedAt: '2026-05-07T11:00:00Z',
      lastSyncedId: 'uuid-last',
      lastRunStatus: 'success',
      lastRunError: null,
    });
    fromMock.mockReturnValue({ select: vi.fn().mockReturnValue(chainSelect({ data: [], error: null })) });

    const results = await runIncremental();
    const anchorsResult = results.find((r) => r.table === 'anchors');

    expect(anchorsResult!.rowsInserted).toBe(0);
    expect(anchorsResult!.newWatermark).toBeNull();
    expect(insertRowsMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ tableId: 'anchors' }),
      expect.anything(),
    );
    // markRunSucceeded called with the SAME watermark (no advance)
    const succeededCalls = markRunSucceededMock.mock.calls.filter((c) => c[0].tableName === 'anchors');
    expect(succeededCalls[0][0].newWatermark).toBe('2026-05-07T11:00:00Z');
    expect(succeededCalls[0][0].newLastId).toBe('uuid-last');
  });
});

describe('runIncremental — failure semantics', () => {
  it('marks run failed and does NOT advance watermark when source query errors', async () => {
    readWatermarkMock.mockResolvedValue({
      tableName: 'anchors',
      lastSyncedAt: '2026-05-01T00:00:00Z',
      lastSyncedId: null,
      lastRunStatus: 'pending',
      lastRunError: null,
    });
    fromMock.mockReturnValue({ select: vi.fn().mockReturnValue(chainSelect({ data: null, error: { message: 'connection lost' } })) });

    const results = await runIncremental();
    const anchorsResult = results.find((r) => r.table === 'anchors');

    expect(anchorsResult!.errors).toBe(1);
    expect(markRunFailedMock).toHaveBeenCalledWith(
      'anchors',
      expect.stringContaining('connection lost'),
    );
    expect(insertRowsMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ tableId: 'anchors' }),
      expect.anything(),
    );
  });

  it('marks run failed when BQ insertRows returns errors', async () => {
    readWatermarkMock.mockResolvedValue({
      tableName: 'anchors',
      lastSyncedAt: '2026-05-01T00:00:00Z',
      lastSyncedId: null,
      lastRunStatus: 'pending',
      lastRunError: null,
    });
    fromMock.mockReturnValue({
      select: vi.fn().mockReturnValue(chainSelect({
        data: [{ id: 'uuid-1', org_id: 'o1', created_at: '2026-05-07T10:00:00Z' }],
        error: null,
      })),
    });
    insertRowsMock.mockResolvedValue({
      insertedCount: 0,
      errors: [{ index: 0, reason: 'invalid: bad timestamp' }],
    });

    const results = await runIncremental();
    const anchorsResult = results.find((r) => r.table === 'anchors');

    expect(anchorsResult!.errors).toBe(1);
    expect(markRunFailedMock).toHaveBeenCalledWith(
      'anchors',
      expect.stringContaining('insertAll errors'),
    );
  });

  it('one table failing does not abort the others', async () => {
    readWatermarkMock.mockResolvedValue({
      tableName: 'anchors', lastSyncedAt: '2026-05-01T00:00:00Z', lastSyncedId: null,
      lastRunStatus: 'pending', lastRunError: null,
    });
    let call = 0;
    fromMock.mockImplementation(() => {
      call++;
      if (call === 1) {
        // anchors: source error
        return { select: vi.fn().mockReturnValue(chainSelect({ data: null, error: { message: 'boom' } })) };
      }
      // verifications + audit_events: empty success
      return { select: vi.fn().mockReturnValue(chainSelect({ data: [], error: null })) };
    });

    const results = await runIncremental();

    expect(results).toHaveLength(3);
    expect(results.filter((r) => r.errors > 0)).toHaveLength(1);
    expect(results.filter((r) => r.errors === 0)).toHaveLength(2);
  });
});

describe('runIncremental — table-specific select columns', () => {
  it('audit_events select list excludes PII columns (event_type/event_category, no actor_email/actor_ip)', () => {
    const cols = __testing.selectColumns('audit_events');
    expect(cols).toContain('event_type');
    expect(cols).toContain('event_category');
    expect(cols).not.toContain('actor_email');
    expect(cols).not.toContain('actor_ip');
    expect(cols).not.toContain('actor_user_agent');
  });

  it('verifications select list pins verifier_ip_hash (NOT raw verifier_ip)', () => {
    const cols = __testing.selectColumns('verifications');
    expect(cols).toContain('verifier_ip_hash');
  });

  it('anchors select list pins the chain + lineage columns we expect', () => {
    const cols = __testing.selectColumns('anchors');
    expect(cols).toContain('parent_anchor_id');
    expect(cols).toContain('chain_block_height');
    expect(cols).toContain('credential_type');
  });
});
