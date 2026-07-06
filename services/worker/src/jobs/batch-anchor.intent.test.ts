/**
 * S3-P0 (batch producer) — persisted pre-broadcast intent + crash-resume tests.
 *
 * HIGHEST-PRIORITY AC: a batch that broadcast once can NEVER broadcast twice.
 *
 * Contract under test (batch-anchor.ts intent pipeline, prepare-capable client):
 *   Phase 3a  prepareFingerprintTx (build + sign, NO network)
 *   Phase 3b  persist intent:
 *               (i)  anchor_proofs rows keyed by the precomputed txid
 *                    (receipt_id) — merkle branch + index + op_return_payload,
 *                    signed tx hex on the merkle_index-0 intent row
 *               (ii) anchors.chain_tx_id on every claimed BROADCASTING row
 *                    (shields them from the RACE-1 chain_tx_id-IS-NULL sweep)
 *   Phase 3c  broadcastSignedTx (bounded retry, already-known == success)
 *   Phase 4   submit_batch_anchors (BROADCASTING → SUBMITTED)
 *
 * Crash-resume (reconcileBroadcastIntents, runs at the start of every batch
 * tick): stale BROADCASTING rows WITH chain_tx_id are grouped per txid;
 *   - tx known on-chain            → finalize (submit_batch_anchors), NO rebroadcast
 *   - tx unknown + intent hex      → rebroadcast the SAME signed bytes (same txid)
 *   - definitive (non-retryable) reject → refund + delete intent proofs + revert
 *   - transient failure / missing hex   → leave untouched (never revert)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildMerkleTree } from '../utils/merkle.js';

// ---- Shared call-order log (intent-before-broadcast assertions) ----

const callOrder = vi.hoisted(() => [] as string[]);

// ---- Hoisted mocks ----

const {
  mockGetFlag,
  mockUpsertAnchorProofs,
  mockPrepare,
  mockBroadcastSigned,
  mockSubmitFingerprint,
  mockGetReceipt,
  mockDbRpc,
  dbState,
  anchorsUpdates,
  proofDeletes,
  mockLogger,
} = vi.hoisted(() => {
  const callOrderRef = callOrder;
  const mockGetFlag = vi.fn(() => true);
  const mockUpsertAnchorProofs = vi.fn(async (..._args: unknown[]) => {
    callOrderRef.push('persistProofs');
  });
  const mockPrepare = vi.fn();
  const mockBroadcastSigned = vi.fn();
  const mockSubmitFingerprint = vi.fn();
  const mockGetReceipt = vi.fn();
  const mockDbRpc = vi.fn();
  const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  // Mutable DB fixture state, reset per test.
  const dbState = {
    /** Rows returned by the reconcile scan (BROADCASTING + chain_tx_id set). */
    reconcileRows: [] as Array<Record<string, unknown>>,
    /** Rows returned by the anchor_proofs intent lookup (per receipt_id). */
    intentProofRows: [] as Array<Record<string, unknown>>,
    /** Oldest-PENDING row for the trigger probe. */
    oldest: { data: { created_at: '2026-01-01T00:00:00Z' }, error: null } as Record<string, unknown>,
  };

  const anchorsUpdates = [] as Array<{ payload: Record<string, unknown>; filters: Array<[string, ...unknown[]]> }>;
  const proofDeletes = [] as Array<{ filters: Array<[string, ...unknown[]]> }>;

  return {
    mockGetFlag,
    mockUpsertAnchorProofs,
    mockPrepare,
    mockBroadcastSigned,
    mockSubmitFingerprint,
    mockGetReceipt,
    mockDbRpc,
    dbState,
    anchorsUpdates,
    proofDeletes,
    mockLogger,
  };
});

// ---- Module mocks ----

vi.mock('../utils/logger.js', () => ({ logger: mockLogger }));
vi.mock('../config.js', () => ({
  config: { nodeEnv: 'test', useMocks: true, enableOrgCreditEnforcement: true },
}));
vi.mock('../middleware/flagRegistry.js', () => ({
  flagRegistry: { getFlag: mockGetFlag },
}));
vi.mock('../utils/anchorProofs.js', () => ({
  upsertAnchorProofs: mockUpsertAnchorProofs,
}));
vi.mock('../utils/complianceMapping.js', () => ({ getComplianceControlIds: () => [] }));
vi.mock('../utils/rpc.js', () => ({
  callRpc: vi.fn(async () => ({ data: null, error: null })),
}));
vi.mock('../chain/client.js', () => ({
  getChainClientAsync: vi.fn(async () => ({
    hasFunds: async () => true,
    estimateCurrentFee: async () => 1,
    submitFingerprint: mockSubmitFingerprint,
    prepareFingerprintTx: mockPrepare,
    broadcastSignedTx: mockBroadcastSigned,
    getReceipt: mockGetReceipt,
  })),
  getInitializedChainClient: vi.fn(),
  getChainClient: vi.fn(),
}));

vi.mock('../utils/db.js', () => {
  // Query-builder that records filters and resolves by table + terminal.
  function makeSelectBuilder(table: string) {
    const filters: Array<[string, ...unknown[]]> = [];
    let usedRange = false;
    const builder: Record<string, unknown> = {};
    const chain = (name: string) => vi.fn((...args: unknown[]) => {
      filters.push([name, ...args]);
      if (name === 'range') usedRange = true;
      return builder;
    });
    builder.eq = chain('eq');
    builder.is = chain('is');
    builder.not = chain('not');
    builder.lt = chain('lt');
    builder.order = chain('order');
    builder.limit = chain('limit');
    builder.range = chain('range');
    builder.maybeSingle = vi.fn(async () => {
      if (usedRange) return { data: null, error: null }; // trigger probe — below threshold
      return dbState.oldest; // oldest-PENDING query
    });
    builder.single = vi.fn(async () => ({ data: null, error: null }));
    builder.then = (resolve?: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      // Thenable terminals: the reconcile scan (anchors + not-null chain_tx_id)
      // and the anchor_proofs intent lookup.
      const wantsIntentScan = filters.some(([name, col]) => name === 'not' && col === 'chain_tx_id');
      if (table === 'anchors' && wantsIntentScan) {
        return Promise.resolve({ data: dbState.reconcileRows, error: null }).then(resolve, reject);
      }
      if (table === 'anchor_proofs') {
        return Promise.resolve({ data: dbState.intentProofRows, error: null }).then(resolve, reject);
      }
      return Promise.resolve({ data: [], error: null }).then(resolve, reject);
    };
    return builder;
  }

  function makeUpdateBuilder(table: string, payload: Record<string, unknown>) {
    const filters: Array<[string, ...unknown[]]> = [];
    const builder: Record<string, unknown> = {};
    const chain = (name: string) => vi.fn((...args: unknown[]) => {
      filters.push([name, ...args]);
      return builder;
    });
    builder.eq = chain('eq');
    builder.in = chain('in');
    builder.then = (resolve?: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      if (table === 'anchors') {
        anchorsUpdates.push({ payload, filters });
        if ('chain_tx_id' in payload && payload.chain_tx_id !== null) {
          callOrder.push('persistChainTxId');
        }
        if (payload.status === 'PENDING') callOrder.push('revertToPending');
      }
      return Promise.resolve({ error: null, count: 1 }).then(resolve, reject);
    };
    return builder;
  }

  function makeDeleteBuilder(table: string) {
    const filters: Array<[string, ...unknown[]]> = [];
    const builder: Record<string, unknown> = {};
    const chain = (name: string) => vi.fn((...args: unknown[]) => {
      filters.push([name, ...args]);
      return builder;
    });
    builder.eq = chain('eq');
    builder.in = chain('in');
    builder.then = (resolve?: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      if (table === 'anchor_proofs') proofDeletes.push({ filters });
      return Promise.resolve({ error: null }).then(resolve, reject);
    };
    return builder;
  }

  return {
    db: {
      rpc: mockDbRpc,
      from: vi.fn((table: string) => ({
        select: vi.fn(() => makeSelectBuilder(table)),
        update: vi.fn((payload: Record<string, unknown>) => makeUpdateBuilder(table, payload)),
        delete: vi.fn(() => makeDeleteBuilder(table)),
      })),
    },
    withDbTimeout: vi.fn((fn: () => Promise<unknown>) => fn()),
  };
});

// ---- System under test ----

import { processBatchAnchors } from './batch-anchor.js';

// ---- Fixtures ----

const FP_A = 'aa'.repeat(32);
const FP_B = 'bb'.repeat(32);
const FP_C = 'cc'.repeat(32);
const SORTED_ROOT = buildMerkleTree([FP_A, FP_B, FP_C]).root;
const TX_HEX = '02000000deadbeefcafef00d';
const TX_ID = 'f1'.repeat(32);

const CLAIMED_OUT_OF_ORDER = [
  { id: 'anchor-c', fingerprint: FP_C, metadata: null },
  { id: 'anchor-a', fingerprint: FP_A, metadata: null },
  { id: 'anchor-b', fingerprint: FP_B, metadata: null },
];

function mockClaimReturns(anchors: Array<Record<string, unknown>>) {
  mockDbRpc.mockImplementation(async (name: string) => {
    if (name === 'claim_pending_anchors') return { data: anchors, error: null };
    if (name === 'submit_batch_anchors') {
      callOrder.push('submitBatchAnchors');
      return { data: anchors.length, error: null };
    }
    if (name === 'refund_org_credit') return { data: { success: true }, error: null };
    return { data: null, error: null };
  });
  // Only the FIRST claim chunk returns rows; subsequent chunks are empty.
  let claimed = false;
  mockDbRpc.mockImplementation(async (name: string) => {
    if (name === 'claim_pending_anchors') {
      if (claimed) return { data: [], error: null };
      claimed = true;
      return { data: anchors, error: null };
    }
    if (name === 'submit_batch_anchors') {
      callOrder.push('submitBatchAnchors');
      return { data: anchors.length, error: null };
    }
    if (name === 'refund_org_credit') return { data: { success: true }, error: null };
    return { data: null, error: null };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  callOrder.length = 0;
  anchorsUpdates.length = 0;
  proofDeletes.length = 0;
  dbState.reconcileRows = [];
  dbState.intentProofRows = [];
  dbState.oldest = { data: { created_at: '2026-01-01T00:00:00Z' }, error: null };

  mockGetFlag.mockReturnValue(true);
  mockUpsertAnchorProofs.mockImplementation(async (..._args: unknown[]) => {
    callOrder.push('persistProofs');
  });
  mockPrepare.mockImplementation(async (req: { fingerprint: string }) => ({
    txHex: TX_HEX,
    txId: TX_ID,
    feeSats: 141,
    opReturnData: `41524b56${req.fingerprint}`,
  }));
  mockBroadcastSigned.mockImplementation(async (hex: string) => {
    callOrder.push('broadcast');
    return {
      receiptId: TX_ID,
      blockHeight: 800100,
      blockTimestamp: '2026-07-06T00:00:00.000Z',
      confirmations: 0,
      rawTxHex: hex,
    };
  });
  mockGetReceipt.mockResolvedValue(null);
  mockDbRpc.mockResolvedValue({ data: [], error: null });
});

// =============================================================================
// AC7 — flag gate: the job cannot run unless explicitly enabled
// =============================================================================

describe('S3-P0 — ENABLE_BATCH_ANCHORING gate', () => {
  it('does nothing when the flag is off — no claim, no chain call, even with force', async () => {
    mockGetFlag.mockReturnValue(false);
    mockClaimReturns(CLAIMED_OUT_OF_ORDER);

    const result = await processBatchAnchors({ force: true });

    expect(result).toEqual({ processed: 0, batchId: null, merkleRoot: null, txId: null });
    expect(mockDbRpc).not.toHaveBeenCalled();
    expect(mockPrepare).not.toHaveBeenCalled();
    expect(mockBroadcastSigned).not.toHaveBeenCalled();
    expect(mockSubmitFingerprint).not.toHaveBeenCalled();
  });

  it('runs when the flag is on', async () => {
    mockClaimReturns(CLAIMED_OUT_OF_ORDER);
    const result = await processBatchAnchors({ force: true });
    expect(result.processed).toBe(3);
  });
});

// =============================================================================
// AC1 — deterministic leaf ordering
// =============================================================================

describe('S3-P0 — deterministic leaf ordering', () => {
  it('sorts claimed leaves by (fingerprint asc, id asc) before building the tree', async () => {
    mockClaimReturns(CLAIMED_OUT_OF_ORDER);

    const result = await processBatchAnchors({ force: true });

    expect(result.merkleRoot).toBe(SORTED_ROOT);
    expect(mockPrepare).toHaveBeenCalledTimes(1);
    expect(mockPrepare.mock.calls[0][0].fingerprint).toBe(SORTED_ROOT);
  });

  it('persists merkle_index aligned with the SORTED order', async () => {
    mockClaimReturns(CLAIMED_OUT_OF_ORDER);
    await processBatchAnchors({ force: true });

    const rows = mockUpsertAnchorProofs.mock.calls[0][1] as Array<Record<string, unknown>>;
    const byAnchor = new Map(rows.map((r) => [r.anchorId, r.merkleIndex]));
    expect(byAnchor.get('anchor-a')).toBe(0);
    expect(byAnchor.get('anchor-b')).toBe(1);
    expect(byAnchor.get('anchor-c')).toBe(2);
  });
});

// =============================================================================
// AC3 — intent persisted BEFORE broadcast; happy path
// =============================================================================

describe('S3-P0 — pre-broadcast intent persistence (happy path)', () => {
  it('persists proofs + chain_tx_id BEFORE broadcasting, then finalizes via submit_batch_anchors', async () => {
    mockClaimReturns(CLAIMED_OUT_OF_ORDER);

    const result = await processBatchAnchors({ force: true });

    expect(result).toMatchObject({ processed: 3, merkleRoot: SORTED_ROOT, txId: TX_ID });

    const broadcastIdx = callOrder.indexOf('broadcast');
    expect(broadcastIdx).toBeGreaterThan(-1);
    expect(callOrder.indexOf('persistProofs')).toBeLessThan(broadcastIdx);
    expect(callOrder.indexOf('persistChainTxId')).toBeLessThan(broadcastIdx);
    expect(callOrder.indexOf('submitBatchAnchors')).toBeGreaterThan(broadcastIdx);

    // The legacy single-call broadcast path must NOT be used.
    expect(mockSubmitFingerprint).not.toHaveBeenCalled();
    // Broadcast sends the exact prepared bytes.
    expect(mockBroadcastSigned).toHaveBeenCalledWith(TX_HEX);
  });

  it('proof rows carry op_return_payload for every leaf and the signed-tx intent on the index-0 row only', async () => {
    mockClaimReturns(CLAIMED_OUT_OF_ORDER);
    await processBatchAnchors({ force: true });

    expect(mockUpsertAnchorProofs).toHaveBeenCalledTimes(1);
    const rows = mockUpsertAnchorProofs.mock.calls[0][1] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.receiptId).toBe(TX_ID);
      expect(row.opReturnPayload).toBe(`41524b56${SORTED_ROOT}`);
      expect(row.merkleRoot).toBe(SORTED_ROOT);
    }
    const intentRows = rows.filter((r) => r.rawResponse != null);
    expect(intentRows).toHaveLength(1);
    expect(intentRows[0].merkleIndex).toBe(0);
    const intent = (intentRows[0].rawResponse as Record<string, Record<string, unknown>>).broadcast_intent;
    expect(intent).toMatchObject({ tx_id: TX_ID, tx_hex: TX_HEX, leaf_count: 3 });
  });

  it('marks chain_tx_id on the claimed BROADCASTING rows as the durable intent lock', async () => {
    mockClaimReturns(CLAIMED_OUT_OF_ORDER);
    await processBatchAnchors({ force: true });

    const intentMark = anchorsUpdates.find(
      (u) => u.payload.chain_tx_id === TX_ID && !('status' in u.payload),
    );
    expect(intentMark).toBeDefined();
    // Guarded to still-BROADCASTING rows only.
    expect(intentMark!.filters).toContainEqual(['eq', 'status', 'BROADCASTING']);
  });
});

// =============================================================================
// AC3 — induced mid-job crash (unknown broadcast outcome) + rerun
// =============================================================================

describe('S3-P0 — crash/unknown-outcome: never revert, never double-broadcast', () => {
  it('transient broadcast failure leaves rows BROADCASTING with the intent intact (no revert, no proof delete)', async () => {
    mockClaimReturns(CLAIMED_OUT_OF_ORDER);
    mockBroadcastSigned.mockRejectedValue(new Error('connect ETIMEDOUT 1.2.3.4:8332'));

    const result = await processBatchAnchors({ force: true });

    expect(result.processed).toBe(0);
    expect(result.txId).toBe(TX_ID); // intent txid surfaced for observability
    expect(callOrder).not.toContain('revertToPending');
    expect(proofDeletes).toHaveLength(0);
    expect(callOrder).not.toContain('submitBatchAnchors');
  });

  it('rerun after crash: tx already on-chain → finalize with the SAME txid, NO second broadcast', async () => {
    // Simulated crash aftermath: rows are BROADCASTING with chain_tx_id set.
    dbState.reconcileRows = [
      { id: 'anchor-a', chain_tx_id: TX_ID, org_id: null, metadata: null, credential_type: null },
      { id: 'anchor-b', chain_tx_id: TX_ID, org_id: null, metadata: null, credential_type: null },
    ];
    mockGetReceipt.mockResolvedValue({
      receiptId: TX_ID,
      blockHeight: 800101,
      blockTimestamp: '2026-07-06T01:00:00.000Z',
      confirmations: 1,
    });

    await processBatchAnchors({ force: true });

    // Finalized via submit_batch_anchors with the SAME txid.
    const submitCall = mockDbRpc.mock.calls.find(([name]) => name === 'submit_batch_anchors');
    expect(submitCall).toBeDefined();
    expect(submitCall![1]).toMatchObject({ p_tx_id: TX_ID });
    expect(new Set(submitCall![1].p_anchor_ids)).toEqual(new Set(['anchor-a', 'anchor-b']));

    // NO rebroadcast of any kind for the reconciled batch.
    expect(mockBroadcastSigned).not.toHaveBeenCalled();
    expect(mockSubmitFingerprint).not.toHaveBeenCalled();
  });

  it('rerun after crash: tx NOT on-chain → rebroadcasts the SAME signed bytes from the intent record', async () => {
    dbState.reconcileRows = [
      { id: 'anchor-a', chain_tx_id: TX_ID, org_id: null, metadata: null, credential_type: null },
    ];
    dbState.intentProofRows = [
      {
        raw_response: {
          broadcast_intent: {
            tx_id: TX_ID,
            tx_hex: TX_HEX,
            fee_sats: 141,
            prepared_at: '2026-07-06T00:00:00.000Z',
          },
        },
      },
    ];
    mockGetReceipt.mockResolvedValue(null);

    await processBatchAnchors({ force: true });

    // The SAME bytes — hence the SAME txid — never a freshly-built second tx.
    expect(mockBroadcastSigned).toHaveBeenCalledWith(TX_HEX);
    expect(mockPrepare).not.toHaveBeenCalled();
    const submitCall = mockDbRpc.mock.calls.find(([name]) => name === 'submit_batch_anchors');
    expect(submitCall![1]).toMatchObject({ p_tx_id: TX_ID });
  });

  it('rerun with tx unknown AND intent hex missing → leaves rows alone (never reverts a possible broadcast)', async () => {
    dbState.reconcileRows = [
      { id: 'anchor-a', chain_tx_id: TX_ID, org_id: null, metadata: null, credential_type: null },
    ];
    dbState.intentProofRows = []; // no recoverable hex
    mockGetReceipt.mockResolvedValue(null);

    await processBatchAnchors({ force: true });

    expect(callOrder).not.toContain('revertToPending');
    expect(mockBroadcastSigned).not.toHaveBeenCalled();
    const submitCall = mockDbRpc.mock.calls.find(([name]) => name === 'submit_batch_anchors');
    expect(submitCall).toBeUndefined();
    expect(mockLogger.error).toHaveBeenCalled();
  });
});

// =============================================================================
// Definitive (non-retryable) reject — the ONLY safe intent unwind
// =============================================================================

describe('S3-P0 — definitive broadcast reject unwinds the intent safely', () => {
  it('non-retryable reject → deletes intent proofs, clears chain_tx_id, reverts to PENDING', async () => {
    mockClaimReturns(CLAIMED_OUT_OF_ORDER);
    mockBroadcastSigned.mockRejectedValue(
      new Error('sendrawtransaction failed: dust (code -26)'),
    );

    const result = await processBatchAnchors({ force: true });

    expect(result.processed).toBe(0);
    // Intent proofs for this exact txid removed.
    expect(proofDeletes.length).toBeGreaterThan(0);
    expect(proofDeletes[0].filters).toContainEqual(['eq', 'receipt_id', TX_ID]);
    // Rows reverted with the intent cleared.
    const revert = anchorsUpdates.find((u) => u.payload.status === 'PENDING');
    expect(revert).toBeDefined();
    expect(revert!.payload.chain_tx_id).toBeNull();
    expect(callOrder).not.toContain('submitBatchAnchors');
  });

  it('refunds queue-run credits charged for the rejected batch', async () => {
    const chargedDocusign = {
      id: 'anchor-ds',
      org_id: '11111111-1111-4111-8111-111111111111',
      fingerprint: 'dd'.repeat(32),
      credential_type: 'CONTRACT_POSTSIGNING',
      metadata: {
        connector_source: 'docusign',
        rule_action_type: 'AUTO_ANCHOR',
        credit_denial_reason: null,
      },
    };
    mockClaimReturns([chargedDocusign]);
    mockBroadcastSigned.mockRejectedValue(new Error('sendrawtransaction failed: dust (code -26)'));

    // deductOrgCredit path: org credit RPC deduction is mocked at the orgCredits
    // module level in the main suite; here the deduct goes through the real
    // helper which calls db.rpc('deduct_org_credit') — return success.
    mockDbRpc.mockImplementation(async (name: string) => {
      if (name === 'claim_pending_anchors') {
        const first = mockDbRpc.mock.calls.filter(([n]) => n === 'claim_pending_anchors').length === 1;
        return { data: first ? [chargedDocusign] : [], error: null };
      }
      if (name === 'deduct_org_credit') {
        return { data: { success: true, balance: 9 }, error: null };
      }
      if (name === 'refund_org_credit') return { data: { success: true }, error: null };
      return { data: null, error: null };
    });

    await processBatchAnchors({ force: true });

    const refundCall = mockDbRpc.mock.calls.find(([name]) => name === 'refund_org_credit');
    expect(refundCall).toBeDefined();
    expect(refundCall![1]).toMatchObject({ p_org_id: chargedDocusign.org_id });
  });
});
