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
import type { ChainClient } from '../chain/types.js';

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
    /** Unresolved durable txid journal rows returned before legacy reconcile. */
    journalRows: [] as Array<Record<string, unknown>>,
    /** Anchors loaded by journal REVERT for idempotent credit refund. */
    journalAnchorRows: [] as Array<Record<string, unknown>>,
    /** Optional journal insert failure for the zero-broadcast barrier test. */
    journalInsertError: null as { message: string; code?: string } | null,
    /** Persistence result distinguishes a newly authorized broadcast from recovery ownership. */
    journalPersistResult: { journal_id: 'journal-1', created: true } as {
      journal_id: string;
      created: boolean;
      [key: string]: unknown;
    },
    /** Per-chunk responses for anchors.chain_tx_id intent-mark updates. */
    intentMarkResults: [] as Array<{ data?: Array<{ id: string }>; count?: number | null; error?: { message?: string } | null }>,
    /** Oldest-PENDING row for the trigger probe. */
    oldest: { data: { created_at: '2026-01-01T00:00:00Z' }, error: null } as Record<string, unknown>,
  };

  const anchorsUpdates = [] as Array<{
    payload: Record<string, unknown>;
    options?: Record<string, unknown>;
    filters: Array<[string, ...unknown[]]>;
  }>;
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
    builder.in = chain('in');
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
      const wantsJournalCohort = filters.some(([name, col]) => name === 'in' && col === 'id');
      if (table === 'anchors' && wantsJournalCohort) {
        return Promise.resolve({ data: dbState.journalAnchorRows, error: null }).then(resolve, reject);
      }
      if (table === 'anchor_proofs') {
        return Promise.resolve({ data: dbState.intentProofRows, error: null }).then(resolve, reject);
      }
      if (table === 'anchor_txid_journal') {
        return Promise.resolve({ data: dbState.journalRows, error: null }).then(resolve, reject);
      }
      return Promise.resolve({ data: [], error: null }).then(resolve, reject);
    };
    return builder;
  }

  function makeUpdateBuilder(table: string, payload: Record<string, unknown>, options?: Record<string, unknown>) {
    const filters: Array<[string, ...unknown[]]> = [];
    const builder: Record<string, unknown> = {};
    const chain = (name: string) => vi.fn((...args: unknown[]) => {
      filters.push([name, ...args]);
      return builder;
    });
    builder.eq = chain('eq');
    builder.in = chain('in');
    builder.select = chain('select');
    builder.then = (resolve?: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      let result: { error: { message?: string } | null; count?: number | null; data?: Array<{ id: string }> } = {
        error: null,
        count: 1,
      };
      if (table === 'anchors') {
        anchorsUpdates.push({ payload, options, filters });
        if ('chain_tx_id' in payload && payload.chain_tx_id !== null) {
          callOrder.push('persistChainTxId');
          const idFilter = filters.find(([name, col]) => name === 'in' && col === 'id');
          const ids = Array.isArray(idFilter?.[2]) ? idFilter[2] as string[] : [];
          const queued = dbState.intentMarkResults.shift();
          result = queued ? {
            error: queued.error ?? null,
            count: queued.count,
            data: queued.data,
          } : {
            error: null,
            count: ids.length,
            data: ids.map((id) => ({ id })),
          };
        }
        if (payload.status === 'PENDING') callOrder.push('revertToPending');
      }
      return Promise.resolve(result).then(resolve, reject);
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

  function makeInsertBuilder(table: string, payload: Record<string, unknown>) {
    const builder: Record<string, unknown> = {};
    builder.select = vi.fn(() => builder);
    builder.single = vi.fn(async () => {
      if (table !== 'anchor_txid_journal') return { data: null, error: { message: `unexpected insert ${table}` } };
      callOrder.push('persistJournal');
      if (dbState.journalInsertError) return { data: null, error: dbState.journalInsertError };
      return { data: { id: 'journal-1', ...payload }, error: null };
    });
    return builder;
  }

  return {
    db: {
      rpc: mockDbRpc,
      from: vi.fn((table: string) => ({
        select: vi.fn(() => makeSelectBuilder(table)),
        insert: vi.fn((payload: Record<string, unknown>) => makeInsertBuilder(table, payload)),
        delete: vi.fn(() => makeDeleteBuilder(table)),
        update: vi.fn((payload: Record<string, unknown>, options?: Record<string, unknown>) =>
          makeUpdateBuilder(table, payload, options),
        ),
      })),
    },
    withDbTimeout: vi.fn((fn: () => Promise<unknown>) => fn()),
  };
});

// ---- System under test ----

import { processBatchAnchors, reconcileTxidJournals } from './batch-anchor.js';
// Real typed errors (utxo-provider is NOT mocked here) — the unwind gate must
// discriminate a definitive broadcast reject from an auth/quota/transport blip.
import { HttpError, RpcApplicationError, BroadcastRejectedError } from '../chain/utxo-provider.js';

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
  const materializeJournalPersistResult = (params: Record<string, unknown>) => {
    const configured = dbState.journalPersistResult;
    if (typeof configured.outcome === 'string') return configured;
    return {
      ...configured,
      outcome: configured.created ? 'CREATED' : 'EXACT_REPLAY',
      owner_batch_id: params.p_batch_id,
      owner_txid: params.p_txid,
      owner_fingerprint_root: params.p_fingerprint_root,
      owner_anchor_ids: params.p_anchor_ids,
      owner_leaf_order: params.p_leaf_order,
      owner_journal_ids: [configured.journal_id],
      protected_anchor_ids: params.p_anchor_ids,
      released_anchor_ids: [],
    };
  };
  mockDbRpc.mockImplementation(async (name: string, params?: Record<string, unknown>) => {
    if (name === 'claim_pending_anchors') return { data: anchors, error: null };
    if (name === 'persist_anchor_txid_journal') {
      callOrder.push('persistJournal');
      if (dbState.journalInsertError) return { data: null, error: dbState.journalInsertError };
      return { data: materializeJournalPersistResult(params ?? {}), error: null };
    }
    if (name === 'submit_batch_anchors') {
      callOrder.push('submitBatchAnchors');
      return { data: anchors.length, error: null };
    }
    if (name === 'refund_org_credit') return { data: { success: true }, error: null };
    return { data: null, error: null };
  });
  // Only the FIRST claim chunk returns rows; subsequent chunks are empty.
  let claimed = false;
  mockDbRpc.mockImplementation(async (name: string, params?: Record<string, unknown>) => {
    if (name === 'claim_pending_anchors') {
      if (claimed) return { data: [], error: null };
      claimed = true;
      return { data: anchors, error: null };
    }
    if (name === 'persist_anchor_txid_journal') {
      callOrder.push('persistJournal');
      if (dbState.journalInsertError) return { data: null, error: dbState.journalInsertError };
      return { data: materializeJournalPersistResult(params ?? {}), error: null };
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
  dbState.journalRows = [];
  dbState.journalAnchorRows = [];
  dbState.journalInsertError = null;
  dbState.journalPersistResult = { journal_id: 'journal-1', created: true };
  dbState.intentMarkResults = [];
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
    expect(callOrder.indexOf('persistJournal')).toBeLessThan(callOrder.indexOf('persistProofs'));
    expect(callOrder.indexOf('persistJournal')).toBeLessThan(broadcastIdx);
    expect(callOrder.indexOf('persistProofs')).toBeLessThan(broadcastIdx);
    expect(callOrder.indexOf('persistChainTxId')).toBeLessThan(broadcastIdx);
    expect(callOrder.indexOf('submitBatchAnchors')).toBeGreaterThan(broadcastIdx);

    // The legacy single-call broadcast path must NOT be used.
    expect(mockSubmitFingerprint).not.toHaveBeenCalled();
    // Broadcast sends the exact prepared bytes.
    expect(mockBroadcastSigned).toHaveBeenCalledWith(TX_HEX);
    const persistCall = mockDbRpc.mock.calls.find(([name]) => name === 'persist_anchor_txid_journal');
    expect(persistCall?.[1]).toMatchObject({
      p_txid: TX_ID,
      p_fingerprint_root: SORTED_ROOT,
      p_anchor_ids: ['anchor-a', 'anchor-b', 'anchor-c'],
    });
    expect(mockDbRpc.mock.calls.some(
      ([name, params]) => name === 'resolve_anchor_txid_journal' && params.p_action === 'PERSISTED',
    )).toBe(true);
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
    expect(intentMark!.options).toEqual({ count: 'exact' });
    expect(intentMark!.filters).toContainEqual(['eq', 'status', 'BROADCASTING']);
    expect(intentMark!.filters).toContainEqual(['select', 'id']);
  });

  it.each([
    ['zero', [], 0],
    ['partial', [{ id: 'anchor-a' }, { id: 'anchor-b' }], 2],
  ])('aborts before broadcast when the intent mark affects %s intended rows', async (_label, returnedRows, count) => {
    mockClaimReturns(CLAIMED_OUT_OF_ORDER);
    dbState.intentMarkResults = [{ data: returnedRows, count, error: null }];

    const result = await processBatchAnchors({ force: true });

    expect(result).toEqual({ processed: 0, batchId: null, merkleRoot: SORTED_ROOT, txId: null });
    expect(mockBroadcastSigned).not.toHaveBeenCalled();
    expect(callOrder).not.toContain('broadcast');
    expect(proofDeletes.length).toBeGreaterThan(0);
    expect(callOrder).toContain('revertToPending');
  });

  it('aborts with zero network calls when the durable journal insert fails', async () => {
    mockClaimReturns(CLAIMED_OUT_OF_ORDER);
    dbState.journalInsertError = { message: 'journal rejected the cohort', code: '23514' };

    const result = await processBatchAnchors({ force: true });

    expect(result).toEqual({ processed: 0, batchId: null, merkleRoot: SORTED_ROOT, txId: null });
    expect(mockBroadcastSigned).not.toHaveBeenCalled();
    expect(mockUpsertAnchorProofs).not.toHaveBeenCalled();
    expect(callOrder).toContain('persistJournal');
    expect(callOrder).toContain('revertToPending');
  });

  it('defers exact live-journal retries to recovery with zero broadcast or destructive unwind', async () => {
    mockClaimReturns(CLAIMED_OUT_OF_ORDER);
    dbState.journalPersistResult = { journal_id: 'journal-existing', created: false };

    const result = await processBatchAnchors({ force: true });

    expect(result).toEqual({
      processed: 0,
      batchId: expect.any(String),
      merkleRoot: SORTED_ROOT,
      txId: TX_ID,
    });
    expect(mockBroadcastSigned).not.toHaveBeenCalled();
    expect(mockUpsertAnchorProofs).not.toHaveBeenCalled();
    expect(callOrder).not.toContain('persistChainTxId');
    expect(callOrder).not.toContain('revertToPending');
    expect(proofDeletes).toHaveLength(0);
    expect(mockDbRpc.mock.calls.some(([name]) => name === 'refund_org_credit')).toBe(false);
  });

  it('fails a disjoint batch/tx collision closed after the database atomically releases this unowned cohort', async () => {
    mockClaimReturns(CLAIMED_OUT_OF_ORDER);
    dbState.journalPersistResult = {
      journal_id: 'journal-existing',
      created: false,
      outcome: 'CONFLICT_UNWOUND',
      conflict_reason: 'disjoint_batch_or_tx_collision',
      owner_batch_id: 'other-batch',
      owner_txid: 'e2'.repeat(32),
      owner_fingerprint_root: 'd3'.repeat(32),
      owner_anchor_ids: ['other-anchor'],
      owner_leaf_order: [{ anchor_id: 'other-anchor', fingerprint: 'd4'.repeat(32) }],
      owner_journal_ids: ['journal-existing'],
      protected_anchor_ids: ['other-anchor'],
      released_anchor_ids: CLAIMED_OUT_OF_ORDER.map((anchor) => anchor.id),
    };

    const result = await processBatchAnchors({ force: true });

    expect(result).toEqual({ processed: 0, batchId: null, merkleRoot: SORTED_ROOT, txId: null });
    expect(mockBroadcastSigned).not.toHaveBeenCalled();
    expect(mockUpsertAnchorProofs).not.toHaveBeenCalled();
    expect(callOrder).not.toContain('persistChainTxId');
  });

  it('fails closed without destructive unwind when a committed collision omits a claimed anchor from both cohorts', async () => {
    mockClaimReturns(CLAIMED_OUT_OF_ORDER);
    dbState.journalPersistResult = {
      journal_id: 'journal-existing',
      created: false,
      outcome: 'CONFLICT_UNWOUND',
      conflict_reason: 'overlapping_immutable_request_conflict',
      owner_batch_id: 'other-batch',
      owner_txid: 'e2'.repeat(32),
      owner_fingerprint_root: 'd3'.repeat(32),
      owner_anchor_ids: ['anchor-b'],
      owner_leaf_order: [{ anchor_id: 'anchor-b', fingerprint: FP_B }],
      owner_journal_ids: ['journal-existing'],
      protected_anchor_ids: ['anchor-b'],
      // anchor-c is malformedly absent from both sides of the partition.
      released_anchor_ids: ['anchor-a'],
    };

    const result = await processBatchAnchors({ force: true });

    expect(result).toEqual({
      processed: 0,
      batchId: expect.any(String),
      merkleRoot: SORTED_ROOT,
      txId: TX_ID,
    });
    expect(mockBroadcastSigned).not.toHaveBeenCalled();
    expect(mockUpsertAnchorProofs).not.toHaveBeenCalled();
    expect(callOrder).not.toContain('revertToPending');
    expect(mockDbRpc.mock.calls.some(([name]) => name === 'refund_org_credit')).toBe(false);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('malformed released cohort') }),
      'Txid journal persistence outcome unknown — preserving cohort for database recovery',
    );
  });

  it('rejects duplicate collision cohort members without refunding or requeueing protected anchors', async () => {
    mockClaimReturns(CLAIMED_OUT_OF_ORDER);
    dbState.journalPersistResult = {
      journal_id: 'journal-existing',
      created: false,
      outcome: 'CONFLICT_UNWOUND',
      conflict_reason: 'overlapping_immutable_request_conflict',
      owner_batch_id: 'other-batch',
      owner_txid: 'e2'.repeat(32),
      owner_fingerprint_root: 'd3'.repeat(32),
      owner_anchor_ids: ['anchor-b', 'anchor-c'],
      owner_leaf_order: [],
      owner_journal_ids: ['journal-existing'],
      protected_anchor_ids: ['anchor-b', 'anchor-c'],
      released_anchor_ids: ['anchor-a', 'anchor-a'],
    };

    const result = await processBatchAnchors({ force: true });

    expect(result).toMatchObject({ processed: 0, batchId: expect.any(String), txId: TX_ID });
    expect(mockBroadcastSigned).not.toHaveBeenCalled();
    expect(callOrder).not.toContain('revertToPending');
    expect(mockDbRpc.mock.calls.some(([name]) => name === 'refund_org_credit')).toBe(false);
  });

  it.each([
    ['empty owner set', []],
    ['non-string owner', [42]],
    ['journal id outside owner set', ['different-journal']],
  ])('rejects %s without destructive unwind', async (_label, ownerJournalIds) => {
    mockClaimReturns(CLAIMED_OUT_OF_ORDER);
    dbState.journalPersistResult = {
      journal_id: 'journal-existing',
      created: false,
      outcome: 'CONFLICT_UNWOUND',
      conflict_reason: 'disjoint_batch_or_tx_collision',
      owner_batch_id: 'other-batch',
      owner_txid: 'e2'.repeat(32),
      owner_fingerprint_root: 'd3'.repeat(32),
      owner_anchor_ids: ['other-anchor'],
      owner_leaf_order: [],
      owner_journal_ids: ownerJournalIds,
      protected_anchor_ids: ['other-anchor'],
      released_anchor_ids: ['anchor-a', 'anchor-b', 'anchor-c'],
    };

    const result = await processBatchAnchors({ force: true });

    expect(result).toMatchObject({ processed: 0, batchId: expect.any(String), txId: TX_ID });
    expect(mockBroadcastSigned).not.toHaveBeenCalled();
    expect(callOrder).not.toContain('revertToPending');
    expect(mockDbRpc.mock.calls.some(([name]) => name === 'refund_org_credit')).toBe(false);
  });
});

// =============================================================================
// SCRUM-2692 — durable journal recovery owns ADOPT / REVERT / HOLD
// =============================================================================

describe('SCRUM-2692 — durable journal integration', () => {
  function stageJournal(overrides: Record<string, unknown> = {}) {
    const oldEnough = new Date(Date.now() - 31 * 60_000).toISOString();
    dbState.journalRows = [{
      id: 'journal-recovery-1',
      batch_id: 'batch_1721044800000_1',
      txid: TX_ID,
      fingerprint_root: FP_A,
      anchor_ids: ['anchor-a'],
      leaf_order: [{ anchor_id: 'anchor-a', fingerprint: FP_A }],
      signed_at: oldEnough,
      created_at: oldEnough,
      recovery_status: 'PENDING',
      ...overrides,
    }];
    dbState.journalAnchorRows = [{
      id: 'anchor-a',
      chain_tx_id: TX_ID,
      org_id: null,
      metadata: null,
      credential_type: null,
    }];
  }

  const client = () => ({ getReceipt: mockGetReceipt }) as unknown as ChainClient;

  it('ADOPTs the exact txid idempotently without any rebroadcast', async () => {
    stageJournal();
    mockGetReceipt.mockResolvedValue({
      receiptId: TX_ID,
      blockHeight: 800101,
      blockTimestamp: '2026-07-15T12:00:00.000Z',
      confirmations: 0,
    });

    const result = await reconcileTxidJournals(client());

    expect(result).toMatchObject({ scanned: 1, adopted: 1, reverted: 0, held: 0 });
    expect(mockDbRpc.mock.calls.some(
      ([name, params]) => name === 'resolve_anchor_txid_journal' && params.p_action === 'ADOPT',
    )).toBe(true);
    expect(mockBroadcastSigned).not.toHaveBeenCalled();
  });

  it.each([
    ['lookup outage', () => mockGetReceipt.mockRejectedValue(new HttpError('GetBlock unavailable', 503)), 'lookup_failed'],
    ['txid mismatch', () => mockGetReceipt.mockResolvedValue({ receiptId: 'e2'.repeat(32), blockHeight: 0, blockTimestamp: '', confirmations: 0 }), 'found_txid_mismatch'],
    ['negative confirmations', () => mockGetReceipt.mockResolvedValue({ receiptId: TX_ID, blockHeight: 0, blockTimestamp: '', confirmations: -1 }), 'negative_confirmations'],
  ])('HOLDs on %s and never calls generic revert', async (_label, arrange, reason) => {
    stageJournal();
    arrange();

    const result = await reconcileTxidJournals(client());

    expect(result).toMatchObject({ scanned: 1, adopted: 0, reverted: 0, held: 1 });
    const hold = mockDbRpc.mock.calls.find(
      ([name, params]) => name === 'resolve_anchor_txid_journal' && params.p_action === 'HOLD',
    );
    expect(hold?.[1]).toMatchObject({ p_reason: reason });
    expect(mockDbRpc.mock.calls.some(([name]) => name === 'recover_stuck_broadcasts')).toBe(false);
  });

  it('HOLDs affirmative absence inside the ambiguity window', async () => {
    stageJournal({ signed_at: new Date().toISOString(), created_at: new Date().toISOString() });
    mockGetReceipt.mockResolvedValue(null);

    const result = await reconcileTxidJournals(client());

    expect(result.held).toBe(1);
    expect(mockDbRpc.mock.calls.some(
      ([name, params]) => name === 'resolve_anchor_txid_journal'
        && params.p_action === 'HOLD'
        && params.p_reason === 'absence_inside_ambiguity_window',
    )).toBe(true);
  });

  it('HOLDs a fresh database journal even when the worker signed_at is arbitrarily old', async () => {
    stageJournal({
      signed_at: new Date(Date.now() - 24 * 60 * 60_000).toISOString(),
      created_at: new Date().toISOString(),
    });
    mockGetReceipt.mockResolvedValue(null);

    const result = await reconcileTxidJournals(client());

    expect(result).toMatchObject({ reverted: 0, held: 1 });
    expect(mockDbRpc.mock.calls.some(
      ([name, params]) => name === 'resolve_anchor_txid_journal'
        && params.p_action === 'HOLD'
        && params.p_reason === 'absence_inside_ambiguity_window',
    )).toBe(true);
  });

  it('REVERTs only after affirmative bounded absence and cohort refund readiness', async () => {
    stageJournal();
    mockGetReceipt.mockResolvedValue(null);

    const result = await reconcileTxidJournals(client());

    expect(result).toMatchObject({ scanned: 1, adopted: 0, reverted: 1, held: 0 });
    expect(mockDbRpc.mock.calls.some(
      ([name, params]) => name === 'resolve_anchor_txid_journal'
        && params.p_action === 'REVERT'
        && params.p_reason === 'affirmative_absence_after_ambiguity_window',
    )).toBe(true);
    expect(mockBroadcastSigned).not.toHaveBeenCalled();
    // BUG-2026-08-01-F9 (GAP 2): a journal REVERT is itself a definitive,
    // fully-unwound rejection of a prior tick's cohort (same shape as the
    // legacy-compat reconcileOneIntent reject, just decided by affirmative
    // absence rather than a node-level reject) — it must not disappear as a
    // bare `reverted: 1` count with no explanation available to callers.
    expect(result.rejectedReason).toBeTruthy();
    expect(result.rejectedReason).toContain('affirmative_absence_after_ambiguity_window');
  });

  it('BUG-2026-08-01-F9 (GAP 2): a journal REVERT with nothing else due this tick still surfaces on the final BatchAnchorResult, not a plain EMPTY', async () => {
    stageJournal();
    mockGetReceipt.mockResolvedValue(null); // affirmative absence → REVERT

    const result = await processBatchAnchors({ force: true });

    expect(result.processed).toBe(0);
    expect(result.rejectedReason).toBeTruthy();
    expect(result.rejectedReason).toContain('affirmative_absence_after_ambiguity_window');
  });

  it.each(['SUBMITTED', 'SECURED'])('never refunds before SQL rejects a %s cohort REVERT', async (status) => {
    stageJournal();
    dbState.journalAnchorRows = [{
      id: 'anchor-a',
      chain_tx_id: TX_ID,
      org_id: '11111111-1111-4111-8111-111111111111',
      metadata: {
        queue_credit_source: 'org_credits',
        queue_credit_charged_at: '2026-07-15T12:00:00.000Z',
      },
      credential_type: null,
      status,
    }];
    mockGetReceipt.mockResolvedValue(null);
    mockDbRpc.mockImplementation(async (name: string, params?: { p_action?: string }) => {
      if (name === 'resolve_anchor_txid_journal' && params?.p_action === 'REVERT') {
        return { data: null, error: { message: `Refusing REVERT for ${status}` } };
      }
      if (name === 'refund_org_credit') return { data: { success: true }, error: null };
      return { data: null, error: null };
    });

    const result = await reconcileTxidJournals(client());

    expect(result).toMatchObject({ reverted: 0, held: 1 });
    expect(mockDbRpc.mock.calls.some(([name]) => name === 'refund_org_credit')).toBe(false);
    expect(anchorsUpdates).toHaveLength(0);
  });

  it('fails the compatibility path closed while more than one journal page remains unresolved', async () => {
    dbState.journalRows = Array.from({ length: 101 }, (_, index) => {
      const suffix = index.toString(16).padStart(64, '0');
      return {
        id: `journal-${index}`,
        batch_id: `batch-${index}`,
        txid: suffix,
        fingerprint_root: FP_A,
        anchor_ids: [`anchor-${index}`],
        leaf_order: [{ anchor_id: `anchor-${index}`, fingerprint: FP_A }],
        signed_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        recovery_status: 'PENDING',
      };
    });
    mockGetReceipt.mockResolvedValue(null);

    const result = await reconcileTxidJournals(client());

    expect(result.protectionLoaded).toBe(false);
    expect(result.scanned).toBe(100);
    expect(result.held).toBe(100);
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

  it('HIGH: a provider quota/auth error (402/401) after a possible broadcast DEFERS, never unwinds (no second mainnet tx)', async () => {
    // S3-P0 review HIGH: a 402 GetBlock quota error (e.g. at the 3am drain), a
    // 401 auth rotation, or a post-broadcast bookkeeping throw is NOT a node
    // rejection — the tx may be live. It must leave rows BROADCASTING+intent for
    // reconcile, NOT refund+delete+revert (which would broadcast a 2nd, different tx).
    mockClaimReturns(CLAIMED_OUT_OF_ORDER);
    mockBroadcastSigned.mockRejectedValue(new Error('GetBlock RPC HTTP 402 Payment Required (quota exceeded)'));

    const result = await processBatchAnchors({ force: true });

    expect(result.processed).toBe(0);
    expect(result.txId).toBe(TX_ID); // intent surfaced; batch NOT nulled/unwound
    expect(callOrder).not.toContain('revertToPending');
    expect(proofDeletes).toHaveLength(0); // intent proofs preserved for reconcile
    expect(callOrder).not.toContain('submitBatchAnchors');
  });

  it('HIGH: a 401 auth error DEFERS too (unknown outcome, not a definitive reject)', async () => {
    mockClaimReturns(CLAIMED_OUT_OF_ORDER);
    mockBroadcastSigned.mockRejectedValue(new Error('HTTP 401 Unauthorized'));

    await processBatchAnchors({ force: true });

    expect(callOrder).not.toContain('revertToPending');
    expect(proofDeletes).toHaveLength(0);
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
  it('non-retryable reject → atomically deletes proofs, clears txid, and reverts the journal cohort', async () => {
    mockClaimReturns(CLAIMED_OUT_OF_ORDER);
    mockBroadcastSigned.mockRejectedValue(
      new Error('sendrawtransaction failed: dust (code -26)'),
    );

    const result = await processBatchAnchors({ force: true });

    expect(result.processed).toBe(0);
    const resolution = mockDbRpc.mock.calls.find(
      ([name, params]) => name === 'resolve_anchor_txid_journal' && params.p_action === 'REVERT',
    );
    expect(resolution).toBeDefined();
    expect(resolution![1]).toMatchObject({ p_journal_id: 'journal-1' });
    // Cleanup is owned by the migration RPC, never split across client writes.
    expect(proofDeletes).toHaveLength(0);
    expect(callOrder).not.toContain('submitBatchAnchors');
  });

  it('delegates charged-batch refund and REVERT to the atomic SQL resolver', async () => {
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
    mockDbRpc.mockImplementation(async (name: string, params?: Record<string, unknown>) => {
      if (name === 'claim_pending_anchors') {
        const first = mockDbRpc.mock.calls.filter(([n]) => n === 'claim_pending_anchors').length === 1;
        return { data: first ? [chargedDocusign] : [], error: null };
      }
      if (name === 'deduct_org_credit') {
        return { data: { success: true, balance: 9 }, error: null };
      }
      if (name === 'persist_anchor_txid_journal') {
        return {
          data: {
            journal_id: 'journal-1',
            created: true,
            outcome: 'CREATED',
            owner_batch_id: params?.p_batch_id,
            owner_txid: params?.p_txid,
            owner_fingerprint_root: params?.p_fingerprint_root,
            owner_anchor_ids: params?.p_anchor_ids,
            owner_leaf_order: params?.p_leaf_order,
            owner_journal_ids: ['journal-1'],
            protected_anchor_ids: params?.p_anchor_ids,
            released_anchor_ids: [],
          },
          error: null,
        };
      }
      if (name === 'resolve_anchor_txid_journal') return { data: 1, error: null };
      if (name === 'refund_org_credit') return { data: { success: true }, error: null };
      return { data: null, error: null };
    });

    await processBatchAnchors({ force: true });

    expect(mockDbRpc.mock.calls.some(([name]) => name === 'refund_org_credit')).toBe(false);
    const resolution = mockDbRpc.mock.calls.find(
      ([name, params]) => name === 'resolve_anchor_txid_journal' && params.p_action === 'REVERT',
    );
    expect(resolution).toBeDefined();
    expect(resolution![1]).toMatchObject({ p_journal_id: 'journal-1' });
  });
});

// =============================================================================
// #1417-HIGH — double-broadcast: the unwind fires ONLY on a typed broadcast
// reject. Auth/quota/transport failures anywhere in the broadcast→reconcile
// path DEFER — never a second, different mainnet tx while the first is live.
// =============================================================================

describe('#1417-HIGH — Phase 3c: only a definitive reject unwinds; auth/quota/transport DEFER', () => {
  it('GetBlock 402 (quota, e.g. at the 3am drain) thrown from broadcastSignedTx → NO unwind, row stays BROADCASTING', async () => {
    mockClaimReturns(CLAIMED_OUT_OF_ORDER);
    // A 402 can surface here two ways: the broadcast itself, OR the infallible
    // post-broadcast height read leaking (belt-and-suspenders: even if that
    // leak regresses, the gate must still DEFER a quota error).
    mockBroadcastSigned.mockRejectedValue(new HttpError('GetBlock quota exceeded', 402));

    const result = await processBatchAnchors({ force: true });

    expect(result.processed).toBe(0);
    expect(result.txId).toBe(TX_ID); // intent surfaced; reconcile will finalize
    expect(callOrder).not.toContain('revertToPending');
    expect(proofDeletes).toHaveLength(0);
    expect(callOrder).not.toContain('submitBatchAnchors');
  });

  it('GetBlock 401 (auth) thrown from broadcastSignedTx → NO unwind (DEFER)', async () => {
    mockClaimReturns(CLAIMED_OUT_OF_ORDER);
    mockBroadcastSigned.mockRejectedValue(new HttpError('unauthorized', 401));

    const result = await processBatchAnchors({ force: true });

    expect(result.processed).toBe(0);
    expect(callOrder).not.toContain('revertToPending');
    expect(proofDeletes).toHaveLength(0);
  });

  it('unknown Error from broadcastSignedTx → NO unwind (fail-safe DEFER)', async () => {
    mockClaimReturns(CLAIMED_OUT_OF_ORDER);
    mockBroadcastSigned.mockRejectedValue(new Error('unexpected provider response shape'));

    await processBatchAnchors({ force: true });

    expect(callOrder).not.toContain('revertToPending');
    expect(proofDeletes).toHaveLength(0);
  });

  it('genuine dust / min-relay-fee reject (BroadcastRejectedError) → unwind DOES fire', async () => {
    mockClaimReturns(CLAIMED_OUT_OF_ORDER);
    mockBroadcastSigned.mockRejectedValue(new BroadcastRejectedError('min relay fee not met (code -26)', -26));

    const result = await processBatchAnchors({ force: true });

    expect(result.processed).toBe(0);
    expect(mockDbRpc.mock.calls.some(
      ([name, params]) => name === 'resolve_anchor_txid_journal' && params.p_action === 'REVERT',
    )).toBe(true);
    expect(proofDeletes).toHaveLength(0);
  });

  // BUG-2026-08-01-F9: a definitive, resolved broadcast rejection (e.g. UTXO
  // contention when a concurrently-scheduled org's broadcast consumed the
  // treasury's UTXOs first) returns the SAME processed:0 shape as "nothing was
  // due" unless the result explicitly signals the rejection. Observed live in
  // prod 2026-08-01T18:49:31Z (org 40383eb2-f1cd-4a85-8099-afafff95e5cf):
  // organization_queue_runs recorded status='succeeded', processed_count=0,
  // error=NULL for a run that WAS a definitive reject — indistinguishable from
  // a quiet no-op to anyone reading run history. This assertion pins that the
  // result carries a `rejectedReason` so a caller (org-queue-scheduler.ts,
  // /api/queue/run) can record the run honestly instead of as a plain success.
  it('genuine reject sets BatchAnchorResult.rejectedReason so callers can distinguish it from "nothing due" (BUG-2026-08-01-F9)', async () => {
    mockClaimReturns(CLAIMED_OUT_OF_ORDER);
    mockBroadcastSigned.mockRejectedValue(new BroadcastRejectedError('min relay fee not met (code -26)', -26));

    const result = await processBatchAnchors({ force: true });

    expect(result.processed).toBe(0);
    expect(result.rejectedReason).toBeTruthy();
    expect(result.rejectedReason).toContain('min relay fee not met');
  });

  it('genuine reject surfaced as RpcApplicationError from sendrawtransaction → unwind DOES fire', async () => {
    mockClaimReturns(CLAIMED_OUT_OF_ORDER);
    mockBroadcastSigned.mockRejectedValue(new RpcApplicationError('bad-txns-inputs-missingorspent (code -25)', -25, 500));

    const result = await processBatchAnchors({ force: true });

    expect(result.processed).toBe(0);
    expect(mockDbRpc.mock.calls.some(
      ([name, params]) => name === 'resolve_anchor_txid_journal' && params.p_action === 'REVERT',
    )).toBe(true);
    expect(proofDeletes).toHaveLength(0);
    // BUG-2026-08-01-F9: same signal must be present on the RpcApplicationError
    // reject path, not just BroadcastRejectedError.
    expect(result.rejectedReason).toBeTruthy();
  });

  it('non-reject failures (HOLD/DEFER outcomes) do NOT set rejectedReason — only a resolved, unwound rejection does', async () => {
    mockClaimReturns(CLAIMED_OUT_OF_ORDER);
    mockBroadcastSigned.mockRejectedValue(new HttpError('unauthorized', 401));

    const result = await processBatchAnchors({ force: true });

    expect(result.rejectedReason).toBeUndefined();
  });
});

describe('#1417-HIGH — reconcile rebroadcast: outage on a LIVE tx defers, never unwinds', () => {
  function stageInterruptedIntent() {
    dbState.reconcileRows = [
      { id: 'anchor-a', chain_tx_id: TX_ID, org_id: null, metadata: null, credential_type: null },
    ];
    dbState.intentProofRows = [
      { raw_response: { broadcast_intent: { tx_id: TX_ID, tx_hex: TX_HEX, fee_sats: 141, prepared_at: '2026-07-06T00:00:00.000Z' } } },
    ];
  }

  it('getReceipt lookup FAILS (throws provider outage) → DEFER, no rebroadcast, no unwind (the reachable "lookup failed" branch)', async () => {
    stageInterruptedIntent();
    // Provider outage during reconcile — getReceipt now THROWS (tri-state
    // lookup-failed) rather than returning null. Must NOT be read as tx-unknown.
    mockGetReceipt.mockRejectedValue(new HttpError('GetBlock quota exceeded', 402));

    await processBatchAnchors({ force: true });

    expect(mockBroadcastSigned).not.toHaveBeenCalled(); // no rebroadcast attempt
    expect(callOrder).not.toContain('revertToPending');
    expect(proofDeletes).toHaveLength(0);
  });

  it('401 during reconcile rebroadcast of an unknown-but-live tx → DEFER (never unwind)', async () => {
    stageInterruptedIntent();
    mockGetReceipt.mockResolvedValue(null); // tx not seen (provider lag) → rebroadcast path
    mockBroadcastSigned.mockRejectedValue(new HttpError('unauthorized', 401));

    await processBatchAnchors({ force: true });

    expect(mockBroadcastSigned).toHaveBeenCalledWith(TX_HEX);
    expect(callOrder).not.toContain('revertToPending');
    expect(proofDeletes).toHaveLength(0);
  });

  it('402 during reconcile rebroadcast → DEFER (never unwind)', async () => {
    stageInterruptedIntent();
    mockGetReceipt.mockResolvedValue(null);
    mockBroadcastSigned.mockRejectedValue(new HttpError('GetBlock quota exceeded', 402));

    await processBatchAnchors({ force: true });

    expect(callOrder).not.toContain('revertToPending');
    expect(proofDeletes).toHaveLength(0);
  });

  it('genuine dust reject during reconcile rebroadcast → unwind DOES fire', async () => {
    stageInterruptedIntent();
    mockGetReceipt.mockResolvedValue(null);
    mockBroadcastSigned.mockRejectedValue(new BroadcastRejectedError('dust (code -26)', -26));

    const result = await processBatchAnchors({ force: true });

    expect(mockBroadcastSigned).toHaveBeenCalledWith(TX_HEX);
    expect(proofDeletes.length).toBeGreaterThan(0);
    expect(callOrder).toContain('revertToPending');
    // BUG-2026-08-01-F9 (GAP 2): the main claim path found nothing new to do
    // this tick (no PENDING claims staged), so — before this fix — the
    // function returned the plain EMPTY shape with no way to tell this
    // apart from "nothing was due", even though a prior tick's broadcast was
    // JUST discovered to be definitively rejected and rolled back right here.
    expect(result.processed).toBe(0);
    expect(result.rejectedReason).toBeTruthy();
    expect(result.rejectedReason).toContain('dust');
  });

  it('non-reject reconcile outcomes (DEFER/HOLD) do NOT set rejectedReason on the final result', async () => {
    stageInterruptedIntent();
    mockGetReceipt.mockResolvedValue(null);
    mockBroadcastSigned.mockRejectedValue(new HttpError('unauthorized', 401));

    const result = await processBatchAnchors({ force: true });

    expect(callOrder).not.toContain('revertToPending');
    expect(result.rejectedReason).toBeUndefined();
  });

  // Precedence: a same-tick reconcile-phase rejection (cleaning up a PRIOR
  // tick's interrupted broadcast) AND a same-tick main-path rejection (THIS
  // tick's own new broadcast attempt) can both occur. The main-path reason
  // wins — it reflects what just happened to the anchors this very call
  // claimed and is the more actionable, current signal; the reconcile-phase
  // reason exists only to keep an otherwise-empty-looking result honest.
  it('precedence: a same-tick main-path rejection reason wins over a same-tick reconcile-phase rejection reason', async () => {
    stageInterruptedIntent(); // stale reconcile cohort on TX_ID
    mockGetReceipt.mockResolvedValue(null);
    mockBroadcastSigned
      .mockRejectedValueOnce(new BroadcastRejectedError('reconcile-phase stale-cohort reject', -26))
      .mockRejectedValueOnce(new BroadcastRejectedError('main-path current-tick reject', -26));
    // A distinct txId for the NEW cohort so it never collides with the stale
    // reconcile txid (TX_ID) in the mock DB state.
    mockPrepare.mockImplementation(async (req: { fingerprint: string }) => ({
      txHex: '02000000newbytes',
      txId: 'e2'.repeat(32),
      feeSats: 141,
      opReturnData: `41524b56${req.fingerprint}`,
    }));
    mockClaimReturns(CLAIMED_OUT_OF_ORDER);

    const result = await processBatchAnchors({ force: true });

    expect(result.rejectedReason).toContain('main-path current-tick reject');
    expect(result.rejectedReason).not.toContain('reconcile-phase stale-cohort reject');
  });
});
