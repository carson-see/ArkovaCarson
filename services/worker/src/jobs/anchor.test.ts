/**
 * Unit tests for processAnchor() and processPendingAnchors()
 *
 * HARDENING-1: Success path, network timeout, malformed receipt,
 * duplicate submission, DB update failure, audit event failure.
 *
 * Updated for claim-before-broadcast pattern (RACE-1):
 * processAnchor() now accepts a ClaimedAnchor (already BROADCASTING).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChainReceipt } from '../chain/types.js';

// ---- Hoisted mocks (available before vi.mock factories run) ----

const {
  mockSubmitFingerprint,
  mockLimit,
  mockAuditInsert,
  mockChainIndexUpsert,
  mockDispatchWebhookEvent,
  mockLogger,
  anchorsTable,
  setUpdateResult,
  _updateChain,
  _selectChain,
} = vi.hoisted(() => {
  // Terminal operations — configured per test
  const mockLimit = vi.fn();
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

  // Select chain: .select().eq().eq().single() or .select().eq().is().order().limit()
  const selectChain: Record<string, unknown> = {};
  selectChain.eq = vi.fn(() => selectChain);
  selectChain.is = vi.fn(() => selectChain);
  selectChain.order = vi.fn(() => selectChain);
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

  return {
    mockSubmitFingerprint,
    mockLimit,
    mockAuditInsert,
    mockChainIndexUpsert,
    mockDispatchWebhookEvent,
    mockLogger,
    anchorsTable,
    _updateChain: updateChain,
    _selectChain: selectChain,
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
    enableProdNetworkAnchoring: false,
    bitcoinNetwork: 'signet',
  },
  getNetworkDisplayName: vi.fn(() => 'Test Environment'),
}));

vi.mock('../chain/client.js', () => ({
  getInitializedChainClient: () => ({ submitFingerprint: mockSubmitFingerprint }),
  getChainClientAsync: () => Promise.resolve({ submitFingerprint: mockSubmitFingerprint }),
}));

vi.mock('../webhooks/delivery.js', () => ({
  dispatchWebhookEvent: mockDispatchWebhookEvent,
}));

// Mock billing modules added by M2M payments audit
vi.mock('../billing/paymentGuard.js', () => ({
  checkPaymentGuard: vi.fn().mockResolvedValue({
    authorized: true,
    source: { id: 'beta_override', type: 'beta_unlimited' },
  }),
}));

vi.mock('../billing/reconciliation.js', () => ({
  isFreeTierUser: vi.fn().mockResolvedValue(false),
  isWithinBatchWindow: vi.fn().mockReturnValue(true),
}));

vi.mock('../utils/rpc.js', () => ({
  callRpc: vi.fn().mockResolvedValue({ data: true, error: null }),
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
  // Pass-through in tests — no actual timeout
  withDbTimeout: vi.fn((fn: () => Promise<unknown>) => fn()),
}));

import { db as _db } from '../utils/db.js';

// ---- System under test ----

import { processAnchor, processPendingAnchors } from './anchor.js';
import type { ClaimedAnchor } from './anchor.js';

// ---- Test fixtures ----

const CLAIMED_ANCHOR: ClaimedAnchor = {
  id: 'anchor-001',
  user_id: 'user-001',
  org_id: 'org-001',
  fingerprint: 'a'.repeat(64), // Valid 64-char hex SHA-256
  public_id: 'pub-001',
  metadata: null,
  credential_type: null,
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
      const result = await processAnchor(CLAIMED_ANCHOR);
      expect(result).toBe(true);
    });

    it('submits the anchor fingerprint to chain client', async () => {
      await processAnchor(CLAIMED_ANCHOR);

      expect(mockSubmitFingerprint).toHaveBeenCalledOnce();
      expect(mockSubmitFingerprint).toHaveBeenCalledWith({
        fingerprint: CLAIMED_ANCHOR.fingerprint,
        timestamp: expect.any(String),
      });
    });

    it('updates anchor status to SUBMITTED with chain receipt data (BETA-01)', async () => {
      await processAnchor(CLAIMED_ANCHOR);

      expect(anchorsTable.update).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'SUBMITTED',
          chain_tx_id: MOCK_RECEIPT.receiptId,
          chain_block_height: MOCK_RECEIPT.blockHeight,
          chain_timestamp: MOCK_RECEIPT.blockTimestamp,
        }),
      );
      expect(_updateChain.eq).toHaveBeenCalledWith('id', 'anchor-001');
    });

    it('guards SUBMITTED update with BROADCASTING status (RACE-1)', async () => {
      await processAnchor(CLAIMED_ANCHOR);

      expect(_updateChain.eq).toHaveBeenCalledWith('status', 'BROADCASTING');
    });

    it('stores _metadata_hash in metadata JSON when receipt includes metadataHash (DEMO-01)', async () => {
      const anchorWithMetadata: ClaimedAnchor = {
        ...CLAIMED_ANCHOR,
        metadata: { degree: 'BS Computer Science', institution: 'University of Michigan' },
      };

      const receiptWithHash: ChainReceipt = {
        ...MOCK_RECEIPT,
        metadataHash: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
      };
      mockSubmitFingerprint.mockResolvedValue(receiptWithHash);

      await processAnchor(anchorWithMetadata);

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

    it('logs audit event with anchor.submitted type (BETA-01)', async () => {
      await processAnchor(CLAIMED_ANCHOR);

      expect(mockAuditInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'anchor.submitted',
          event_category: 'ANCHOR',
          actor_id: CLAIMED_ANCHOR.user_id,
          target_type: 'anchor',
          target_id: 'anchor-001',
          org_id: CLAIMED_ANCHOR.org_id,
        }),
      );
    });

    it('includes network display name in audit details', async () => {
      await processAnchor(CLAIMED_ANCHOR);

      expect(mockAuditInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          details: expect.stringContaining('Test Environment'),
        }),
      );
    });

    it('includes receipt ID in audit details', async () => {
      await processAnchor(CLAIMED_ANCHOR);

      expect(mockAuditInsert).toHaveBeenCalledWith(
        expect.objectContaining({
          details: expect.stringContaining(MOCK_RECEIPT.receiptId),
        }),
      );
    });
  });

  // ---- Chain client failure (network timeout) ----

  describe('chain client failure', () => {
    it('returns false when chain client throws a network error', async () => {
      mockSubmitFingerprint.mockRejectedValue(new Error('ETIMEDOUT: network timeout'));

      const result = await processAnchor(CLAIMED_ANCHOR);
      expect(result).toBe(false);
    });

    it('returns false when chain client throws a connection error', async () => {
      mockSubmitFingerprint.mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await processAnchor(CLAIMED_ANCHOR);
      expect(result).toBe(false);
    });

    it('does not update anchor status to SUBMITTED on chain failure', async () => {
      mockSubmitFingerprint.mockRejectedValue(new Error('timeout'));

      await processAnchor(CLAIMED_ANCHOR);

      // No SUBMITTED status update should have been called
      const statusUpdates = anchorsTable.update.mock.calls.filter(
        (call: unknown[]) => call[0] && (call[0] as Record<string, unknown>).status === 'SUBMITTED',
      );
      expect(statusUpdates.length).toBe(0);
    });

    it('does not log audit event on chain failure', async () => {
      mockSubmitFingerprint.mockRejectedValue(new Error('timeout'));

      await processAnchor(CLAIMED_ANCHOR);

      expect(mockAuditInsert).not.toHaveBeenCalled();
    });

    it('logs the chain error via RPC logger', async () => {
      const chainError = new Error('ETIMEDOUT: network timeout');
      mockSubmitFingerprint.mockRejectedValue(chainError);

      // DH-11: Error is now logged via createRpcLogger().error()
      const { createRpcLogger } = await import('../utils/logger.js');
      const mockRpcLog = (createRpcLogger as ReturnType<typeof vi.fn>).mock.results;

      await processAnchor(CLAIMED_ANCHOR);

      // createRpcLogger was called, and .error() was called on the returned logger
      expect(createRpcLogger).toHaveBeenCalledWith('processAnchor', { anchorId: 'anchor-001' });
      const lastRpcLog = mockRpcLog[mockRpcLog.length - 1].value;
      expect(lastRpcLog.error).toHaveBeenCalledWith(chainError);
    });

    it('reverts anchor to PENDING on chain failure', async () => {
      mockSubmitFingerprint.mockRejectedValue(new Error('timeout'));

      await processAnchor(CLAIMED_ANCHOR);

      // Should revert BROADCASTING → PENDING
      expect(anchorsTable.update).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'PENDING' }),
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

      const result = await processAnchor(CLAIMED_ANCHOR);

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

      const result = await processAnchor(CLAIMED_ANCHOR);
      expect(result).toBe(false);
    });

    it('logs the update error', async () => {
      const dbError = { message: 'constraint violation', code: '23505' };
      setUpdateResult({ error: dbError });

      await processAnchor(CLAIMED_ANCHOR);

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ anchorId: 'anchor-001', error: dbError }),
        'Failed to update anchor',
      );
    });

    it('does not log audit event when DB update fails', async () => {
      setUpdateResult({
        error: { message: 'constraint violation' },
      });

      await processAnchor(CLAIMED_ANCHOR);

      expect(mockAuditInsert).not.toHaveBeenCalled();
    });
  });

  // ---- Audit event failure (regression test for silent failure bug) ----

  describe('audit event failure', () => {
    it('still returns true when audit insert fails (anchor IS secured)', async () => {
      mockAuditInsert.mockResolvedValue({
        error: { message: 'audit table full' },
      });

      const result = await processAnchor(CLAIMED_ANCHOR);

      // Anchor was successfully secured on chain and in DB
      expect(result).toBe(true);
    });

    it('logs a warning when audit event insert fails', async () => {
      mockAuditInsert.mockResolvedValue({
        error: { message: 'audit table full' },
      });

      await processAnchor(CLAIMED_ANCHOR);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ anchorId: 'anchor-001' }),
        expect.stringContaining('audit'),
      );
    });
  });

  // ---- Fingerprint validation ----

  describe('fingerprint validation', () => {
    it('returns false when fingerprint is missing', async () => {
      const badAnchor: ClaimedAnchor = { ...CLAIMED_ANCHOR, fingerprint: '' };
      const result = await processAnchor(badAnchor);
      expect(result).toBe(false);
      expect(mockSubmitFingerprint).not.toHaveBeenCalled();
    });

    it('returns false when fingerprint is not 64 hex chars', async () => {
      const badAnchor: ClaimedAnchor = { ...CLAIMED_ANCHOR, fingerprint: 'not-a-valid-hash' };
      const result = await processAnchor(badAnchor);
      expect(result).toBe(false);
      expect(mockSubmitFingerprint).not.toHaveBeenCalled();
    });

    it('returns false when fingerprint is null', async () => {
      const badAnchor: ClaimedAnchor = { ...CLAIMED_ANCHOR, fingerprint: null as unknown as string };
      const result = await processAnchor(badAnchor);
      expect(result).toBe(false);
      expect(mockSubmitFingerprint).not.toHaveBeenCalled();
    });

    it('accepts valid uppercase hex fingerprint', async () => {
      const upperAnchor: ClaimedAnchor = { ...CLAIMED_ANCHOR, fingerprint: 'A'.repeat(64) };
      const result = await processAnchor(upperAnchor);
      expect(result).toBe(true);
      expect(mockSubmitFingerprint).toHaveBeenCalled();
    });
  });

  // ---- Chain index upsert moved to check-confirmations (BETA-01) ----

  describe('chain index upsert (BETA-01: deferred to confirmation checker)', () => {
    it('does not upsert chain index at submission time (deferred to confirmation)', async () => {
      await processAnchor(CLAIMED_ANCHOR);

      expect(mockChainIndexUpsert).not.toHaveBeenCalled();
    });
  });

  // ---- HARDENING-4: Webhook dispatch ----

  describe('webhook dispatch', () => {
    it('dispatches anchor.submitted webhook event after successful processing (BETA-01)', async () => {
      await processAnchor(CLAIMED_ANCHOR);

      expect(mockDispatchWebhookEvent).toHaveBeenCalledOnce();
      // SCRUM-1268 (R2-5): event_id is public_id (CLAUDE.md §6 bans
      // exposing anchors.id). Payload uses the strict AnchorSubmitted schema.
      expect(mockDispatchWebhookEvent).toHaveBeenCalledWith(
        CLAIMED_ANCHOR.org_id,
        'anchor.submitted',
        CLAIMED_ANCHOR.public_id,
        expect.objectContaining({
          public_id: CLAIMED_ANCHOR.public_id,
          status: 'SUBMITTED',
          chain_tx_id: MOCK_RECEIPT.receiptId,
          submitted_at: MOCK_RECEIPT.blockTimestamp,
        }),
      );
    });

    it('includes public_id in webhook payload', async () => {
      const anchorWithPublicId: ClaimedAnchor = { ...CLAIMED_ANCHOR, public_id: 'pub-abc-123' };

      await processAnchor(anchorWithPublicId);

      expect(mockDispatchWebhookEvent).toHaveBeenCalledWith(
        CLAIMED_ANCHOR.org_id,
        'anchor.submitted',
        'pub-abc-123',
        expect.objectContaining({
          public_id: 'pub-abc-123',
        }),
      );
    });

    it('skips webhook dispatch when anchor has no public_id', async () => {
      // SCRUM-1268 (R2-5): dispatch is gated on (org_id && public_id) — a
      // null public_id means there's nothing safe to expose, so the
      // dispatch is skipped silently.
      const anchorNoPublicId: ClaimedAnchor = { ...CLAIMED_ANCHOR, public_id: null };

      await processAnchor(anchorNoPublicId);

      expect(mockDispatchWebhookEvent).not.toHaveBeenCalled();
    });

    it('still returns true when webhook dispatch fails (non-fatal)', async () => {
      mockDispatchWebhookEvent.mockRejectedValue(new Error('webhook delivery failed'));

      const result = await processAnchor(CLAIMED_ANCHOR);

      expect(result).toBe(true);
    });

    it('logs a warning when webhook dispatch throws', async () => {
      mockDispatchWebhookEvent.mockRejectedValue(new Error('webhook delivery failed'));

      await processAnchor(CLAIMED_ANCHOR);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ anchorId: 'anchor-001' }),
        expect.stringContaining('webhook'),
      );
    });

    it('skips webhook dispatch when anchor has no org_id', async () => {
      const individualAnchor: ClaimedAnchor = { ...CLAIMED_ANCHOR, org_id: null };

      await processAnchor(individualAnchor);

      expect(mockDispatchWebhookEvent).not.toHaveBeenCalled();
    });

    it('does not dispatch webhook when chain submission fails', async () => {
      mockSubmitFingerprint.mockRejectedValue(new Error('timeout'));

      await processAnchor(CLAIMED_ANCHOR);

      expect(mockDispatchWebhookEvent).not.toHaveBeenCalled();
    });

    it('does not dispatch webhook when DB update fails', async () => {
      setUpdateResult({
        error: { message: 'constraint violation' },
      });

      await processAnchor(CLAIMED_ANCHOR);

      expect(mockDispatchWebhookEvent).not.toHaveBeenCalled();
    });

    it('dispatches webhook even when audit event fails', async () => {
      mockAuditInsert.mockResolvedValue({
        error: { message: 'audit table full' },
      });

      await processAnchor(CLAIMED_ANCHOR);

      // Audit failure is non-fatal — webhook should still fire
      expect(mockDispatchWebhookEvent).toHaveBeenCalledOnce();
    });
  });
});

// ================================================================
// processPendingAnchors
// ================================================================

describe('processPendingAnchors', () => {
  beforeEach(async () => {
    vi.clearAllMocks();

    // Reset callRpc to default (enabled) — switchboard tests override this
    const { callRpc } = await import('../utils/rpc.js');
    (callRpc as ReturnType<typeof vi.fn>).mockResolvedValue({ data: true, error: null });

    // Default: claim RPC returns empty
    mockRpc.mockResolvedValue({ data: [], error: null });
    mockLimit.mockResolvedValue({ data: [], error: null });

    // Defaults for processAnchor internals
    mockSubmitFingerprint.mockResolvedValue(MOCK_RECEIPT);
    setUpdateResult({ error: null, count: 1 });
    mockChainIndexUpsert.mockResolvedValue({ error: null });
    mockAuditInsert.mockResolvedValue({ error: null });
    mockDispatchWebhookEvent.mockResolvedValue(undefined);
  });

  it('returns zero counts when no pending anchors exist', async () => {
    // callRpc (get_flag) returns true, claim RPC returns empty
    mockRpc.mockResolvedValue({ data: [], error: null });

    const result = await processPendingAnchors();

    expect(result).toEqual({ processed: 0, failed: 0 });
  });

  it('processes claimed anchors via the claim RPC', async () => {
    mockRpc.mockResolvedValueOnce({
      data: [
        { ...CLAIMED_ANCHOR, id: 'a1' },
        { ...CLAIMED_ANCHOR, id: 'a2' },
      ],
      error: null,
    });

    const result = await processPendingAnchors();

    expect(result).toEqual({ processed: 2, failed: 0 });
    expect(mockSubmitFingerprint).toHaveBeenCalledTimes(2);
  });

  it('falls back to legacy path when claim RPC errors', async () => {
    // claim RPC fails
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'function not found' } });
    // Legacy select returns anchors
    mockLimit.mockResolvedValue({
      data: [
        { id: 'a1', user_id: 'user-001', org_id: 'org-001', fingerprint: 'a'.repeat(64), public_id: null, metadata: null, credential_type: null },
      ],
      error: null,
    });

    const _result = await processPendingAnchors();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(Object) }),
      expect.stringContaining('falling back to legacy'),
    );
  });

  it('counts failures separately from successes', async () => {
    mockRpc.mockResolvedValueOnce({
      data: [
        { ...CLAIMED_ANCHOR, id: 'a1', fingerprint: 'a'.repeat(64) },
        { ...CLAIMED_ANCHOR, id: 'a2', fingerprint: '' }, // invalid → will fail
        { ...CLAIMED_ANCHOR, id: 'a3', fingerprint: 'c'.repeat(64) },
      ],
      error: null,
    });

    const result = await processPendingAnchors();

    expect(result).toEqual({ processed: 2, failed: 1 });
  });

  // ---- Switchboard kill switch ----

  describe('switchboard flag check', () => {
    it('skips processing when switchboard flag is disabled', async () => {
      const { callRpc } = await import('../utils/rpc.js');
      (callRpc as ReturnType<typeof vi.fn>).mockResolvedValue({ data: false, error: null });

      const result = await processPendingAnchors();
      expect(result).toEqual({ processed: 0, failed: 0 });
    });

    it('defaults to disabled when flag read fails (fail-closed)', async () => {
      const { callRpc } = await import('../utils/rpc.js');
      (callRpc as ReturnType<typeof vi.fn>).mockResolvedValue({ data: null, error: { message: 'RPC error' } });

      const result = await processPendingAnchors();
      expect(result).toEqual({ processed: 0, failed: 0 });
    });

    it('defaults to disabled when RPC throws (fail-closed)', async () => {
      const { callRpc } = await import('../utils/rpc.js');
      (callRpc as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB unreachable'));

      const result = await processPendingAnchors();
      expect(result).toEqual({ processed: 0, failed: 0 });
    });
  });

  // ---- Processing order and isolation ----

  describe('processing order and failure isolation', () => {
    it('processes anchors sequentially (not in parallel)', async () => {
      const callOrder: string[] = [];

      mockRpc.mockResolvedValueOnce({
        data: [
          { ...CLAIMED_ANCHOR, id: 'a1' },
          { ...CLAIMED_ANCHOR, id: 'a2' },
          { ...CLAIMED_ANCHOR, id: 'a3' },
        ],
        error: null,
      });

      mockSubmitFingerprint.mockImplementation(async () => {
        callOrder.push(`submit-${mockSubmitFingerprint.mock.calls.length}`);
        return MOCK_RECEIPT;
      });

      await processPendingAnchors();

      // Should process sequentially: submit-1, submit-2, submit-3
      expect(callOrder).toEqual(['submit-1', 'submit-2', 'submit-3']);
    });

    it('continues processing remaining anchors after one fails', async () => {
      mockRpc.mockResolvedValueOnce({
        data: [
          { ...CLAIMED_ANCHOR, id: 'a1' },
          { ...CLAIMED_ANCHOR, id: 'a2' },
          { ...CLAIMED_ANCHOR, id: 'a3' },
        ],
        error: null,
      });

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
      mockRpc.mockResolvedValueOnce({
        data: [
          { ...CLAIMED_ANCHOR, id: 'a1' },
          { ...CLAIMED_ANCHOR, id: 'a2' },
        ],
        error: null,
      });

      mockSubmitFingerprint.mockRejectedValue(new Error('chain down'));

      // Should not throw — failures are counted, not propagated
      const result = await processPendingAnchors();

      expect(result).toEqual({ processed: 0, failed: 2 });
    });
  });
});
