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

vi.mock('../chain/client.js', () => ({
  getInitializedChainClient: () => ({ submitFingerprint: mockSubmitFingerprint }),
  getChainClientAsync: () => Promise.resolve({ submitFingerprint: mockSubmitFingerprint }),
  getChainClient: () => ({ submitFingerprint: mockSubmitFingerprint }),
}));

const mockDbRpc = vi.hoisted(() => vi.fn());

vi.mock('../utils/db.js', () => {
  // Legacy select chain for fallback path
  const selectChain: Record<string, unknown> = {};
  selectChain.eq = vi.fn(() => selectChain);
  selectChain.is = vi.fn(() => selectChain);
  selectChain.order = vi.fn(() => selectChain);
  selectChain.limit = vi.fn().mockResolvedValue({ data: [], error: null });

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

import { processBatchAnchors, BATCH_SIZE, MIN_BATCH_SIZE } from './batch-anchor.js';

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

  it('falls back to legacy path when RPC returns an error', async () => {
    mockDbRpc.mockResolvedValue({
      data: null,
      error: { message: 'function not found' },
    });

    const result = await processBatchAnchors();

    // Legacy path also returns 0 since select mock returns empty
    expect(result.processed).toBe(0);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(Object) }),
      expect.stringContaining('falling back to legacy'),
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

  // ---- Partial DB update failure ----

  it('reverts to PENDING when submit_batch_anchors RPC fails (M1)', async () => {
    mockDbRpc
      .mockResolvedValueOnce({ data: [ANCHOR_A, ANCHOR_B, ANCHOR_C], error: null }) // claim
      .mockResolvedValueOnce({ data: null, error: { message: 'function not found' } }); // submit_batch_anchors fails

    const result = await processBatchAnchors();

    // M1: Reverts all to PENDING instead of N+1 individual SUBMITTED updates
    expect(result.processed).toBe(0);
    expect(result.merkleRoot).toBeTruthy(); // root was computed before failure
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(Object) }),
      expect.stringContaining('submit_batch_anchors RPC failed'),
    );
    // Bulk revert: single .update({ status: 'PENDING' }).in().eq() call
    expect(mockAnchorsUpdate).toHaveBeenCalledTimes(1);
    const revertCalls = mockAnchorsUpdate.mock.calls.filter(
      (call: unknown[]) => call[0] && (call[0] as Record<string, unknown>).status === 'PENDING',
    );
    expect(revertCalls.length).toBe(1);
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

  it('exports BATCH_SIZE as 100 (increased per audit)', () => {
    expect(BATCH_SIZE).toBe(100);
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
