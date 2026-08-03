/**
 * FIX-1 (SCRUM-2471) — customer batch path persists each leaf's Merkle
 * branch + integer index into anchor_proofs.
 *
 * Before this fix, `tree.proofs` was discarded in batch-anchor.ts: only
 * publicRecordAnchor.ts wrote branches, so customer SECURED anchors had no
 * recomputable proof and `verify-proof` could not produce a cryptographic
 * `verified` verdict (PROOF-VERIFY depends on the stored branch).
 *
 * INVARIANT pinned here: after a successful customer batch broadcast,
 * `upsertAnchorProofs` is called with one row per anchor carrying the
 * leaf's branch (proofPath) + integer merkleIndex + the batch merkle_root.
 * A multi-leaf batch ⇒ every persisted branch is NON-EMPTY. A single-leaf
 * batch ⇒ empty branch with merkle_root == fingerprint (still valid).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import type { ChainReceipt } from '../chain/types.js';
import { verifyMerkleInclusion } from '../utils/merkle-verify.js';

const fp = (seed: string) => createHash('sha256').update(seed).digest('hex');

// ---- Hoisted mocks ----
const {
  mockSubmitFingerprint,
  mockEstimateCurrentFee,
  mockGetChainClientAsync,
  mockDbRpc,
  mockUpsertAnchorProofs,
  mockLogger,
  oldestRef,
  setOldest,
} = vi.hoisted(() => {
  const mockSubmitFingerprint = vi.fn();
  const mockEstimateCurrentFee = vi.fn();
  const mockGetChainClientAsync = vi.fn();
  const mockDbRpc = vi.fn();
  const mockUpsertAnchorProofs = vi.fn((_client: unknown, _rows: Array<Record<string, unknown>>): Promise<void> => Promise.resolve());
  const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const oldestRef: { value: { created_at: string } | null } = { value: null };
  const setOldest = (v: { created_at: string } | null) => { oldestRef.value = v; };
  return {
    mockSubmitFingerprint,
    mockEstimateCurrentFee,
    mockGetChainClientAsync,
    mockDbRpc,
    mockUpsertAnchorProofs,
    mockLogger,
    oldestRef,
    setOldest,
  };
});

vi.mock('../utils/logger.js', () => ({ logger: mockLogger }));
vi.mock('../config.js', () => ({
  config: { nodeEnv: 'test', useMocks: true, enableOrgCreditEnforcement: false, maxFeeThresholdSatPerVbyte: 50 },
}));
vi.mock('../chain/client.js', () => ({
  getChainClientAsync: mockGetChainClientAsync,
  getInitializedChainClient: vi.fn(),
  getChainClient: vi.fn(),
}));
vi.mock('../utils/complianceMapping.js', () => ({ getComplianceControlIds: () => [] }));
vi.mock('../utils/orgCredits.js', () => ({
  deductOrgCredit: vi.fn(async () => ({ allowed: true, reason: 'feature_disabled', balance: null })),
}));
vi.mock('../utils/anchorProofs.js', () => ({ upsertAnchorProofs: mockUpsertAnchorProofs }));

// S3-P0: the batch job is gated on ENABLE_BATCH_ANCHORING — force ON so the
// FIX-1 proof-persistence pins below still exercise the pipeline.
vi.mock('../middleware/flagRegistry.js', () => ({
  flagRegistry: { getFlag: vi.fn(() => true) },
}));

// db mock: anchors select chain (oldest probe + threshold probes) + update;
// anchor_proofs is handled by the mocked upsertAnchorProofs.
vi.mock('../utils/db.js', async () => {
  // Async factory so the shared `job_queue` lease double can be imported here.
  // A static import would not work: `vi.mock` factories are hoisted above it.
  const { grantedRunLeaseTable } = await import('./__tests__/__testHelpers.js');

  const anchorsSelectChain: Record<string, unknown> = {};
  anchorsSelectChain.eq = vi.fn(() => anchorsSelectChain);
  anchorsSelectChain.is = vi.fn(() => anchorsSelectChain);
  anchorsSelectChain.order = vi.fn(() => anchorsSelectChain);
  anchorsSelectChain.limit = vi.fn(() => anchorsSelectChain);
  anchorsSelectChain.range = vi.fn(() => anchorsSelectChain);
  anchorsSelectChain.maybeSingle = vi.fn(async () => ({ data: oldestRef.value, error: null }));

  const updateChain: Record<string, unknown> = {};
  updateChain.eq = vi.fn(() => updateChain);
  updateChain.in = vi.fn(() => updateChain);
  updateChain.then = (resolve?: (v: unknown) => unknown) => Promise.resolve({ error: null, count: 1 }).then(resolve);

  return {
    db: {
      rpc: mockDbRpc,
      from: vi.fn((table: string) => {
        if (table === 'anchors') {
          return { select: vi.fn(() => anchorsSelectChain), update: vi.fn(() => updateChain) };
        }
        // SCRUM-3031: run lease claimed before any drain work — always granted
        // here; semantics live in `__tests__/run-lease.test.ts`.
        if (table === 'job_queue') return grantedRunLeaseTable();
        return { upsert: vi.fn(async () => ({ error: null })) };
      }),
    },
    withDbTimeout: vi.fn((fn: () => Promise<unknown>) => fn()),
  };
});

import { processBatchAnchors } from './batch-anchor.js';

const RECEIPT: ChainReceipt = {
  receiptId: 'tx_batch_proofs_001',
  blockHeight: 880_000,
  blockTimestamp: '2026-06-15T12:00:00Z',
  confirmations: 0,
};

function primeChainAndClaims(anchors: Array<Record<string, unknown>>) {
  setOldest({ created_at: '2026-01-01T00:00:00Z' }); // forces non-empty pending probe path
  mockGetChainClientAsync.mockResolvedValue({
    submitFingerprint: mockSubmitFingerprint,
    estimateCurrentFee: mockEstimateCurrentFee,
    hasFunds: async () => true,
  });
  mockSubmitFingerprint.mockResolvedValue(RECEIPT);
  mockEstimateCurrentFee.mockResolvedValue(1);
  // claim_pending_anchors returns the claimed rows once, then [].
  let claimCalls = 0;
  mockDbRpc.mockImplementation(async (rpcName: string) => {
    if (rpcName === 'claim_pending_anchors') {
      claimCalls += 1;
      return claimCalls === 1 ? { data: anchors, error: null } : { data: [], error: null };
    }
    if (rpcName === 'submit_batch_anchors') return { data: anchors.length, error: null };
    return { data: null, error: null };
  });
}

describe('FIX-1 (SCRUM-2471) — batch path persists Merkle branches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpsertAnchorProofs.mockResolvedValue(undefined);
  });

  it('persists a non-empty branch + integer index per leaf for a multi-leaf batch', async () => {
    const anchors = [
      { id: 'a1', fingerprint: fp('cust-1'), metadata: null, org_id: 'o1', public_id: 'P1', credential_type: 'DIPLOMA' },
      { id: 'a2', fingerprint: fp('cust-2'), metadata: null, org_id: 'o1', public_id: 'P2', credential_type: 'DIPLOMA' },
      { id: 'a3', fingerprint: fp('cust-3'), metadata: null, org_id: 'o1', public_id: 'P3', credential_type: 'DIPLOMA' },
    ];
    primeChainAndClaims(anchors);

    const result = await processBatchAnchors({ force: true });
    expect(result.processed).toBeGreaterThan(0);
    expect(mockUpsertAnchorProofs).toHaveBeenCalledTimes(1);

    const rows = mockUpsertAnchorProofs.mock.calls[0][1] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(3);

    // Every row carries the batch root, a non-empty branch, and an integer index.
    const merkleRoot = result.merkleRoot!;
    for (const row of rows) {
      expect(row.merkleRoot).toBe(merkleRoot);
      expect(row.receiptId).toBe(RECEIPT.receiptId);
      expect(typeof row.merkleIndex).toBe('number');
      expect(Array.isArray(row.proofPath)).toBe(true);
      expect((row.proofPath as unknown[]).length).toBeGreaterThan(0); // NON-EMPTY for multi-leaf
    }

    // INVARIANT: each persisted branch cryptographically recomputes to the root.
    for (let i = 0; i < anchors.length; i++) {
      const row = rows.find((r) => r.anchorId === anchors[i].id)!;
      const inclusion = verifyMerkleInclusion(
        anchors[i].fingerprint as string,
        row.proofPath as { hash: string; position: 'left' | 'right' }[],
        merkleRoot,
        { leafIndex: row.merkleIndex as number },
      );
      expect(inclusion.valid).toBe(true);
    }
  });

  it('single-leaf batch ⇒ empty branch, merkle_root == fingerprint (still valid)', async () => {
    const only = { id: 'solo1', fingerprint: fp('solo-cust'), metadata: null, org_id: 'o1', public_id: 'PS', credential_type: 'DIPLOMA' };
    primeChainAndClaims([only]);

    const result = await processBatchAnchors({ force: true });
    expect(mockUpsertAnchorProofs).toHaveBeenCalledTimes(1);
    const rows = mockUpsertAnchorProofs.mock.calls[0][1] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].merkleRoot).toBe(only.fingerprint); // root == fingerprint for n=1
    expect(rows[0].proofPath).toEqual([]); // empty branch
    expect(rows[0].merkleIndex).toBe(0);

    const inclusion = verifyMerkleInclusion(
      only.fingerprint,
      [],
      result.merkleRoot!,
      { leafIndex: 0, leafCount: 1 },
    );
    expect(inclusion.valid).toBe(true);
  });

  it('does not fail the broadcast if proof persistence throws (non-fatal, backfill recovers)', async () => {
    const anchors = [
      { id: 'b1', fingerprint: fp('x1'), metadata: null, org_id: 'o1', public_id: 'B1', credential_type: 'DIPLOMA' },
      { id: 'b2', fingerprint: fp('x2'), metadata: null, org_id: 'o1', public_id: 'B2', credential_type: 'DIPLOMA' },
    ];
    primeChainAndClaims(anchors);
    mockUpsertAnchorProofs.mockRejectedValue(new Error('transient anchor_proofs failure'));

    const result = await processBatchAnchors({ force: true });
    // Broadcast still succeeded — proofs are recoverable via backfill.
    expect(result.processed).toBeGreaterThan(0);
    expect(result.txId).toBe(RECEIPT.receiptId);
  });
});
