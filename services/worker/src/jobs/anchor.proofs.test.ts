/**
 * FIX-1 (SCRUM-2471) — the single-anchor customer path (processAnchor)
 * persists a single-leaf proof into anchor_proofs.
 *
 * processAnchor handles ONE already-claimed (BROADCASTING) anchor and
 * broadcasts a single fingerprint. That is a degenerate single-leaf tree:
 * root == fingerprint, empty branch. After a successful broadcast it must
 * write an anchor_proofs row (merkle_root == fingerprint, proofPath: [],
 * merkleIndex: 0) so the SECURED anchor carries a recomputable proof for
 * PROOF-VERIFY (SCRUM-2490).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import type { ChainReceipt } from '../chain/types.js';
import { verifyMerkleInclusion } from '../utils/merkle-verify.js';

const fp = (seed: string) => createHash('sha256').update(seed).digest('hex');

const {
  mockSubmitFingerprint,
  mockGetChainClientAsync,
  mockUpsertAnchorProofs,
  mockLogger,
  anchorsUpdateResult,
} = vi.hoisted(() => {
  const mockSubmitFingerprint = vi.fn();
  const mockGetChainClientAsync = vi.fn();
  const mockUpsertAnchorProofs = vi.fn((_client: unknown, _rows: Array<Record<string, unknown>>): Promise<void> => Promise.resolve());
  const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const anchorsUpdateResult = { value: { error: null, count: 1 } as Record<string, unknown> };
  return { mockSubmitFingerprint, mockGetChainClientAsync, mockUpsertAnchorProofs, mockLogger, anchorsUpdateResult };
});

vi.mock('../utils/logger.js', () => ({
  logger: mockLogger,
  createRpcLogger: () => ({ start: vi.fn(), success: vi.fn(), error: vi.fn() }),
}));
vi.mock('../config.js', () => ({
  config: { bitcoinNetwork: 'signet', bitcoinMaxFeeRate: null },
  getNetworkDisplayName: () => 'Test Environment',
}));
vi.mock('../chain/client.js', () => ({ getChainClientAsync: mockGetChainClientAsync }));
vi.mock('../webhooks/delivery.js', () => ({ dispatchWebhookEvent: vi.fn(async () => undefined) }));
vi.mock('../billing/paymentGuard.js', () => ({
  checkPaymentGuard: vi.fn(async () => ({ authorized: true, source: null })),
}));
vi.mock('../billing/reconciliation.js', () => ({
  isFreeTierUser: vi.fn(async () => false),
  isWithinBatchWindow: vi.fn(() => true),
}));
vi.mock('../utils/complianceMapping.js', () => ({ getComplianceControlIds: () => [] }));
vi.mock('../utils/anchorProofs.js', () => ({ upsertAnchorProofs: mockUpsertAnchorProofs }));

vi.mock('../utils/db.js', () => {
  const updateChain: Record<string, unknown> = {};
  updateChain.eq = vi.fn(() => updateChain);
  updateChain.then = (resolve?: (v: unknown) => unknown) => Promise.resolve(anchorsUpdateResult.value).then(resolve);

  const selectChain: Record<string, unknown> = {};
  selectChain.eq = vi.fn(() => selectChain);
  selectChain.order = vi.fn(() => selectChain);
  selectChain.limit = vi.fn(async () => ({ data: [], error: null }));

  return {
    db: {
      from: vi.fn((table: string) => {
        if (table === 'anchors') return { update: vi.fn(() => updateChain), select: vi.fn(() => selectChain) };
        if (table === 'audit_events') return { insert: vi.fn(async () => ({ error: null })) };
        return { select: vi.fn(() => selectChain), upsert: vi.fn(async () => ({ error: null })) };
      }),
      rpc: vi.fn(async () => ({ data: null, error: null })),
    },
    withDbTimeout: vi.fn((fn: () => Promise<unknown>) => fn()),
  };
});

import { processAnchor, type ClaimedAnchor } from './anchor.js';

const RECEIPT: ChainReceipt = {
  receiptId: 'tx_single_001',
  blockHeight: 880_001,
  blockTimestamp: '2026-06-15T12:01:00Z',
  confirmations: 0,
};

describe('FIX-1 (SCRUM-2471) — processAnchor persists single-leaf proof', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpsertAnchorProofs.mockResolvedValue(undefined);
    mockGetChainClientAsync.mockResolvedValue({ submitFingerprint: mockSubmitFingerprint });
    mockSubmitFingerprint.mockResolvedValue(RECEIPT);
  });

  it('writes anchor_proofs with empty branch + root == fingerprint after broadcast', async () => {
    const anchor: ClaimedAnchor = {
      id: 'anc-single-1',
      user_id: 'u1',
      org_id: 'o1',
      fingerprint: fp('single-customer-doc'),
      public_id: 'pub-single-1',
      metadata: null,
      credential_type: 'DIPLOMA',
    };

    const ok = await processAnchor(anchor);
    expect(ok).toBe(true);
    expect(mockUpsertAnchorProofs).toHaveBeenCalledTimes(1);

    const rows = mockUpsertAnchorProofs.mock.calls[0][1] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].anchorId).toBe('anc-single-1');
    expect(rows[0].receiptId).toBe(RECEIPT.receiptId);
    expect(rows[0].merkleRoot).toBe(anchor.fingerprint); // single leaf ⇒ root == fingerprint
    expect(rows[0].proofPath).toEqual([]);
    expect(rows[0].merkleIndex).toBe(0);

    const inclusion = verifyMerkleInclusion(anchor.fingerprint, [], anchor.fingerprint, { leafIndex: 0, leafCount: 1 });
    expect(inclusion.valid).toBe(true);
  });

  it('does not persist a proof when the broadcast is rejected (empty receipt)', async () => {
    mockSubmitFingerprint.mockResolvedValue({ receiptId: '' });
    const anchor: ClaimedAnchor = {
      id: 'anc-single-2',
      user_id: 'u1',
      org_id: 'o1',
      fingerprint: fp('rejected-doc'),
      public_id: 'pub-single-2',
      metadata: null,
      credential_type: 'DIPLOMA',
    };
    const ok = await processAnchor(anchor);
    expect(ok).toBe(false);
    expect(mockUpsertAnchorProofs).not.toHaveBeenCalled();
  });

  it('broadcast still succeeds if proof persistence throws (non-fatal)', async () => {
    mockUpsertAnchorProofs.mockRejectedValue(new Error('transient'));
    const anchor: ClaimedAnchor = {
      id: 'anc-single-3',
      user_id: 'u1',
      org_id: 'o1',
      fingerprint: fp('doc-3'),
      public_id: 'pub-single-3',
      metadata: null,
      credential_type: 'DIPLOMA',
    };
    const ok = await processAnchor(anchor);
    expect(ok).toBe(true);
  });
});
