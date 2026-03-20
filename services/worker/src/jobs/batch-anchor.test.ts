/**
 * Batch Anchor Processing Tests (MVP-23)
 *
 * Tests for processBatchAnchors() using mocked DB and chain client.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChainReceipt } from '../chain/types.js';

// ---- Hoisted mocks ----

const {
  mockSubmitFingerprint,
  mockAnchorsSelect,
  mockAnchorsUpdate,
  mockUpdateEq,
  mockLogger,
} = vi.hoisted(() => {
  const mockSubmitFingerprint = vi.fn();

  // Select chain: .select().eq().is().order().limit()
  const selectChain: Record<string, unknown> = {};
  selectChain.eq = vi.fn(() => selectChain);
  selectChain.is = vi.fn(() => selectChain);
  selectChain.order = vi.fn(() => selectChain);
  selectChain.limit = vi.fn();

  const mockUpdateEq = vi.fn();
  const updateChain = { eq: mockUpdateEq };

  const mockAnchorsSelect = vi.fn(() => selectChain);
  const mockAnchorsUpdate = vi.fn(() => updateChain);

  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  return {
    mockSubmitFingerprint,
    mockAnchorsSelect,
    mockAnchorsUpdate,
    mockUpdateEq,
    mockLogger,
    selectChain,
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
}));

vi.mock('../utils/db.js', () => ({
  db: {
    from: vi.fn((table: string) => {
      if (table === 'anchors') {
        return {
          select: mockAnchorsSelect,
          update: mockAnchorsUpdate,
        };
      }
      return {};
    }),
  },
}));

// ---- System under test ----

import { processBatchAnchors, BATCH_SIZE, MIN_BATCH_SIZE } from './batch-anchor.js';

// ---- Helpers ----

// Access the select chain's limit mock (terminal operation for fetch query)
function getSelectLimitMock() {
  const chain = mockAnchorsSelect();
  return (chain as Record<string, ReturnType<typeof vi.fn>>).limit;
}

// ---- Fixtures ----

const MOCK_RECEIPT: ChainReceipt = {
  receiptId: 'mock_receipt_batch_001',
  blockHeight: 800100,
  blockTimestamp: '2026-03-15T12:00:00Z',
  confirmations: 6,
};

const ANCHOR_A = { id: 'anchor-a', fingerprint: 'aa'.repeat(32) };
const ANCHOR_B = { id: 'anchor-b', fingerprint: 'bb'.repeat(32) };
const ANCHOR_C = { id: 'anchor-c', fingerprint: 'cc'.repeat(32) };

// ================================================================
// processBatchAnchors
// ================================================================

describe('processBatchAnchors', () => {
  let limitMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    limitMock = getSelectLimitMock();

    // Defaults
    limitMock.mockResolvedValue({ data: [], error: null });
    mockSubmitFingerprint.mockResolvedValue(MOCK_RECEIPT);
    mockUpdateEq.mockResolvedValue({ error: null });
  });

  // ---- No pending anchors ----

  it('returns 0 processed when no pending anchors exist', async () => {
    limitMock.mockResolvedValue({ data: [], error: null });

    const result = await processBatchAnchors();

    expect(result.processed).toBe(0);
    expect(result.batchId).toBeNull();
    expect(result.merkleRoot).toBeNull();
    expect(result.txId).toBeNull();
  });

  it('returns 0 processed when fetch returns null data', async () => {
    limitMock.mockResolvedValue({ data: null, error: null });

    const result = await processBatchAnchors();

    expect(result.processed).toBe(0);
  });

  it('returns 0 processed when fetch returns an error', async () => {
    limitMock.mockResolvedValue({
      data: null,
      error: { message: 'connection timeout' },
    });

    const result = await processBatchAnchors();

    expect(result.processed).toBe(0);
    expect(mockLogger.error).toHaveBeenCalled();
  });

  // ---- Not enough for batch ----

  it('returns 0 processed when only 1 pending anchor (below MIN_BATCH_SIZE)', async () => {
    limitMock.mockResolvedValue({
      data: [ANCHOR_A],
      error: null,
    });

    const result = await processBatchAnchors();

    expect(result.processed).toBe(0);
    expect(mockSubmitFingerprint).not.toHaveBeenCalled();
  });

  // ---- Successful batch processing ----

  it('processes batch of 3 anchors: builds tree, publishes root, updates all', async () => {
    limitMock.mockResolvedValue({
      data: [ANCHOR_A, ANCHOR_B, ANCHOR_C],
      error: null,
    });

    const result = await processBatchAnchors();

    expect(result.processed).toBe(3);
    expect(result.batchId).toMatch(/^batch_\d+_3$/);
    expect(result.merkleRoot).toBeTruthy();
    expect(result.txId).toBe(MOCK_RECEIPT.receiptId);
  });

  it('submits the Merkle root (not individual fingerprints) to chain', async () => {
    limitMock.mockResolvedValue({
      data: [ANCHOR_A, ANCHOR_B],
      error: null,
    });

    await processBatchAnchors();

    // Only one chain submission for the batch
    expect(mockSubmitFingerprint).toHaveBeenCalledOnce();

    // The submitted fingerprint should be the Merkle root, not an individual fingerprint
    const submittedFp = mockSubmitFingerprint.mock.calls[0][0].fingerprint;
    expect(submittedFp).not.toBe(ANCHOR_A.fingerprint);
    expect(submittedFp).not.toBe(ANCHOR_B.fingerprint);
    expect(submittedFp).toHaveLength(64); // SHA-256 hex
  });

  it('updates each anchor with chain receipt data', async () => {
    limitMock.mockResolvedValue({
      data: [ANCHOR_A, ANCHOR_B],
      error: null,
    });

    await processBatchAnchors();

    // Two updates (one per anchor)
    expect(mockAnchorsUpdate).toHaveBeenCalledTimes(2);
    expect(mockUpdateEq).toHaveBeenCalledTimes(2);

    // Each update includes chain info
    expect(mockAnchorsUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'SUBMITTED',
        chain_tx_id: MOCK_RECEIPT.receiptId,
        chain_block_height: MOCK_RECEIPT.blockHeight,
        chain_timestamp: MOCK_RECEIPT.blockTimestamp,
      }),
    );
  });

  it('stores Merkle proof in metadata for each anchor', async () => {
    limitMock.mockResolvedValue({
      data: [ANCHOR_A, ANCHOR_B],
      error: null,
    });

    await processBatchAnchors();

    // Each anchor's metadata should contain its Merkle proof
    for (const call of mockAnchorsUpdate.mock.calls as unknown[][]) {
      const updatePayload = call[0] as Record<string, Record<string, unknown>>;
      expect(updatePayload.metadata).toBeDefined();
      expect(updatePayload.metadata.merkle_proof).toBeDefined();
      expect(updatePayload.metadata.merkle_root).toBeTruthy();
      expect(updatePayload.metadata.batch_id).toMatch(/^batch_/);
    }
  });

  it('marks all anchors as SUBMITTED after successful publish', async () => {
    limitMock.mockResolvedValue({
      data: [ANCHOR_A, ANCHOR_B, ANCHOR_C],
      error: null,
    });

    await processBatchAnchors();

    for (const call of mockAnchorsUpdate.mock.calls as unknown[][]) {
      expect((call[0] as Record<string, unknown>).status).toBe('SUBMITTED');
    }

    expect(mockUpdateEq).toHaveBeenCalledWith('id', 'anchor-a');
    expect(mockUpdateEq).toHaveBeenCalledWith('id', 'anchor-b');
    expect(mockUpdateEq).toHaveBeenCalledWith('id', 'anchor-c');
  });

  // ---- Chain publish failure ----

  it('returns 0 processed when chain submission fails', async () => {
    limitMock.mockResolvedValue({
      data: [ANCHOR_A, ANCHOR_B],
      error: null,
    });
    mockSubmitFingerprint.mockRejectedValue(new Error('chain unavailable'));

    const result = await processBatchAnchors();

    expect(result.processed).toBe(0);
    expect(result.merkleRoot).toBeTruthy(); // root was computed before failure
    expect(result.txId).toBeNull();
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it('does not update any anchors when chain submission fails', async () => {
    limitMock.mockResolvedValue({
      data: [ANCHOR_A, ANCHOR_B],
      error: null,
    });
    mockSubmitFingerprint.mockRejectedValue(new Error('timeout'));

    await processBatchAnchors();

    expect(mockAnchorsUpdate).not.toHaveBeenCalled();
  });

  // ---- Partial DB update failure ----

  it('continues updating remaining anchors when one update fails', async () => {
    limitMock.mockResolvedValue({
      data: [ANCHOR_A, ANCHOR_B, ANCHOR_C],
      error: null,
    });

    // First update fails, second and third succeed
    mockUpdateEq
      .mockResolvedValueOnce({ error: { message: 'constraint violation' } })
      .mockResolvedValueOnce({ error: null })
      .mockResolvedValueOnce({ error: null });

    const result = await processBatchAnchors();

    expect(result.processed).toBe(2);
    expect(mockAnchorsUpdate).toHaveBeenCalledTimes(3);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ anchorId: 'anchor-a' }),
      'Failed to update anchor in batch',
    );
  });

  // ---- Batch ID generation ----

  it('generates batch ID with timestamp and count', async () => {
    limitMock.mockResolvedValue({
      data: [ANCHOR_A, ANCHOR_B],
      error: null,
    });

    const result = await processBatchAnchors();

    expect(result.batchId).toMatch(/^batch_\d+_2$/);
  });

  // ---- Constants ----

  it('exports BATCH_SIZE as 50', () => {
    expect(BATCH_SIZE).toBe(50);
  });

  it('exports MIN_BATCH_SIZE as 2', () => {
    expect(MIN_BATCH_SIZE).toBe(2);
  });

  // ---- Logging ----

  it('logs completion info with batch details', async () => {
    limitMock.mockResolvedValue({
      data: [ANCHOR_A, ANCHOR_B],
      error: null,
    });

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
