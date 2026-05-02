/**
 * Batch Anchor Processing Tests (MVP-23)
 *
 * Tests for processBatchAnchors() using mocked DB and chain client.
 * Updated for claim-before-broadcast pattern (RACE-1).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChainReceipt } from '../chain/types.js';

// ---- Hoisted mocks ----

const {
  mockSubmitFingerprint,
  mockAnchorsUpdate,
  mockLogger,
  setUpdateResult,
  _setUpdateResultQueue,
} = vi.hoisted(() => {
  const mockSubmitFingerprint = vi.fn();

  // RACE-1: Update chain supports .eq() chaining + thenable
  // Supports both fixed results and per-call result queues
  let updateResults: Record<string, unknown>[] = [];
  let defaultUpdateResult: Record<string, unknown> = { error: null, count: 1 };
  const updateChain: Record<string, unknown> = {};
  updateChain.eq = vi.fn(() => updateChain);
  updateChain.in = vi.fn(() => updateChain);
  updateChain.then = (resolve?: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
    const result = updateResults.length > 0 ? updateResults.shift()! : defaultUpdateResult;
    return Promise.resolve(result).then(resolve, reject);
  };
  const setUpdateResult = (result: Record<string, unknown>) => {
    defaultUpdateResult = result;
    updateResults = [];
  };
  const setUpdateResultQueue = (results: Record<string, unknown>[]) => {
    updateResults = [...results];
  };

  const mockAnchorsUpdate = vi.fn(() => updateChain);

  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  return {
    mockSubmitFingerprint,
    mockAnchorsUpdate,
    mockLogger,
    setUpdateResult,
    _setUpdateResultQueue: setUpdateResultQueue,
  };
});

// ---- Module mocks ----

vi.mock('../utils/logger.js', () => ({
  logger: mockLogger,
}));

vi.mock('../config.js', () => ({
  config: {
    nodeEnv: 'test',
    useMocks: true,
  },
}));

vi.mock('../utils/rpc.js', () => ({
  callRpc: vi.fn(() => Promise.resolve({
    data: { PENDING: 3000, SUBMITTED: 0, BROADCASTING: 0, SECURED: 0, REVOKED: 0, total: 3000 },
    error: null,
  })),
}));

vi.mock('../chain/client.js', () => ({
  getInitializedChainClient: () => ({ submitFingerprint: mockSubmitFingerprint }),
  getChainClientAsync: () => Promise.resolve({ submitFingerprint: mockSubmitFingerprint }),
  getChainClient: () => ({ submitFingerprint: mockSubmitFingerprint }),
}));

const mockDbRpc = vi.hoisted(() => vi.fn());
const mockSelectEq = vi.hoisted(() => vi.fn());
const mockSelectIs = vi.hoisted(() => vi.fn());
const mockSelectRange = vi.hoisted(() => vi.fn());
const mockSelectSingle = vi.hoisted(() => vi.fn());
const mockSelectMaybeSingle = vi.hoisted(() => vi.fn());

vi.mock('../utils/db.js', () => {
  // Legacy select chain for fallback path
  const selectChain: Record<string, unknown> = {};
  selectChain.eq = mockSelectEq.mockImplementation(() => selectChain);
  selectChain.is = mockSelectIs.mockImplementation(() => selectChain);
  selectChain.order = vi.fn(() => selectChain);
  selectChain.limit = vi.fn(() => selectChain);
  selectChain.range = mockSelectRange.mockImplementation(() => selectChain);
  selectChain.single = mockSelectSingle.mockResolvedValue({
    data: { created_at: '2026-01-01T00:00:00Z' },
    error: null,
  });
  selectChain.maybeSingle = mockSelectMaybeSingle.mockResolvedValue({
    data: { id: 'threshold-anchor' },
    error: null,
  });
  selectChain.then = (resolve?: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => (
    Promise.resolve({ data: [], error: null }).then(resolve, reject)
  );

  return {
    db: {
      rpc: mockDbRpc,
      from: vi.fn((table: string) => {
        if (table === 'anchors') {
          return {
            select: vi.fn(() => selectChain),
            update: mockAnchorsUpdate,
          };
        }
        return {};
      }),
    },
    // Pass-through in tests — no actual timeout
    withDbTimeout: vi.fn((fn: () => Promise<unknown>) => fn()),
  };
});

// ---- System under test ----

import { processBatchAnchors, BATCH_SIZE, MIN_BATCH_SIZE, MIN_BATCH_THRESHOLD } from './batch-anchor.js';

// ---- Fixtures ----

const MOCK_RECEIPT: ChainReceipt = {
  receiptId: 'mock_receipt_batch_001',
  blockHeight: 800100,
  blockTimestamp: '2026-03-15T12:00:00Z',
  confirmations: 6,
};

const ANCHOR_A = { id: 'anchor-a', fingerprint: 'aa'.repeat(32), metadata: null };
const ANCHOR_B = { id: 'anchor-b', fingerprint: 'bb'.repeat(32), metadata: null };
const ANCHOR_C = { id: 'anchor-c', fingerprint: 'cc'.repeat(32), metadata: null };

// ================================================================
// processBatchAnchors
// ================================================================

describe('processBatchAnchors', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: RPC returns empty (no pending anchors)
    mockDbRpc.mockResolvedValue({ data: [], error: null });
    mockSubmitFingerprint.mockResolvedValue(MOCK_RECEIPT);
    setUpdateResult({ error: null, count: 1 });
  });

  // ---- No pending anchors ----

  it('returns 0 processed when no pending anchors exist', async () => {
    mockDbRpc.mockResolvedValue({ data: [], error: null });

    const result = await processBatchAnchors();

    expect(result.processed).toBe(0);
    expect(result.batchId).toBeNull();
    expect(result.merkleRoot).toBeNull();
    expect(result.txId).toBeNull();
  });

  it('returns 0 processed when RPC returns null data', async () => {
    mockDbRpc.mockResolvedValue({ data: null, error: null });

    const result = await processBatchAnchors();

    expect(result.processed).toBe(0);
  });

  it('falls back to legacy path when claim RPC is migration-incompatible', async () => {
    mockDbRpc.mockResolvedValue({
      data: null,
      error: {
        code: 'PGRST202',
        message: 'Could not find the function public.claim_pending_anchors in the schema cache',
      },
    });

    const result = await processBatchAnchors();

    // Legacy path also returns 0 since select mock returns empty
    expect(result.processed).toBe(0);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(Object) }),
      expect.stringContaining('falling back to legacy'),
    );
  });

  it('scopes legacy fallback to orgId when old claim RPC signature is still deployed', async () => {
    mockDbRpc.mockResolvedValue({
      data: null,
      error: {
        code: 'PGRST202',
        message: 'Could not find function public.claim_pending_anchors(p_exclude_pipeline, p_limit, p_org_id, p_worker_id) in the schema cache',
      },
    });

    await processBatchAnchors({ force: true, orgId: 'org-1' });

    const orgScopeCalls = mockSelectEq.mock.calls.filter((call) => call[0] === 'org_id');
    expect(orgScopeCalls).toEqual([
      ['org_id', 'org-1'],
      ['org_id', 'org-1'],
      ['org_id', 'org-1'],
    ]);
    expect(mockSelectRange).toHaveBeenCalledWith(MIN_BATCH_THRESHOLD - 1, MIN_BATCH_THRESHOLD - 1);
    expect(mockSelectMaybeSingle).toHaveBeenCalled();
    expect(mockSelectIs.mock.calls.filter((call) => call[0] === 'deleted_at')).toHaveLength(3);
  });

  it('does not use legacy fallback for non-migration claim RPC errors', async () => {
    mockDbRpc.mockResolvedValue({
      data: null,
      error: { code: 'PGRST301', message: 'permission denied' },
    });

    const result = await processBatchAnchors({ force: true, orgId: 'org-1' });

    expect(result).toEqual({ processed: 0, batchId: null, merkleRoot: null, txId: null });
    const orgScopeCalls = mockSelectEq.mock.calls.filter((call) => call[0] === 'org_id');
    expect(orgScopeCalls).toEqual([
      ['org_id', 'org-1'],
      ['org_id', 'org-1'],
    ]);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(Object) }),
      expect.stringContaining('without legacy fallback'),
    );
  });

  it('does not use legacy fallback for missing helper errors unrelated to claim_pending_anchors', async () => {
    mockDbRpc.mockResolvedValue({
      data: null,
      error: {
        code: '42883',
        message: 'function public.internal_anchor_helper(uuid) does not exist',
      },
    });

    const result = await processBatchAnchors({ force: true, orgId: 'org-1' });

    expect(result).toEqual({ processed: 0, batchId: null, merkleRoot: null, txId: null });
    const orgScopeCalls = mockSelectEq.mock.calls.filter((call) => call[0] === 'org_id');
    expect(orgScopeCalls).toEqual([
      ['org_id', 'org-1'],
      ['org_id', 'org-1'],
    ]);
    expect(mockLogger.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('falling back to legacy'),
    );
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(Object) }),
      expect.stringContaining('without legacy fallback'),
    );
  });

  // ---- Single anchor batch ----

  it('processes single anchor via batch (INEFF-2: MIN_BATCH_SIZE = 1)', async () => {
    mockDbRpc
      .mockResolvedValueOnce({ data: [ANCHOR_A], error: null }) // claim
      .mockResolvedValueOnce({ data: 1, error: null }); // submit_batch_anchors

    const result = await processBatchAnchors();

    expect(result.processed).toBe(1);
    expect(mockSubmitFingerprint).toHaveBeenCalledTimes(1);
  });

  // ---- Successful batch processing ----

  it('processes batch of 3 anchors: builds tree, publishes root, updates all', async () => {
    mockDbRpc
      .mockResolvedValueOnce({ data: [ANCHOR_A, ANCHOR_B, ANCHOR_C], error: null }) // claim
      .mockResolvedValueOnce({ data: 3, error: null }); // submit_batch_anchors

    const result = await processBatchAnchors();

    expect(result.processed).toBe(3);
    expect(result.batchId).toMatch(/^batch_\d+_3$/);
    expect(result.merkleRoot).toBeTruthy();
    expect(result.txId).toBe(MOCK_RECEIPT.receiptId);
  });

  it('passes orgId through to claim_pending_anchors for manual org queue runs', async () => {
    mockDbRpc
      .mockResolvedValueOnce({ data: [ANCHOR_A, ANCHOR_B], error: null }) // claim
      .mockResolvedValueOnce({ data: 2, error: null }); // submit_batch_anchors

    await processBatchAnchors({ force: true, orgId: 'org-1' });

    expect(mockDbRpc).toHaveBeenCalledWith('claim_pending_anchors', expect.objectContaining({
      p_org_id: 'org-1',
    }));
  });

  it('submits the Merkle root (not individual fingerprints) to chain', async () => {
    mockDbRpc
      .mockResolvedValueOnce({ data: [ANCHOR_A, ANCHOR_B], error: null }) // claim
      .mockResolvedValueOnce({ data: 2, error: null }); // submit_batch_anchors

    await processBatchAnchors();

    // Only one chain submission for the batch
    expect(mockSubmitFingerprint).toHaveBeenCalledOnce();

    // The submitted fingerprint should be the Merkle root, not an individual fingerprint
    const submittedFp = mockSubmitFingerprint.mock.calls[0][0].fingerprint;
    expect(submittedFp).not.toBe(ANCHOR_A.fingerprint);
    expect(submittedFp).not.toBe(ANCHOR_B.fingerprint);
    expect(submittedFp).toHaveLength(64); // SHA-256 hex
  });

  it('calls submit_batch_anchors RPC with correct params', async () => {
    mockDbRpc
      .mockResolvedValueOnce({ data: [ANCHOR_A, ANCHOR_B], error: null }) // claim
      .mockResolvedValueOnce({ data: 2, error: null }); // submit_batch_anchors

    await processBatchAnchors();

    // Second RPC call should be submit_batch_anchors
    expect(mockDbRpc).toHaveBeenCalledWith('submit_batch_anchors', expect.objectContaining({
      p_anchor_ids: ['anchor-a', 'anchor-b'],
      p_tx_id: MOCK_RECEIPT.receiptId,
      p_block_height: MOCK_RECEIPT.blockHeight,
      p_block_timestamp: MOCK_RECEIPT.blockTimestamp,
      p_merkle_root: expect.any(String),
      p_batch_id: expect.stringMatching(/^batch_/),
    }));
  });

  it('stores Merkle root in submit_batch_anchors RPC call', async () => {
    mockDbRpc
      .mockResolvedValueOnce({ data: [ANCHOR_A, ANCHOR_B], error: null }) // claim
      .mockResolvedValueOnce({ data: 2, error: null }); // submit_batch_anchors

    await processBatchAnchors();

    // The RPC call should include the Merkle root
    const submitCall = mockDbRpc.mock.calls.find(
      (call: unknown[]) => call[0] === 'submit_batch_anchors',
    );
    expect(submitCall).toBeDefined();
    expect(submitCall![1].p_merkle_root).toBeTruthy();
    expect(submitCall![1].p_merkle_root).toHaveLength(64);
  });

  it('marks all anchors as SUBMITTED via bulk RPC after successful publish', async () => {
    mockDbRpc
      .mockResolvedValueOnce({ data: [ANCHOR_A, ANCHOR_B, ANCHOR_C], error: null }) // claim
      .mockResolvedValueOnce({ data: 3, error: null }); // submit_batch_anchors

    const result = await processBatchAnchors();

    // All 3 anchors should be processed via bulk RPC
    expect(result.processed).toBe(3);
    expect(mockDbRpc).toHaveBeenCalledWith('submit_batch_anchors', expect.objectContaining({
      p_anchor_ids: ['anchor-a', 'anchor-b', 'anchor-c'],
    }));
  });

  // ---- Chain publish failure ----

  it('returns 0 processed when chain submission fails', async () => {
    mockDbRpc
      .mockResolvedValueOnce({ data: [ANCHOR_A, ANCHOR_B], error: null }); // claim
    mockSubmitFingerprint.mockRejectedValue(new Error('chain unavailable'));

    const result = await processBatchAnchors();

    expect(result.processed).toBe(0);
    expect(result.merkleRoot).toBeTruthy(); // root was computed before failure
    expect(result.txId).toBeNull();
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it('does not update anchors to SUBMITTED when chain submission fails', async () => {
    mockDbRpc
      .mockResolvedValueOnce({ data: [ANCHOR_A, ANCHOR_B], error: null }); // claim
    mockSubmitFingerprint.mockRejectedValue(new Error('timeout'));

    await processBatchAnchors();

    // No SUBMITTED updates — only revert calls (BROADCASTING → PENDING)
    const submittedUpdates = mockAnchorsUpdate.mock.calls.filter(
      (call: unknown[]) => call[0] && (call[0] as Record<string, unknown>).status === 'SUBMITTED',
    );
    expect(submittedUpdates.length).toBe(0);
  });

  // ---- Post-broadcast DB update failure ----
  //
  // After `chainClient.submitFingerprint()` has already broadcast a Bitcoin TX,
  // the batch processor MUST NOT revert the claimed anchors to PENDING — doing
  // so causes the next cron tick to re-claim the same anchors and broadcast a
  // second, different TX for the same fingerprints, wasting treasury sats.
  //
  // Hardened behavior (0236):
  //   1. submit_batch_anchors RPC fails → retry once (transient timeouts are
  //      the most common cause under load).
  //   2. Retry also fails → fall back to chunked direct `UPDATE status = 'SUBMITTED'`
  //      with the broadcast tx_id so the anchors move forward and
  //      recover_stuck_broadcasts() (which only reverts when chain_tx_id IS NULL)
  //      will leave them alone.
  //
  // Crucially: no code path here may set `status: 'PENDING'` after broadcast.

  it('retries submit_batch_anchors once if first call fails (transient timeout)', async () => {
    mockDbRpc
      .mockResolvedValueOnce({ data: [ANCHOR_A, ANCHOR_B, ANCHOR_C], error: null }) // claim
      .mockResolvedValueOnce({ data: null, error: { message: 'statement timeout' } }) // RPC attempt #1
      .mockResolvedValueOnce({ data: 3, error: null }); // RPC attempt #2 (retry) succeeds

    const result = await processBatchAnchors();

    expect(result.processed).toBe(3);
    expect(result.txId).toBe(MOCK_RECEIPT.receiptId);

    // submit_batch_anchors invoked twice
    const submitCalls = mockDbRpc.mock.calls.filter(
      (call: unknown[]) => call[0] === 'submit_batch_anchors',
    );
    expect(submitCalls.length).toBe(2);

    // Retry succeeded → no status updates at all (no fallback, no revert).
    // (The unrelated compliance_controls post-processing is allowed.)
    const statusUpdates = mockAnchorsUpdate.mock.calls.filter((call: unknown[]) => {
      const patch = call[0] as Record<string, unknown> | undefined;
      return patch?.status !== undefined;
    });
    expect(statusUpdates.length).toBe(0);
  });

  it('falls back to direct SUBMITTED update when submit_batch_anchors fails twice (prevents double-broadcast)', async () => {
    mockDbRpc
      .mockResolvedValueOnce({ data: [ANCHOR_A, ANCHOR_B, ANCHOR_C], error: null }) // claim
      .mockResolvedValueOnce({ data: null, error: { message: 'statement timeout' } }) // RPC attempt #1
      .mockResolvedValueOnce({ data: null, error: { message: 'statement timeout' } }); // RPC attempt #2

    setUpdateResult({ error: null, count: 3 });

    await processBatchAnchors();

    // Fallback path MUST NOT set status = 'PENDING' — that would cause
    // re-broadcast of the same fingerprints on the next cron tick.
    const revertCalls = mockAnchorsUpdate.mock.calls.filter(
      (call: unknown[]) => call[0] && (call[0] as Record<string, unknown>).status === 'PENDING',
    );
    expect(revertCalls.length).toBe(0);

    // Fallback must record chain_tx_id so recover_stuck_broadcasts()
    // (which only touches BROADCASTING where chain_tx_id IS NULL) ignores them.
    const submittedCalls = mockAnchorsUpdate.mock.calls.filter(
      (call: unknown[]) => {
        const patch = call[0] as Record<string, unknown> | undefined;
        return patch?.status === 'SUBMITTED' && patch?.chain_tx_id === MOCK_RECEIPT.receiptId;
      },
    );
    expect(submittedCalls.length).toBeGreaterThan(0);

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        txId: MOCK_RECEIPT.receiptId,
      }),
      expect.stringContaining('falling back'),
    );
  });

  it('never reverts to PENDING after a successful chain broadcast', async () => {
    // Both submit_batch_anchors attempts fail with a permanent-looking error.
    mockDbRpc
      .mockResolvedValueOnce({ data: [ANCHOR_A, ANCHOR_B], error: null }) // claim
      .mockResolvedValueOnce({ data: null, error: { message: 'function not found' } }) // attempt #1
      .mockResolvedValueOnce({ data: null, error: { message: 'function not found' } }); // attempt #2

    setUpdateResult({ error: null, count: 2 });

    await processBatchAnchors();

    const pendingResets = mockAnchorsUpdate.mock.calls.filter(
      (call: unknown[]) => (call[0] as Record<string, unknown> | undefined)?.status === 'PENDING',
    );
    expect(pendingResets.length).toBe(0);
  });

  it('reverts BROADCASTING → PENDING when chain broadcast itself fails (pre-tx-id)', async () => {
    // Distinct from the post-broadcast path: if we never got a tx_id back,
    // the safe action is to release the claim so the next cron can retry.
    mockDbRpc
      .mockResolvedValueOnce({ data: [ANCHOR_A, ANCHOR_B], error: null }); // claim succeeds
    mockSubmitFingerprint.mockRejectedValue(new Error('chain unavailable'));

    const result = await processBatchAnchors();

    expect(result.processed).toBe(0);
    expect(result.txId).toBeNull();

    const pendingResets = mockAnchorsUpdate.mock.calls.filter(
      (call: unknown[]) => (call[0] as Record<string, unknown> | undefined)?.status === 'PENDING',
    );
    expect(pendingResets.length).toBe(1);
  });

  // ---- Batch ID generation ----

  it('generates batch ID with timestamp and count', async () => {
    mockDbRpc
      .mockResolvedValueOnce({ data: [ANCHOR_A, ANCHOR_B], error: null }) // claim
      .mockResolvedValueOnce({ data: 2, error: null }); // submit_batch_anchors

    const result = await processBatchAnchors();

    expect(result.batchId).toMatch(/^batch_\d+_2$/);
  });

  // ---- Constants ----

  it('exports BATCH_SIZE as 10000 (max per BATCH_ANCHOR_MAX_SIZE default)', () => {
    expect(BATCH_SIZE).toBe(10000);
  });

  it('exports MIN_BATCH_SIZE as 1 (INEFF-2: all anchors benefit from Merkle batching)', () => {
    expect(MIN_BATCH_SIZE).toBe(1);
  });

  // ---- Logging ----

  it('logs completion info with batch details', async () => {
    mockDbRpc
      .mockResolvedValueOnce({ data: [ANCHOR_A, ANCHOR_B], error: null }) // claim
      .mockResolvedValueOnce({ data: 2, error: null }); // submit_batch_anchors

    await processBatchAnchors();

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        batchId: expect.stringMatching(/^batch_/),
        count: 2,
        total: 2,
        merkleRoot: expect.any(String),
        txId: MOCK_RECEIPT.receiptId,
      }),
      'Batch anchor processing complete',
    );
  });
});
