/**
 * `summarizeIntentRevert` — what the intent-revert summary line may claim.
 *
 * `revertIntentAnchors` used to end with an UNCONDITIONAL
 * "Reverted definitively-rejected intent anchors BROADCASTING → PENDING" at
 * INFO, emitted even when every chunk had just logged a failure on the line
 * directly above it. That is the same reported-success-over-real-failure shape
 * as #1812, where a claim-revert that released nothing reported success — and
 * it is what makes this class of outage invisible in the logs.
 *
 * The revert deliberately does NOT throw (it runs inside the broadcast-failure
 * path, where a secondary throw would mask the real chain error), so the log
 * line is the ONLY signal that exists. It has to be true.
 */
import { describe, it, expect, vi } from 'vitest';

// Same module stubs the sibling batch-anchor suites use — importing the module
// pulls in config/db/chain, none of which this pure function touches.
const { mockLogger, mockFrom } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  mockFrom: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({ logger: mockLogger }));
vi.mock('../utils/db.js', () => ({
  db: { from: mockFrom, rpc: vi.fn() },
  withDbTimeout: <T>(p: T) => p,
}));
vi.mock('../config.js', () => ({
  config: { nodeEnv: 'test', useMocks: true, enableOrgCreditEnforcement: false, maxFeeThresholdSatPerVbyte: 50 },
}));
vi.mock('../chain/client.js', () => ({
  getChainClientAsync: vi.fn(),
  getInitializedChainClient: vi.fn(),
  getChainClient: vi.fn(),
}));
vi.mock('../utils/complianceMapping.js', () => ({ getComplianceControlIds: () => [] }));
vi.mock('../utils/orgCredits.js', () => ({ deductOrgCredit: vi.fn() }));
vi.mock('../utils/anchorProofs.js', () => ({ upsertAnchorProofs: vi.fn() }));
vi.mock('../middleware/flagRegistry.js', () => ({
  flagRegistry: { getFlag: vi.fn(async () => true) },
}));

import { summarizeIntentRevert, revertIntentAnchors } from './batch-anchor.js';

describe('summarizeIntentRevert', () => {
  it('claims success only when no chunk failed', () => {
    const out = summarizeIntentRevert({
      total: 1_000,
      reverted: 1_000,
      attemptedChunks: 5,
      failedChunks: 0,
    });

    expect(out.level).toBe('info');
    expect(out.message).toMatch(/Reverted definitively-rejected intent anchors/);
    expect(out.detail).toEqual({
      reverted: 1_000,
      stranded: 0,
      attemptedChunks: 5,
      failedChunks: 0,
    });
  });

  it('never claims success when EVERY chunk failed — the #1812 shape', () => {
    const out = summarizeIntentRevert({
      total: 1_000,
      reverted: 0,
      attemptedChunks: 5,
      failedChunks: 5,
    });

    expect(out.level).toBe('error');
    expect(out.message).not.toMatch(/^Reverted definitively-rejected/);
    expect(out.message).toMatch(/reverted NOTHING/);
    // The number that matters operationally: everything is still BROADCASTING.
    expect(out.detail.stranded).toBe(1_000);
    expect(out.detail.reverted).toBe(0);
  });

  it('reports a partial failure as a warning that names the stranded count', () => {
    const out = summarizeIntentRevert({
      total: 1_000,
      reverted: 800,
      attemptedChunks: 5,
      failedChunks: 1,
    });

    expect(out.level).toBe('warn');
    expect(out.message).toMatch(/partially failed/);
    expect(out.detail.stranded).toBe(200);
    expect(out.detail.failedChunks).toBe(1);
  });

  // Added after review: `revertIntentAnchors` used to count `chunk.length` as
  // reverted without measuring the UPDATE, so a run where every row had already
  // left BROADCASTING logged `reverted: 1000, stranded: 0` and claimed success.
  // It now passes `{ count: 'exact' }`, which makes this state reachable.
  it('does not claim a revert when nothing errored but nothing matched', () => {
    const out = summarizeIntentRevert({
      total: 1_000,
      reverted: 0,
      attemptedChunks: 5,
      failedChunks: 0,
    });

    expect(out.level).toBe('info');
    // Must not be the success line — nothing was reverted.
    expect(out.message).not.toMatch(/^Reverted definitively-rejected/);
    expect(out.message).toMatch(/matched no BROADCASTING rows/);
    expect(out.detail.reverted).toBe(0);
    expect(out.detail.stranded).toBe(1_000);
  });

  it('still claims success when rows actually moved', () => {
    const out = summarizeIntentRevert({
      total: 1_000,
      reverted: 1_000,
      attemptedChunks: 5,
      failedChunks: 0,
    });
    expect(out.message).toMatch(/^Reverted definitively-rejected/);
  });

  it('does not report success for an empty revert that had no chunks to run', () => {
    const out = summarizeIntentRevert({
      total: 0,
      reverted: 0,
      attemptedChunks: 0,
      failedChunks: 0,
    });

    // Nothing failed, so INFO is correct — but it must not imply work happened.
    expect(out.level).toBe('info');
    expect(out.detail.reverted).toBe(0);
    expect(out.detail.stranded).toBe(0);
  });
});

/**
 * The WIRING, not just the decision.
 *
 * A first cut of this fix tested only `summarizeIntentRevert` and left
 * `revertIntentAnchors` feeding it an unmeasured number — reverting
 * `count ?? 0` back to `chunk.length` killed zero tests. A pure-function test
 * for a reporting bug does not cover the reporting.
 *
 * Exported for this test the same way #1853 exported `applyComplianceControls`:
 * to reach a defect directly. (Distinct from the width exports #1839 reverted —
 * width is `chunkForInFilter`'s guarantee and is asserted once, on the helper.)
 */
describe('revertIntentAnchors — what it counts as reverted', () => {
  const ids = (n: number) =>
    Array.from({ length: n }, (_, i) => `8a7b6c5d-4e3f-4a2b-8c1d-${String(i).padStart(12, '0')}`);

  /**
   * `.update(...).in(...).eq(...)` resolving with an exact `count`.
   *
   * Emulates the real client on the point that matters: postgrest-js returns
   * `count` ONLY when the update asked for `{ count: 'exact' }`. A mock that
   * hands back a count regardless would let someone drop that option and still
   * see green — the forgiving-mock trap. Verified: removing the option now
   * fails these tests.
   */
  function mockDb(countPerCall: (call: number) => { count?: number; error?: unknown }) {
    let call = 0;
    mockFrom.mockImplementation(() => ({
      update: (_values: unknown, opts?: { count?: string }) => ({
        in: () => ({
          eq: () => {
            const result = countPerCall(call++);
            if (opts?.count !== 'exact') {
              // What the real client does when no count was requested.
              return Promise.resolve({ data: null, error: result.error ?? null, count: null });
            }
            return Promise.resolve({ ...result, data: null });
          },
        }),
      }),
    }));
  }

  beforeEach(() => {
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
  });

  it('reports rows the UPDATE actually matched, not ids sent', async () => {
    // 400 ids -> 2 chunks; the statement matches only 3 rows in total because
    // the rest already left BROADCASTING.
    mockDb((c) => ({ count: c === 0 ? 3 : 0 }));

    await revertIntentAnchors(ids(400));

    expect(mockLogger.info).toHaveBeenCalledTimes(1);
    const [detail] = mockLogger.info.mock.calls[0];
    expect(detail).toMatchObject({ reverted: 3, stranded: 397 });
  });

  it('does not claim success when the UPDATE matched nothing', async () => {
    mockDb(() => ({ count: 0 }));

    await revertIntentAnchors(ids(400));

    const [, message] = mockLogger.info.mock.calls[0];
    expect(message).not.toMatch(/^Reverted definitively-rejected/);
    expect(message).toMatch(/matched no BROADCASTING rows/);
  });

  it('escalates to ERROR when every chunk fails, and never logs success', async () => {
    mockDb(() => ({ error: { message: 'request line too large' } }));

    await revertIntentAnchors(ids(400));

    expect(mockLogger.info).not.toHaveBeenCalled();
    const [detail, message] = mockLogger.error.mock.calls.at(-1)!;
    expect(message).toMatch(/reverted NOTHING/);
    expect(detail).toMatchObject({ reverted: 0, stranded: 400 });
  });
});
