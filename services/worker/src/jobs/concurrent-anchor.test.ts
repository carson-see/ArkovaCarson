/**
 * QA Audit Tests: Race Condition Fixes
 *
 * RACE-1: Status guard on anchor UPDATE prevents double-broadcast
 * RACE-2: Empty receipt validation prevents orphaned SUBMITTED anchors
 * RACE-5: Status guard on revocation UPDATE prevents concurrent overwrites
 *
 * Covers audit items #1, #3, #4, #5, #6, #7
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChainReceipt } from '../chain/types.js';

// ---- Hoisted mocks ----

const {
  mockSubmitFingerprint,
  mockSingle,
  mockAuditInsert,
  mockDispatchWebhookEvent,
  mockLogger,
  anchorsTable,
  selectChain,
  setUpdateResult,
} = vi.hoisted(() => {
  const mockSingle = vi.fn();
  const mockAuditInsert = vi.fn();
  const mockSubmitFingerprint = vi.fn();
  const mockDispatchWebhookEvent = vi.fn();

  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  const selectChain: Record<string, unknown> = {};
  selectChain.eq = vi.fn(() => selectChain);
  selectChain.is = vi.fn(() => selectChain);
  selectChain.single = mockSingle;
  selectChain.limit = vi.fn().mockResolvedValue({ data: [], error: null });

  // Update chain: thenable, supports chaining .eq().eq().is()
  let updateResult: Record<string, unknown> = { error: null, count: 1 };
  const updateChain: Record<string, unknown> = {};
  updateChain.eq = vi.fn(() => updateChain);
  updateChain.is = vi.fn(() => updateChain);
  updateChain.then = (resolve?: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
    return Promise.resolve(updateResult).then(resolve, reject);
  };
  const setUpdateResult = (result: Record<string, unknown>) => {
    updateResult = result;
  };

  const anchorsTable = {
    select: vi.fn(() => selectChain),
    update: vi.fn(() => updateChain),
  };

  return {
    mockSubmitFingerprint,
    mockSingle,
    mockAuditInsert,
    mockDispatchWebhookEvent,
    mockLogger,
    anchorsTable,
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
    bitcoinNetwork: 'signet',
  },
  getNetworkDisplayName: vi.fn(() => 'Test Environment'),
}));

vi.mock('../chain/client.js', () => ({
  getInitializedChainClient: () => ({ submitFingerprint: mockSubmitFingerprint }),
}));

vi.mock('../webhooks/delivery.js', () => ({
  dispatchWebhookEvent: mockDispatchWebhookEvent,
}));

vi.mock('../email/index.js', () => ({
  sendEmail: vi.fn(),
  buildRevocationEmail: vi.fn(() => ({ subject: 'test', html: '<p>test</p>' })),
}));

vi.mock('../utils/rpc.js', () => ({
  callRpc: vi.fn().mockResolvedValue({ data: true, error: null }),
}));

vi.mock('../utils/db.js', () => ({
  db: {
    from: vi.fn((table: string) => {
      if (table === 'anchors') return anchorsTable;
      if (table === 'audit_events') return { insert: mockAuditInsert };
      if (table === 'profiles') {
        const chain: Record<string, unknown> = {};
        chain.select = vi.fn(() => chain);
        chain.eq = vi.fn(() => chain);
        chain.single = vi.fn(() => Promise.resolve({ data: null, error: null }));
        return chain;
      }
      return {};
    }),
    rpc: vi.fn().mockResolvedValue({ data: true, error: null }),
  },
}));

// ---- System under test ----

import { processAnchor } from './anchor.js';
import { processRevocation } from './revocation.js';

// ---- Fixtures ----

const MOCK_ANCHOR = {
  id: 'anchor-001',
  user_id: 'user-001',
  org_id: 'org-001',
  fingerprint: 'a'.repeat(64),
  status: 'PENDING',
  metadata: null,
  deleted_at: null,
  chain_tx_id: null,
  public_id: 'pub-001',
};

const MOCK_REVOKED_ANCHOR = {
  ...MOCK_ANCHOR,
  id: 'anchor-revoked',
  status: 'REVOKED',
  chain_tx_id: 'original_tx_abc',
  revocation_tx_id: null,
};

const MOCK_RECEIPT: ChainReceipt = {
  receiptId: 'mock_receipt_123',
  blockHeight: 800001,
  blockTimestamp: '2026-01-01T00:01:00Z',
  confirmations: 6,
};

// ================================================================
// RACE-1: Status guard prevents double-broadcast
// ================================================================

describe('RACE-1: Anchor status guard on UPDATE', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSingle.mockResolvedValue({ data: MOCK_ANCHOR, error: null });
    mockSubmitFingerprint.mockResolvedValue(MOCK_RECEIPT);
    mockAuditInsert.mockResolvedValue({ error: null });
    mockDispatchWebhookEvent.mockResolvedValue(undefined);
    setUpdateResult({ error: null, count: 1 });
  });

  it('returns false when anchor already claimed by another worker (count=0)', async () => {
    setUpdateResult({ error: null, count: 0 });

    const result = await processAnchor('anchor-001');
    expect(result).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ anchorId: 'anchor-001' }),
      expect.stringContaining('already claimed'),
    );
  });

  it('succeeds when count > 0 (no concurrent contention)', async () => {
    setUpdateResult({ error: null, count: 1 });

    const result = await processAnchor('anchor-001');
    expect(result).toBe(true);
  });
});

// ================================================================
// RACE-2: Empty receipt validation
// ================================================================

describe('RACE-2: Validate broadcast response', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSingle.mockResolvedValue({ data: MOCK_ANCHOR, error: null });
    mockAuditInsert.mockResolvedValue({ error: null });
    setUpdateResult({ error: null, count: 1 });
  });

  it('returns false when chain client returns null receipt', async () => {
    mockSubmitFingerprint.mockResolvedValue(null);

    const result = await processAnchor('anchor-001');
    expect(result).toBe(false);
    expect(anchorsTable.update).not.toHaveBeenCalled();
  });

  it('returns false when receipt has empty receiptId', async () => {
    mockSubmitFingerprint.mockResolvedValue({
      ...MOCK_RECEIPT,
      receiptId: '',
    });

    const result = await processAnchor('anchor-001');
    expect(result).toBe(false);
    expect(anchorsTable.update).not.toHaveBeenCalled();
  });

  it('logs error with receipt details when broadcast is rejected', async () => {
    mockSubmitFingerprint.mockResolvedValue({ receiptId: null });

    await processAnchor('anchor-001');

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ anchorId: 'anchor-001' }),
      expect.stringContaining('empty receipt'),
    );
  });
});

// ================================================================
// RACE-5: Revocation status guard
// ================================================================

describe('RACE-5: Revocation status guard on UPDATE', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectChain.limit = vi.fn().mockResolvedValue({
      data: [MOCK_REVOKED_ANCHOR],
      error: null,
    });
    mockSubmitFingerprint.mockResolvedValue(MOCK_RECEIPT);
    mockAuditInsert.mockResolvedValue({ error: null });
    mockDispatchWebhookEvent.mockResolvedValue(undefined);
    setUpdateResult({ error: null, count: 1 });
  });

  it('returns false when revocation already processed (count=0)', async () => {
    setUpdateResult({ error: null, count: 0 });

    const result = await processRevocation('anchor-revoked');
    expect(result).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ anchorId: 'anchor-revoked' }),
      expect.stringContaining('already processed'),
    );
  });

  it('succeeds when count > 0 (no concurrent contention)', async () => {
    setUpdateResult({ error: null, count: 1 });

    const result = await processRevocation('anchor-revoked');
    expect(result).toBe(true);
  });
});
