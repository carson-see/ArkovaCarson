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
  mockChainIndexUpsert,
  mockDispatchWebhookEvent,
  mockLogger,
  anchorsTable,
  updateChain,
  selectChain,
} = vi.hoisted(() => {
  // Terminal operations — configured per test
  const mockSingle = vi.fn();
  const mockLimit = vi.fn();
  const mockUpdateEq = vi.fn();
  const mockAuditInsert = vi.fn();
  const mockChainIndexUpsert = vi.fn();
  const mockSubmitFingerprint = vi.fn();
  const mockDispatchWebhookEvent = vi.fn();

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
  const chainIndexTable = { upsert: mockChainIndexUpsert };

  const mockFrom = vi.fn((table: string) => {
    switch (table) {
      case 'anchors':
        return anchorsTable;
      case 'audit_events':
        return auditTable;
      case 'anchor_chain_index':
        return chainIndexTable;
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
    mockChainIndexUpsert,
    mockDispatchWebhookEvent,
    mockLogger,
    mockFrom,
    anchorsTable,
    auditTable,
    chainIndexTable,
    updateChain,
    selectChain,
  };
});

// ---- Module mocks ----

vi.mock('../utils/logger.js', () => ({
  logger: mockLogger,
  createRpcLogger: vi.fn(() => ({
    start: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock('../config.js', () => ({
  config: {
    chainNetwork: 'testnet' as const,
    nodeEnv: 'test',
    useMocks: true,
  },
  getNetworkDisplayName: vi.fn(() => 'Test Environment'),
}));

vi.mock('../chain/client.js', () => ({
  getInitializedChainClient: () => ({ submitFingerprint: mockSubmitFingerprint }),
}));

vi.mock('../webhooks/delivery.js', () => ({
  dispatchWebhookEvent: mockDispatchWebhookEvent,
}));

vi.mock('../utils/db.js', () => ({
  db: {
    from: vi.fn((table: string) => {
      switch (table) {
        case 'anchors':
          return anchorsTable;
        case 'audit_events':
          return { insert: mockAuditInsert };
        case 'anchor_chain_index':
          return { upsert: mockChainIndexUpsert };
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
    mockChainIndexUpsert.mockResolvedValue({ error: null });
    mockAuditInsert.mockResolvedValue({ error: null });
    mockDispatchWebhookEvent.mockResolvedValue(undefined);
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

    it('logs the chain error via RPC logger', async () => {
      const chainError = new Error('ETIMEDOUT: network timeout');
      mockSubmitFingerprint.mockRejectedValue(chainError);

      // DH-11: Error is now logged via createRpcLogger().error()
      const { createRpcLogger } = await import('../utils/logger.js');
      const mockRpcLog = (createRpcLogger as ReturnType<typeof vi.fn>).mock.results;

      await processAnchor('anchor-001');

      // createRpcLogger was called, and .error() was called on the returned logger
      expect(createRpcLogger).toHaveBeenCalledWith('processAnchor', { anchorId: 'anchor-001' });
      const lastRpcLog = mockRpcLog[mockRpcLog.length - 1].value;
      expect(lastRpcLog.error).toHaveBeenCalledWith(chainError);
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

  // ---- Chain index upsert (P7-TS-13) ----

  describe('chain index upsert', () => {
    it('upserts chain index entry after SECURED update', async () => {
      await processAnchor('anchor-001');

      expect(mockChainIndexUpsert).toHaveBeenCalledOnce();
      expect(mockChainIndexUpsert).toHaveBeenCalledWith(
        {
          fingerprint_sha256: MOCK_ANCHOR.fingerprint,
          chain_tx_id: MOCK_RECEIPT.receiptId,
          chain_block_height: MOCK_RECEIPT.blockHeight,
          chain_block_timestamp: MOCK_RECEIPT.blockTimestamp,
          confirmations: MOCK_RECEIPT.confirmations,
          anchor_id: 'anchor-001',
        },
        { onConflict: 'fingerprint_sha256,chain_tx_id' },
      );
    });

    it('still returns true when chain index upsert fails (non-fatal)', async () => {
      mockChainIndexUpsert.mockResolvedValue({
        error: { message: 'index write failed' },
      });

      const result = await processAnchor('anchor-001');

      expect(result).toBe(true);
    });

    it('logs a warning when chain index upsert fails', async () => {
      mockChainIndexUpsert.mockResolvedValue({
        error: { message: 'index write failed' },
      });

      await processAnchor('anchor-001');

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ anchorId: 'anchor-001' }),
        expect.stringContaining('chain index'),
      );
    });

    it('does not upsert chain index when anchor is not found', async () => {
      mockSingle.mockResolvedValue({ data: null, error: null });

      await processAnchor('nonexistent');

      expect(mockChainIndexUpsert).not.toHaveBeenCalled();
    });

    it('does not upsert chain index when chain submission fails', async () => {
      mockSubmitFingerprint.mockRejectedValue(new Error('timeout'));

      await processAnchor('anchor-001');

      expect(mockChainIndexUpsert).not.toHaveBeenCalled();
    });

    it('does not upsert chain index when DB update fails', async () => {
      mockUpdateEq.mockResolvedValue({
        error: { message: 'constraint violation' },
      });

      await processAnchor('anchor-001');

      expect(mockChainIndexUpsert).not.toHaveBeenCalled();
    });
  });

  // ---- HARDENING-4: Webhook dispatch ----

  describe('webhook dispatch', () => {
    it('dispatches anchor.secured webhook event after successful processing', async () => {
      await processAnchor('anchor-001');

      expect(mockDispatchWebhookEvent).toHaveBeenCalledOnce();
      expect(mockDispatchWebhookEvent).toHaveBeenCalledWith(
        MOCK_ANCHOR.org_id,
        'anchor.secured',
        'anchor-001',
        expect.objectContaining({
          anchor_id: 'anchor-001',
          fingerprint: MOCK_ANCHOR.fingerprint,
          status: 'SECURED',
          chain_tx_id: MOCK_RECEIPT.receiptId,
          chain_block_height: MOCK_RECEIPT.blockHeight,
          secured_at: MOCK_RECEIPT.blockTimestamp,
        }),
      );
    });

    it('includes public_id in webhook payload', async () => {
      mockSingle.mockResolvedValue({
        data: { ...MOCK_ANCHOR, public_id: 'pub-abc-123' },
        error: null,
      });

      await processAnchor('anchor-001');

      expect(mockDispatchWebhookEvent).toHaveBeenCalledWith(
        MOCK_ANCHOR.org_id,
        'anchor.secured',
        'anchor-001',
        expect.objectContaining({
          public_id: 'pub-abc-123',
        }),
      );
    });

    it('sends null public_id when anchor has no public_id', async () => {
      mockSingle.mockResolvedValue({
        data: { ...MOCK_ANCHOR, public_id: undefined },
        error: null,
      });

      await processAnchor('anchor-001');

      expect(mockDispatchWebhookEvent).toHaveBeenCalledWith(
        MOCK_ANCHOR.org_id,
        'anchor.secured',
        'anchor-001',
        expect.objectContaining({
          public_id: null,
        }),
      );
    });

    it('still returns true when webhook dispatch fails (non-fatal)', async () => {
      mockDispatchWebhookEvent.mockRejectedValue(new Error('webhook delivery failed'));

      const result = await processAnchor('anchor-001');

      expect(result).toBe(true);
    });

    it('logs a warning when webhook dispatch throws', async () => {
      mockDispatchWebhookEvent.mockRejectedValue(new Error('webhook delivery failed'));

      await processAnchor('anchor-001');

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ anchorId: 'anchor-001' }),
        expect.stringContaining('webhook'),
      );
    });

    it('skips webhook dispatch when anchor has no org_id', async () => {
      mockSingle.mockResolvedValue({
        data: { ...MOCK_ANCHOR, org_id: null },
        error: null,
      });

      await processAnchor('anchor-001');

      expect(mockDispatchWebhookEvent).not.toHaveBeenCalled();
    });

    it('does not dispatch webhook when anchor is not found', async () => {
      mockSingle.mockResolvedValue({ data: null, error: null });

      await processAnchor('nonexistent');

      expect(mockDispatchWebhookEvent).not.toHaveBeenCalled();
    });

    it('does not dispatch webhook when chain submission fails', async () => {
      mockSubmitFingerprint.mockRejectedValue(new Error('timeout'));

      await processAnchor('anchor-001');

      expect(mockDispatchWebhookEvent).not.toHaveBeenCalled();
    });

    it('does not dispatch webhook when DB update fails', async () => {
      mockUpdateEq.mockResolvedValue({
        error: { message: 'constraint violation' },
      });

      await processAnchor('anchor-001');

      expect(mockDispatchWebhookEvent).not.toHaveBeenCalled();
    });

    it('dispatches webhook even when audit event fails', async () => {
      mockAuditInsert.mockResolvedValue({
        error: { message: 'audit table full' },
      });

      await processAnchor('anchor-001');

      // Audit failure is non-fatal — webhook should still fire
      expect(mockDispatchWebhookEvent).toHaveBeenCalledOnce();
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
    mockChainIndexUpsert.mockResolvedValue({ error: null });
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

  // ---- HARDENING-2: Query shape verification ----

  describe('query shape', () => {
    it('queries anchors table', async () => {
      await processPendingAnchors();

      expect(db.from).toHaveBeenCalledWith('anchors');
    });

    it('selects only id column', async () => {
      await processPendingAnchors();

      expect(anchorsTable.select).toHaveBeenCalledWith('id');
    });

    it('filters by status PENDING', async () => {
      await processPendingAnchors();

      expect(selectChain.eq).toHaveBeenCalledWith('status', 'PENDING');
    });

    it('filters out soft-deleted records (deleted_at IS NULL)', async () => {
      await processPendingAnchors();

      expect(selectChain.is).toHaveBeenCalledWith('deleted_at', null);
    });

    it('limits batch size to 100', async () => {
      await processPendingAnchors();

      expect(mockLimit).toHaveBeenCalledWith(100);
    });
  });

  // ---- HARDENING-2: Processing order and isolation ----

  describe('processing order and failure isolation', () => {
    it('processes anchors sequentially (not in parallel)', async () => {
      const callOrder: string[] = [];

      mockLimit.mockResolvedValue({
        data: [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }],
        error: null,
      });

      // Track call order via submitFingerprint
      mockSingle
        .mockResolvedValueOnce({ data: { ...MOCK_ANCHOR, id: 'a1' }, error: null })
        .mockResolvedValueOnce({ data: { ...MOCK_ANCHOR, id: 'a2' }, error: null })
        .mockResolvedValueOnce({ data: { ...MOCK_ANCHOR, id: 'a3' }, error: null });

      mockSubmitFingerprint.mockImplementation(async () => {
        callOrder.push(`submit-${mockSubmitFingerprint.mock.calls.length}`);
        return MOCK_RECEIPT;
      });

      await processPendingAnchors();

      // Should process sequentially: submit-1, submit-2, submit-3
      expect(callOrder).toEqual(['submit-1', 'submit-2', 'submit-3']);
    });

    it('continues processing remaining anchors after one fails', async () => {
      mockLimit.mockResolvedValue({
        data: [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }],
        error: null,
      });

      // a1 succeeds, a2 chain timeout, a3 succeeds
      mockSingle
        .mockResolvedValueOnce({ data: { ...MOCK_ANCHOR, id: 'a1' }, error: null })
        .mockResolvedValueOnce({ data: { ...MOCK_ANCHOR, id: 'a2' }, error: null })
        .mockResolvedValueOnce({ data: { ...MOCK_ANCHOR, id: 'a3' }, error: null });

      mockSubmitFingerprint
        .mockResolvedValueOnce(MOCK_RECEIPT)        // a1 ok
        .mockRejectedValueOnce(new Error('timeout')) // a2 fails
        .mockResolvedValueOnce(MOCK_RECEIPT);        // a3 ok

      const result = await processPendingAnchors();

      expect(result).toEqual({ processed: 2, failed: 1 });
      // All three were attempted
      expect(mockSubmitFingerprint).toHaveBeenCalledTimes(3);
    });

    it('does not throw even when all anchors fail with exceptions', async () => {
      mockLimit.mockResolvedValue({
        data: [{ id: 'a1' }, { id: 'a2' }],
        error: null,
      });

      mockSingle.mockResolvedValue({ data: MOCK_ANCHOR, error: null });
      mockSubmitFingerprint.mockRejectedValue(new Error('chain down'));

      // Should not throw — failures are counted, not propagated
      const result = await processPendingAnchors();

      expect(result).toEqual({ processed: 0, failed: 2 });
    });

    it('logs total counts on completion', async () => {
      mockLimit.mockResolvedValue({
        data: [{ id: 'a1' }],
        error: null,
      });

      await processPendingAnchors();

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ processed: expect.any(Number), failed: expect.any(Number) }),
        'Finished processing pending anchors',
      );
    });
  });
});
