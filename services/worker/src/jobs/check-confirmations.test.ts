/**
 * Unit tests for checkSubmittedConfirmations() (BETA-01)
 *
 * Tests the cron job that polls mempool.space and promotes
 * SUBMITTED → SECURED when a transaction is confirmed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---- Hoisted mocks ----

const {
  mockLogger,
  mockAuditInsert,
  mockChainIndexUpsert,
  mockDispatchWebhookEvent,
  mockFetch,
  mockAnchorsSelectResult,
  mockAnchorsUpdateResult,
  mockSendEmail,
  mockBuildAnchorSecuredEmail,
} = vi.hoisted(() => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  const mockAuditInsert = vi.fn();
  const mockChainIndexUpsert = vi.fn();
  const mockDispatchWebhookEvent = vi.fn();
  const mockFetch = vi.fn();
  const mockSendEmail = vi.fn();
  const mockBuildAnchorSecuredEmail = vi.fn();

  // Configurable results per test
  const mockAnchorsSelectResult: { data: unknown; error: unknown } = { data: [], error: null };
  const mockAnchorsUpdateResult: { error: unknown } = { error: null };

  return {
    mockLogger,
    mockAuditInsert,
    mockChainIndexUpsert,
    mockDispatchWebhookEvent,
    mockFetch,
    mockAnchorsSelectResult,
    mockAnchorsUpdateResult,
    mockSendEmail,
    mockBuildAnchorSecuredEmail,
  };
});

// ---- Module mocks ----

vi.mock('../utils/logger.js', () => ({
  logger: mockLogger,
}));

vi.mock('../config.js', () => ({
  config: {
    bitcoinNetwork: 'testnet4' as const,
    nodeEnv: 'development',
    useMocks: false,
    mempoolApiUrl: undefined,
    frontendUrl: 'http://localhost:5173',
  },
}));

vi.mock('../webhooks/delivery.js', () => ({
  dispatchWebhookEvent: mockDispatchWebhookEvent,
}));

vi.mock('../email/index.js', () => ({
  sendEmail: mockSendEmail,
  buildAnchorSecuredEmail: mockBuildAnchorSecuredEmail,
}));

vi.mock('../middleware/aiFeatureGate.js', () => ({
  isSemanticSearchEnabled: vi.fn().mockResolvedValue(false),
}));

vi.mock('../ai/embeddings.js', () => ({
  generateAndStoreEmbedding: vi.fn(),
}));

vi.mock('../ai/factory.js', () => ({
  createAIProvider: vi.fn(),
}));

vi.mock('../utils/db.js', () => {
  // Build chainable mock objects
  const makeSelectChain = () => {
    const chain: Record<string, unknown> = {};
    chain.eq = vi.fn(() => chain);
    chain.not = vi.fn(() => chain);
    chain.is = vi.fn(() => chain);
    chain.order = vi.fn(() => chain);
    chain.limit = vi.fn(() => mockAnchorsSelectResult);
    chain.single = vi.fn(() => ({
      data: { credential_type: 'DEGREE', metadata: { issuerName: 'Test Uni' } },
      error: null,
    }));
    return chain;
  };

  const makeUpdateChain = () => {
    const chain: Record<string, unknown> = {};
    // Support chained .eq().eq() — first .eq() returns chain, second returns result
    let eqCallCount = 0;
    chain.eq = vi.fn(() => {
      eqCallCount++;
      return eqCallCount >= 2 ? mockAnchorsUpdateResult : chain;
    });
    chain.in = vi.fn(() => chain);
    return chain;
  };

  // Chainable mock for profile/org lookups (single result)
  const makeProfileChain = (result: unknown) => {
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.single = vi.fn(() => result);
    chain.maybeSingle = vi.fn(() => result);
    return chain;
  };

  return {
    db: {
      from: vi.fn((table: string) => {
        switch (table) {
          case 'anchors':
            return {
              select: vi.fn(() => makeSelectChain()),
              update: vi.fn(() => makeUpdateChain()),
            };
          case 'audit_events':
            return { insert: mockAuditInsert };
          case 'anchor_chain_index':
            return { upsert: mockChainIndexUpsert };
          case 'profiles':
            return makeProfileChain({ data: { email: 'user@example.com' }, error: null });
          case 'organizations':
            return makeProfileChain({ data: { display_name: 'Test Org' }, error: null });
          default:
            return {};
        }
      }),
      // RACE-3: Advisory lock mock — always returns true (lock acquired).
      // 2026-04-29: also handles drain_submitted_to_secured_for_tx — returns
      // a single batch's worth then 0 to terminate the worker's drain loop.
      rpc: vi.fn((name: string) => {
        if (name === 'drain_submitted_to_secured_for_tx') {
          // First call returns 1 row updated (test fixtures use 1-2 anchors
          // per tx). capped=false signals the worker drain loop to exit.
          return {
            data: {
              updated: 1,
              capped: false,
              anchors: [{ public_id: 'pub-001', org_id: 'org-001' }],
            },
            error: null,
          };
        }
        return { data: true, error: null };
      }),
    },
  };
});

// ---- System under test ----

import { checkSubmittedConfirmations } from './check-confirmations.js';

// ---- Fixtures ----

const MOCK_SUBMITTED_ANCHOR = {
  id: 'anchor-001',
  chain_tx_id: 'abc123def456',
  user_id: 'user-001',
  org_id: 'org-001',
  fingerprint: 'a'.repeat(64),
  public_id: 'pub-001',
};

const MOCK_CONFIRMED_TX = {
  txid: 'abc123def456',
  status: {
    confirmed: true,
    block_height: 200100,
    block_time: 1700000000,
    block_hash: 'blockhash123',
  },
};

const MOCK_UNCONFIRMED_TX = {
  txid: 'abc123def456',
  status: {
    confirmed: false,
  },
};

// ================================================================

describe('checkSubmittedConfirmations', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();

    globalThis.fetch = mockFetch;

    // Defaults
    mockAnchorsSelectResult.data = [];
    mockAnchorsSelectResult.error = null;
    (mockAnchorsUpdateResult as Record<string, unknown>).error = null;
    (mockAnchorsUpdateResult as Record<string, unknown>).count = 1;
    mockAuditInsert.mockResolvedValue({ error: null });
    mockChainIndexUpsert.mockResolvedValue({ error: null });
    mockDispatchWebhookEvent.mockResolvedValue(undefined);
    mockSendEmail.mockResolvedValue({ success: true, messageId: 'msg-001' });
    mockBuildAnchorSecuredEmail.mockReturnValue({ subject: 'Test Subject', html: '<p>test</p>' });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // ---- No work ----

  it('returns { checked: 0, confirmed: 0 } when no SUBMITTED anchors exist', async () => {
    mockAnchorsSelectResult.data = [];

    const result = await checkSubmittedConfirmations();
    expect(result).toEqual({ checked: 0, confirmed: 0 });
  });

  it('returns { checked: 0, confirmed: 0 } on DB fetch error', async () => {
    mockAnchorsSelectResult.data = null;
    mockAnchorsSelectResult.error = { message: 'DB error' };

    const result = await checkSubmittedConfirmations();
    expect(result).toEqual({ checked: 0, confirmed: 0 });
    expect(mockLogger.error).toHaveBeenCalled();
  });

  // ---- Unconfirmed ----

  it('does not promote anchor when tx is unconfirmed', async () => {
    mockAnchorsSelectResult.data = [MOCK_SUBMITTED_ANCHOR];

    mockFetch
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('200200') }) // tip height
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(MOCK_UNCONFIRMED_TX),
      });

    const result = await checkSubmittedConfirmations();
    expect(result).toEqual({ checked: 1, confirmed: 0 });
  });

  // ---- Confirmed (happy path) ----

  it('promotes SUBMITTED → SECURED when tx is confirmed', async () => {
    mockAnchorsSelectResult.data = [MOCK_SUBMITTED_ANCHOR];

    mockFetch
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('200200') }) // tip height
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(MOCK_CONFIRMED_TX),
      });

    const result = await checkSubmittedConfirmations();
    expect(result).toEqual({ checked: 1, confirmed: 1 });
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ txId: MOCK_SUBMITTED_ANCHOR.chain_tx_id, blockHeight: 200100 }),
      expect.stringContaining('confirmed'),
    );
  });

  it('inserts audit events after confirmation', async () => {
    mockAnchorsSelectResult.data = [MOCK_SUBMITTED_ANCHOR];

    mockFetch
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('200200') }) // tip height
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(MOCK_CONFIRMED_TX),
      });

    await checkSubmittedConfirmations();

    // The grouped path inserts a single batch audit event per TX
    expect(mockAuditInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'anchor.batch_secured',
        event_category: 'ANCHOR',
        target_type: 'anchor',
        target_id: MOCK_SUBMITTED_ANCHOR.chain_tx_id,
      }),
    );
  });

  it('logs bulk confirmed anchor group info', async () => {
    mockAnchorsSelectResult.data = [MOCK_SUBMITTED_ANCHOR];

    mockFetch
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('200200') }) // tip height
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(MOCK_CONFIRMED_TX),
      });

    await checkSubmittedConfirmations();

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        txId: MOCK_SUBMITTED_ANCHOR.chain_tx_id,
        confirmed: 1,
        blockHeight: 200100,
      }),
      expect.stringContaining('Bulk confirmed'),
    );
  });

  it('returns correct count when confirmation succeeds', async () => {
    mockAnchorsSelectResult.data = [MOCK_SUBMITTED_ANCHOR];

    mockFetch
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('200200') }) // tip height
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(MOCK_CONFIRMED_TX),
      });

    const result = await checkSubmittedConfirmations();
    expect(result.confirmed).toBe(1);
    expect(result.checked).toBe(1);
  });

  // ---- Mempool API errors ----

  it('handles mempool.space 404 gracefully', async () => {
    mockAnchorsSelectResult.data = [MOCK_SUBMITTED_ANCHOR];

    mockFetch
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('200200') }) // tip height
      .mockResolvedValue({
        ok: false,
        status: 404,
      });

    const result = await checkSubmittedConfirmations();
    expect(result).toEqual({ checked: 1, confirmed: 0 });
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('handles fetch network error gracefully', async () => {
    mockAnchorsSelectResult.data = [MOCK_SUBMITTED_ANCHOR];

    mockFetch
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('200200') }) // tip height
      .mockRejectedValue(new Error('ETIMEDOUT'));

    const result = await checkSubmittedConfirmations();
    expect(result).toEqual({ checked: 1, confirmed: 0 });
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  // ---- No org_id: skips webhook ----

  it('confirms anchor when anchor has no org_id', async () => {
    mockAnchorsSelectResult.data = [{ ...MOCK_SUBMITTED_ANCHOR, org_id: null }];

    mockFetch
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('200200') }) // tip height
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(MOCK_CONFIRMED_TX),
      });

    const result = await checkSubmittedConfirmations();
    expect(result.confirmed).toBe(1);
  });

  // ---- Multiple anchors ----

  it('processes multiple anchors and counts correctly', async () => {
    const anchor2 = { ...MOCK_SUBMITTED_ANCHOR, id: 'anchor-002', chain_tx_id: 'tx-002' };
    mockAnchorsSelectResult.data = [MOCK_SUBMITTED_ANCHOR, anchor2];

    // First call: tip height. Second call: confirmed. Third call: unconfirmed.
    mockFetch
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('200200') }) // tip height
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(MOCK_CONFIRMED_TX),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(MOCK_UNCONFIRMED_TX),
      });

    const result = await checkSubmittedConfirmations();
    expect(result).toEqual({ checked: 2, confirmed: 1 });
  });

  // ---- Email notifications ----

  it('confirms anchors via grouped bulk update path', async () => {
    mockAnchorsSelectResult.data = [MOCK_SUBMITTED_ANCHOR];

    mockFetch
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('200200') }) // tip height
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(MOCK_CONFIRMED_TX),
      });

    const result = await checkSubmittedConfirmations();
    // Grouped path should confirm the anchor
    expect(result).toEqual({ checked: 1, confirmed: 1 });
  });

  it('handles DB update error without crashing', async () => {
    mockAnchorsSelectResult.data = [MOCK_SUBMITTED_ANCHOR];

    // 2026-04-29: error propagation now flows through the
    // drain_submitted_to_secured_for_tx RPC, not the chained .update().
    // Override the rpc mock for this case to return an error.
    const { db } = await import('../utils/db.js');
    const rpcSpy = vi.spyOn(db, 'rpc').mockImplementation(((name: string) => {
      if (name === 'drain_submitted_to_secured_for_tx') {
        return Promise.resolve({ data: null, error: { message: 'DB error' } });
      }
      return Promise.resolve({ data: true, error: null });
    }) as never);

    mockFetch
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('200200') }) // tip height
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(MOCK_CONFIRMED_TX),
      });

    const result = await checkSubmittedConfirmations();
    // Update failed so confirmed should be 0
    expect(result.checked).toBe(1);
    expect(result.confirmed).toBe(0);
    expect(mockLogger.error).toHaveBeenCalled();

    rpcSpy.mockRestore();
  });
});
