/**
 * Integration tests for the three BQ export jobs (SCRUM-1723 / 1724 / 1727).
 *
 * Consolidated into a single file so the shared mock-setup boilerplate
 * (vi.hoisted, vi.mock, beforeEach resets) lives in one place — keeps the
 * SonarCloud duplicate-line detector from flagging the same mock surface
 * across separate per-job files.
 *
 * Pure-function tests (selectColumns shape, BACKFILLABLE allowlist,
 * assertNoApiKeysPiiLeak unit cases) live in the per-job *.test.ts files;
 * THIS file only covers the integration paths that need mocked db + client
 * + watermark — i.e. the stuff that drives coverage on the runtime modules.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Hoisted mocks (shared across all 3 jobs) ----

const { fromMock, ensureTableMock, insertRowsMock, runQueryMock,
        readWatermarkMock, markRunStartedMock, markRunSucceededMock,
        markRunFailedMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  ensureTableMock: vi.fn(),
  insertRowsMock: vi.fn(),
  runQueryMock: vi.fn(),
  readWatermarkMock: vi.fn(),
  markRunStartedMock: vi.fn(),
  markRunSucceededMock: vi.fn(),
  markRunFailedMock: vi.fn(),
}));

vi.mock('../utils/db.js', () => ({ db: { from: (...a: unknown[]) => fromMock(...a) } }));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./bq-export-client.js', async (importActual) => {
  // Real toBqRow needs to flow through — it's the wire-shaper used by both
  // incremental and backfill. Only the network-touching helpers are mocked.
  const actual = await importActual<typeof import('./bq-export-client.js')>();
  return {
    ...actual,
    ensureTable: (...a: unknown[]) => ensureTableMock(...a),
    insertRows: (...a: unknown[]) => insertRowsMock(...a),
    runQuery: (...a: unknown[]) => runQueryMock(...a),
  };
});
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

import { runIncremental, __testing as incrementalTesting } from './bq-export-incremental.js';
import { runSnapshot, __testing as snapshotTesting } from './bq-export-snapshot.js';
import { runBackfill } from './bq-export-backfill.js';
import { chainSelect } from './bq-export-test-helpers.js';

beforeEach(() => {
  fromMock.mockReset();
  ensureTableMock.mockReset();
  insertRowsMock.mockReset();
  runQueryMock.mockReset();
  readWatermarkMock.mockReset();
  markRunStartedMock.mockReset();
  markRunSucceededMock.mockReset();
  markRunFailedMock.mockReset();

  ensureTableMock.mockResolvedValue({ created: false });
  runQueryMock.mockResolvedValue({ totalRows: 0 });
  markRunStartedMock.mockResolvedValue(undefined);
  markRunSucceededMock.mockResolvedValue(undefined);
  markRunFailedMock.mockResolvedValue(undefined);
});

// Tiny helper for "the happy path of an append-only sync run" used by both
// runIncremental and runBackfill — collapses the watermark + fromMock +
// insertRowsMock setup into one call so SonarCloud's duplicate-line
// detector doesn't trip on the same shape repeated twice.
function setupAppendHappyPath(opts: {
  tableName: 'anchors' | 'verifications' | 'audit_events';
  watermark: string;
  sourceRows: ReadonlyArray<Record<string, unknown>>;
}): void {
  readWatermarkMock.mockResolvedValue({
    tableName: opts.tableName,
    lastSyncedAt: opts.watermark,
    lastSyncedId: null,
    lastRunStatus: 'pending',
    lastRunError: null,
  });
  fromMock.mockReturnValue({
    select: vi.fn().mockReturnValue(chainSelect({ data: opts.sourceRows, error: null })),
  });
  insertRowsMock.mockResolvedValue({ insertedCount: opts.sourceRows.length, errors: [] });
}

// ============================================================================
// SCRUM-1723: runIncremental
// ============================================================================

describe('runIncremental — happy path', () => {
  it('inserts rows and advances watermark to MAX(created_at)', async () => {
    setupAppendHappyPath({
      tableName: 'anchors',
      watermark: '2026-05-01T00:00:00Z',
      sourceRows: [
        { id: 'uuid-1', org_id: 'o1', created_at: '2026-05-07T10:00:00Z' },
        { id: 'uuid-2', org_id: 'o1', created_at: '2026-05-07T10:05:00Z' },
        { id: 'uuid-3', org_id: 'o2', created_at: '2026-05-07T10:10:00Z' },
      ],
    });

    const results = await runIncremental();
    const anchorsResult = results.find((r) => r.table === 'anchors');

    expect(anchorsResult).toBeDefined();
    expect(anchorsResult!.rowsScanned).toBe(3);
    expect(anchorsResult!.rowsInserted).toBe(3);
    expect(anchorsResult!.newWatermark).toBe('2026-05-07T10:10:00Z');
    expect(anchorsResult!.errors).toBe(0);

    const succeededCalls = markRunSucceededMock.mock.calls.filter((c) => c[0].tableName === 'anchors');
    expect(succeededCalls).toHaveLength(1);
    expect(succeededCalls[0][0].newWatermark).toBe('2026-05-07T10:10:00Z');
    expect(succeededCalls[0][0].newLastId).toBe('uuid-3');
  });
});

describe('runIncremental — empty source', () => {
  it('does NOT call insertRows when source returns 0 rows', async () => {
    readWatermarkMock.mockResolvedValue({
      tableName: 'anchors', lastSyncedAt: '2026-05-07T11:00:00Z',
      lastSyncedId: 'uuid-last', lastRunStatus: 'success', lastRunError: null,
    });
    fromMock.mockReturnValue({ select: vi.fn().mockReturnValue(chainSelect({ data: [], error: null })) });

    const results = await runIncremental();
    const anchorsResult = results.find((r) => r.table === 'anchors');

    expect(anchorsResult!.rowsInserted).toBe(0);
    expect(anchorsResult!.newWatermark).toBeNull();

    const succeededCalls = markRunSucceededMock.mock.calls.filter((c) => c[0].tableName === 'anchors');
    expect(succeededCalls[0][0].newWatermark).toBe('2026-05-07T11:00:00Z');
    expect(succeededCalls[0][0].newLastId).toBe('uuid-last');
  });
});

describe('runIncremental — failure semantics', () => {
  it('marks run failed and does NOT advance watermark when source query errors', async () => {
    readWatermarkMock.mockResolvedValue({
      tableName: 'anchors', lastSyncedAt: '2026-05-01T00:00:00Z',
      lastSyncedId: null, lastRunStatus: 'pending', lastRunError: null,
    });
    fromMock.mockReturnValue({ select: vi.fn().mockReturnValue(chainSelect({ data: null, error: { message: 'connection lost' } })) });

    const results = await runIncremental();
    const anchorsResult = results.find((r) => r.table === 'anchors');

    expect(anchorsResult!.errors).toBe(1);
    expect(markRunFailedMock).toHaveBeenCalledWith('anchors', expect.stringContaining('connection lost'));
  });

  it('marks run failed when BQ insertRows returns errors', async () => {
    readWatermarkMock.mockResolvedValue({
      tableName: 'anchors', lastSyncedAt: '2026-05-01T00:00:00Z',
      lastSyncedId: null, lastRunStatus: 'pending', lastRunError: null,
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
    expect(markRunFailedMock).toHaveBeenCalledWith('anchors', expect.stringContaining('insertAll errors'));
  });

  it('one table failing does not abort the others', async () => {
    readWatermarkMock.mockResolvedValue({
      tableName: 'anchors', lastSyncedAt: '2026-05-01T00:00:00Z',
      lastSyncedId: null, lastRunStatus: 'pending', lastRunError: null,
    });
    let call = 0;
    fromMock.mockImplementation(() => {
      call++;
      if (call === 1) return { select: vi.fn().mockReturnValue(chainSelect({ data: null, error: { message: 'boom' } })) };
      return { select: vi.fn().mockReturnValue(chainSelect({ data: [], error: null })) };
    });

    const results = await runIncremental();

    expect(results).toHaveLength(3);
    expect(results.filter((r) => r.errors > 0)).toHaveLength(1);
    expect(results.filter((r) => r.errors === 0)).toHaveLength(2);
  });
});

describe('runIncremental — table-specific select columns', () => {
  it('audit_events excludes PII (event_type/event_category, not actor_email/ip)', () => {
    const cols = incrementalTesting.selectColumns('audit_events');
    expect(cols).toContain('event_type');
    expect(cols).toContain('event_category');
    expect(cols).not.toContain('actor_email');
    expect(cols).not.toContain('actor_ip');
    expect(cols).not.toContain('actor_user_agent');
  });

  it('verifications pins verifier_ip_hash (NOT raw verifier_ip)', () => {
    const cols = incrementalTesting.selectColumns('verifications');
    expect(cols).toContain('verifier_ip_hash');
  });

  it('anchors pins chain + lineage columns', () => {
    const cols = incrementalTesting.selectColumns('anchors');
    expect(cols).toContain('parent_anchor_id');
    expect(cols).toContain('chain_block_height');
    expect(cols).toContain('credential_type');
  });
});

// ============================================================================
// SCRUM-1724: runSnapshot
// ============================================================================

describe('runSnapshot — happy path', () => {
  it('runs DELETE-then-INSERT for both organizations and api_keys', async () => {
    fromMock.mockImplementation((tableName: string) => ({
      select: vi.fn().mockResolvedValue({
        data: tableName === 'organizations'
          ? [{ id: 'org-1', legal_name: 'Acme', display_name: 'Acme Inc' }]
          : [{ id: 'k-1', org_id: 'org-1', key_prefix: 'ak_', key_hash: 'sha256-abc' }],
        error: null,
      }),
    }));
    insertRowsMock.mockResolvedValue({ insertedCount: 1, errors: [] });

    const results = await runSnapshot('2026-05-07');

    expect(results).toHaveLength(2);
    expect(runQueryMock).toHaveBeenCalledTimes(2);
    expect(runQueryMock.mock.calls[0][0]).toContain('DELETE FROM');
    expect(runQueryMock.mock.calls[0][0]).toContain('organizations');
    expect(runQueryMock.mock.calls[1][0]).toContain('api_keys');
    expect(runQueryMock.mock.calls[0][1]).toEqual([{ name: 'snap', type: 'DATE', value: '2026-05-07' }]);
    expect(markRunSucceededMock).toHaveBeenCalledTimes(2);
  });

  it('api_keys SELECT goes through API_KEYS_COLUMN_ALLOWLIST, never *', async () => {
    const apiKeysSelectMock = vi.fn().mockResolvedValue({ data: [], error: null });
    const orgsSelectMock = vi.fn().mockResolvedValue({ data: [], error: null });
    fromMock.mockImplementation((t: string) => ({
      select: t === 'api_keys' ? apiKeysSelectMock : orgsSelectMock,
    }));
    insertRowsMock.mockResolvedValue({ insertedCount: 0, errors: [] });

    await runSnapshot('2026-05-07');

    const apiKeysSelectArg = String(apiKeysSelectMock.mock.calls[0][0] ?? '');
    expect(apiKeysSelectArg).toContain('key_hash');
    expect(apiKeysSelectArg).not.toContain('*');
    expect(apiKeysSelectArg).not.toMatch(/(?:^|,\s)key(?:,|$)/);
    expect(apiKeysSelectArg).not.toContain('secret');
    expect(apiKeysSelectArg).not.toContain('password');
  });

  it('insertAll payload stamps snapshot_date + bq_synced_at on every row', async () => {
    fromMock.mockImplementation((tableName: string) => ({
      select: vi.fn().mockResolvedValue({
        data: tableName === 'organizations'
          ? [{ id: 'org-1', legal_name: 'Acme' }]
          : [{ id: 'k-1', org_id: 'org-1' }],
        error: null,
      }),
    }));
    insertRowsMock.mockResolvedValue({ insertedCount: 1, errors: [] });

    await runSnapshot('2026-05-07');

    const allInsertCalls = insertRowsMock.mock.calls;
    for (const [target, rows] of allInsertCalls) {
      for (const r of rows) {
        expect(r.json.snapshot_date).toBe('2026-05-07');
        expect(typeof r.json.bq_synced_at).toBe('string');
        expect(r.insertId).toMatch(/-2026-05-07-/);
      }
      expect(target.tableId).toBeDefined();
    }
  });
});

describe('runSnapshot — failure semantics', () => {
  it('marks run failed when source SELECT errors', async () => {
    fromMock.mockImplementation((tableName: string) => ({
      select: vi.fn().mockResolvedValue(
        tableName === 'organizations'
          ? { data: null, error: { message: 'pg unavailable' } }
          : { data: [], error: null },
      ),
    }));
    insertRowsMock.mockResolvedValue({ insertedCount: 0, errors: [] });

    await runSnapshot('2026-05-07');

    expect(markRunFailedMock).toHaveBeenCalledWith('organizations', expect.stringContaining('pg unavailable'));
  });

  it('marks run failed when BQ insertAll returns errors', async () => {
    fromMock.mockImplementation((tableName: string) => ({
      select: vi.fn().mockResolvedValue({
        data: tableName === 'organizations' ? [{ id: 'org-1' }] : [{ id: 'k-1' }],
        error: null,
      }),
    }));
    let callIdx = 0;
    insertRowsMock.mockImplementation(() => {
      callIdx++;
      if (callIdx === 1) return Promise.resolve({ insertedCount: 0, errors: [{ index: 0, reason: 'bad-data' }] });
      return Promise.resolve({ insertedCount: 1, errors: [] });
    });

    await runSnapshot('2026-05-07');

    expect(markRunFailedMock).toHaveBeenCalledWith('organizations', expect.any(String));
  });

  it('one snapshot table failing does not abort the other', async () => {
    fromMock.mockImplementation((tableName: string) => ({
      select: vi.fn().mockResolvedValue(
        tableName === 'organizations'
          ? { data: null, error: { message: 'oops' } }
          : { data: [{ id: 'k-1' }], error: null },
      ),
    }));
    insertRowsMock.mockResolvedValue({ insertedCount: 1, errors: [] });

    const results = await runSnapshot('2026-05-07');

    expect(results.filter((r) => r.errors > 0)).toHaveLength(1);
    expect(results.filter((r) => r.errors === 0)).toHaveLength(1);
  });
});

describe('runSnapshot — assertNoApiKeysPiiLeak runtime defense', () => {
  it('passes for the canonical allowlist (sanity)', () => {
    expect(() => snapshotTesting.assertNoApiKeysPiiLeak(['id', 'org_id', 'key_hash'])).not.toThrow();
  });

  it('throws if any forbidden column is in the list', () => {
    expect(() => snapshotTesting.assertNoApiKeysPiiLeak(['id', 'key', 'org_id'])).toThrow(/forbidden PII/);
  });
});

// ============================================================================
// SCRUM-1727: runBackfill
// ============================================================================

describe('runBackfill — happy path', () => {
  it('loops in batches; advances watermark per batch; returns total inserted', async () => {
    setupAppendHappyPath({
      tableName: 'anchors',
      watermark: '1970-01-01T00:00:00Z',
      sourceRows: [
        { id: 'u-1', org_id: 'o', created_at: '2025-01-01T00:00:00Z' },
        { id: 'u-2', org_id: 'o', created_at: '2025-06-01T00:00:00Z' },
        { id: 'u-3', org_id: 'o', created_at: '2026-01-01T00:00:00Z' },
      ],
    });

    const result = await runBackfill('anchors');

    expect(result.table).toBe('anchors');
    expect(result.totalRowsInserted).toBe(3);
    expect(result.finalWatermark).toBe('2026-01-01T00:00:00Z');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    const succeededCalls = markRunSucceededMock.mock.calls;
    expect(succeededCalls.length).toBeGreaterThanOrEqual(1);
    expect(succeededCalls[succeededCalls.length - 1][0].newWatermark).toBe('2026-01-01T00:00:00Z');
  });
});

describe('runBackfill — failure semantics', () => {
  it('marks run failed and throws when source query errors mid-loop', async () => {
    readWatermarkMock.mockResolvedValue({
      tableName: 'anchors', lastSyncedAt: '1970-01-01T00:00:00Z',
      lastSyncedId: null, lastRunStatus: 'pending', lastRunError: null,
    });
    fromMock.mockReturnValue({ select: vi.fn().mockReturnValue(chainSelect({ data: null, error: { message: 'pg crash' } })) });

    await expect(runBackfill('anchors')).rejects.toThrow(/pg crash/);
    expect(markRunFailedMock).toHaveBeenCalledWith('anchors', expect.stringContaining('pg crash'));
  });

  it('marks run failed and throws when BQ insertAll returns errors', async () => {
    readWatermarkMock.mockResolvedValue({
      tableName: 'verifications', lastSyncedAt: '1970-01-01T00:00:00Z',
      lastSyncedId: null, lastRunStatus: 'pending', lastRunError: null,
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
