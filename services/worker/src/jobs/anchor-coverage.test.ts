/**
 * SCRUM-1545 (R4-4-FU) coverage-backfill tests for src/jobs/anchor.ts.
 *
 * Pins the branches the original anchor.test.ts didn't reach: GAP-6
 * confidence gate, RISK-1 payment guard reject + free-tier batch deferral,
 * ECON-1 fee-ceiling defer, VAI-01 extraction-manifest linkage, RACE-1
 * count===0 guard, RACE-2 empty-receipt revert, isAnchoringEnabled dev/prod
 * paths, treasury pre-flight, claim RPC timeout + legacy fallback.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChainReceipt } from '../chain/types.js';

// ---- Hoisted mocks ----

const {
  mockSubmitFingerprint,
  mockHasFunds,
  mockEstimateFee,
  mockCheckPaymentGuard,
  mockIsFreeTierUser,
  mockIsWithinBatchWindow,
  mockCallRpc,
  mockWithDbTimeout,
  mockDispatchWebhookEvent,
  mockLogger,
  aiUsageLimit,
  manifestLimit,
  legacyAllPendingLimit,
  anchorUpdateChain,
  setAnchorUpdateResult,
  resetAnchorUpdateResult,
  manifestUpdateChain,
  mockAnchorsUpdate,
  mockManifestUpdate,
  mockAuditInsert,
  mockRpc,
  mockChainClientCfg,
} = vi.hoisted(() => {
  const mockSubmitFingerprint = vi.fn();
  const mockHasFunds = vi.fn();
  const mockEstimateFee = vi.fn();
  const mockCheckPaymentGuard = vi.fn();
  const mockIsFreeTierUser = vi.fn();
  const mockIsWithinBatchWindow = vi.fn();
  const mockCallRpc = vi.fn();
  const mockWithDbTimeout = vi.fn(async (fn: () => Promise<unknown>) => fn());
  const mockDispatchWebhookEvent = vi.fn();
  const mockAuditInsert = vi.fn();
  const mockRpc = vi.fn();

  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  // Per-table select chain terminals
  const aiUsageLimit = vi.fn().mockResolvedValue({ data: null, error: null });
  const manifestLimit = vi.fn().mockResolvedValue({ data: null, error: null });
  const legacyAllPendingLimit = vi.fn().mockResolvedValue({ data: [], error: null });

  // anchors.update().eq().eq() — chained, thenable
  let anchorUpdateResult: Record<string, unknown> = { error: null, count: 1 };
  const anchorUpdateChain: Record<string, unknown> = {};
  anchorUpdateChain.eq = vi.fn(() => anchorUpdateChain);
  anchorUpdateChain.then = (
    resolve?: (v: unknown) => unknown,
    reject?: (e: unknown) => unknown,
  ) => Promise.resolve(anchorUpdateResult).then(resolve, reject);
  const setAnchorUpdateResult = (r: Record<string, unknown>) => {
    anchorUpdateResult = r;
  };
  const resetAnchorUpdateResult = () => {
    anchorUpdateResult = { error: null, count: 1 };
  };

  // extraction_manifests.update().eq() — used to link manifest to anchor.
  // The SUT chains .then() inline; we mimic a thenable.
  const manifestUpdateChain: Record<string, unknown> = {};
  manifestUpdateChain.eq = vi.fn(() => manifestUpdateChain);
  manifestUpdateChain.then = (resolve?: (v: unknown) => unknown) =>
    Promise.resolve({ error: null }).then(resolve);

  const mockChainClientCfg = {
    submitFingerprint: mockSubmitFingerprint,
    hasFunds: mockHasFunds,
  };

  // Stable update fns so tests can inspect call args across multiple
  // `db.from('anchors').update(...)` invocations within one processAnchor.
  const mockAnchorsUpdate = vi.fn(() => anchorUpdateChain);
  const mockManifestUpdate = vi.fn(() => manifestUpdateChain);

  return {
    mockSubmitFingerprint,
    mockHasFunds,
    mockEstimateFee,
    mockCheckPaymentGuard,
    mockIsFreeTierUser,
    mockIsWithinBatchWindow,
    mockCallRpc,
    mockWithDbTimeout,
    mockDispatchWebhookEvent,
    mockLogger,
    aiUsageLimit,
    manifestLimit,
    legacyAllPendingLimit,
    anchorUpdateChain,
    setAnchorUpdateResult,
    resetAnchorUpdateResult,
    manifestUpdateChain,
    mockAnchorsUpdate,
    mockManifestUpdate,
    mockAuditInsert,
    mockRpc,
    mockChainClientCfg,
  };
});

vi.mock('../utils/logger.js', () => ({
  logger: mockLogger,
  createRpcLogger: vi.fn(() => ({
    start: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
  })),
}));

const mockConfig = {
  chainNetwork: 'testnet' as const,
  nodeEnv: 'test' as string,
  useMocks: true,
  enableProdNetworkAnchoring: false,
  bitcoinNetwork: 'signet',
  bitcoinMaxFeeRate: undefined as number | undefined,
};

vi.mock('../config.js', () => ({
  get config() {
    return mockConfig;
  },
  getNetworkDisplayName: vi.fn(() => 'Test Environment'),
}));

vi.mock('../chain/client.js', () => ({
  getChainClientAsync: () => Promise.resolve(mockChainClientCfg),
  getInitializedChainClient: () => mockChainClientCfg,
}));

vi.mock('../chain/fee-estimator.js', () => ({
  MempoolFeeEstimator: class {
    estimateFee = mockEstimateFee;
  },
  createFeeEstimator: vi.fn(),
}));

vi.mock('../webhooks/delivery.js', () => ({
  dispatchWebhookEvent: mockDispatchWebhookEvent,
}));

vi.mock('../billing/paymentGuard.js', () => ({
  checkPaymentGuard: mockCheckPaymentGuard,
}));

vi.mock('../billing/reconciliation.js', () => ({
  isFreeTierUser: mockIsFreeTierUser,
  isWithinBatchWindow: mockIsWithinBatchWindow,
}));

vi.mock('../utils/rpc.js', () => ({
  callRpc: mockCallRpc,
}));

vi.mock('../utils/complianceMapping.js', () => ({
  getComplianceControlIds: vi.fn(() => []),
}));

// Per-table select-chain factory that lets each test set its own terminal data.
function makeSelectChain(terminal: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn(() => chain);
  chain.eq = vi.fn(() => chain);
  chain.is = vi.fn(() => chain);
  chain.order = vi.fn(() => chain);
  chain.limit = terminal;
  return chain;
}

const tables = {
  ai_usage_events: makeSelectChain(aiUsageLimit),
  extraction_manifests: makeSelectChain(manifestLimit),
  anchors_select: makeSelectChain(legacyAllPendingLimit),
};

vi.mock('../utils/db.js', () => ({
  db: {
    from: vi.fn((table: string) => {
      switch (table) {
        case 'ai_usage_events':
          return tables.ai_usage_events;
        case 'extraction_manifests':
          return {
            ...tables.extraction_manifests,
            update: mockManifestUpdate,
          };
        case 'audit_events':
          return { insert: mockAuditInsert };
        case 'anchors':
          return {
            ...tables.anchors_select,
            update: mockAnchorsUpdate,
          };
        default:
          return {};
      }
    }),
    rpc: mockRpc,
  },
  withDbTimeout: mockWithDbTimeout,
}));

import { processAnchor, processPendingAnchors } from './anchor.js';
import type { ClaimedAnchor } from './anchor.js';

const VALID_FP = 'a'.repeat(64);

const BASE_ANCHOR: ClaimedAnchor = {
  id: 'anchor-cov-1',
  user_id: 'user-cov-1',
  org_id: 'org-cov-1',
  fingerprint: VALID_FP,
  public_id: 'pub-cov-1',
  metadata: null,
  credential_type: null,
};

const RECEIPT_OK: ChainReceipt = {
  receiptId: 'tx_cov_ok',
  blockHeight: 800100,
  blockTimestamp: '2026-05-05T00:00:00Z',
  confirmations: 0,
};

beforeEach(() => {
  vi.resetAllMocks();
  resetAnchorUpdateResult();

  mockConfig.nodeEnv = 'test';
  mockConfig.useMocks = true;
  mockConfig.enableProdNetworkAnchoring = false;
  mockConfig.bitcoinMaxFeeRate = undefined;

  mockSubmitFingerprint.mockResolvedValue(RECEIPT_OK);
  mockHasFunds.mockResolvedValue(true);
  mockEstimateFee.mockResolvedValue(10);

  mockCheckPaymentGuard.mockResolvedValue({
    authorized: true,
    source: { id: 'beta', type: 'beta_unlimited' },
  });
  mockIsFreeTierUser.mockResolvedValue(false);
  mockIsWithinBatchWindow.mockReturnValue(true);

  mockCallRpc.mockResolvedValue({ data: true, error: null });
  mockRpc.mockResolvedValue({ data: [], error: null });

  aiUsageLimit.mockResolvedValue({ data: null, error: null });
  manifestLimit.mockResolvedValue({ data: null, error: null });
  legacyAllPendingLimit.mockResolvedValue({ data: [], error: null });

  mockAuditInsert.mockResolvedValue({ error: null });
  mockDispatchWebhookEvent.mockResolvedValue(undefined);
});

describe('processAnchor confidence gate (GAP-6)', () => {
  it('reverts to PENDING when confidence below threshold', async () => {
    aiUsageLimit.mockResolvedValueOnce({ data: [{ confidence: 0.1 }], error: null });

    const result = await processAnchor(BASE_ANCHOR);

    expect(result).toBe(false);
    expect(mockSubmitFingerprint).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ confidence: 0.1 }),
      expect.stringContaining('confidence gate'),
    );
  });

  it('proceeds when confidence at or above threshold', async () => {
    aiUsageLimit.mockResolvedValueOnce({ data: [{ confidence: 0.9 }], error: null });

    const result = await processAnchor(BASE_ANCHOR);
    expect(result).toBe(true);
    expect(mockSubmitFingerprint).toHaveBeenCalledOnce();
  });

  it('skips confidence gate for pipeline records', async () => {
    aiUsageLimit.mockResolvedValueOnce({ data: [{ confidence: 0.0 }], error: null });

    const result = await processAnchor({
      ...BASE_ANCHOR,
      metadata: { pipeline_source: 'compliance' },
    });

    expect(result).toBe(true);
    expect(mockSubmitFingerprint).toHaveBeenCalledOnce();
  });
});

describe('processAnchor payment guard (RISK-1)', () => {
  it('reverts when checkPaymentGuard authorized=false', async () => {
    mockCheckPaymentGuard.mockResolvedValueOnce({ authorized: false, reason: 'no_active_sub' });

    const result = await processAnchor(BASE_ANCHOR);
    expect(result).toBe(false);
    expect(mockSubmitFingerprint).not.toHaveBeenCalled();
  });

  it('defers free-tier user outside batch window', async () => {
    mockCheckPaymentGuard.mockResolvedValueOnce({
      authorized: true,
      source: { id: 'src1', type: 'metered' },
    });
    mockIsFreeTierUser.mockResolvedValueOnce(true);
    mockIsWithinBatchWindow.mockReturnValueOnce(false);

    const result = await processAnchor(BASE_ANCHOR);
    expect(result).toBe(false);
    expect(mockSubmitFingerprint).not.toHaveBeenCalled();
  });

  it('proceeds when free-tier check is bypassed by beta_unlimited source', async () => {
    mockCheckPaymentGuard.mockResolvedValueOnce({
      authorized: true,
      source: { id: 'src_beta', type: 'beta_unlimited' },
    });
    mockIsFreeTierUser.mockResolvedValueOnce(true);
    mockIsWithinBatchWindow.mockReturnValueOnce(false);

    const result = await processAnchor(BASE_ANCHOR);
    expect(result).toBe(true);
  });
});

describe('processAnchor pipeline records', () => {
  it('skips payment guard and free-tier check for pipeline_source records', async () => {
    const result = await processAnchor({
      ...BASE_ANCHOR,
      metadata: { pipeline_source: 'compliance' },
    });

    expect(result).toBe(true);
    expect(mockCheckPaymentGuard).not.toHaveBeenCalled();
    expect(mockIsFreeTierUser).not.toHaveBeenCalled();
  });
});

describe('processAnchor invalid fingerprint', () => {
  it('reverts when fingerprint is missing', async () => {
    const result = await processAnchor({ ...BASE_ANCHOR, fingerprint: '' });
    expect(result).toBe(false);
    expect(mockSubmitFingerprint).not.toHaveBeenCalled();
  });

  it('reverts when fingerprint is not 64-char hex', async () => {
    const result = await processAnchor({ ...BASE_ANCHOR, fingerprint: 'not-hex' });
    expect(result).toBe(false);
    expect(mockSubmitFingerprint).not.toHaveBeenCalled();
  });
});

describe('processAnchor fee ceiling (ECON-1)', () => {
  it('defers when current fee rate exceeds bitcoinMaxFeeRate', async () => {
    mockConfig.bitcoinMaxFeeRate = 5;
    mockEstimateFee.mockResolvedValueOnce(50);

    const result = await processAnchor(BASE_ANCHOR);

    expect(result).toBe(false);
    expect(mockSubmitFingerprint).not.toHaveBeenCalled();
  });

  it('proceeds when fee estimator throws (non-fatal)', async () => {
    mockConfig.bitcoinMaxFeeRate = 5;
    mockEstimateFee.mockRejectedValueOnce(new Error('estimator down'));

    const result = await processAnchor(BASE_ANCHOR);
    expect(result).toBe(true);
  });
});

describe('processAnchor extraction manifest linkage (VAI-01)', () => {
  it('attaches _extraction_manifest_hash and links manifest row when found', async () => {
    manifestLimit.mockResolvedValueOnce({
      data: [{ id: 'manifest-1', manifest_hash: 'h_test' }],
      error: null,
    });

    const result = await processAnchor(BASE_ANCHOR);
    expect(result).toBe(true);
    // SUBMITTED update payload carries the manifest hash
    expect(mockAnchorsUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'SUBMITTED',
        metadata: expect.objectContaining({ _extraction_manifest_hash: 'h_test' }),
      }),
    );
    // Manifest row is linked back to this anchor
    expect(mockManifestUpdate).toHaveBeenCalledWith({ anchor_id: BASE_ANCHOR.id });
  });

  it('proceeds when manifest lookup throws (non-fatal)', async () => {
    manifestLimit.mockRejectedValueOnce(new Error('manifest table missing'));

    const result = await processAnchor(BASE_ANCHOR);
    expect(result).toBe(true);
  });
});

describe('processAnchor RACE-1 count guard', () => {
  it('returns false when SUBMITTED update affected zero rows', async () => {
    setAnchorUpdateResult({ error: null, count: 0 });

    const result = await processAnchor(BASE_ANCHOR);
    expect(result).toBe(false);
  });
});

describe('processAnchor RACE-2 empty receipt', () => {
  it('reverts when chain client returns no receiptId', async () => {
    mockSubmitFingerprint.mockResolvedValueOnce({ receiptId: null });

    const result = await processAnchor(BASE_ANCHOR);
    expect(result).toBe(false);
  });

  it('reverts when chain client returns null', async () => {
    mockSubmitFingerprint.mockResolvedValueOnce(null);

    const result = await processAnchor(BASE_ANCHOR);
    expect(result).toBe(false);
  });
});

describe('processAnchor receipt extras', () => {
  it('captures rawTxHex, feeSats, and metadataHash on the SUBMITTED update', async () => {
    mockSubmitFingerprint.mockResolvedValueOnce({
      ...RECEIPT_OK,
      rawTxHex: '01abcd',
      feeSats: 1234,
      metadataHash: 'mh',
    });

    const result = await processAnchor({ ...BASE_ANCHOR, metadata: { existing: 'k' } });
    expect(result).toBe(true);
    expect(mockAnchorsUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'SUBMITTED',
        metadata: expect.objectContaining({
          existing: 'k',
          _raw_tx_hex: '01abcd',
          _fee_sats: 1234,
          _metadata_hash: 'mh',
        }),
      }),
    );
  });

  it('skips webhook dispatch when public_id is missing', async () => {
    const result = await processAnchor({ ...BASE_ANCHOR, public_id: null });
    expect(result).toBe(true);
    expect(mockDispatchWebhookEvent).not.toHaveBeenCalled();
  });

  it('logs but does not fail when webhook dispatch throws', async () => {
    mockDispatchWebhookEvent.mockRejectedValueOnce(new Error('webhook 500'));
    const result = await processAnchor(BASE_ANCHOR);
    expect(result).toBe(true);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ anchorId: BASE_ANCHOR.id }),
      expect.stringContaining('Failed to dispatch webhook'),
    );
  });

  it('logs but does not fail when audit insert errors', async () => {
    mockAuditInsert.mockResolvedValueOnce({ error: { message: 'audit row dup' } });
    const result = await processAnchor(BASE_ANCHOR);
    expect(result).toBe(true);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ anchorId: BASE_ANCHOR.id }),
      expect.stringContaining('Failed to log audit event'),
    );
  });
});

// ---------------------------------------------------------------
// processPendingAnchors — pre-flight + claim RPC + legacy fallback
// ---------------------------------------------------------------

describe('processPendingAnchors switchboard flag', () => {
  it('skips claim RPC in dev when flag is false and env is unset', async () => {
    mockConfig.nodeEnv = 'development';
    mockConfig.enableProdNetworkAnchoring = false;
    mockCallRpc.mockResolvedValueOnce({ data: false, error: null });

    const result = await processPendingAnchors();
    expect(result).toEqual({ processed: 0, failed: 0 });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('calls claim RPC in dev when env override is true', async () => {
    mockConfig.nodeEnv = 'development';
    mockConfig.enableProdNetworkAnchoring = true;
    mockHasFunds.mockResolvedValueOnce(true);
    mockRpc.mockResolvedValueOnce({ data: [], error: null });

    await processPendingAnchors();
    expect(mockRpc).toHaveBeenCalledWith('claim_pending_anchors', expect.any(Object));
  });

  it('calls claim RPC in prod when DB flag returns true', async () => {
    mockConfig.nodeEnv = 'production';
    mockCallRpc.mockResolvedValueOnce({ data: true, error: null });
    mockHasFunds.mockResolvedValueOnce(true);
    mockRpc.mockResolvedValueOnce({ data: [], error: null });

    await processPendingAnchors();
    expect(mockRpc).toHaveBeenCalled();
  });

  it('falls back to env override in prod when DB flag errors', async () => {
    mockConfig.nodeEnv = 'production';
    mockConfig.enableProdNetworkAnchoring = true;
    mockCallRpc.mockResolvedValueOnce({ data: null, error: { message: 'rpc bad' } });
    mockHasFunds.mockResolvedValueOnce(true);
    mockRpc.mockResolvedValueOnce({ data: [], error: null });

    await processPendingAnchors();
    expect(mockRpc).toHaveBeenCalled();
  });

  it('skips claim RPC in prod when DB flag errors and env override is false', async () => {
    mockConfig.nodeEnv = 'production';
    mockConfig.enableProdNetworkAnchoring = false;
    mockCallRpc.mockResolvedValueOnce({ data: null, error: { message: 'rpc bad' } });

    const result = await processPendingAnchors();
    expect(result).toEqual({ processed: 0, failed: 0 });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('skips claim RPC in prod when get_flag throws and env override is false', async () => {
    mockConfig.nodeEnv = 'production';
    mockConfig.enableProdNetworkAnchoring = false;
    mockCallRpc.mockRejectedValueOnce(new Error('throw'));

    const result = await processPendingAnchors();
    expect(result).toEqual({ processed: 0, failed: 0 });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('calls claim RPC in prod when get_flag throws and env override is true', async () => {
    mockConfig.nodeEnv = 'production';
    mockConfig.enableProdNetworkAnchoring = true;
    mockCallRpc.mockRejectedValueOnce(new Error('throw'));
    mockHasFunds.mockResolvedValueOnce(true);
    mockRpc.mockResolvedValueOnce({ data: [], error: null });

    await processPendingAnchors();
    expect(mockRpc).toHaveBeenCalled();
  });
});

describe('processPendingAnchors treasury pre-flight', () => {
  beforeEach(() => {
    mockConfig.nodeEnv = 'development';
    mockConfig.enableProdNetworkAnchoring = true;
  });

  it('skips claim when treasury empty', async () => {
    mockHasFunds.mockResolvedValueOnce(false);
    const result = await processPendingAnchors();
    expect(result).toEqual({ processed: 0, failed: 0 });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('proceeds when hasFunds throws (non-fatal)', async () => {
    mockHasFunds.mockRejectedValueOnce(new Error('utxo provider down'));
    mockRpc.mockResolvedValueOnce({ data: [], error: null });
    const result = await processPendingAnchors();
    expect(result).toEqual({ processed: 0, failed: 0 });
  });
});

describe('processPendingAnchors claim RPC', () => {
  beforeEach(() => {
    mockConfig.nodeEnv = 'development';
    mockConfig.enableProdNetworkAnchoring = true;
    mockHasFunds.mockResolvedValue(true);
  });

  it('returns 0/0 when claim RPC times out', async () => {
    mockWithDbTimeout.mockRejectedValueOnce(new Error('timed out'));
    const result = await processPendingAnchors();
    expect(result).toEqual({ processed: 0, failed: 0 });
  });

  it('falls back to legacy path when claim RPC errors', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'rpc missing' } });
    legacyAllPendingLimit.mockResolvedValueOnce({ data: [], error: null });
    const result = await processPendingAnchors();
    expect(result).toEqual({ processed: 0, failed: 0 });
  });

  it('returns 0/0 when claim RPC returns no rows', async () => {
    mockRpc.mockResolvedValueOnce({ data: [], error: null });
    const result = await processPendingAnchors();
    expect(result).toEqual({ processed: 0, failed: 0 });
  });

  it('processes a claimed anchor end-to-end (success path)', async () => {
    mockRpc.mockResolvedValueOnce({
      data: [
        {
          id: 'a1',
          user_id: 'u1',
          org_id: 'o1',
          fingerprint: VALID_FP,
          public_id: 'pub-a1',
          metadata: null,
          credential_type: null,
        },
      ],
      error: null,
    });
    const result = await processPendingAnchors();
    expect(result).toEqual({ processed: 1, failed: 0 });
    expect(mockSubmitFingerprint).toHaveBeenCalledOnce();
  });
});

describe('processPendingAnchors legacy fallback', () => {
  beforeEach(() => {
    mockConfig.nodeEnv = 'development';
    mockConfig.enableProdNetworkAnchoring = true;
    mockHasFunds.mockResolvedValue(true);
    mockRpc.mockResolvedValue({ data: null, error: { message: 'rpc missing' } });
  });

  it('returns 0/0 when legacy query fails', async () => {
    legacyAllPendingLimit.mockResolvedValueOnce({ data: null, error: { message: 'select failed' } });
    const result = await processPendingAnchors();
    expect(result).toEqual({ processed: 0, failed: 0 });
  });

  it('skips pipeline anchors in legacy fallback', async () => {
    legacyAllPendingLimit.mockResolvedValueOnce({
      data: [
        {
          id: 'a-pipe',
          user_id: 'u1',
          org_id: 'o1',
          fingerprint: VALID_FP,
          public_id: 'pub',
          metadata: { pipeline_source: 'x' },
          credential_type: null,
        },
      ],
      error: null,
    });
    const result = await processPendingAnchors();
    expect(result).toEqual({ processed: 0, failed: 0 });
  });

  it('skips anchors that lose the BROADCASTING claim race', async () => {
    legacyAllPendingLimit.mockResolvedValueOnce({
      data: [
        {
          id: 'a-lost',
          user_id: 'u1',
          org_id: 'o1',
          fingerprint: VALID_FP,
          public_id: 'pub',
          metadata: null,
          credential_type: null,
        },
      ],
      error: null,
    });
    setAnchorUpdateResult({ error: null, count: 0 });
    const result = await processPendingAnchors();
    expect(result).toEqual({ processed: 0, failed: 0 });
  });
});
