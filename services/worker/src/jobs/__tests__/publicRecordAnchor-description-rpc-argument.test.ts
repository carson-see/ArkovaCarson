/**
 * SCRUM-5120 — the JS-side half of the `batch_insert_anchors` description
 * contract.
 *
 * `buildPipelineAnchorInsert` (private to `publicRecordAnchor.ts`) has always
 * built its RPC element with `...(description ? { description } : {})` —
 * this file never dropped the field. The bug was entirely on the SQL side
 * (`public.batch_insert_anchors`, fixed by migration `0458`): the RPC never
 * read `elem->>'description'` out of `p_anchors`, so whatever the worker sent
 * here was silently discarded before it ever reached `anchors.description`.
 *
 * This test cannot prove the SQL side persists the value — only a live-DB
 * test can prove that (see `tests/rls/scrum-5120-batch-insert-anchors-description.test.ts`,
 * which calls the real RPC against real Postgres and reads the row back).
 * What this test CAN prove, and is scoped to proving, is the JS-side half of
 * the contract: that `processPublicRecordAnchoring` actually calls
 * `client.rpc('batch_insert_anchors', { p_anchors })` with a `description` key
 * present on the element built from a record that has source text, and absent
 * (not `null`, not `''`) on the element built from a record that does not —
 * exactly the conditional-spread shape `buildPipelineAnchorInsert` produces.
 * Mocking the RPC here is legitimate per `tests/rls/agents.md`'s rule (a mock
 * may stand in for a collaborator, never for the invariant under test):
 * "does the worker send the right argument" is a JS-side property; "does
 * Postgres store what it's sent" is not, which is why that half lives in
 * `tests/rls/` instead.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockSupabase as _createMockSupabase, grantedRunLeaseTable } from './__testHelpers.js';

const { mockRpc, mockLogger, mockSubmitFingerprint, mockAnchorProofsUpsert } = vi.hoisted(() => ({
  mockRpc: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  mockSubmitFingerprint: vi.fn(),
  mockAnchorProofsUpsert: vi.fn().mockResolvedValue({ error: null }),
}));

vi.mock('../../config.js', () => ({
  config: {
    logLevel: 'info',
    nodeEnv: 'test',
    useMocks: true,
    enableProdNetworkAnchoring: false,
    bitcoinNetwork: 'signet',
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

const captureCreditRpcFailureAlert = vi.hoisted(() => vi.fn());
vi.mock('../../utils/sentry.js', () => ({ captureCreditRpcFailureAlert }));

/**
 * Adapted from `publicRecordAnchor.test.ts`'s own `makeMock()` (the proven
 * mock shape for driving `processPublicRecordAnchoring` end to end) — this
 * file duplicates rather than imports it, matching this directory's own
 * convention of each focused test file owning its mock setup (see e.g.
 * `publicRecordAnchor-revert-in-filter.test.ts`). Only what this test
 * actually exercises is included: the happy path through
 * `batch_insert_anchors` -> the post-insert anchor re-fetch -> finalize.
 */
/**
 * `fetchUnanchoredPublicRecords` fans out to FOUR priority-source queries
 * (`.eq('source', X)`) plus one non-priority query (`.not('source','in',...)`)
 * against the SAME `public_records` table. A mock that returns the full
 * fixture for every call — rather than filtering by the source predicate the
 * real code applied — silently multiplies every fixture row once per query
 * that runs, which is exactly the kind of premise-supplied-by-the-fixture
 * bug `tests/rls/agents.md` warns about (a mock standing in for the
 * INVARIANT, not a collaborator). This builds one filtering chain per
 * `.from('public_records').select(...)` call, tracking whichever of
 * `.eq('source', X)` / `.not('source','in',(a,b,c))` was actually applied
 * before `.range()` resolves, so each source query returns only ITS rows.
 */
function publicRecordsFromImpl(records: Array<Record<string, unknown>>) {
  return () => {
    let sourceEq: string | undefined;
    let sourceNotIn: string[] | undefined;
    const chain: Record<string, unknown> = {};
    chain.is = vi.fn(() => chain);
    chain.eq = vi.fn((column: string, value: string) => {
      if (column === 'source') sourceEq = value;
      return chain;
    });
    chain.not = vi.fn((column: string, op: string, value: string) => {
      if (column === 'source' && op === 'in') {
        sourceNotIn = String(value).replace(/[()]/g, '').split(',').filter(Boolean);
      }
      return chain;
    });
    chain.order = vi.fn(() => chain);
    chain.range = vi.fn().mockImplementation(() => {
      let filtered = records;
      if (sourceEq !== undefined) {
        filtered = records.filter((r) => r.source === sourceEq);
      } else if (sourceNotIn !== undefined) {
        filtered = records.filter((r) => !sourceNotIn!.includes(r.source as string));
      }
      return Promise.resolve({ data: filtered, error: null });
    });
    return chain;
  };
}

function makeMock(records: Array<Record<string, unknown>>) {
  const publicRecordsSelect = publicRecordsFromImpl(records);

  // The post-batch-insert re-fetch (`.select(...).in('id', ids).is('deleted_at', null)`),
  // the claim-to-BROADCASTING update, and the anchor_proofs upsert. Content
  // doesn't need to correlate with the RPC's returned ids for this test —
  // nothing here asserts on the Merkle/submit path, only on the
  // batch_insert_anchors RPC argument itself.
  const anchorRows = records.map((record, i) => ({
    id: `anchor-uuid-${i}`,
    fingerprint: record.content_hash,
    status: 'PENDING',
    chain_tx_id: null,
    metadata: {},
  }));
  const claimedAnchorRows = anchorRows.map((row) => ({ ...row, status: 'BROADCASTING' }));

  const anchorsSelectByIds = {
    in: vi.fn(() => ({
      is: vi.fn().mockResolvedValue({ data: anchorRows, error: null }),
    })),
  };
  const anchorsBroadcastingUpdate = {
    in: vi.fn(() => ({
      eq: vi.fn(() => ({
        select: vi.fn().mockResolvedValue({ data: claimedAnchorRows, error: null }),
      })),
    })),
  };
  const anchorsSubmittedUpdate = {
    in: vi.fn(() => ({
      eq: vi.fn().mockResolvedValue({ error: null }),
    })),
  };

  return _createMockSupabase({
    rpcMock: mockRpc,
    fromImpl: vi.fn((table: string) => {
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
          update: vi.fn((payload: Record<string, unknown>) => (
            payload.status === 'BROADCASTING' ? anchorsBroadcastingUpdate : anchorsSubmittedUpdate
          )),
        };
      }
      if (table === 'anchor_proofs') {
        return { upsert: mockAnchorProofsUpsert };
      }
      if (table === 'public_records') {
        return { select: vi.fn(publicRecordsSelect) };
      }
      if (table === 'job_queue') {
        return grantedRunLeaseTable();
      }
      throw new Error(`makeMock: unexpected table "${table}"`);
    }),
  }).client;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAnchorProofsUpsert.mockResolvedValue({ error: null });
});

describe('SCRUM-5120 — batch_insert_anchors RPC argument carries description (JS side)', () => {
  it('sends description for a record with source text, and omits the key entirely for a record without', async () => {
    const withText = {
      id: 'record-with-abstract',
      content_hash: 'a1'.repeat(32),
      metadata: { abstract: 'This paper studies the thing.' },
      source: 'openalex',
      source_id: 'W123',
      source_url: 'https://openalex.org/W123',
      record_type: 'article',
      title: 'A Paper',
    };
    const withoutText = {
      id: 'record-without-text',
      content_hash: 'b2'.repeat(32),
      metadata: {},
      source: 'federal_register',
      source_id: 'FR-456',
      source_url: 'https://federalregister.gov/FR-456',
      record_type: 'notice',
      title: 'A Notice',
    };
    const records = [withText, withoutText];

    mockRpc
      .mockResolvedValueOnce({ data: true }) // get_flag
      .mockResolvedValueOnce({
        data: records.map((r) => ({ id: `anchor-${r.id}`, fingerprint: r.content_hash })),
      }) // batch_insert_anchors
      .mockResolvedValueOnce({ data: { records_updated: 2, anchors_updated: 2 } }); // finalize

    mockSubmitFingerprint.mockResolvedValue({
      receiptId: 'tx_mock_scrum5120',
      blockHeight: 0,
      blockTimestamp: new Date().toISOString(),
      confirmations: 0,
    });

    const { processPublicRecordAnchoring } = await import('../publicRecordAnchor.js');
    await processPublicRecordAnchoring(makeMock(records));

    const batchInsertCall = mockRpc.mock.calls.find(([name]) => name === 'batch_insert_anchors');
    expect(batchInsertCall, 'batch_insert_anchors was never called').toBeDefined();

    const [, args] = batchInsertCall as [string, { p_anchors: Array<Record<string, unknown>> }];
    const pAnchors = args.p_anchors;
    expect(pAnchors).toHaveLength(2);

    const withTextElement = pAnchors.find((e) => e.fingerprint === withText.content_hash);
    const withoutTextElement = pAnchors.find((e) => e.fingerprint === withoutText.content_hash);
    expect(withTextElement, 'element for the with-abstract record was not sent').toBeDefined();
    expect(withoutTextElement, 'element for the without-text record was not sent').toBeDefined();

    // POSITIVE: the JS side must actually send the field for the worker to
    // have any chance of it being persisted.
    expect(withTextElement).toHaveProperty('description', 'This paper studies the thing.');

    // NEGATIVE CONTROL: buildPipelineAnchorInsert's conditional spread means
    // the key is ABSENT, not present-as-null/empty-string — asserting
    // `not.toHaveProperty` (rather than `.description` to be falsy) pins the
    // exact shape the RPC element has on the wire.
    expect(withoutTextElement).not.toHaveProperty('description');
  });
});
