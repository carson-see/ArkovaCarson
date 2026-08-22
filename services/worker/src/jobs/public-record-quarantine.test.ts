/**
 * Unit tests for the public-record anchor-insert quarantine
 * (defense-in-depth for the 2026-08-17 poison-record incident).
 *
 * A row whose anchor insert fails serially with a NON-23505 error must not be
 * retried forever at the head of the `created_at`-ascending queue. Failures
 * are counted in `public_records.metadata`; at the threshold the row gets a
 * `anchor_insert_quarantined_at` marker and every fetch path excludes it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('../utils/logger.js', () => ({ logger: mockLogger }));

import {
  ANCHOR_INSERT_FAILURE_COUNT_KEY,
  ANCHOR_INSERT_LAST_CODE_KEY,
  ANCHOR_INSERT_QUARANTINE_FILTER_COLUMN,
  ANCHOR_INSERT_QUARANTINE_THRESHOLD,
  ANCHOR_INSERT_QUARANTINED_AT_KEY,
  pipelineSourceKey,
  quarantineFailedSerialInserts,
  type SerialInsertFailure,
} from './public-record-quarantine.js';

function makeClient() {
  const eqCalls: Array<{ payload: Record<string, unknown>; id: string }> = [];
  let updateError: unknown = null;
  const update = vi.fn((payload: Record<string, unknown>) => ({
    eq: vi.fn(async (_col: string, id: string) => {
      eqCalls.push({ payload, id });
      return { error: updateError };
    }),
  }));
  const from = vi.fn((table: string) => {
    if (table !== 'public_records') throw new Error(`unexpected table ${table}`);
    return { update };
  });
  return {
    client: { from },
    update,
    eqCalls,
    setUpdateError(err: unknown) {
      updateError = err;
    },
  };
}

function failureFor(record: { source: string; source_id: string; content_hash: string }): SerialInsertFailure {
  return {
    fingerprint: record.content_hash,
    sourceKey: pipelineSourceKey(record.source, record.source_id),
    pgCode: 'PGRST102',
  };
}

function makeRecord(metadata: Record<string, unknown> = {}) {
  return {
    id: 'record-poison',
    source: 'openalex',
    source_id: 'W7159838936',
    content_hash: '18ce56cd'.repeat(8),
    metadata,
  };
}

function recordsMap(record: ReturnType<typeof makeRecord>) {
  return new Map([[pipelineSourceKey(record.source, record.source_id), record]]);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('quarantineFailedSerialInserts', () => {
  it('threshold is a positive integer and the filter column targets the quarantine key', () => {
    expect(ANCHOR_INSERT_QUARANTINE_THRESHOLD).toBeGreaterThanOrEqual(2);
    // Pinned literal: the fetch-path tests in publicRecordAnchor.test.ts and
    // pipelineThroughputMonitor.test.ts assert this exact string reaches
    // PostgREST — if the key changes, change it everywhere or rows quarantine
    // under one name and get fetched under another.
    expect(ANCHOR_INSERT_QUARANTINED_AT_KEY).toBe('anchor_insert_quarantined_at');
    expect(ANCHOR_INSERT_QUARANTINE_FILTER_COLUMN).toBe('metadata->anchor_insert_quarantined_at');
  });

  it('first failure increments the counter WITHOUT quarantining', async () => {
    const record = makeRecord({ abstract: 'x' });
    const { client, eqCalls } = makeClient();

    const result = await quarantineFailedSerialInserts(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client as any,
      [failureFor(record)],
      recordsMap(record),
    );

    expect(result).toEqual({ counted: 1, quarantined: 0 });
    expect(eqCalls).toHaveLength(1);
    expect(eqCalls[0].id).toBe('record-poison');
    const metadata = eqCalls[0].payload.metadata as Record<string, unknown>;
    expect(metadata[ANCHOR_INSERT_FAILURE_COUNT_KEY]).toBe(1);
    expect(metadata[ANCHOR_INSERT_LAST_CODE_KEY]).toBe('PGRST102');
    expect(metadata[ANCHOR_INSERT_QUARANTINED_AT_KEY]).toBeUndefined();
    expect(metadata.abstract).toBe('x'); // pre-existing metadata preserved
    // Structured, searchable marker for the failure event.
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'public_record_anchor_insert_failure',
        recordId: 'record-poison',
        pgCode: 'PGRST102',
        failureCount: 1,
      }),
      expect.any(String),
    );
  });

  it('reaching the threshold sets the quarantine marker and logs the quarantine event', async () => {
    const record = makeRecord({
      [ANCHOR_INSERT_FAILURE_COUNT_KEY]: ANCHOR_INSERT_QUARANTINE_THRESHOLD - 1,
    });
    const { client, eqCalls } = makeClient();

    const result = await quarantineFailedSerialInserts(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client as any,
      [failureFor(record)],
      recordsMap(record),
    );

    expect(result).toEqual({ counted: 1, quarantined: 1 });
    const metadata = eqCalls[0].payload.metadata as Record<string, unknown>;
    expect(metadata[ANCHOR_INSERT_FAILURE_COUNT_KEY]).toBe(ANCHOR_INSERT_QUARANTINE_THRESHOLD);
    expect(typeof metadata[ANCHOR_INSERT_QUARANTINED_AT_KEY]).toBe('string');
    expect(Number.isNaN(Date.parse(metadata[ANCHOR_INSERT_QUARANTINED_AT_KEY] as string))).toBe(false);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'public_record_anchor_quarantined',
        recordId: 'record-poison',
        failureCount: ANCHOR_INSERT_QUARANTINE_THRESHOLD,
      }),
      expect.any(String),
    );
  });

  it('an unresolvable sourceKey is logged and skipped — never throws', async () => {
    const record = makeRecord();
    const { client, eqCalls } = makeClient();

    const result = await quarantineFailedSerialInserts(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client as any,
      [{ fingerprint: 'ff'.repeat(32), sourceKey: pipelineSourceKey('edgar', 'UNKNOWN'), pgCode: null }],
      recordsMap(record),
    );

    expect(result).toEqual({ counted: 0, quarantined: 0 });
    expect(eqCalls).toHaveLength(0);
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('a failed metadata update is logged and does not throw (best-effort defense)', async () => {
    const record = makeRecord();
    const failing = makeClient();
    failing.setUpdateError({ code: '57014', message: 'canceling statement' });

    await expect(
      quarantineFailedSerialInserts(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        failing.client as any,
        [failureFor(record)],
        recordsMap(record),
      ),
    ).resolves.toEqual({ counted: 0, quarantined: 0 });
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it('pipelineSourceKey cannot collide across source/source_id concatenation', () => {
    // 'a' + 'bc' vs 'ab' + 'c' must NOT produce the same key.
    expect(pipelineSourceKey('a', 'bc')).not.toBe(pipelineSourceKey('ab', 'c'));
  });
});
