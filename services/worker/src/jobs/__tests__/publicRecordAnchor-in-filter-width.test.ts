/**
 * SCRUM-3031 follow-up: the PostgREST id-filter width invariant, asserted at
 * EVERY id-filter call site in publicRecordAnchor.ts — not just the two that
 * were fixed by PR #1795.
 *
 * Background. `POSTGREST_ROW_LIMIT` (1,000) governs how many rows PostgREST
 * RETURNS. It says nothing about how wide a URL query-string filter may be.
 * Chunking `.in('id', chunk)` by that constant produces a ~38 KB encoded
 * request line, which PostgREST rejects with 400 Bad Request. On 2026-07-29
 * that conflation silently killed public-record anchoring for 70+ hours while
 * every anchoring cron returned HTTP 200 (see anchor-batching.ts and the
 * `POSTGREST_IN_FILTER_CHUNK` docstring).
 *
 * PR #1795 fixed `fetchAnchorRows` and `claimPendingPipelineAnchors`. It did
 * NOT fix `revertClaimedAnchors`, which kept chunking by `POSTGREST_ROW_LIMIT`
 * — so the ONE path that runs after a failed chain submission, whose entire
 * job is to release up to 10,000 claimed anchors from `BROADCASTING` back to
 * `PENDING`, would 400 on every chunk and release nothing. It only logged and
 * continued, so the job reported a normal chain-submission failure while
 * leaving the whole claimed batch stranded.
 *
 * These tests are deliberately CALL-SITE behavioral, not constant-value
 * assertions (anchor-batching.test.ts already pins the constants). They drive
 * each real function with a recording client and assert the encoded wire
 * filter every call site actually emits stays inside the budget. That is the
 * invariant that was violated twice; pinning the constant alone would not have
 * caught either violation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
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

import {
  claimPendingPipelineAnchors,
  fetchAnchorRows,
  revertClaimedAnchors,
} from '../publicRecordAnchor.js';
import {
  POSTGREST_IN_FILTER_CHUNK,
  POSTGREST_URL_FILTER_BUDGET_BYTES,
} from '../anchor-batching.js';

/** A full pipeline batch — the real worst case (PUBLIC_RECORD_BATCH_SIZE). */
const FULL_BATCH = 10_000;

function uuids(count: number): string[] {
  return Array.from(
    { length: count },
    (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  );
}

/** The bytes supabase-js puts on the wire for `id=in.(...)`. */
function encodedInFilterBytes(ids: string[]): number {
  return encodeURIComponent(`in.(${ids.join(',')})`).length;
}

/**
 * Records every `.in(column, ids)` a call site issues, so a test can assert
 * the emitted wire filter rather than an approximation of it.
 */
function recordingClient(options: { inError?: unknown } = {}) {
  const inCalls: Array<{ column: string; ids: string[] }> = [];
  const result = { data: [] as unknown[], error: options.inError ?? null };

  const chain: Record<string, unknown> = {};
  const passthrough = () => chain;
  chain.select = passthrough;
  chain.eq = passthrough;
  chain.is = passthrough;
  chain.in = (column: string, ids: string[]) => {
    inCalls.push({ column, ids });
    return chain;
  };
  // Terminal await: every builder in this module resolves to { data, error }.
  chain.then = (resolve: (value: typeof result) => unknown) => Promise.resolve(resolve(result));

  const client = {
    from: () => chain,
    update: passthrough,
  } as unknown as Parameters<typeof fetchAnchorRows>[0];

  // `.from(...).update(...)` and `.from(...).select(...)` both continue the
  // same chain, so expose update on it too.
  chain.update = passthrough;

  return { client, inCalls };
}

function assertEveryFilterFitsBudget(inCalls: Array<{ ids: string[] }>): void {
  expect(inCalls.length).toBeGreaterThan(0);
  for (const call of inCalls) {
    expect(call.ids.length).toBeLessThanOrEqual(POSTGREST_IN_FILTER_CHUNK);
    expect(encodedInFilterBytes(call.ids)).toBeLessThan(POSTGREST_URL_FILTER_BUDGET_BYTES);
  }
}

describe('publicRecordAnchor id-filter width (every call site)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetchAnchorRows keeps every id filter inside the URL budget', async () => {
    const { client, inCalls } = recordingClient();
    await fetchAnchorRows(client, uuids(FULL_BATCH));
    assertEveryFilterFitsBudget(inCalls);
  });

  it('claimPendingPipelineAnchors keeps every id filter inside the URL budget', async () => {
    const { client, inCalls } = recordingClient();
    await claimPendingPipelineAnchors(
      client,
      uuids(FULL_BATCH).map((id) => ({
        id,
        fingerprint: 'a'.repeat(64),
        status: 'PENDING',
        chain_tx_id: null,
      })),
    );
    assertEveryFilterFitsBudget(inCalls);
  });

  // The regression PR #1795 missed. Pre-fix this emitted 1,000-id filters and
  // every chunk 400'd, so a failed chain submission stranded the entire
  // claimed batch in BROADCASTING.
  it('revertClaimedAnchors keeps every id filter inside the URL budget', async () => {
    const { client, inCalls } = recordingClient();
    await revertClaimedAnchors(client, uuids(FULL_BATCH));
    assertEveryFilterFitsBudget(inCalls);
  });
});

describe('revertClaimedAnchors failure reporting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports how many anchors were left stranded when every chunk fails', async () => {
    const { client } = recordingClient({ inError: { message: 'Bad Request' } });
    const ids = uuids(500);

    const result = await revertClaimedAnchors(client, ids);

    expect(result.attemptedChunks).toBeGreaterThan(0);
    expect(result.failedChunks).toBe(result.attemptedChunks);
    expect(result.strandedAnchorIds).toBe(ids.length);
  });

  it('escalates a total revert failure to error level naming the stranded count', async () => {
    const { client } = recordingClient({ inError: { message: 'Bad Request' } });

    await revertClaimedAnchors(client, uuids(500));

    const escalation = mockLogger.error.mock.calls.find(
      ([, msg]) => typeof msg === 'string' && msg.includes('left BROADCASTING'),
    );
    expect(escalation).toBeDefined();
    expect((escalation?.[0] as { strandedAnchorIds?: number })?.strandedAnchorIds).toBe(500);
  });

  it('reports a clean revert when every chunk succeeds', async () => {
    const { client } = recordingClient();

    const result = await revertClaimedAnchors(client, uuids(500));

    expect(result.failedChunks).toBe(0);
    expect(result.strandedAnchorIds).toBe(0);
  });
});
