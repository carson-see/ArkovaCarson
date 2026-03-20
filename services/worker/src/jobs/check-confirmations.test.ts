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
    chain.limit = vi.fn(() => mockAnchorsSelectResult);
    chain.single = vi.fn(() => ({
      data: { credential_type: 'DEGREE', metadata: { issuerName: 'Test Uni' } },
      error: null,
    }));
    return chain;
  };

  const makeUpdateChain = () => {
    const chain: Record<string, unknown> = {};
    chain.eq = vi.fn(() => {
      // Return a new chain-like with another .eq
      return { eq: vi.fn(() => mockAnchorsUpdateResult) };
    });
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
    mockAnchorsUpdateResult.error = null;
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

    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(MOCK_UNCONFIRMED_TX),
    });

    const result = await checkSubmittedConfirmations();
    expect(result).toEqual({ checked: 1, confirmed: 0 });
  });

  // ---- Confirmed (happy path) ----

  it('promotes SUBMITTED → SECURED when tx is confirmed', async () => {
    mockAnchorsSelectResult.data = [MOCK_SUBMITTED_ANCHOR];

    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(MOCK_CONFIRMED_TX),
    });

    const result = await checkSubmittedConfirmations();
    expect(result).toEqual({ checked: 1, confirmed: 1 });
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ anchorId: 'anchor-001', blockHeight: 200100 }),
      expect.stringContaining('SECURED'),
    );
  });

  it('upserts chain index after confirmation', async () => {
    mockAnchorsSelectResult.data = [MOCK_SUBMITTED_ANCHOR];

    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(MOCK_CONFIRMED_TX),
    });

    await checkSubmittedConfirmations();

    expect(mockChainIndexUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        fingerprint_sha256: MOCK_SUBMITTED_ANCHOR.fingerprint,
        chain_tx_id: MOCK_SUBMITTED_ANCHOR.chain_tx_id,
        chain_block_height: 200100,
        confirmations: 1,
        anchor_id: MOCK_SUBMITTED_ANCHOR.id,
      }),
      { onConflict: 'fingerprint_sha256,chain_tx_id' },
    );
  });

  it('logs anchor.secured audit event after confirmation', async () => {
    mockAnchorsSelectResult.data = [MOCK_SUBMITTED_ANCHOR];

    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(MOCK_CONFIRMED_TX),
    });

    await checkSubmittedConfirmations();

    expect(mockAuditInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'anchor.secured',
        event_category: 'ANCHOR',
        actor_id: MOCK_SUBMITTED_ANCHOR.user_id,
        target_type: 'anchor',
        target_id: MOCK_SUBMITTED_ANCHOR.id,
        org_id: MOCK_SUBMITTED_ANCHOR.org_id,
      }),
    );
  });

  it('dispatches anchor.secured webhook after confirmation', async () => {
    mockAnchorsSelectResult.data = [MOCK_SUBMITTED_ANCHOR];

    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(MOCK_CONFIRMED_TX),
    });

    await checkSubmittedConfirmations();

    expect(mockDispatchWebhookEvent).toHaveBeenCalledWith(
      MOCK_SUBMITTED_ANCHOR.org_id,
      'anchor.secured',
      MOCK_SUBMITTED_ANCHOR.id,
      expect.objectContaining({
        anchor_id: MOCK_SUBMITTED_ANCHOR.id,
        status: 'SECURED',
        chain_tx_id: MOCK_SUBMITTED_ANCHOR.chain_tx_id,
        chain_block_height: 200100,
      }),
    );
  });

  // ---- Mempool API errors ----

  it('handles mempool.space 404 gracefully', async () => {
    mockAnchorsSelectResult.data = [MOCK_SUBMITTED_ANCHOR];

    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
    });

    const result = await checkSubmittedConfirmations();
    expect(result).toEqual({ checked: 1, confirmed: 0 });
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('handles fetch network error gracefully', async () => {
    mockAnchorsSelectResult.data = [MOCK_SUBMITTED_ANCHOR];

    mockFetch.mockRejectedValue(new Error('ETIMEDOUT'));

    const result = await checkSubmittedConfirmations();
    expect(result).toEqual({ checked: 1, confirmed: 0 });
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  // ---- No org_id: skips webhook ----

  it('skips webhook dispatch when anchor has no org_id', async () => {
    mockAnchorsSelectResult.data = [{ ...MOCK_SUBMITTED_ANCHOR, org_id: null }];

    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(MOCK_CONFIRMED_TX),
    });

    await checkSubmittedConfirmations();

    expect(mockDispatchWebhookEvent).not.toHaveBeenCalled();
  });

  // ---- Multiple anchors ----

  it('processes multiple anchors and counts correctly', async () => {
    const anchor2 = { ...MOCK_SUBMITTED_ANCHOR, id: 'anchor-002', chain_tx_id: 'tx-002' };
    mockAnchorsSelectResult.data = [MOCK_SUBMITTED_ANCHOR, anchor2];

    // First call: confirmed. Second call: unconfirmed
    mockFetch
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

  it('sends anchor_secured email after confirmation', async () => {
    mockAnchorsSelectResult.data = [MOCK_SUBMITTED_ANCHOR];

    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(MOCK_CONFIRMED_TX),
    });

    await checkSubmittedConfirmations();

    // Allow async fire-and-forget to settle
    await new Promise((r) => setTimeout(r, 50));

    expect(mockBuildAnchorSecuredEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientEmail: 'user@example.com',
        verificationUrl: expect.stringContaining('pub-001'),
      }),
    );

    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'user@example.com',
        emailType: 'anchor_secured',
        anchorId: MOCK_SUBMITTED_ANCHOR.id,
      }),
    );
  });

  it('does not fail confirmation when email send fails', async () => {
    mockAnchorsSelectResult.data = [MOCK_SUBMITTED_ANCHOR];
    mockSendEmail.mockRejectedValue(new Error('Resend API down'));

    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(MOCK_CONFIRMED_TX),
    });

    const result = await checkSubmittedConfirmations();
    // Confirmation should still succeed even if email fails
    expect(result).toEqual({ checked: 1, confirmed: 1 });
  });
});
