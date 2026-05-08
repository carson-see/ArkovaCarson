/**
 * BigQuery REST client wrapper tests.
 *
 * Mocks fetch + gcp-auth's access-token getter; asserts the client builds
 * the right URLs, sends the right payloads, surfaces HTTP failures, and
 * handles the BQ-specific shape of `tabledata.insertAll` responses
 * (success + partial errors + total failure).
 *
 * Drives coverage for bq-export-client.ts to ~100%.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/gcp-auth.js', () => ({
  getGcpAccessToken: vi.fn().mockResolvedValue('mock-access-token'),
}));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { ensureTable, insertRows, runQuery } from './bq-export-client.js';
import { BQ_TABLES } from './bq-export-schemas.js';

// Set global fetch mock per-test
const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = fetchMock;
});

// Returns a minimal Response-shaped object. Not annotating with `Response`
// because the worker's tsconfig (lib=ES2022) doesn't include DOM lib;
// `fetch` baseline already has this same caveat.
function mockFetchResponse(opts: { status: number; body?: unknown }) {
  const text = opts.body === undefined ? '' : JSON.stringify(opts.body);
  return {
    ok: opts.status >= 200 && opts.status < 300,
    status: opts.status,
    statusText: '',
    text: () => Promise.resolve(text),
  };
}

describe('ensureTable', () => {
  it('returns {created: false} when table already exists (200 OK on GET)', async () => {
    fetchMock.mockResolvedValueOnce(mockFetchResponse({ status: 200, body: { id: 'arkova1:arkova_analytics.anchors' } }));

    const result = await ensureTable(BQ_TABLES.anchors);

    expect(result.created).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('/projects/arkova1/datasets/arkova_analytics/tables/anchors');
  });

  it('creates the table when GET returns 404', async () => {
    fetchMock
      .mockResolvedValueOnce(mockFetchResponse({ status: 404, body: { error: { code: 404 } } }))
      .mockResolvedValueOnce(mockFetchResponse({ status: 200, body: { id: 'arkova1:arkova_analytics.anchors' } }));

    const result = await ensureTable(BQ_TABLES.anchors);

    expect(result.created).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const createCall = fetchMock.mock.calls[1];
    expect(createCall[1].method).toBe('POST');
    const body = JSON.parse(createCall[1].body);
    expect(body.tableReference.tableId).toBe('anchors');
    expect(body.timePartitioning.field).toBe('created_at');
    expect(body.clustering.fields).toEqual(['org_id', 'status']);
  });

  it('forwards audit_events 7-year partitionExpirationMs in the create call', async () => {
    fetchMock
      .mockResolvedValueOnce(mockFetchResponse({ status: 404 }))
      .mockResolvedValueOnce(mockFetchResponse({ status: 200, body: {} }));

    await ensureTable(BQ_TABLES.audit_events);

    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    // 2555 days * 86400s * 1000ms = 220,752,000,000ms
    expect(body.timePartitioning.expirationMs).toBe('220752000000');
  });

  it('throws when GET returns a non-404 error', async () => {
    fetchMock.mockResolvedValueOnce(mockFetchResponse({ status: 500, body: { error: 'oops' } }));

    await expect(ensureTable(BQ_TABLES.anchors)).rejects.toThrow(/BigQuery API error: 500/);
  });

  it('throws when CREATE returns an error', async () => {
    fetchMock
      .mockResolvedValueOnce(mockFetchResponse({ status: 404 }))
      .mockResolvedValueOnce(mockFetchResponse({ status: 403, body: { error: { code: 403 } } }));

    await expect(ensureTable(BQ_TABLES.anchors)).rejects.toThrow(/BigQuery API error: 403/);
  });

  it('attaches Bearer token from gcp-auth on every request', async () => {
    fetchMock.mockResolvedValueOnce(mockFetchResponse({ status: 200, body: {} }));

    await ensureTable(BQ_TABLES.anchors);

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers.Authorization).toBe('Bearer mock-access-token');
    expect(headers['Content-Type']).toBe('application/json');
  });
});

describe('insertRows', () => {
  it('returns {insertedCount: 0, errors: []} for empty rows (no fetch call)', async () => {
    const result = await insertRows(BQ_TABLES.anchors, []);

    expect(result.insertedCount).toBe(0);
    expect(result.errors).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('inserts rows successfully (no insertErrors in response)', async () => {
    fetchMock.mockResolvedValueOnce(mockFetchResponse({ status: 200, body: { kind: 'bigquery#tableDataInsertAllResponse' } }));

    const rows = [
      { insertId: 'anchors-uuid-1', json: { id: 'uuid-1', org_id: 'o1', created_at: '2026-05-07T10:00:00Z' } },
      { insertId: 'anchors-uuid-2', json: { id: 'uuid-2', org_id: 'o1', created_at: '2026-05-07T10:01:00Z' } },
    ];

    const result = await insertRows(BQ_TABLES.anchors, rows);

    expect(result.insertedCount).toBe(2);
    expect(result.errors).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const callBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(callBody.kind).toBe('bigquery#tableDataInsertAllRequest');
    expect(callBody.skipInvalidRows).toBe(false);
    expect(callBody.ignoreUnknownValues).toBe(false);
    expect(callBody.rows).toHaveLength(2);
    expect(callBody.rows[0].insertId).toBe('anchors-uuid-1');
    expect(callBody.rows[0].json.id).toBe('uuid-1');
  });

  it('reports per-row errors when BQ returns insertErrors', async () => {
    fetchMock.mockResolvedValueOnce(
      mockFetchResponse({
        status: 200,
        body: {
          kind: 'bigquery#tableDataInsertAllResponse',
          insertErrors: [
            { index: 1, errors: [{ reason: 'invalid', message: 'bad date' }] },
          ],
        },
      }),
    );

    const result = await insertRows(BQ_TABLES.anchors, [
      { insertId: 'a-1', json: { id: '1' } },
      { insertId: 'a-2', json: { id: '2' } },
    ]);

    expect(result.insertedCount).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].index).toBe(1);
    expect(result.errors[0].reason).toContain('invalid');
    expect(result.errors[0].reason).toContain('bad date');
  });

  it('throws on HTTP error (non-2xx)', async () => {
    fetchMock.mockResolvedValueOnce(mockFetchResponse({ status: 401, body: { error: 'auth' } }));

    await expect(insertRows(BQ_TABLES.anchors, [{ insertId: 'a-1', json: { id: '1' } }])).rejects.toThrow(/BigQuery API error: 401/);
  });
});

describe('runQuery', () => {
  it('sends a parameterized query with NAMED parameters', async () => {
    fetchMock.mockResolvedValueOnce(
      mockFetchResponse({ status: 200, body: { kind: 'bigquery#queryResponse', numDmlAffectedRows: '42' } }),
    );

    const result = await runQuery(
      'DELETE FROM `arkova1.arkova_analytics.organizations` WHERE snapshot_date = @snap',
      [{ name: 'snap', type: 'DATE', value: '2026-05-07' }],
    );

    expect(result.totalRows).toBe(42);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.useLegacySql).toBe(false);
    expect(body.location).toBe('US');
    expect(body.parameterMode).toBe('NAMED');
    expect(body.queryParameters[0].name).toBe('snap');
    expect(body.queryParameters[0].parameterType.type).toBe('DATE');
    expect(body.queryParameters[0].parameterValue.value).toBe('2026-05-07');
  });

  it('uses POSITIONAL parameter mode when no parameters are provided', async () => {
    fetchMock.mockResolvedValueOnce(mockFetchResponse({ status: 200, body: {} }));

    await runQuery('SELECT 1');

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.parameterMode).toBe('POSITIONAL');
    expect(body.queryParameters).toEqual([]);
  });

  it('falls back to totalRows when numDmlAffectedRows is absent', async () => {
    fetchMock.mockResolvedValueOnce(mockFetchResponse({ status: 200, body: { totalRows: '7' } }));

    const result = await runQuery('SELECT * FROM foo');
    expect(result.totalRows).toBe(7);
  });

  it('returns 0 when neither field is present', async () => {
    fetchMock.mockResolvedValueOnce(mockFetchResponse({ status: 200, body: {} }));

    const result = await runQuery('CREATE TABLE foo (x INT64)');
    expect(result.totalRows).toBe(0);
  });

  it('throws on HTTP error', async () => {
    fetchMock.mockResolvedValueOnce(mockFetchResponse({ status: 400, body: { error: { message: 'bad query' } } }));

    await expect(runQuery('not valid sql')).rejects.toThrow(/BigQuery API error: 400/);
  });
});
