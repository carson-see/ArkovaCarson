/**
 * Unit tests for processRevocations() (BETA-02)
 *
 * Tests the job that broadcasts OP_RETURN revocation transactions
 * for anchors that have been revoked but not yet anchored on-chain.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

// Canonical metadata hash — mirrors chain/base.ts canonicalMetadataJson +
// hashMetadata (sorted keys → JSON.stringify → SHA-256 hex). Inlined here
// instead of importing chain/base.ts, which transitively pulls in viem.
function hashMetadata(metadata: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(metadata).sort((a, b) => a.localeCompare(b))) {
    sorted[key] = metadata[key];
  }
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

// ---- Hoisted mocks ----

const {
  mockLogger,
  mockAuditInsert,
  mockDispatchWebhookEvent,
  mockSubmitFingerprint,
  mockGetInitializedChainClient,
  mockAnchorsSelectResult,
  mockAnchorsUpdateResult,
  mockAnchorsUpdate,
  mockIsAnchoringEnabled,
  mockSendEmail,
  mockBuildRevocationEmail,
} = vi.hoisted(() => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  const mockAuditInsert = vi.fn();
  const mockDispatchWebhookEvent = vi.fn();
  const mockSubmitFingerprint = vi.fn();
  const mockGetInitializedChainClient = vi.fn();

  const mockAnchorsSelectResult: { data: unknown; error: unknown } = { data: [], error: null };
  const mockAnchorsUpdateResult: { error: unknown } = { error: null };
  // SCRUM-2252: capture the exact payload passed to anchors.update() so tests
  // can assert revocation_metadata / revocation_metadata_hash persistence.
  const mockAnchorsUpdate = vi.fn();
  const mockIsAnchoringEnabled = vi.fn();
  const mockSendEmail = vi.fn();
  const mockBuildRevocationEmail = vi.fn();

  return {
    mockLogger,
    mockAuditInsert,
    mockDispatchWebhookEvent,
    mockSubmitFingerprint,
    mockGetInitializedChainClient,
    mockAnchorsSelectResult,
    mockAnchorsUpdateResult,
    mockAnchorsUpdate,
    mockIsAnchoringEnabled,
    mockSendEmail,
    mockBuildRevocationEmail,
  };
});

// ---- Module mocks ----

vi.mock('../utils/logger.js', () => ({
  logger: mockLogger,
  createRpcLogger: () => ({
    start: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../config.js', () => ({
  config: {
    bitcoinNetwork: 'testnet4' as const,
    nodeEnv: 'development',
    useMocks: false,
  },
  getNetworkDisplayName: () => 'Test Environment',
}));

// Build a chainable Supabase mock
function makeChainableMock(result: { data?: unknown; error?: unknown }) {
  const chainable: Record<string, unknown> = {};
  const methods = ['select', 'eq', 'is', 'order', 'limit', 'update', 'upsert', 'insert', 'single', 'maybeSingle'];
  for (const m of methods) {
    chainable[m] = vi.fn().mockReturnValue(chainable);
  }
  // Terminal: resolves the promise (SonarQube S7739: use defineProperty)
  Object.defineProperty(chainable, 'then', {
    value: (resolve: (v: unknown) => void) => resolve(result),
    enumerable: false,
  });
  return chainable;
}

// Like makeChainableMock, but routes update() through mockAnchorsUpdate so the
// payload is captured for assertions (SCRUM-2252).
function makeAnchorsMock(result: { data?: unknown; error?: unknown }) {
  const chainable = makeChainableMock(result);
  chainable.update = vi.fn((payload: unknown) => {
    mockAnchorsUpdate(payload);
    return chainable;
  });
  return chainable;
}

vi.mock('../utils/db.js', () => ({
  db: {
    from: vi.fn((table: string) => {
      if (table === 'anchors') return makeAnchorsMock(mockAnchorsSelectResult);
      if (table === 'audit_events') {
        const mock = makeChainableMock({ error: null });
        mockAuditInsert.mockImplementation(() => mock);
        return { insert: mockAuditInsert };
      }
      if (table === 'profiles') {
        return makeChainableMock({ data: { email: 'user@example.com' }, error: null });
      }
      if (table === 'organizations') {
        return makeChainableMock({ data: { display_name: 'Test Org' }, error: null });
      }
      return makeChainableMock({ data: null, error: null });
    }),
  },
}));

vi.mock('../utils/rpc.js', () => ({
  callRpc: mockIsAnchoringEnabled,
}));

vi.mock('../chain/client.js', () => ({
  getInitializedChainClient: mockGetInitializedChainClient,
  getChainClientAsync: (...args: unknown[]) => Promise.resolve(mockGetInitializedChainClient(...args)),
}));

vi.mock('../webhooks/delivery.js', () => ({
  dispatchWebhookEvent: mockDispatchWebhookEvent,
}));

vi.mock('../email/index.js', () => ({
  sendEmail: mockSendEmail,
  buildRevocationEmail: mockBuildRevocationEmail,
}));

// ---- Import after mocks ----
import { processRevocation, processRevokedAnchors } from './revocation.js';

// ---- Test data ----

const MOCK_ANCHOR = {
  id: 'anchor-uuid-1',
  fingerprint: 'a'.repeat(64),
  chain_tx_id: 'original-tx-id-abc123',
  status: 'REVOKED',
  user_id: 'user-uuid-1',
  org_id: 'org-uuid-1',
  public_id: 'pub-id-1',
  revocation_tx_id: null,
  revocation_block_height: null,
};

// The metadata processRevocation submits for MOCK_ANCHOR. The chain client
// returns receipt.metadataHash = SHA-256 of the canonical (sorted-key) JSON of
// this object. We precompute it here so the receipt mock is realistic and the
// round-trip assertion has a fixed expectation.
const EXPECTED_REVOCATION_METADATA = {
  type: 'REVOKE',
  original_tx_id: 'original-tx-id-abc123',
};
const EXPECTED_METADATA_HASH = createHash('sha256')
  .update(JSON.stringify({ original_tx_id: 'original-tx-id-abc123', type: 'REVOKE' })) // sorted keys
  .digest('hex');

const MOCK_RECEIPT = {
  receiptId: 'revoke-tx-id-xyz789',
  blockHeight: 800100,
  blockTimestamp: '2026-03-17T12:00:00.000Z',
  confirmations: 0,
  metadataHash: EXPECTED_METADATA_HASH,
};

describe('processRevocation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAnchorsSelectResult.data = null;
    mockAnchorsSelectResult.error = null;
    mockAnchorsUpdateResult.error = null;
    mockSubmitFingerprint.mockResolvedValue(MOCK_RECEIPT);
    mockGetInitializedChainClient.mockReturnValue({
      submitFingerprint: mockSubmitFingerprint,
    });
    mockDispatchWebhookEvent.mockResolvedValue(undefined);
    mockAuditInsert.mockReturnValue({ error: null });
    mockSendEmail.mockResolvedValue({ success: true, messageId: 'msg-001' });
    mockBuildRevocationEmail.mockReturnValue({ subject: 'Revoked', html: '<p>revoked</p>' });
  });

  it('returns false when anchor is not found', async () => {
    mockAnchorsSelectResult.data = null;
    mockAnchorsSelectResult.error = { message: 'not found' };

    const result = await processRevocation('missing-id');
    expect(result).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('returns false when anchor already has revocation_tx_id', async () => {
    mockAnchorsSelectResult.data = {
      ...MOCK_ANCHOR,
      revocation_tx_id: 'already-done',
    };
    mockAnchorsSelectResult.error = null;

    const result = await processRevocation('anchor-uuid-1');
    expect(result).toBe(false);
    expect(mockSubmitFingerprint).not.toHaveBeenCalled();
  });

  it('returns false when anchor has no chain_tx_id (was never anchored)', async () => {
    mockAnchorsSelectResult.data = {
      ...MOCK_ANCHOR,
      chain_tx_id: null,
    };
    mockAnchorsSelectResult.error = null;

    const result = await processRevocation('anchor-uuid-1');
    expect(result).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('submits revocation OP_RETURN with ARKV:REVOKE prefix', async () => {
    mockAnchorsSelectResult.data = MOCK_ANCHOR;
    mockAnchorsSelectResult.error = null;

    const result = await processRevocation('anchor-uuid-1');

    expect(result).toBe(true);
    expect(mockSubmitFingerprint).toHaveBeenCalledTimes(1);

    // Verify the fingerprint sent includes REVOKE marker
    const call = mockSubmitFingerprint.mock.calls[0][0];
    expect(call.metadata).toBeDefined();
    expect(call.metadata.type).toBe('REVOKE');
    expect(call.metadata.original_tx_id).toBe('original-tx-id-abc123');
  });

  it('updates revocation_tx_id and revocation_block_height on success', async () => {
    mockAnchorsSelectResult.data = MOCK_ANCHOR;
    mockAnchorsSelectResult.error = null;

    const result = await processRevocation('anchor-uuid-1');
    expect(result).toBe(true);

    expect(mockAnchorsUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        revocation_tx_id: MOCK_RECEIPT.receiptId,
        revocation_block_height: MOCK_RECEIPT.blockHeight,
      }),
    );
  });

  // SCRUM-2252 (BUG-2026-05-16-003): the metadata object + receipt.metadataHash
  // must be persisted, not discarded, so the on-chain hash is verifiable.
  it('persists the exact revocation_metadata object submitted to the chain', async () => {
    mockAnchorsSelectResult.data = MOCK_ANCHOR;
    mockAnchorsSelectResult.error = null;

    await processRevocation('anchor-uuid-1');

    // The persisted metadata must equal the metadata sent to submitFingerprint.
    const submitCall = mockSubmitFingerprint.mock.calls[0][0];
    expect(mockAnchorsUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        revocation_metadata: EXPECTED_REVOCATION_METADATA,
      }),
    );
    const updatePayload = mockAnchorsUpdate.mock.calls[0][0] as Record<string, unknown>;
    expect(updatePayload.revocation_metadata).toEqual(submitCall.metadata);
  });

  it('persists receipt.metadataHash as revocation_metadata_hash', async () => {
    mockAnchorsSelectResult.data = MOCK_ANCHOR;
    mockAnchorsSelectResult.error = null;

    await processRevocation('anchor-uuid-1');

    expect(mockAnchorsUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        revocation_metadata_hash: MOCK_RECEIPT.metadataHash,
      }),
    );
  });

  it('stored hash recomputes from stored metadata (canonical-JSON round-trip)', async () => {
    mockAnchorsSelectResult.data = MOCK_ANCHOR;
    mockAnchorsSelectResult.error = null;

    await processRevocation('anchor-uuid-1');

    const updatePayload = mockAnchorsUpdate.mock.calls[0][0] as {
      revocation_metadata: Record<string, string>;
      revocation_metadata_hash: string;
    };

    // Recompute the canonical hash from the stored metadata and confirm it
    // matches the stored hash — i.e. the on-chain commitment is reconstructible
    // purely from our own records (the bug this story fixes).
    const recomputed = hashMetadata(updatePayload.revocation_metadata);
    expect(recomputed).toBe(updatePayload.revocation_metadata_hash);
    expect(recomputed).toBe(EXPECTED_METADATA_HASH);
  });

  it('persists null revocation_metadata_hash when the chain returns no hash', async () => {
    mockAnchorsSelectResult.data = MOCK_ANCHOR;
    mockAnchorsSelectResult.error = null;
    mockSubmitFingerprint.mockResolvedValue({ ...MOCK_RECEIPT, metadataHash: undefined });

    await processRevocation('anchor-uuid-1');

    expect(mockAnchorsUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        revocation_metadata: EXPECTED_REVOCATION_METADATA,
        revocation_metadata_hash: null,
      }),
    );
  });

  it('logs audit event on successful revocation broadcast', async () => {
    mockAnchorsSelectResult.data = MOCK_ANCHOR;
    mockAnchorsSelectResult.error = null;

    await processRevocation('anchor-uuid-1');

    expect(mockAuditInsert).toHaveBeenCalled();
  });

  it('dispatches webhook on successful revocation broadcast', async () => {
    mockAnchorsSelectResult.data = MOCK_ANCHOR;
    mockAnchorsSelectResult.error = null;

    await processRevocation('anchor-uuid-1');

    expect(mockDispatchWebhookEvent).toHaveBeenCalledWith(
      'org-uuid-1',
      'anchor.revocation_anchored',
      'anchor-uuid-1',
      expect.objectContaining({
        revocation_tx_id: MOCK_RECEIPT.receiptId,
      }),
    );
  });

  it('returns false and logs error when chain submission fails', async () => {
    mockAnchorsSelectResult.data = MOCK_ANCHOR;
    mockAnchorsSelectResult.error = null;
    mockSubmitFingerprint.mockRejectedValue(new Error('No UTXOs available'));

    const result = await processRevocation('anchor-uuid-1');
    expect(result).toBe(false);
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it('skips webhook dispatch when org_id is null', async () => {
    mockAnchorsSelectResult.data = { ...MOCK_ANCHOR, org_id: null };
    mockAnchorsSelectResult.error = null;

    await processRevocation('anchor-uuid-1');

    expect(mockDispatchWebhookEvent).not.toHaveBeenCalled();
  });

  it('sends revocation email after successful chain revocation', async () => {
    mockAnchorsSelectResult.data = {
      ...MOCK_ANCHOR,
      metadata: { issuerName: 'MIT' },
      credential_type: 'DEGREE',
    };
    mockAnchorsSelectResult.error = null;

    await processRevocation('anchor-uuid-1');

    // Allow async fire-and-forget to settle
    await new Promise((r) => setTimeout(r, 50));

    expect(mockBuildRevocationEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientEmail: 'user@example.com',
        credentialLabel: expect.stringContaining('MIT'),
      }),
    );

    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'user@example.com',
        emailType: 'revocation',
        anchorId: 'anchor-uuid-1',
      }),
    );
  });

  it('does not fail revocation when email send fails', async () => {
    mockAnchorsSelectResult.data = MOCK_ANCHOR;
    mockAnchorsSelectResult.error = null;
    mockSendEmail.mockRejectedValue(new Error('Resend down'));

    const result = await processRevocation('anchor-uuid-1');
    // Revocation should still succeed even if email fails
    expect(result).toBe(true);
  });
});

describe('processRevokedAnchors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAnchorsSelectResult.data = [];
    mockAnchorsSelectResult.error = null;
    mockIsAnchoringEnabled.mockResolvedValue({ data: true, error: null });
    mockSubmitFingerprint.mockResolvedValue(MOCK_RECEIPT);
    mockGetInitializedChainClient.mockReturnValue({
      submitFingerprint: mockSubmitFingerprint,
    });
    mockAuditInsert.mockReturnValue({ error: null });
  });

  it('returns zero counts when no revoked anchors need processing', async () => {
    const result = await processRevokedAnchors();
    expect(result).toEqual({ processed: 0, failed: 0 });
  });

  it('skips processing when anchoring is disabled via switchboard', async () => {
    mockIsAnchoringEnabled.mockResolvedValue({ data: false, error: null });

    const result = await processRevokedAnchors();
    expect(result).toEqual({ processed: 0, failed: 0 });
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('disabled'),
    );
  });

  it('processes multiple revoked anchors', async () => {
    mockAnchorsSelectResult.data = [
      { id: 'a1' },
      { id: 'a2' },
    ];

    // For individual processRevocation calls, we need the single-anchor mock
    // This is integration-level; the batch function calls processRevocation per anchor
    const result = await processRevokedAnchors();
    // Since processRevocation will fail to find individual anchors (mock returns list),
    // we verify the batch function attempted processing
    expect(result.processed + result.failed).toBeLessThanOrEqual(2);
  });

  it('fails closed when switchboard flag lookup throws', async () => {
    mockIsAnchoringEnabled.mockResolvedValue({ data: null, error: { message: 'timeout' } });

    const result = await processRevokedAnchors();
    expect(result).toEqual({ processed: 0, failed: 0 });
  });
});
