/**
 * Feeder paging for the public-record anchoring pipeline (BUG-2026-08-02-002).
 *
 * `fetchRecordsForSource` and `fetchNonPriorityRecords` ended their paging loop
 * on `chunk.length < chunkSize` — "the server returned fewer rows than I asked
 * for" read as "there are no more rows". `chunkSize` reaches
 * `POSTGREST_ROW_LIMIT` (1000) on every run at the default batch size, and
 * PostgREST's `db-max-rows` is a SERVER setting the worker cannot see. Where it
 * sits below 1000, the very first page short-circuits the loop and every run
 * feeds the pipeline a fraction of the records it asked for.
 *
 * Milder than the same mistake in `api/v1/auditBatchVerify.ts` — the filter is
 * `anchor_id IS NULL`, so under-read records are simply picked up by a later
 * run rather than permanently lost — but it throttles a pipeline that currently
 * has a ~259k record backlog to work through.
 *
 * EVERY test here sets a mock server page cap DIFFERENT from
 * `POSTGREST_ROW_LIMIT`. A mock that caps pages at the same constant the code
 * compares against can only ever prove the code agrees with itself, which is
 * exactly why the original bug survived its own test suite.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
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
  getInitializedChainClient: () => ({ submitFingerprint: vi.fn() }),
  getChainClientAsync: () => Promise.resolve({ submitFingerprint: vi.fn() }),
}));

import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchRecordsForSource, fetchNonPriorityRecords } from '../publicRecordAnchor.js';
import { POSTGREST_ROW_LIMIT } from '../../utils/postgrest-filter.js';

interface RangeCall {
  from: number;
  to: number;
}

function record(n: number) {
  return {
    id: `rec-${n}`,
    source: 'courtlistener',
    source_id: `src-${n}`,
    source_url: `https://example.test/${n}`,
    record_type: 'opinion',
    title: `Record ${n}`,
    content_hash: 'c'.repeat(64),
    metadata: {},
  };
}

/**
 * A `public_records` table behind a PostgREST whose page cap is `serverPageCap`,
 * regardless of the width the worker requests.
 */
function makeClient(options: {
  total: number;
  serverPageCap: number;
  failAtCallIndex?: number;
}) {
  const rangeCalls: RangeCall[] = [];
  const rows = Array.from({ length: options.total }, (_, i) => record(i));

  const builder = {
    select: () => builder,
    is: () => builder,
    eq: () => builder,
    not: () => builder,
    order: () => builder,
    range: (from: number, to: number) => {
      rangeCalls.push({ from, to });
      if (options.failAtCallIndex === rangeCalls.length - 1) {
        // postgrest-js RESOLVES a failure — it does not throw.
        return Promise.resolve({
          data: null,
          error: { code: 'PGRST103', message: 'Requested range not satisfiable' },
        });
      }
      const width = Math.min(to - from + 1, options.serverPageCap);
      return Promise.resolve({ data: rows.slice(from, from + width), error: null });
    },
  };

  const client = { from: () => builder } as unknown as SupabaseClient;
  return { client, rangeCalls };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('fetchRecordsForSource — paging', () => {
  it('reads the full requested limit when the server page cap is BELOW the worker constant', async () => {
    // The defect: chunkSize is 1000, the server hands back 400, `400 < 1000`
    // ends the loop, and the pipeline is fed 400 of the 2500 records it asked
    // for — on every single run.
    const { client } = makeClient({ total: 5000, serverPageCap: 400 });

    const records = await fetchRecordsForSource(client, 'courtlistener', 2500);

    expect(records).toHaveLength(2500);
    expect(new Set(records.map((r) => r.id)).size).toBe(2500);
  });

  it('advances the offset by rows RETURNED, never by the width requested', async () => {
    // Advancing by the requested width skips every row a short page withheld.
    const { client, rangeCalls } = makeClient({ total: 5000, serverPageCap: 400 });

    await fetchRecordsForSource(client, 'courtlistener', 1200);

    expect(rangeCalls.slice(0, 4).map((c) => c.from)).toEqual([0, 400, 800, 1200]);
  });

  it('stops at the limit rather than draining the whole table', async () => {
    const { client } = makeClient({ total: 50_000, serverPageCap: 400 });

    const records = await fetchRecordsForSource(client, 'courtlistener', 900);

    expect(records).toHaveLength(900);
  });

  it('returns everything available when the source holds fewer than the limit', async () => {
    const { client } = makeClient({ total: 130, serverPageCap: 400 });

    const records = await fetchRecordsForSource(client, 'courtlistener', 2500);

    expect(records).toHaveLength(130);
  });

  it('returns an empty list for an exhausted source without erroring', async () => {
    const { client, rangeCalls } = makeClient({ total: 0, serverPageCap: 400 });

    const records = await fetchRecordsForSource(client, 'courtlistener', 2500);

    expect(records).toEqual([]);
    expect(rangeCalls).toHaveLength(1);
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it('also works when the server page cap is ABOVE the worker constant', async () => {
    const { client } = makeClient({ total: 5000, serverPageCap: 4000 });

    const records = await fetchRecordsForSource(client, 'courtlistener', 2500);

    expect(records).toHaveLength(2500);
  });

  it('over-fetches by at most one row past the limit', async () => {
    // The old loop capped its final page at exactly `limit - offset`. A naive
    // migration that always asks for POSTGREST_ROW_LIMIT would pull up to ~1000
    // surplus `public_records` rows — each carrying title + jsonb metadata —
    // on every source, every run.
    const { client, rangeCalls } = makeClient({ total: 50_000, serverPageCap: 400 });

    await fetchRecordsForSource(client, 'courtlistener', 900);

    const fetched = rangeCalls.reduce(
      (total, call) => total + Math.min(call.to - call.from + 1, 400),
      0,
    );
    expect(fetched).toBeLessThanOrEqual(901);
  });

  it('logs and returns the partial batch on a page error rather than aborting the run', async () => {
    // Deliberate, and different from `auditBatchVerify.ts`, which throws. There
    // a partial read is signed off as a complete audit answer; here it is
    // simply less work this run, and the records stay `anchor_id IS NULL` for
    // the next one. Throwing would take down the other three priority sources
    // fetched alongside this one under `Promise.all`.
    const { client } = makeClient({ total: 5000, serverPageCap: 400, failAtCallIndex: 2 });

    const records = await fetchRecordsForSource(client, 'courtlistener', 2500);

    expect(records).toHaveLength(800);
    expect(mockLogger.error).toHaveBeenCalled();
    // Driver code only — never the driver message, which echoes values back.
    const logged = JSON.stringify(mockLogger.error.mock.calls);
    expect(logged).toContain('PGRST103');
    expect(logged).not.toContain('Requested range not satisfiable');
  });
});

describe('fetchNonPriorityRecords — paging', () => {
  it('reads the full requested limit when the server page cap is BELOW the worker constant', async () => {
    const { client } = makeClient({ total: 5000, serverPageCap: 400 });

    const records = await fetchNonPriorityRecords(client, 2500);

    expect(records).toHaveLength(2500);
    expect(new Set(records.map((r) => r.id)).size).toBe(2500);
  });

  it('advances the offset by rows RETURNED, never by the width requested', async () => {
    const { client, rangeCalls } = makeClient({ total: 5000, serverPageCap: 400 });

    await fetchNonPriorityRecords(client, 1200);

    expect(rangeCalls.slice(0, 4).map((c) => c.from)).toEqual([0, 400, 800, 1200]);
  });

  it('logs and returns the partial batch on a page error', async () => {
    const { client } = makeClient({ total: 5000, serverPageCap: 400, failAtCallIndex: 1 });

    const records = await fetchNonPriorityRecords(client, 2500);

    expect(records).toHaveLength(400);
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it('cannot spin forever when the server never returns an empty page', async () => {
    // A tiny server cap means the page ceiling, not the row budget, is what
    // ends the scan. It must end it — and the job must still get usable work
    // out of the run rather than hanging or throwing.
    const { client, rangeCalls } = makeClient({ total: 1_000_000, serverPageCap: 1 });

    const records = await fetchNonPriorityRecords(client, 10_000);

    expect(rangeCalls.length).toBeLessThanOrEqual(200);
    expect(records.length).toBe(rangeCalls.length);
    expect(mockLogger.warn).toHaveBeenCalled();
  });
});

describe('the worker constant is not the server cap', () => {
  it('POSTGREST_ROW_LIMIT is a request width, not an observed server limit', () => {
    // Guard against a future edit re-deriving "done" from this constant. Every
    // test above deliberately runs with a server cap that differs from it.
    expect(POSTGREST_ROW_LIMIT).toBe(1000);
  });
});
