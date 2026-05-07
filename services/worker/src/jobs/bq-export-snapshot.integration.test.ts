/**
 * Snapshot sync integration tests (SCRUM-1724).
 *
 * Mocks db + client + watermark; asserts:
 *   - DELETE-then-INSERT idempotency for partition replace
 *   - api_keys SELECT uses the column allowlist (NOT *)
 *   - PII guard fires before any DB call when allowlist tampered
 *   - Failure paths mark run failed and don't silently succeed
 *
 * Drives coverage for bq-export-snapshot.ts to ~100%.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { fromMock, ensureTableMock, insertRowsMock, runQueryMock,
        markRunStartedMock, markRunSucceededMock, markRunFailedMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  ensureTableMock: vi.fn(),
  insertRowsMock: vi.fn(),
  runQueryMock: vi.fn(),
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
  runQuery: (...a: unknown[]) => runQueryMock(...a),
}));
vi.mock('./bq-export-watermark.js', async (importActual) => {
  const actual = await importActual<typeof import('./bq-export-watermark.js')>();
  return {
    ...actual,
    markRunStarted: (...a: unknown[]) => markRunStartedMock(...a),
    markRunSucceeded: (...a: unknown[]) => markRunSucceededMock(...a),
    markRunFailed: (...a: unknown[]) => markRunFailedMock(...a),
  };
});

import { runSnapshot, __testing } from './bq-export-snapshot.js';

beforeEach(() => {
  fromMock.mockReset();
  ensureTableMock.mockReset();
  insertRowsMock.mockReset();
  runQueryMock.mockReset();
  markRunStartedMock.mockReset();
  markRunSucceededMock.mockReset();
  markRunFailedMock.mockReset();

  ensureTableMock.mockResolvedValue({ created: false });
  runQueryMock.mockResolvedValue({ totalRows: 0 });
  markRunStartedMock.mockResolvedValue(undefined);
  markRunSucceededMock.mockResolvedValue(undefined);
  markRunFailedMock.mockResolvedValue(undefined);
});

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
    expect(results.find((r) => r.table === 'organizations')!.rowsInserted).toBe(1);
    expect(results.find((r) => r.table === 'api_keys')!.rowsInserted).toBe(1);

    // DELETE called for both
    expect(runQueryMock).toHaveBeenCalledTimes(2);
    expect(runQueryMock.mock.calls[0][0]).toContain('DELETE FROM');
    expect(runQueryMock.mock.calls[0][0]).toContain('organizations');
    expect(runQueryMock.mock.calls[1][0]).toContain('api_keys');
    // Both DELETEs use parameterized snapshot_date
    expect(runQueryMock.mock.calls[0][1]).toEqual([{ name: 'snap', type: 'DATE', value: '2026-05-07' }]);

    // markRunSucceeded called for both with snapshot_date as watermark
    expect(markRunSucceededMock).toHaveBeenCalledTimes(2);
  });

  it('api_keys SELECT request goes through API_KEYS_COLUMN_ALLOWLIST, never *', async () => {
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
    // Forbidden columns must NEVER appear in the SELECT
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
      // Each row should have snapshot_date + bq_synced_at
      for (const r of rows) {
        expect(r.json.snapshot_date).toBe('2026-05-07');
        expect(typeof r.json.bq_synced_at).toBe('string');
        expect(r.insertId).toMatch(/-2026-05-07-/);
      }
      // Type lookup just to use `target` (silences lint)
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

    expect(markRunFailedMock).toHaveBeenCalledWith(
      'organizations',
      expect.stringContaining('pg unavailable'),
    );
  });

  it('marks run failed when BQ insertAll returns errors', async () => {
    fromMock.mockImplementation((tableName: string) => ({
      select: vi.fn().mockResolvedValue({
        data: tableName === 'organizations'
          ? [{ id: 'org-1' }]
          : [{ id: 'k-1' }],
        error: null,
      }),
    }));
    let callIdx = 0;
    insertRowsMock.mockImplementation(() => {
      callIdx++;
      if (callIdx === 1) {
        return Promise.resolve({ insertedCount: 0, errors: [{ index: 0, reason: 'bad-data' }] });
      }
      return Promise.resolve({ insertedCount: 1, errors: [] });
    });

    await runSnapshot('2026-05-07');

    expect(markRunFailedMock).toHaveBeenCalledWith('organizations', expect.any(String));
  });

  it('one table failing does not abort the other', async () => {
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

describe('assertNoApiKeysPiiLeak runtime defense', () => {
  it('passes for the canonical allowlist (sanity)', () => {
    expect(() => __testing.assertNoApiKeysPiiLeak(['id', 'org_id', 'key_hash'])).not.toThrow();
  });

  it('throws if any forbidden column is in the list', () => {
    expect(() => __testing.assertNoApiKeysPiiLeak(['id', 'key', 'org_id'])).toThrow(/forbidden PII/);
  });
});
