/**
 * Unit tests for processAnchor() and processPendingAnchors()
 *
 * HARDENING-1: Success path, network timeout, malformed receipt,
 * duplicate submission, DB update failure, audit event failure.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChainReceipt } from '../chain/types.js';

// ---- Hoisted mocks (available before vi.mock factories run) ----

const {
  mockSubmitFingerprint,
  mockSingle,
  mockLimit,
  mockUpdateEq,
  mockAuditInsert,
  mockLogger,
  anchorsTable,
  updateChain,
} = vi.hoisted(() => {
  // Terminal operations — configured per test
  const mockSingle = vi.fn();
  const mockLimit = vi.fn();
  const mockUpdateEq = vi.fn();
  const mockAuditInsert = vi.fn();
  const mockSubmitFingerprint = vi.fn();

  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  // Select chain: .select().eq().eq().single() or .select().eq().is().limit()
  const selectChain: Record<string, any> = {};
  selectChain.eq = vi.fn(() => selectChain);
  selectChain.is = vi.fn(() => selectChain);
  selectChain.single = mockSingle;
  selectChain.limit = mockLimit;

  // Update chain: .update({...}).eq('id', ...)
  const updateChain = { eq: mockUpdateEq };

  // Table mocks
  const anchorsTable = {
    select: vi.fn(() => selectChain),
    update: vi.fn(() => updateChain),
  };
  const auditTable = { insert: mockAuditInsert };

  const mockFrom = vi.fn((table: string) => {
    switch (table) {
      case 'anchors':
        return anchorsTable;
      case 'audit_events':
        return auditTable;
      default:
        return {};
    }
  });

  return {
    mockSubmitFingerprint,
    mockSingle,
    mockLimit,
    mockUpdateEq,
    mockAuditInsert,
    mockLogger,
    mockFrom,
    anchorsTable,
    auditTable,
    updateChain,
  };
});

// ---- Module mocks ----

vi.mock('../utils/logger.js', () => ({ logger: mockLogger }));

vi.mock('../config.js', () => ({
  config: {
    chainNetwork: 'testnet' as const,
    nodeEnv: 'test',
    useMocks: true,
  },
  getNetworkDisplayName: vi.fn(() => 'Test Environment'),
}));

vi.mock('../chain/client.js', () => ({
  chainClient: { submitFingerprint: mockSubmitFingerprint },
}));

vi.mock('../utils/db.js', () => ({
  db: {
    from: vi.fn((table: string) => {
      switch (table) {
        case 'anchors':
          return anchorsTable;
        case 'audit_events':
          return { insert: mockAuditInsert };
        default:
          return {};
      }
    }),
  },
}));

import { db } from '../utils/db.js';

// ---- System under test ----

import { processAnchor, processPendingAnchors } from './anchor.js';

// ---- Test fixtures ----

const MOCK_ANCHOR = {
  id: 'anchor-001',
  user_id: 'user-001',
  org_id: 'org-001',
  fingerprint: 'sha256-abc123def456789',
  status: 'PENDING',
  file_name: 'test-document.pdf',
  file_size: 1024,
  created_at: '2026-01-01T00:00:00Z',
  deleted_at: null,
};

const MOCK_RECEIPT: ChainReceipt = {
  receiptId: 'mock_receipt_123',
  blockHeight: 800001,
  blockTimestamp: '2026-01-01T00:01:00Z',
  confirmations: 6,
};

// ================================================================
// processAnchor
// ================================================================

describe('processAnchor', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Defaults: happy path
    mockSingle.mockResolvedValue({ data: MOCK_ANCHOR, error: null });
    mockSubmitFingerprint.mockResolvedValue(MOCK_RECEIPT);
    mockUpdateEq.mockResolvedValue({ error: null });
    mockAuditInsert.mockResolvedValue({ error: null });
  });

  // ---- Success path ----

  describe('success path', () => {
    it('returns true on successful processing', async () => {
      const result = await processAnchor('anchor-001');
      expect(result).toBe(true);
    });

    it('submits the anchor fingerprint to chain client', async () => {
      await processAnchor('anchor-001');

      expect(mockSubmitFingerprint).toHaveBeenCalledOnce();
      expect(mockSubmitFingerprint).toHaveBeenCalledWith({
        fingerprint: MOCK_ANCHOR.fingerprint,
        timestamp: expect.any(String),
      });
    });

    it('updates anchor status to SECURED with chain receipt data', async () => {
      await processAnchor('anchor-001');

      expect(anchorsTable.update).toHaveBeenCalledWith({
        status: 'SECURED',
        chain_tx_id: MOCK_RECEIPT.receiptId,
        chain_block_height: MOCK_RECEIPT.blockHeight,
        chain_timestamp: MOCK_RECEIPT.blockTimestamp,
      });
      expect(mockUpdateEq).toHaveBeenCalledWith('id', 'anchor-001');
    });

    it('logs audit event with correct metadata', async () => {
      await processAnchor('anchor-001');

      expect(mockAuditInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'anchor.secured',
          event_category: 'ANCHOR',
          actor_id: MOCK_ANCHOR.user_id,
          target_type: 'anchor',
          target_id: 'anchor-001',
          org_id: MOCK_ANCHOR.org_id,
        }),
      );
    });

    it('includes network display name in audit details', async () => {
      await processAnchor('anchor-001');

      expect(mockAuditInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          details: expect.stringContaining('Test Environment'),
        }),
      );
    });

    it('includes receipt ID in audit details', async () => {
      await processAnchor('anchor-001');

      expect(mockAuditInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          details: expect.stringContaining(MOCK_RECEIPT.receiptId),
        }),
      );
    });
  });

  // ---- Anchor not found / already processed (duplicate submission) ----

  describe('anchor not found or already processed', () => {
    it('returns false when anchor is not found', async () => {
      mockSingle.mockResolvedValue({ data: null, error: null });

      const result = await processAnchor('nonexistent');
      expect(result).toBe(false);
    });

    it('returns false when DB fetch returns an error', async () => {
      mockSingle.mockResolvedValue({
        data: null,
        error: { message: 'database error', code: '42P01' },
      });

      const result = await processAnchor('anchor-001');
      expect(result).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('does not call chain client when anchor is not found', async () => {
      mockSingle.mockResolvedValue({ data: null, error: null });

      await processAnchor('already-secured-anchor');

      expect(mockSubmitFingerprint).not.toHaveBeenCalled();
    });

    it('does not attempt DB update when anchor is not found', async () => {
      mockSingle.mockResolvedValue({ data: null, error: null });

      await processAnchor('missing');

      expect(anchorsTable.update).not.toHaveBeenCalled();
    });
  });

  // ---- Chain client failure (network timeout) ----

  describe('chain client failure', () => {
    it('returns false when chain client throws a network error', async () => {
      mockSubmitFingerprint.mockRejectedValue(new Error('ETIMEDOUT: network timeout'));

      const result = await processAnchor('anchor-001');
      expect(result).toBe(false);
    });

    it('returns false when chain client throws a connection error', async () => {
      mockSubmitFingerprint.mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await processAnchor('anchor-001');
      expect(result).toBe(false);
    });

    it('does not update anchor status on chain failure', async () => {
      mockSubmitFingerprint.mockRejectedValue(new Error('timeout'));

      await processAnchor('anchor-001');

      expect(anchorsTable.update).not.toHaveBeenCalled();
    });

    it('does not log audit event on chain failure', async () => {
      mockSubmitFingerprint.mockRejectedValue(new Error('timeout'));

      await processAnchor('anchor-001');

      expect(mockAuditInsert).not.toHaveBeenCalled();
    });

    it('logs the chain error', async () => {
      const chainError = new Error('ETIMEDOUT: network timeout');
      mockSubmitFingerprint.mockRejectedValue(chainError);

      await processAnchor('anchor-001');

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ anchorId: 'anchor-001', error: chainError }),
        'Failed to process anchor',
      );
    });
  });

  // ---- Malformed receipt ----

  describe('malformed receipt', () => {
    it('passes undefined receipt fields through to DB update', async () => {
      const malformedReceipt = {
        receiptId: 'receipt_no_block',
        blockHeight: undefined as unknown as number,
        blockTimestamp: undefined as unknown as string,
        confirmations: 0,
      };
      mockSubmitFingerprint.mockResolvedValue(malformedReceipt);

      const result = await processAnchor('anchor-001');

      // processAnchor does not validate receipt fields — passes them through
      expect(result).toBe(true);
      expect(anchorsTable.update).toHaveBeenCalledWith({
        status: 'SECURED',
        chain_tx_id: 'receipt_no_block',
        chain_block_height: undefined,
        chain_timestamp: undefined,
      });
    });
  });

  // ---- DB update failure after successful chain submission ----

  describe('DB update failure after chain submission', () => {
    it('returns false when anchor update fails', async () => {
      mockUpdateEq.mockResolvedValue({
        error: { message: 'constraint violation', code: '23505' },
      });

      const result = await processAnchor('anchor-001');
      expect(result).toBe(false);
    });

    it('logs the update error', async () => {
      const dbError = { message: 'constraint violation', code: '23505' };
      mockUpdateEq.mockResolvedValue({ error: dbError });

      await processAnchor('anchor-001');

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ anchorId: 'anchor-001', error: dbError }),
        'Failed to update anchor',
      );
    });

    it('does not log audit event when DB update fails', async () => {
      mockUpdateEq.mockResolvedValue({
        error: { message: 'constraint violation' },
      });

      await processAnchor('anchor-001');

      expect(mockAuditInsert).not.toHaveBeenCalled();
    });
  });

  // ---- Audit event failure (regression test for silent failure bug) ----

  describe('audit event failure', () => {
    it('still returns true when audit insert fails (anchor IS secured)', async () => {
      mockAuditInsert.mockResolvedValue({
        error: { message: 'audit table full' },
      });

      const result = await processAnchor('anchor-001');

      // Anchor was successfully secured on chain and in DB
      expect(result).toBe(true);
    });

    it('logs a warning when audit event insert fails', async () => {
      mockAuditInsert.mockResolvedValue({
        error: { message: 'audit table full' },
      });

      await processAnchor('anchor-001');

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ anchorId: 'anchor-001' }),
        expect.stringContaining('audit'),
      );
    });
  });
});

// ================================================================
// processPendingAnchors
// ================================================================

describe('processPendingAnchors', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: no pending anchors
    mockLimit.mockResolvedValue({ data: [], error: null });

    // Defaults for processAnchor internals
    mockSingle.mockResolvedValue({ data: MOCK_ANCHOR, error: null });
    mockSubmitFingerprint.mockResolvedValue(MOCK_RECEIPT);
    mockUpdateEq.mockResolvedValue({ error: null });
    mockAuditInsert.mockResolvedValue({ error: null });
  });

  it('returns zero counts when no pending anchors exist', async () => {
    mockLimit.mockResolvedValue({ data: [], error: null });

    const result = await processPendingAnchors();

    expect(result).toEqual({ processed: 0, failed: 0 });
  });

  it('returns zero counts when data is null', async () => {
    mockLimit.mockResolvedValue({ data: null, error: null });

    const result = await processPendingAnchors();

    expect(result).toEqual({ processed: 0, failed: 0 });
  });

  it('returns zero counts when fetch errors', async () => {
    mockLimit.mockResolvedValue({
      data: null,
      error: { message: 'connection timeout' },
    });

    const result = await processPendingAnchors();

    expect(result).toEqual({ processed: 0, failed: 0 });
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it('processes all pending anchors', async () => {
    mockLimit.mockResolvedValue({
      data: [{ id: 'a1' }, { id: 'a2' }],
      error: null,
    });

    const result = await processPendingAnchors();

    expect(result).toEqual({ processed: 2, failed: 0 });
    expect(mockSubmitFingerprint).toHaveBeenCalledTimes(2);
  });

  it('counts failures separately from successes', async () => {
    mockLimit.mockResolvedValue({
      data: [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }],
      error: null,
    });

    // a1 succeeds, a2 not found (returns false), a3 succeeds
    mockSingle
      .mockResolvedValueOnce({ data: { ...MOCK_ANCHOR, id: 'a1' }, error: null })
      .mockResolvedValueOnce({ data: null, error: null }) // a2 not found
      .mockResolvedValueOnce({ data: { ...MOCK_ANCHOR, id: 'a3' }, error: null });

    const result = await processPendingAnchors();

    expect(result).toEqual({ processed: 2, failed: 1 });
  });

  it('handles all anchors failing', async () => {
    mockLimit.mockResolvedValue({
      data: [{ id: 'a1' }, { id: 'a2' }],
      error: null,
    });

    // Both not found
    mockSingle.mockResolvedValue({ data: null, error: null });

    const result = await processPendingAnchors();

    expect(result).toEqual({ processed: 0, failed: 2 });
  });
});
