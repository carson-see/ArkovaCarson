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
  mockAuditInsert,
  mockChainIndexUpsert,
  mockDispatchWebhookEvent,
  mockLogger,
  anchorsTable,
  setUpdateResult,
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
  const selectChain: Record<string, unknown> = {};
  selectChain.eq = vi.fn(() => selectChain);
  selectChain.is = vi.fn(() => selectChain);
  selectChain.single = mockSingle;
  selectChain.limit = mockLimit;

  // Update chain: .update({...}).eq('id', ...).eq('status', ...) — supports chaining
  // RACE-1: Now chains two .eq() calls. Chain is thenable (like Supabase's query builder).
  let updateResult: Record<string, unknown> = { error: null, count: 1 };
  const updateChain: Record<string, unknown> = {};
  updateChain.eq = vi.fn(() => updateChain);
  updateChain.then = (resolve?: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
    return Promise.resolve(updateResult).then(resolve, reject);
  };

  // Helper to configure the update result per test
  const setUpdateResult = (result: Record<string, unknown>) => {
    updateResult = result;
  };

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
    setUpdateResult,
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

const mockRpc = vi.hoisted(() => vi.fn());

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
    rpc: mockRpc,
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
  fingerprint: 'a'.repeat(64), // Valid 64-char hex SHA-256
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
    setUpdateResult({ error: null, count: 1 });
    mockChainIndexUpsert.mockResolvedValue({ error: null });
    mockAuditInsert.mockResolvedValue({ error: null });
    mockDispatchWebhookEvent.mockResolvedValue(undefined);
    mockRpc.mockResolvedValue({ data: true, error: null });
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

    it('updates anchor status to SUBMITTED with chain receipt data (BETA-01)', async () => {
      await processAnchor('anchor-001');

      expect(anchorsTable.update).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'SUBMITTED',
          chain_tx_id: MOCK_RECEIPT.receiptId,
          chain_block_height: MOCK_RECEIPT.blockHeight,
          chain_timestamp: MOCK_RECEIPT.blockTimestamp,
        }),
      );
      expect(updateChain.eq).toHaveBeenCalledWith('id', 'anchor-001');
    });

    it('stores _metadata_hash in metadata JSON when receipt includes metadataHash (DEMO-01)', async () => {
      // Anchor with metadata
      const anchorWithMetadata = {
        ...MOCK_ANCHOR,
        metadata: { degree: 'BS Computer Science', institution: 'University of Michigan' },
      };
      mockSingle.mockResolvedValue({ data: anchorWithMetadata, error: null });

      const receiptWithHash: ChainReceipt = {
        ...MOCK_RECEIPT,
        metadataHash: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
      };
      mockSubmitFingerprint.mockResolvedValue(receiptWithHash);

      await processAnchor('anchor-001');

      expect(anchorsTable.update).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'SUBMITTED',
          metadata: expect.objectContaining({
            degree: 'BS Computer Science',
            institution: 'University of Michigan',
            _metadata_hash: receiptWithHash.metadataHash,
          }),
        }),
      );
    });

    it('does not add _metadata_hash when receipt has no metadataHash (DEMO-01)', async () => {
      // Reset to anchor without metadata
      mockSingle.mockResolvedValue({ data: MOCK_ANCHOR, error: null });
      mockSubmitFingerprint.mockResolvedValue(MOCK_RECEIPT);

      await processAnchor('anchor-001');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const updateCalls = anchorsTable.update.mock.calls as any[];
      const updateArg = (updateCalls.length > 0 ? updateCalls[0][0] : {}) as Record<string, unknown>;
      expect(updateArg.metadata).toBeUndefined();
    });

    it('logs audit event with anchor.submitted type (BETA-01)', async () => {
      await processAnchor('anchor-001');

      expect(mockAuditInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'anchor.submitted',
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
      expect(anchorsTable.update).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'SUBMITTED',
          chain_tx_id: 'receipt_no_block',
          chain_block_height: undefined,
          chain_timestamp: undefined,
        }),
      );
    });
  });

  // ---- DB update failure after successful chain submission ----

  describe('DB update failure after chain submission', () => {
    it('returns false when anchor update fails', async () => {
      setUpdateResult({
        error: { message: 'constraint violation', code: '23505' },
      });

      const result = await processAnchor('anchor-001');
      expect(result).toBe(false);
    });

    it('logs the update error', async () => {
      const dbError = { message: 'constraint violation', code: '23505' };
      setUpdateResult({ error: dbError });

      await processAnchor('anchor-001');

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ anchorId: 'anchor-001', error: dbError }),
        'Failed to update anchor',
      );
    });

    it('does not log audit event when DB update fails', async () => {
      setUpdateResult({
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

  // ---- Fingerprint validation ----

  describe('fingerprint validation', () => {
    it('returns false when fingerprint is missing', async () => {
      mockSingle.mockResolvedValue({
        data: { ...MOCK_ANCHOR, fingerprint: '' },
        error: null,
      });
      const result = await processAnchor('anchor-001');
      expect(result).toBe(false);
      expect(mockSubmitFingerprint).not.toHaveBeenCalled();
    });

    it('returns false when fingerprint is not 64 hex chars', async () => {
      mockSingle.mockResolvedValue({
        data: { ...MOCK_ANCHOR, fingerprint: 'not-a-valid-hash' },
        error: null,
      });
      const result = await processAnchor('anchor-001');
      expect(result).toBe(false);
      expect(mockSubmitFingerprint).not.toHaveBeenCalled();
    });

    it('returns false when fingerprint is null', async () => {
      mockSingle.mockResolvedValue({
        data: { ...MOCK_ANCHOR, fingerprint: null },
        error: null,
      });
      const result = await processAnchor('anchor-001');
      expect(result).toBe(false);
      expect(mockSubmitFingerprint).not.toHaveBeenCalled();
    });

    it('accepts valid uppercase hex fingerprint', async () => {
      mockSingle.mockResolvedValue({
        data: { ...MOCK_ANCHOR, fingerprint: 'A'.repeat(64) },
        error: null,
      });
      const result = await processAnchor('anchor-001');
      expect(result).toBe(true);
      expect(mockSubmitFingerprint).toHaveBeenCalled();
    });
  });

  // ---- Chain index upsert moved to check-confirmations (BETA-01) ----

  describe('chain index upsert (BETA-01: deferred to confirmation checker)', () => {
    it('does not upsert chain index at submission time (deferred to confirmation)', async () => {
      await processAnchor('anchor-001');

      expect(mockChainIndexUpsert).not.toHaveBeenCalled();
    });
  });

  // ---- HARDENING-4: Webhook dispatch ----

  describe('webhook dispatch', () => {
    it('dispatches anchor.submitted webhook event after successful processing (BETA-01)', async () => {
      await processAnchor('anchor-001');

      expect(mockDispatchWebhookEvent).toHaveBeenCalledOnce();
      expect(mockDispatchWebhookEvent).toHaveBeenCalledWith(
        MOCK_ANCHOR.org_id,
        'anchor.submitted',
        'anchor-001',
        expect.objectContaining({
          anchor_id: 'anchor-001',
          fingerprint: MOCK_ANCHOR.fingerprint,
          status: 'SUBMITTED',
          chain_tx_id: MOCK_RECEIPT.receiptId,
          submitted_at: MOCK_RECEIPT.blockTimestamp,
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
        'anchor.submitted',
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
        'anchor.submitted',
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
      setUpdateResult({
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
    setUpdateResult({ error: null, count: 1 });
    mockChainIndexUpsert.mockResolvedValue({ error: null });
    mockAuditInsert.mockResolvedValue({ error: null });
    mockRpc.mockResolvedValue({ data: true, error: null });
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
      data: [{ id: 'a1', metadata: null }, { id: 'a2', metadata: null }],
      error: null,
    });

    const result = await processPendingAnchors();

    expect(result).toEqual({ processed: 2, failed: 0 });
    expect(mockSubmitFingerprint).toHaveBeenCalledTimes(2);
  });

  it('counts failures separately from successes', async () => {
    mockLimit.mockResolvedValue({
      data: [{ id: 'a1', metadata: null }, { id: 'a2', metadata: null }, { id: 'a3', metadata: null }],
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
      data: [{ id: 'a1', metadata: null }, { id: 'a2', metadata: null }],
      error: null,
    });

    // Both not found
    mockSingle.mockResolvedValue({ data: null, error: null });

    const result = await processPendingAnchors();

    expect(result).toEqual({ processed: 0, failed: 2 });
  });

  // ---- Switchboard kill switch ----

  describe('switchboard flag check', () => {
    it('skips processing when switchboard flag is disabled', async () => {
      mockRpc.mockResolvedValue({ data: false, error: null });
      const result = await processPendingAnchors();
      expect(result).toEqual({ processed: 0, failed: 0 });
      expect(anchorsTable.select).not.toHaveBeenCalled();
    });

    it('proceeds when switchboard flag is enabled', async () => {
      mockRpc.mockResolvedValue({ data: true, error: null });
      mockLimit.mockResolvedValue({ data: [{ id: 'a1', metadata: null }], error: null });
      const result = await processPendingAnchors();
      expect(result.processed).toBe(1);
    });

    it('defaults to disabled when flag read fails (fail-closed)', async () => {
      mockRpc.mockResolvedValue({ data: null, error: { message: 'RPC error' } });
      mockLimit.mockResolvedValue({ data: [{ id: 'a1', metadata: null }], error: null });
      const result = await processPendingAnchors();
      expect(result).toEqual({ processed: 0, failed: 0 });
    });

    it('defaults to disabled when RPC throws (fail-closed)', async () => {
      mockRpc.mockRejectedValue(new Error('DB unreachable'));
      mockLimit.mockResolvedValue({ data: [{ id: 'a1', metadata: null }], error: null });
      const result = await processPendingAnchors();
      expect(result).toEqual({ processed: 0, failed: 0 });
    });

    it('defaults to disabled when flag data is not a boolean', async () => {
      mockRpc.mockResolvedValue({ data: 'true', error: null });
      mockLimit.mockResolvedValue({ data: [{ id: 'a1', metadata: null }], error: null });
      const result = await processPendingAnchors();
      expect(result).toEqual({ processed: 0, failed: 0 });
    });
  });

  // ---- HARDENING-2: Query shape verification ----

  describe('query shape', () => {
    it('queries anchors table', async () => {
      await processPendingAnchors();

      expect(db.from).toHaveBeenCalledWith('anchors');
    });

    it('selects id and metadata columns', async () => {
      await processPendingAnchors();

      expect(anchorsTable.select).toHaveBeenCalledWith('id, metadata');
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
        data: [{ id: 'a1', metadata: null }, { id: 'a2', metadata: null }, { id: 'a3', metadata: null }],
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
        data: [{ id: 'a1', metadata: null }, { id: 'a2', metadata: null }, { id: 'a3', metadata: null }],
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
        data: [{ id: 'a1', metadata: null }, { id: 'a2', metadata: null }],
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
        data: [{ id: 'a1', metadata: null }],
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
