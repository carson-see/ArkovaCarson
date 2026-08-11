/**
 * SCRUM-3188 — LEAF-ORDER ROUND TRIP (the ratchet against a repeat of the
 * 2,969,630-record backlog).
 *
 * ── The defect this pins shut ──────────────────────────────────────────────
 * The Mar/Apr producer passed `claim_pending_anchors` rows straight into
 * `buildMerkleTree`. `UPDATE … RETURNING` carries NO ordering guarantee, so the
 * committed leaf ORDER was a query-plan artifact that was never written down.
 * The leaf SET survived; the ORDER did not. For batches larger than 8 leaves
 * the order is unrecoverable, which is why 2,969,630 SECURED anchors can never
 * be given an offline inclusion branch against their original transaction.
 *
 * ── The property under test ────────────────────────────────────────────────
 * For a FRESHLY BUILT batch, the order the producer PERSISTS
 * (`anchor_txid_journal.leaf_order`, via `persist_anchor_txid_journal`) must
 * rebuild the EXACT root the producer COMMITTED. If those two ever drift, this
 * backlog recurs silently — the anchors would look fine until someone tried to
 * verify one, months later, which is exactly how the original defect hid.
 *
 * These tests drive the REAL `processBatchAnchors` pipeline and pin the REAL
 * `sortAnchorsForBatch`, not re-implementations of either.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { buildMerkleTree, verifyMerkleProof } from '../utils/merkle.js';

const fp = (seed: string) => createHash('sha256').update(seed).digest('hex');

const {
  mockPrepareFingerprintTx,
  mockBroadcastSignedTx,
  mockEstimateCurrentFee,
  mockGetChainClientAsync,
  mockDbRpc,
  mockUpsertAnchorProofs,
  mockLogger,
  oldestRef,
  setOldest,
  journalCalls,
} = vi.hoisted(() => ({
  mockPrepareFingerprintTx: vi.fn(),
  mockBroadcastSignedTx: vi.fn(),
  mockEstimateCurrentFee: vi.fn(),
  mockGetChainClientAsync: vi.fn(),
  mockDbRpc: vi.fn(),
  mockUpsertAnchorProofs: vi.fn(
    (_c: unknown, _r: Array<Record<string, unknown>>): Promise<void> => Promise.resolve(),
  ),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  oldestRef: { value: { created_at: '2026-01-01T00:00:00Z' } as { created_at: string } | null },
  setOldest: vi.fn(),
  journalCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock('../utils/logger.js', () => ({ logger: mockLogger }));
vi.mock('../config.js', () => ({
  config: {
    nodeEnv: 'test',
    useMocks: true,
    enableOrgCreditEnforcement: false,
    maxFeeThresholdSatPerVbyte: 50,
  },
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
vi.mock('../middleware/flagRegistry.js', () => ({ flagRegistry: { getFlag: vi.fn(() => true) } }));

vi.mock('../utils/db.js', async () => {
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
  updateChain.then = (resolve?: (v: unknown) => unknown) =>
    Promise.resolve({ error: null, count: 1 }).then(resolve);

  const deleteChain: Record<string, unknown> = {};
  deleteChain.eq = vi.fn(() => deleteChain);
  deleteChain.in = vi.fn(() => deleteChain);
  deleteChain.then = (resolve?: (v: unknown) => unknown) =>
    Promise.resolve({ error: null }).then(resolve);

  return {
    db: {
      rpc: mockDbRpc,
      from: vi.fn((table: string) => {
        if (table === 'anchors') {
          return {
            select: vi.fn(() => anchorsSelectChain),
            update: vi.fn(() => updateChain),
            delete: vi.fn(() => deleteChain),
          };
        }
        if (table === 'job_queue') return grantedRunLeaseTable();
        return {
          upsert: vi.fn(async () => ({ error: null })),
          delete: vi.fn(() => deleteChain),
          select: vi.fn(() => anchorsSelectChain),
        };
      }),
    },
    withDbTimeout: vi.fn((fn: () => Promise<unknown>) => fn()),
  };
});

import { processBatchAnchors, sortAnchorsForBatch } from './batch-anchor.js';

interface Leaf { anchor_id: string; fingerprint: string }

/**
 * Wire the intent-capable (journal) path: sign -> journal -> intent -> broadcast.
 * The prepared txid is derived from the committed root so each distinct batch
 * gets a distinct, deterministic txid.
 */
function primeJournalPath(anchors: Array<Record<string, unknown>>) {
  journalCalls.length = 0;
  mockGetChainClientAsync.mockResolvedValue({
    prepareFingerprintTx: mockPrepareFingerprintTx,
    broadcastSignedTx: mockBroadcastSignedTx,
    estimateCurrentFee: mockEstimateCurrentFee,
    hasFunds: async () => true,
  });
  mockEstimateCurrentFee.mockResolvedValue(1);
  mockPrepareFingerprintTx.mockImplementation(async ({ fingerprint }: { fingerprint: string }) => ({
    txId: createHash('sha256').update(`tx:${fingerprint}`).digest('hex'),
    txHex: '00'.repeat(64),
    feeSats: 157,
    // "ARKV" + 32-byte root, exactly the production OP_RETURN shape.
    opReturnData: `41524b56${fingerprint}`,
  }));
  mockBroadcastSignedTx.mockImplementation(async () => {
    const root = mockPrepareFingerprintTx.mock.calls.at(-1)![0].fingerprint as string;
    return {
      receiptId: createHash('sha256').update(`tx:${root}`).digest('hex'),
      blockHeight: 961_982,
      blockTimestamp: '2026-08-11T08:17:15Z',
      confirmations: 0,
    };
  });

  let claimCalls = 0;
  mockDbRpc.mockImplementation(async (rpcName: string, params?: Record<string, unknown>) => {
    if (rpcName === 'claim_pending_anchors') {
      claimCalls += 1;
      return claimCalls === 1 ? { data: anchors, error: null } : { data: [], error: null };
    }
    if (rpcName === 'persist_anchor_txid_journal') {
      journalCalls.push(params ?? {});
      // Echo the request back as the owning journal (a CREATED outcome).
      return {
        data: {
          journal_id: 'journal-1',
          created: true,
          outcome: 'CREATED',
          owner_batch_id: params!.p_batch_id,
          owner_txid: params!.p_txid,
          owner_fingerprint_root: params!.p_fingerprint_root,
          owner_anchor_ids: params!.p_anchor_ids,
          owner_leaf_order: params!.p_leaf_order,
          owner_journal_ids: ['journal-1'],
          protected_anchor_ids: params!.p_anchor_ids,
          released_anchor_ids: [],
        },
        error: null,
      };
    }
    if (rpcName === 'submit_batch_anchors') return { data: anchors.length, error: null };
    return { data: null, error: null };
  });
}

/** The leaf order the producer actually persisted for the journal. */
function persistedLeafOrder(): Leaf[] {
  expect(journalCalls.length).toBeGreaterThan(0);
  return journalCalls[0].p_leaf_order as Leaf[];
}

function makeAnchors(n: number): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => ({
    id: `anchor-${String(i).padStart(4, '0')}`,
    fingerprint: fp(`leaf-${i}`),
    metadata: null,
    org_id: 'org-1',
    public_id: `P${i}`,
    credential_type: 'DIPLOMA',
  }));
}

describe('SCRUM-3188 — persisted leaf order rebuilds the committed root', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setOldest({ created_at: '2026-01-01T00:00:00Z' });
    mockUpsertAnchorProofs.mockResolvedValue(undefined);
  });

  it('rebuilds the EXACT committed root from anchor_txid_journal.leaf_order', async () => {
    const anchors = makeAnchors(37);
    primeJournalPath(anchors);

    const result = await processBatchAnchors({ force: true });
    expect(result.merkleRoot).toBeTruthy();

    const leafOrder = persistedLeafOrder();
    expect(leafOrder).toHaveLength(37);

    // THE property: the persisted order reproduces the committed root exactly.
    const rebuilt = buildMerkleTree(leafOrder.map((l) => l.fingerprint));
    expect(rebuilt.root).toBe(result.merkleRoot);
  });

  it('persists the SAME array that was hashed — index-aligned with every branch', async () => {
    // Catches a future refactor that sorts in one place but journals another:
    // the roots would still match by luck of a shared sort, but the indices
    // would not, and every stored branch would be subtly wrong.
    const anchors = makeAnchors(21);
    primeJournalPath(anchors);

    const result = await processBatchAnchors({ force: true });
    const leafOrder = persistedLeafOrder();
    const rows = mockUpsertAnchorProofs.mock.calls[0][1] as Array<Record<string, unknown>>;

    for (const row of rows) {
      const idx = row.merkleIndex as number;
      expect(leafOrder[idx].anchor_id).toBe(row.anchorId);
      expect(leafOrder[idx].fingerprint).toBe(
        anchors.find((a) => a.id === row.anchorId)!.fingerprint,
      );
      // And the branch stored at that index verifies against the committed root.
      expect(
        verifyMerkleProof(
          leafOrder[idx].fingerprint,
          row.proofPath as { hash: string; position: 'left' | 'right' }[],
          result.merkleRoot!,
        ),
      ).toBe(true);
    }
  });

  it('commits the same root no matter what order the claim RPC returns rows in', async () => {
    // `UPDATE … RETURNING` has no ordering guarantee. The committed root must be
    // a pure function of the leaf SET, so a query-plan change cannot alter it.
    const anchors = makeAnchors(30);
    primeJournalPath(anchors);
    const first = await processBatchAnchors({ force: true });
    const firstOrder = persistedLeafOrder().map((l) => l.anchor_id);

    vi.clearAllMocks();
    setOldest({ created_at: '2026-01-01T00:00:00Z' });
    mockUpsertAnchorProofs.mockResolvedValue(undefined);
    primeJournalPath([...anchors].reverse());
    const second = await processBatchAnchors({ force: true });

    expect(second.merkleRoot).toBe(first.merkleRoot);
    expect(persistedLeafOrder().map((l) => l.anchor_id)).toEqual(firstOrder);
  });

  it('NEGATIVE CONTROL: the raw claim-arrival order does NOT reproduce the root', async () => {
    // This is the Mar/Apr producer's exact behaviour. If this assertion ever
    // starts failing because the two orders coincide, the test above stops
    // proving anything, so pin that they genuinely differ for a >8-leaf batch.
    const anchors = makeAnchors(40);
    primeJournalPath(anchors);
    const result = await processBatchAnchors({ force: true });

    const arrivalOrderRoot = buildMerkleTree(
      anchors.map((a) => a.fingerprint as string),
    ).root;
    expect(arrivalOrderRoot).not.toBe(result.merkleRoot);
  });

  it('sortAnchorsForBatch is a total, deterministic order on (fingerprint, id)', () => {
    const a = { id: 'z', fingerprint: fp('same'), metadata: null };
    const b = { id: 'a', fingerprint: fp('same'), metadata: null };
    const c = { id: 'm', fingerprint: fp('other'), metadata: null };
    const once = sortAnchorsForBatch([a, b, c]);
    expect(sortAnchorsForBatch([c, b, a])).toEqual(once);
    // Ties on fingerprint break deterministically by anchor id.
    const tied = once.filter((x) => x.fingerprint === fp('same')).map((x) => x.id);
    expect(tied).toEqual(['a', 'z']);
  });
});
