/**
 * Unit tests for processAttestationAnchoring()
 *
 * Tests: flag disabled, no pending attestations, successful anchoring,
 * chain submission failure, partial update failure, race condition.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Hoisted mocks ----
const {
  mockSubmitFingerprint,
  mockLogger,
  mockDbFrom,
  mockCallRpc,
} = vi.hoisted(() => {
  const mockSubmitFingerprint = vi.fn();
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  const mockCallRpc = vi.fn();
  const mockDbFrom = vi.fn();

  return { mockSubmitFingerprint, mockLogger, mockDbFrom, mockCallRpc };
});

// Mock modules
vi.mock('../utils/db.js', () => ({
  db: { from: mockDbFrom, rpc: vi.fn() },
}));

vi.mock('../utils/logger.js', () => ({
  logger: mockLogger,
}));

vi.mock('../utils/rpc.js', () => ({
  callRpc: mockCallRpc,
}));

vi.mock('../chain/client.js', () => ({
  getInitializedChainClient: () => ({
    submitFingerprint: mockSubmitFingerprint,
  }),
}));

vi.mock('../utils/merkle.js', () => ({
  buildMerkleTree: (fingerprints: string[]) => ({
    root: 'merkle_root_' + fingerprints.length,
    proofs: new Map(fingerprints.map((fp) => [fp, [`proof_${fp}`]])),
  }),
}));

import { processAttestationAnchoring, ATTESTATION_BATCH_SIZE } from './attestationAnchor.js';

describe('processAttestationAnchoring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should skip when ENABLE_ATTESTATION_ANCHORING flag is disabled', async () => {
    mockCallRpc.mockResolvedValueOnce({ data: false });

    const result = await processAttestationAnchoring();

    expect(result.processed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(mockCallRpc).toHaveBeenCalledWith(
      expect.anything(),
      'get_flag',
      { p_flag_key: 'ENABLE_ATTESTATION_ANCHORING' },
    );
    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('disabled'));
  });

  it('should return early when no pending attestations exist', async () => {
    mockCallRpc.mockResolvedValueOnce({ data: true });

    const queryChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      not: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: [], error: null }),
    };
    mockDbFrom.mockReturnValue(queryChain);

    const result = await processAttestationAnchoring();

    expect(result.processed).toBe(0);
    expect(result.txId).toBeNull();
    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('No pending'));
  });

  it('should anchor pending attestations and update to ACTIVE', async () => {
    mockCallRpc.mockResolvedValueOnce({ data: true });

    const mockAttestations = [
      { id: 'att-1', public_id: 'ARK-TST-VER-ABC123', fingerprint: 'fp_1' },
      { id: 'att-2', public_id: 'ARK-TST-AUD-DEF456', fingerprint: 'fp_2' },
    ];

    let callCount = 0;
    mockDbFrom.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          not: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue({ data: mockAttestations, error: null }),
        };
      }
      // Update calls — return data with one item to indicate row matched
      return {
        update: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              select: vi.fn().mockResolvedValue({ data: [{ id: 'updated' }], error: null }),
            }),
          }),
        }),
      };
    });

    mockSubmitFingerprint.mockResolvedValue({
      receiptId: 'tx_att_123',
      timestamp: new Date().toISOString(),
    });

    const result = await processAttestationAnchoring();

    expect(result.processed).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.txId).toBe('tx_att_123');
    expect(result.merkleRoot).toBe('merkle_root_2');
    expect(result.batchId).toMatch(/^att_batch_/);
    expect(mockSubmitFingerprint).toHaveBeenCalledWith({
      fingerprint: 'merkle_root_2',
      timestamp: expect.any(String),
    });
  });

  it('should handle chain submission failure gracefully', async () => {
    mockCallRpc.mockResolvedValueOnce({ data: true });

    const mockAttestations = [
      { id: 'att-1', public_id: 'ARK-TST-VER-ABC123', fingerprint: 'fp_1' },
    ];

    const queryChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      not: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: mockAttestations, error: null }),
    };
    mockDbFrom.mockReturnValue(queryChain);

    mockSubmitFingerprint.mockRejectedValue(new Error('Chain unavailable'));

    const result = await processAttestationAnchoring();

    expect(result.processed).toBe(0);
    expect(result.txId).toBeNull();
    expect(result.merkleRoot).toBe('merkle_root_1');
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ merkleRoot: 'merkle_root_1' }),
      expect.stringContaining('chain submission failed'),
    );
  });

  it('should handle DB fetch error', async () => {
    mockCallRpc.mockResolvedValueOnce({ data: true });

    const queryChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      not: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: null, error: { message: 'DB error' } }),
    };
    mockDbFrom.mockReturnValue(queryChain);

    const result = await processAttestationAnchoring();

    expect(result.processed).toBe(0);
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it('should detect race condition when attestation status changed', async () => {
    mockCallRpc.mockResolvedValueOnce({ data: true });

    const mockAttestations = [
      { id: 'att-1', public_id: 'ARK-TST-VER-ABC123', fingerprint: 'fp_1' },
    ];

    let callCount = 0;
    mockDbFrom.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          not: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue({ data: mockAttestations, error: null }),
        };
      }
      // Update returns empty array — row was already updated by another worker
      return {
        update: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              select: vi.fn().mockResolvedValue({ data: [], error: null }),
            }),
          }),
        }),
      };
    });

    mockSubmitFingerprint.mockResolvedValue({
      receiptId: 'tx_att_race',
      timestamp: new Date().toISOString(),
    });

    const result = await processAttestationAnchoring();

    expect(result.processed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.txId).toBe('tx_att_race');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ attestationId: 'att-1' }),
      expect.stringContaining('status changed'),
    );
  });

  it('should handle individual attestation update failure', async () => {
    mockCallRpc.mockResolvedValueOnce({ data: true });

    const mockAttestations = [
      { id: 'att-1', public_id: 'ARK-TST-VER-ABC123', fingerprint: 'fp_1' },
      { id: 'att-2', public_id: 'ARK-TST-AUD-DEF456', fingerprint: 'fp_2' },
    ];

    let callCount = 0;
    mockDbFrom.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          not: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue({ data: mockAttestations, error: null }),
        };
      }
      // First update succeeds, second fails
      const shouldFail = callCount === 3;
      return {
        update: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              select: vi.fn().mockResolvedValue({
                data: shouldFail ? null : [{ id: 'ok' }],
                error: shouldFail ? { message: 'Update failed' } : null,
              }),
            }),
          }),
        }),
      };
    });

    mockSubmitFingerprint.mockResolvedValue({
      receiptId: 'tx_att_456',
      timestamp: new Date().toISOString(),
    });

    const result = await processAttestationAnchoring();

    expect(result.processed).toBe(1);
    expect(result.txId).toBe('tx_att_456');
  });

  it('should export correct batch size constant', () => {
    expect(ATTESTATION_BATCH_SIZE).toBe(100);
  });
});
