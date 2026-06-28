/**
 * FIX-1 (SCRUM-2471) — resumable proof-branch backfill for EXISTING SECURED
 * customer anchors whose anchor_proofs row has a merkle_root but no branch.
 *
 * Self-validating: for each batch it reconstructs the tree from the batch's
 * fingerprints (ordered created_at,id), recomputes the root, and persists
 * the branches ONLY IF the recomputed root equals the stored merkle_root.
 * A batch whose ordering can't be recovered (root mismatch) is skipped and
 * counted — never written with a wrong branch.
 *
 * Resumable: the data is the watermark — a batch with proof_path populated
 * no longer appears in the "incomplete" query, so re-running resumes.
 *
 * NOT run against prod (manual-trigger job, no cron wiring).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { buildMerkleTree } from '../utils/merkle.js';
import { verifyMerkleInclusion } from '../utils/merkle-verify.js';

const fp = (seed: string) => createHash('sha256').update(seed).digest('hex');

const { mockUpsertAnchorProofs, mockLogger } = vi.hoisted(() => ({
  mockUpsertAnchorProofs: vi.fn((_client: unknown, _rows: Array<Record<string, unknown>>): Promise<void> => Promise.resolve()),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../utils/logger.js', () => ({ logger: mockLogger }));
vi.mock('../utils/anchorProofs.js', () => ({ upsertAnchorProofs: mockUpsertAnchorProofs }));

import { runProofBranchBackfill, type ProofBackfillClient } from './proof-branch-backfill.js';

// In-memory fake DB modelling the two queries the job runs:
//  1. distinct incomplete batches (merkle_root set, proof_path null), SECURED, ordered by created_at
//  2. all anchors of a batch (id, fingerprint, created_at) ordered created_at,id
interface FakeAnchor {
  id: string;
  fingerprint: string;
  created_at: string;
  batch_id: string;
  status: string;
  proof_complete: boolean; // proof_path already present?
  merkle_root: string;
}

function makeClient(anchors: FakeAnchor[]): ProofBackfillClient {
  return {
    async listIncompleteBatches({ startAfterCreatedAt, limit }) {
      const seen = new Map<string, { batch_id: string; created_at: string; merkle_root: string }>();
      for (const a of anchors) {
        if (a.status !== 'SECURED') continue;
        if (a.proof_complete) continue;
        if (startAfterCreatedAt && a.created_at <= startAfterCreatedAt) continue;
        if (!seen.has(a.batch_id)) {
          seen.set(a.batch_id, { batch_id: a.batch_id, created_at: a.created_at, merkle_root: a.merkle_root });
        }
      }
      return Array.from(seen.values())
        .sort((x, y) => x.created_at.localeCompare(y.created_at))
        .slice(0, limit);
    },
    async listBatchAnchors(batchId) {
      return anchors
        .filter((a) => a.batch_id === batchId)
        .sort((x, y) => x.created_at.localeCompare(y.created_at) || x.id.localeCompare(y.id))
        .map((a) => ({ id: a.id, fingerprint: a.fingerprint, merkle_root: a.merkle_root }));
    },
  };
}

describe('runProofBranchBackfill (SCRUM-2471)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpsertAnchorProofs.mockResolvedValue(undefined);
  });

  it('reconstructs + persists branches for a recoverable batch (root matches)', async () => {
    const leaves = [fp('c1'), fp('c2'), fp('c3')];
    const tree = buildMerkleTree(leaves); // built in created_at,id order
    const anchors: FakeAnchor[] = leaves.map((f, i) => ({
      id: `id-${i}`,
      fingerprint: f,
      created_at: `2026-05-01T00:0${i}:00Z`,
      batch_id: 'batchX',
      status: 'SECURED',
      proof_complete: false,
      merkle_root: tree.root,
    }));
    const client = makeClient(anchors);

    const result = await runProofBranchBackfill({ client, batchLimit: 10 });
    expect(result.batchesProcessed).toBe(1);
    expect(result.batchesRecovered).toBe(1);
    expect(result.batchesUnrecoverable).toBe(0);
    expect(result.anchorsBackfilled).toBe(3);
    expect(mockUpsertAnchorProofs).toHaveBeenCalledTimes(1);

    const rows = mockUpsertAnchorProofs.mock.calls[0][1] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      const row = rows.find((r) => r.anchorId === `id-${i}`)!;
      expect(row.merkleRoot).toBe(tree.root);
      expect(row.merkleIndex).toBe(i);
      const inclusion = verifyMerkleInclusion(
        leaves[i],
        row.proofPath as { hash: string; position: 'left' | 'right' }[],
        tree.root,
        { leafIndex: row.merkleIndex as number },
      );
      expect(inclusion.valid).toBe(true);
    }
  });

  it('skips an unrecoverable batch (stored root matches no recomputed ordering) without writing', async () => {
    const leaves = [fp('u1'), fp('u2')];
    const anchors: FakeAnchor[] = leaves.map((f, i) => ({
      id: `u-${i}`,
      fingerprint: f,
      created_at: `2026-05-02T00:0${i}:00Z`,
      batch_id: 'batchBad',
      status: 'SECURED',
      proof_complete: false,
      merkle_root: fp('a-root-that-does-not-match'), // deliberately wrong
    }));
    const client = makeClient(anchors);

    const result = await runProofBranchBackfill({ client, batchLimit: 10 });
    expect(result.batchesProcessed).toBe(1);
    expect(result.batchesRecovered).toBe(0);
    expect(result.batchesUnrecoverable).toBe(1);
    expect(result.anchorsBackfilled).toBe(0);
    expect(mockUpsertAnchorProofs).not.toHaveBeenCalled();
  });

  it('is resumable: passing startAfterCreatedAt continues past processed batches', async () => {
    const leavesA = [fp('a1'), fp('a2')];
    const treeA = buildMerkleTree(leavesA);
    const leavesB = [fp('b1'), fp('b2')];
    const treeB = buildMerkleTree(leavesB);
    const anchors: FakeAnchor[] = [
      ...leavesA.map((f, i) => ({ id: `a-${i}`, fingerprint: f, created_at: `2026-05-01T00:0${i}:00Z`, batch_id: 'A', status: 'SECURED', proof_complete: false, merkle_root: treeA.root })),
      ...leavesB.map((f, i) => ({ id: `b-${i}`, fingerprint: f, created_at: `2026-05-03T00:0${i}:00Z`, batch_id: 'B', status: 'SECURED', proof_complete: false, merkle_root: treeB.root })),
    ];
    const client = makeClient(anchors);

    // Resume after batch A's window — only batch B should be processed.
    const result = await runProofBranchBackfill({ client, batchLimit: 10, startAfterCreatedAt: '2026-05-02T00:00:00Z' });
    expect(result.batchesProcessed).toBe(1);
    expect(result.anchorsBackfilled).toBe(2);
    const rows = mockUpsertAnchorProofs.mock.calls[0][1] as Array<Record<string, unknown>>;
    expect(rows.every((r) => String(r.anchorId).startsWith('b-'))).toBe(true);
  });

  it('returns the final cursor so a chunked manual run can resume', async () => {
    const leaves = [fp('z1'), fp('z2')];
    const tree = buildMerkleTree(leaves);
    const anchors: FakeAnchor[] = leaves.map((f, i) => ({
      id: `z-${i}`, fingerprint: f, created_at: `2026-05-09T00:0${i}:00Z`, batch_id: 'Z', status: 'SECURED', proof_complete: false, merkle_root: tree.root,
    }));
    const result = await runProofBranchBackfill({ client: makeClient(anchors), batchLimit: 10 });
    expect(result.lastCursor).toBe('2026-05-09T00:00:00Z'); // batch anchor created_at boundary
  });

  it('no incomplete batches ⇒ no-op', async () => {
    const result = await runProofBranchBackfill({ client: makeClient([]), batchLimit: 10 });
    expect(result.batchesProcessed).toBe(0);
    expect(mockUpsertAnchorProofs).not.toHaveBeenCalled();
  });
});
