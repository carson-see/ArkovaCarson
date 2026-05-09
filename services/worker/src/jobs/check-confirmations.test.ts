/**
 * Unit tests for checkSubmittedConfirmations() (BETA-01)
 *
 * Tests the cron job that polls mempool.space and promotes
 * SUBMITTED → SECURED when a transaction is confirmed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readMigration } from '../test-utils/migrations.js';

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
  mockDrainResults,
  mockInvalidateVerificationCache,
  mockCredentialTypeSelectResult,
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
  const mockInvalidateVerificationCache = vi.fn();

  // Configurable results per test
  const mockAnchorsSelectResult: { data: unknown; error: unknown } = { data: [], error: null };
  const mockAnchorsUpdateResult: { error: unknown } = { error: null };
  // SCRUM-1800 (SCRUM-1743 Phase 2c): the bulk credential_type lookup added in
  // check-confirmations.ts uses `.from('anchors').select(...).in('public_id', ids)`,
  // which is a different terminator than the main SUBMITTED select. We expose a
  // dedicated result so tests can drive credential.status_changed emission.
  const mockCredentialTypeSelectResult: { data: unknown; error: unknown } = {
    data: [],
    error: null,
  };
  const mockDrainResults: Array<{
    data: {
      updated: number;
      capped: boolean;
      anchors: Array<{ public_id: string | null; org_id: string | null }>;
    } | null;
    error: unknown;
  }> = [];

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
    mockDrainResults,
    mockInvalidateVerificationCache,
    mockCredentialTypeSelectResult,
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

vi.mock('../utils/verifyCache.js', () => ({
  invalidateVerificationCache: mockInvalidateVerificationCache,
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
    // SCRUM-1800 (SCRUM-1743 Phase 2c): bulk credential_type lookup terminator.
    // Used by check-confirmations.ts to fan credential.status_changed alongside
    // anchor.secured. Returns a thenable-like result directly so the production
    // call shape `await db.from('anchors').select(...).in('public_id', ids)` resolves.
    chain.in = vi.fn(() => mockCredentialTypeSelectResult);
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
          return (
            mockDrainResults.shift() ?? {
              data: { updated: 0, capped: false, anchors: [] },
              error: null,
            }
          );
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
    // SCRUM-1800 (SCRUM-1743 Phase 2c): default the credential_type bulk lookup
    // to empty so existing tests retain their original `anchor.secured`-only
    // call counts. Tests covering credential.status_changed override this with
    // real rows.
    mockCredentialTypeSelectResult.data = [];
    mockCredentialTypeSelectResult.error = null;
    mockSendEmail.mockResolvedValue({ success: true, messageId: 'msg-001' });
    mockBuildAnchorSecuredEmail.mockReturnValue({ subject: 'Test Subject', html: '<p>test</p>' });
    mockInvalidateVerificationCache.mockResolvedValue(undefined);
    mockDrainResults.splice(0, mockDrainResults.length, {
      data: {
        updated: 1,
        capped: false,
        anchors: [{ public_id: 'pub-001', org_id: 'org-001' }],
      },
      error: null,
    });
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

  it('releases the in-process mutex after unexpected failures', async () => {
    const { db } = await import('../utils/db.js');
    const fromMock = db.from as unknown as { mockImplementationOnce: (impl: () => never) => void };
    fromMock.mockImplementationOnce(() => {
      throw new Error('unexpected DB failure');
    });

    await expect(checkSubmittedConfirmations()).rejects.toThrow('unexpected DB failure');

    mockAnchorsSelectResult.data = [];
    const result = await checkSubmittedConfirmations();
    expect(result).toEqual({ checked: 0, confirmed: 0 });
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
        org_id: 'org-001',
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

  it('continues draining capped RPC batches and invalidates every verification cache', async () => {
    mockAnchorsSelectResult.data = [MOCK_SUBMITTED_ANCHOR];
    mockDrainResults.splice(
      0,
      mockDrainResults.length,
      {
        data: {
          updated: 2,
          capped: true,
          anchors: [
            { public_id: 'pub-001', org_id: 'org-001' },
            { public_id: 'pub-002', org_id: 'org-001' },
          ],
        },
        error: null,
      },
      {
        data: {
          updated: 1,
          capped: false,
          anchors: [{ public_id: 'pub-003', org_id: 'org-002' }],
        },
        error: null,
      },
    );

    mockFetch
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('200200') }) // tip height
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(MOCK_CONFIRMED_TX),
      });

    const { db } = await import('../utils/db.js');

    const result = await checkSubmittedConfirmations();

    expect(result).toEqual({ checked: 1, confirmed: 3 });
    expect(db.rpc).toHaveBeenCalledTimes(2);
    expect(db.rpc).toHaveBeenNthCalledWith(
      1,
      'drain_submitted_to_secured_for_tx',
      expect.objectContaining({
        p_chain_tx_id: MOCK_SUBMITTED_ANCHOR.chain_tx_id,
        p_confirmations: 101,
      }),
    );
    expect(mockInvalidateVerificationCache).toHaveBeenCalledWith('pub-001');
    expect(mockInvalidateVerificationCache).toHaveBeenCalledWith('pub-002');
    expect(mockInvalidateVerificationCache).toHaveBeenCalledWith('pub-003');
    expect(mockDispatchWebhookEvent).toHaveBeenCalledTimes(3);
    expect(mockAuditInsert).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          event_type: 'anchor.batch_secured',
          org_id: 'org-001',
          details: expect.stringContaining('Batch confirmed 2 anchors'),
        }),
        expect.objectContaining({
          event_type: 'anchor.batch_secured',
          org_id: 'org-002',
          details: expect.stringContaining('Batch confirmed 1 anchors'),
        }),
      ]),
    );
  });

  // ---- SCRUM-1800 (SCRUM-1743 Phase 2c): credential.status_changed fan-out ----

  it('dispatches credential.status_changed alongside anchor.secured for anchors with credential_type', async () => {
    mockAnchorsSelectResult.data = [MOCK_SUBMITTED_ANCHOR];
    mockDrainResults.splice(0, mockDrainResults.length, {
      data: {
        updated: 2,
        capped: false,
        anchors: [
          { public_id: 'pub-001', org_id: 'org-001' },
          { public_id: 'pub-002', org_id: 'org-001' },
        ],
      },
      error: null,
    });
    mockCredentialTypeSelectResult.data = [
      { public_id: 'pub-001', credential_type: 'DEGREE' },
      { public_id: 'pub-002', credential_type: 'TRANSCRIPT' },
    ];

    mockFetch
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('200200') })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(MOCK_CONFIRMED_TX),
      });

    await checkSubmittedConfirmations();

    // 2 anchors × (anchor.secured + credential.status_changed) = 4 dispatches
    expect(mockDispatchWebhookEvent).toHaveBeenCalledTimes(4);
    expect(mockDispatchWebhookEvent).toHaveBeenCalledWith(
      'org-001',
      'credential.status_changed',
      'pub-001',
      expect.objectContaining({
        public_id: 'pub-001',
        credential_type: 'DEGREE',
        previous_status: 'SUBMITTED',
        new_status: 'SECURED',
      }),
    );
    expect(mockDispatchWebhookEvent).toHaveBeenCalledWith(
      'org-001',
      'credential.status_changed',
      'pub-002',
      expect.objectContaining({
        public_id: 'pub-002',
        credential_type: 'TRANSCRIPT',
        previous_status: 'SUBMITTED',
        new_status: 'SECURED',
      }),
    );
    expect(mockDispatchWebhookEvent).toHaveBeenCalledWith(
      'org-001',
      'anchor.secured',
      'pub-001',
      expect.objectContaining({ status: 'SECURED' }),
    );
  });

  it('skips credential.status_changed for anchors without credential_type but still emits anchor.secured', async () => {
    mockAnchorsSelectResult.data = [MOCK_SUBMITTED_ANCHOR];
    mockDrainResults.splice(0, mockDrainResults.length, {
      data: {
        updated: 2,
        capped: false,
        anchors: [
          { public_id: 'pub-001', org_id: 'org-001' },
          { public_id: 'pub-002', org_id: 'org-001' },
        ],
      },
      error: null,
    });
    mockCredentialTypeSelectResult.data = [
      { public_id: 'pub-001', credential_type: 'DEGREE' },
      // pub-002 deliberately omitted — non-credential anchor
    ];

    mockFetch
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('200200') })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(MOCK_CONFIRMED_TX),
      });

    await checkSubmittedConfirmations();

    // 2 anchor.secured + 1 credential.status_changed (only pub-001 has credential_type)
    expect(mockDispatchWebhookEvent).toHaveBeenCalledTimes(3);
    expect(mockDispatchWebhookEvent).toHaveBeenCalledWith(
      'org-001',
      'credential.status_changed',
      'pub-001',
      expect.any(Object),
    );
    expect(mockDispatchWebhookEvent).not.toHaveBeenCalledWith(
      expect.anything(),
      'credential.status_changed',
      'pub-002',
      expect.anything(),
    );
  });

  it('writes a credential.status_changed.batch audit row per org with sample public_ids', async () => {
    mockAnchorsSelectResult.data = [MOCK_SUBMITTED_ANCHOR];
    mockDrainResults.splice(0, mockDrainResults.length, {
      data: {
        updated: 3,
        capped: false,
        anchors: [
          { public_id: 'pub-001', org_id: 'org-001' },
          { public_id: 'pub-002', org_id: 'org-001' },
          { public_id: 'pub-003', org_id: 'org-002' },
        ],
      },
      error: null,
    });
    mockCredentialTypeSelectResult.data = [
      { public_id: 'pub-001', credential_type: 'DEGREE' },
      { public_id: 'pub-002', credential_type: 'TRANSCRIPT' },
      { public_id: 'pub-003', credential_type: 'CERTIFICATE' },
    ];

    mockFetch
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('200200') })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(MOCK_CONFIRMED_TX),
      });

    await checkSubmittedConfirmations();

    // fanOutSecuredAnchorWebhooks is fire-and-forget (line ~690 in
    // check-confirmations.ts). Drain microtasks so the credential audit
    // insert at the end of the detached promise lands before assertions.
    for (let i = 0; i < 10; i++) await Promise.resolve();

    // mockAuditInsert is the audit_events insert. Look for a per-org
    // credential.status_changed.batch row from this test's anchors.
    const allCalls = mockAuditInsert.mock.calls;
    const flatRows: any[] = [];
    for (const call of allCalls) {
      const arg = call[0];
      if (Array.isArray(arg)) flatRows.push(...arg);
      else flatRows.push(arg);
    }
    const credBatchRows = flatRows.filter(
      (r: any) => r?.event_type === 'credential.status_changed.batch',
    );
    // 2 orgs → 2 batch audit rows
    expect(credBatchRows.length).toBe(2);
    const org1Row = credBatchRows.find((r: any) => r.org_id === 'org-001');
    expect(org1Row).toBeDefined();
    const org1Details = JSON.parse(org1Row.details);
    expect(org1Details.credentials_dispatched_attempted).toBe(2);
    expect(org1Details.previous_status).toBe('SUBMITTED');
    expect(org1Details.new_status).toBe('SECURED');
    expect(org1Details.sample_public_ids).toEqual(
      expect.arrayContaining(['pub-001', 'pub-002']),
    );
  });

  it('captures per-emit failure outcomes in credential.status_changed.batch audit row', async () => {
    mockAnchorsSelectResult.data = [MOCK_SUBMITTED_ANCHOR];
    mockDrainResults.splice(0, mockDrainResults.length, {
      data: {
        updated: 3,
        capped: false,
        anchors: [
          { public_id: 'pub-001', org_id: 'org-001' },
          { public_id: 'pub-002', org_id: 'org-001' },
          { public_id: 'pub-003', org_id: 'org-001' },
        ],
      },
      error: null,
    });
    mockCredentialTypeSelectResult.data = [
      { public_id: 'pub-001', credential_type: 'DEGREE' },
      { public_id: 'pub-002', credential_type: 'TRANSCRIPT' },
      { public_id: 'pub-003', credential_type: 'CERTIFICATE' },
    ];

    // Make the credential.status_changed dispatch fail for pub-002 only.
    // anchor.secured calls succeed; credential.status_changed for pub-001 +
    // pub-003 succeed; pub-002 throws.
    mockDispatchWebhookEvent.mockImplementation(
      async (_orgId: string, eventType: string, eventId: string) => {
        if (eventType === 'credential.status_changed' && eventId === 'pub-002') {
          throw new Error('endpoint pub-002 timeout');
        }
        return undefined;
      },
    );

    mockFetch
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('200200') })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(MOCK_CONFIRMED_TX),
      });

    await checkSubmittedConfirmations();
    for (let i = 0; i < 10; i++) await Promise.resolve();

    const allCalls = mockAuditInsert.mock.calls;
    const flatRows: any[] = [];
    for (const call of allCalls) {
      const arg = call[0];
      if (Array.isArray(arg)) flatRows.push(...arg);
      else flatRows.push(arg);
    }
    const credBatch = flatRows.find(
      (r: any) => r?.event_type === 'credential.status_changed.batch',
    );
    expect(credBatch).toBeDefined();
    const details = JSON.parse(credBatch.details);
    expect(details.credentials_dispatched_attempted).toBe(3);
    expect(details.credentials_dispatched_succeeded).toBe(2);
    expect(details.credentials_dispatched_failed).toBe(1);
    expect(details.sample_failures).toHaveLength(1);
    expect(details.sample_failures[0].public_id).toBe('pub-002');
    expect(details.sample_failures[0].error).toBe('endpoint pub-002 timeout');
  });

  it('does not write credential.status_changed.batch audit row when no anchors have credential_type', async () => {
    mockAnchorsSelectResult.data = [MOCK_SUBMITTED_ANCHOR];
    mockDrainResults.splice(0, mockDrainResults.length, {
      data: {
        updated: 1,
        capped: false,
        anchors: [{ public_id: 'pub-001', org_id: 'org-001' }],
      },
      error: null,
    });
    // No credential_type → no credential audit
    mockCredentialTypeSelectResult.data = [];

    mockFetch
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('200200') })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(MOCK_CONFIRMED_TX),
      });

    await checkSubmittedConfirmations();
    for (let i = 0; i < 10; i++) await Promise.resolve();

    const allCalls = mockAuditInsert.mock.calls;
    const flatRows: any[] = [];
    for (const call of allCalls) {
      const arg = call[0];
      if (Array.isArray(arg)) flatRows.push(...arg);
      else flatRows.push(arg);
    }
    const credBatchRows = flatRows.filter(
      (r: any) => r?.event_type === 'credential.status_changed.batch',
    );
    expect(credBatchRows.length).toBe(0);
  });

  it('continues anchor.secured fan-out when credential_type lookup fails', async () => {
    mockAnchorsSelectResult.data = [MOCK_SUBMITTED_ANCHOR];
    mockDrainResults.splice(0, mockDrainResults.length, {
      data: {
        updated: 1,
        capped: false,
        anchors: [{ public_id: 'pub-001', org_id: 'org-001' }],
      },
      error: null,
    });
    mockCredentialTypeSelectResult.data = null;
    mockCredentialTypeSelectResult.error = { message: 'simulated DB outage' };

    mockFetch
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('200200') })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(MOCK_CONFIRMED_TX),
      });

    await checkSubmittedConfirmations();

    // anchor.secured still emits; credential.status_changed suppressed
    expect(mockDispatchWebhookEvent).toHaveBeenCalledTimes(1);
    expect(mockDispatchWebhookEvent).toHaveBeenCalledWith(
      'org-001',
      'anchor.secured',
      'pub-001',
      expect.any(Object),
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ txId: MOCK_SUBMITTED_ANCHOR.chain_tx_id }),
      expect.stringContaining('Failed to fetch credential_type'),
    );
  });

  it('does not re-query secured anchors for webhook fan-out when the drain RPC omits anchor identities', async () => {
    mockAnchorsSelectResult.data = [MOCK_SUBMITTED_ANCHOR];
    mockDrainResults.splice(0, mockDrainResults.length, {
      data: {
        updated: 1,
        capped: false,
        anchors: [],
      },
      error: null,
    });

    mockFetch
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('200200') }) // tip height
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(MOCK_CONFIRMED_TX),
      });

    const result = await checkSubmittedConfirmations();

    expect(result).toEqual({ checked: 1, confirmed: 1 });
    expect(mockDispatchWebhookEvent).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        txId: MOCK_SUBMITTED_ANCHOR.chain_tx_id,
        confirmed: 1,
      }),
      expect.stringContaining('refusing to re-query all SECURED anchors'),
    );
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

    try {
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
    } finally {
      rpcSpy.mockRestore();
    }
  });
});

describe('drain_submitted_to_secured_for_tx migration', () => {
  it('persists confirmations on anchors during the bulk SECURED drain', () => {
    const sql = readMigration('0283_drain_submitted_to_secured_helper.sql');

    expect(sql).toMatch(
      /UPDATE anchors a\s+SET[\s\S]*chain_confirmations = GREATEST\(p_confirmations, 1\)[\s\S]*FROM batch/,
    );
    expect(sql).toMatch(
      /INSERT INTO public\.anchor_chain_index[\s\S]*confirmations[\s\S]*GREATEST\(p_confirmations, 1\)/,
    );
  });
});
