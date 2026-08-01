/**
 * Regression tests for the public-record anchoring ROLLBACK path.
 *
 * Sibling of the 2026-07-29 → 2026-08-01 production incident fixed in
 * `fix(anchoring): PostgREST .in() filter width killed public-record anchoring
 * for 70h`. That fix repointed `fetchAnchorRows` and `claimPendingPipelineAnchors`
 * at `POSTGREST_IN_FILTER_CHUNK`, but `revertClaimedAnchors` — the compensating
 * write that returns BROADCASTING anchors to PENDING when the chain submission
 * throws — was still chunking its `.in('id', chunk)` filter by
 * `POSTGREST_ROW_LIMIT` (1,000). At 1,000 UUIDs the encoded `in.(...)` value is
 * ~38 KB, PostgREST answers 400 Bad Request, and the loop only logs and moves
 * on, so the entire rollback no-ops.
 *
 * The anchors are NOT lost: `recover_stuck_broadcasts` (migration `0358`) resets
 * `BROADCASTING` anchors with a NULL `chain_tx_id`, no PENDING/HELD
 * `anchor_txid_journal` row, and a stale `updated_at` — which is exactly this
 * cohort. The cost is a head-of-line stall until that recovery pass runs, during
 * which the batch re-reads the same oldest-first records, partitions the
 * BROADCASTING rows nowhere, and reports "no new pending" with HTTP 200.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  POSTGREST_IN_FILTER_CHUNK,
  POSTGREST_URL_FILTER_BUDGET_BYTES,
} from '../anchor-batching.js';

const { mockRpc, mockSubmitFingerprint, mockLogger, mockAnchorProofsUpsert } = vi.hoisted(() => ({
  mockRpc: vi.fn(),
  mockSubmitFingerprint: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  mockAnchorProofsUpsert: vi.fn().mockResolvedValue({ error: null }),
}));

vi.mock('../../config.js', () => ({
  config: {
    logLevel: 'info',
    nodeEnv: 'test',
    useMocks: true,
    enableProdNetworkAnchoring: false,
    bitcoinNetwork: 'signet',
    batchAnchorMaxSize: 10_000,
  },
}));

vi.mock('../../utils/logger.js', () => ({ logger: mockLogger }));

vi.mock('../../utils/db.js', () => ({
  db: {},
  withDbTimeout: vi.fn((operation: () => Promise<unknown>) => operation()),
}));

vi.mock('../../chain/client.js', () => ({
  getInitializedChainClient: () => ({ submitFingerprint: mockSubmitFingerprint }),
  getChainClientAsync: () => Promise.resolve({ submitFingerprint: mockSubmitFingerprint }),
}));

vi.mock('../../utils/anchorProofs.js', () => ({ upsertAnchorProofs: mockAnchorProofsUpsert }));

/** UUID-shaped ids, so the measured filter width matches the real wire format. */
function anchorUuid(i: number): string {
  return `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
}

/** The exact query-string value PostgREST receives for one `.in('id', ids)` chunk. */
function encodedInFilterBytes(ids: string[]): number {
  return encodeURIComponent(`in.(${ids.join(',')})`).length;
}

/**
 * Mock Supabase wired for a batch that claims `recordCount` anchors and then
 * fails the chain submission, forcing the revert path. Records the id array of
 * every `anchors.update({ status: 'PENDING' }).in('id', …)` call.
 */
function makeRevertMock(recordCount: number, options: { revertError?: unknown } = {}) {
  const revertChunks: string[][] = [];

  // Single source. The job fans out across four priority sources in parallel; a
  // mock that returns the same rows for every source would inflate the record
  // set 4x and let the downstream dedup hide accounting bugs, so `eq('source')`
  // is honoured here and every other source returns empty.
  const SOURCE = 'edgar';
  const records = Array.from({ length: recordCount }, (_, i) => ({
    id: `record-${i}`,
    content_hash: i.toString(16).padStart(64, '0'),
    metadata: {},
    source: SOURCE,
    source_id: `${SOURCE}-${i}`,
    source_url: `https://example.com/${SOURCE}/${i}`,
    record_type: 'filing',
    title: `Test Record ${i}`,
  }));

  const anchorResults = records.map((r, i) => ({ id: anchorUuid(i), fingerprint: r.content_hash }));
  const anchorByFingerprint = new Map(anchorResults.map((a) => [a.fingerprint, a]));
  const anchorRows = anchorResults.map((a) => ({
    id: a.id,
    fingerprint: a.fingerprint,
    status: 'PENDING',
    chain_tx_id: null,
    metadata: {},
  }));
  const claimedRows = anchorRows.map((a) => ({ ...a, status: 'BROADCASTING' }));

  mockRpc.mockImplementation((fnName: string, args?: { p_anchors?: Array<{ fingerprint: string }> }) => {
    if (fnName === 'get_flag') return Promise.resolve({ data: true });
    if (fnName === 'batch_insert_anchors') {
      // Return only the anchors for the chunk actually passed in — returning the
      // full set for every chunk would multiply createdAnchors and, again, let
      // dedup mask a real over-count.
      const requested = args?.p_anchors ?? [];
      return Promise.resolve({
        data: requested
          .map((a) => anchorByFingerprint.get(a.fingerprint))
          .filter((a): a is { id: string; fingerprint: string } => Boolean(a)),
      });
    }
    if (fnName === 'link_public_records_to_anchors') {
      return Promise.resolve({ data: { records_updated: 0 } });
    }
    return Promise.resolve({ data: null });
  });

  const anchorsSelectByIds = {
    // `fetchAnchorRows` chunks its own reads; return the subset it asked for so
    // the row count downstream matches the claim.
    in: vi.fn((_column: string, ids: string[]) => ({
      is: vi.fn().mockResolvedValue({
        data: anchorRows.filter((row) => ids.includes(row.id)),
        error: null,
      }),
    })),
  };

  const anchorsBroadcastingUpdate = {
    in: vi.fn((_column: string, ids: string[]) => ({
      eq: vi.fn(() => ({
        select: vi.fn().mockResolvedValue({
          data: claimedRows.filter((row) => ids.includes(row.id)),
          error: null,
        }),
      })),
    })),
  };

  const anchorsPendingUpdate = {
    in: vi.fn((_column: string, ids: string[]) => {
      revertChunks.push([...ids]);
      return { eq: vi.fn().mockResolvedValue({ error: options.revertError ?? null }) };
    }),
  };

  const publicRecordsSelect = () => {
    const chain: Record<string, unknown> = {};
    let selectedSource: string | null = null;
    let excluded = false;
    chain.is = vi.fn(() => chain);
    chain.eq = vi.fn((column: string, value: string) => {
      if (column === 'source') selectedSource = value;
      return chain;
    });
    chain.not = vi.fn(() => { excluded = true; return chain; });
    chain.order = vi.fn(() => chain);
    chain.range = vi.fn((from: number, to: number) =>
      Promise.resolve({
        data: excluded || selectedSource !== SOURCE ? [] : records.slice(from, to + 1),
        error: null,
      }),
    );
    chain.limit = vi.fn(() => Promise.resolve({ data: [], error: null }));
    return chain;
  };

  const client = {
    rpc: mockRpc,
    from: vi.fn((table: string) => {
      if (table === 'profiles') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn().mockResolvedValue({
                data: { id: 'admin-user-id', org_id: 'admin-org-id' },
                error: null,
              }),
            })),
          })),
        };
      }
      if (table === 'anchors') {
        return {
          select: vi.fn(() => anchorsSelectByIds),
          update: vi.fn((payload: Record<string, unknown>) =>
            payload.status === 'BROADCASTING' ? anchorsBroadcastingUpdate : anchorsPendingUpdate,
          ),
        };
      }
      if (table === 'anchor_proofs') return { upsert: mockAnchorProofsUpsert };
      if (table === 'public_records') return { select: vi.fn(publicRecordsSelect) };
      return { select: vi.fn(publicRecordsSelect) };
    }),
  };

  return { client, revertChunks };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAnchorProofsUpsert.mockResolvedValue({ error: null });
});

describe('publicRecordAnchor — revert path in-filter width', () => {
  /** Wide enough to need several chunks, small enough to stay a fast unit test. */
  const RECORD_COUNT = POSTGREST_IN_FILTER_CHUNK * 3 + 7;

  it('reverts claimed anchors in chunks that fit the PostgREST URL budget', async () => {
    const { client, revertChunks } = makeRevertMock(RECORD_COUNT);
    mockSubmitFingerprint.mockRejectedValue(new Error('chain submission failed'));

    const { processPublicRecordAnchoring } = await import('../publicRecordAnchor.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await processPublicRecordAnchoring(client as any);

    expect(result.txId).toBeNull();
    expect(result.claimed).toBe(RECORD_COUNT);

    // Every claimed anchor must be handed to a revert call exactly once...
    expect(revertChunks.flat()).toHaveLength(RECORD_COUNT);
    expect(new Set(revertChunks.flat()).size).toBe(RECORD_COUNT);

    // ...no single call may exceed what PostgREST will accept in a URL — before
    // the fix this was one 1,000-id chunk per 1,000 anchors, ~38 KB of query
    // string and a 400 on every chunk...
    for (const chunk of revertChunks) {
      expect(encodedInFilterBytes(chunk)).toBeLessThan(POSTGREST_URL_FILTER_BUDGET_BYTES);
    }

    // ...and the chunking must be exactly POSTGREST_IN_FILTER_CHUNK-wide. An
    // upper bound alone would also accept a degenerate one-id-per-call loop,
    // which is safe but would make a 607-anchor rollback 607 round trips.
    expect(revertChunks.map((chunk) => chunk.length)).toEqual([
      POSTGREST_IN_FILTER_CHUNK,
      POSTGREST_IN_FILTER_CHUNK,
      POSTGREST_IN_FILTER_CHUNK,
      RECORD_COUNT - POSTGREST_IN_FILTER_CHUNK * 3,
    ]);
  }, 30_000);

  it('reports the failed id count and names the recovery path when a chunk 400s', async () => {
    const { client, revertChunks } = makeRevertMock(RECORD_COUNT, {
      revertError: { message: 'Bad Request' },
    });
    mockSubmitFingerprint.mockRejectedValue(new Error('chain submission failed'));

    const { processPublicRecordAnchoring } = await import('../publicRecordAnchor.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await processPublicRecordAnchoring(client as any);

    // A failing chunk must not abort the loop — every chunk is still attempted.
    expect(revertChunks.flat()).toHaveLength(RECORD_COUNT);

    // One aggregate line carrying the id count, pointing at the automatic
    // recovery path rather than implying manual intervention.
    const aggregate = mockLogger.error.mock.calls.find(
      ([, message]) => typeof message === 'string' && message.includes('left in BROADCASTING'),
    );
    expect(aggregate).toBeDefined();
    expect(aggregate?.[0]).toMatchObject({ failed: RECORD_COUNT, attempted: RECORD_COUNT });
    expect(aggregate?.[1]).toContain('recover_stuck_broadcasts');

    // The caller surfaces the failure alongside the chain error instead of
    // discarding it — the silent-success shape is what hid the 70h outage.
    const submissionFailure = mockLogger.error.mock.calls.find(
      ([, message]) => typeof message === 'string' && message.includes('chain submission failed'),
    );
    expect(submissionFailure?.[0]).toMatchObject({ revertFailed: RECORD_COUNT });
  }, 30_000);
});
