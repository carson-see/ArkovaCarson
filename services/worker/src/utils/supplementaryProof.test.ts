/**
 * SCRUM-3188 — supplementary proof anchor, pure core.
 *
 * The properties under test are the ones that make this subsystem safe to point
 * at real mainnet money and 2.97M live customer records:
 *
 *  1. A proof row can ONLY be constructed after every emitted branch verifies
 *     against the root the CHAIN committed. There is no best-effort mode.
 *  2. The leaf ORDER is recorded, and a root rebuilt from the recorded order is
 *     byte-identical — the defect that created this backlog cannot recur.
 *  3. The original attestation is carried through untouched and is mandatory:
 *     a supplementary proof that does not name what it supplements is refused.
 *  4. Spend is bounded by an explicit fee ceiling and a treasury reserve.
 */

import { describe, it, expect } from 'vitest';
import { buildMerkleTree, verifyMerkleProof } from './merkle.js';
import {
  orderSupplementaryLeaves,
  planSupplementaryBatch,
  buildVerifiedSupplementaryProofRows,
  assessSupplementarySpend,
  estimateSupplementaryRun,
  SUPPLEMENTARY_TX_VSIZE,
  UnverifiedSupplementaryProofError,
  type SupplementaryLeaf,
} from './supplementaryProof.js';

/** Deterministic, well-distributed 64-hex fingerprint for a seed. */
function fp(seed: number): string {
  // Knuth multiplicative hash keeps the leaves spread across the sort space
  // (rather than all sharing a long zero prefix), so ordering assertions
  // exercise real comparisons.
  const word = (((seed + 1) * 2654435761) >>> 0).toString(16).padStart(8, '0');
  return word.repeat(8);
}

function leaves(n: number): SupplementaryLeaf[] {
  return Array.from({ length: n }, (_, i) => ({
    anchorId: `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`,
    fingerprint: fp(i + 1),
  }));
}

function originals(ls: SupplementaryLeaf[], txId = 'a'.repeat(64)): Map<string, string> {
  return new Map(ls.map((l) => [l.anchorId, txId]));
}

describe('orderSupplementaryLeaves', () => {
  it('is deterministic and independent of input order', () => {
    const ls = leaves(50);
    const shuffled = [...ls].reverse();
    expect(orderSupplementaryLeaves(shuffled)).toEqual(orderSupplementaryLeaves(ls));
  });

  it('orders by (fingerprint asc, anchorId asc), matching the primary producer', () => {
    const a: SupplementaryLeaf = { anchorId: 'id-b', fingerprint: fp(1) };
    const b: SupplementaryLeaf = { anchorId: 'id-a', fingerprint: fp(1) };
    const c: SupplementaryLeaf = { anchorId: 'id-c', fingerprint: fp(2) };
    expect(orderSupplementaryLeaves([c, a, b])).toEqual([b, a, c]);
  });

  it('rejects duplicate anchor ids — a cohort must be a set', () => {
    const dup = [...leaves(2), { anchorId: leaves(2)[0].anchorId, fingerprint: fp(9) }];
    expect(() => orderSupplementaryLeaves(dup)).toThrow(/duplicate anchor/i);
  });

  it('rejects a malformed fingerprint rather than committing it', () => {
    expect(() => orderSupplementaryLeaves([{ anchorId: 'x', fingerprint: 'not-hex' }]))
      .toThrow(/fingerprint/i);
  });
});

describe('planSupplementaryBatch — the recorded-order round trip', () => {
  it('rebuilds a byte-identical root from the RECORDED leaf order', () => {
    // This is the regression ratchet for the defect that created the backlog:
    // the Mar/Apr producer never persisted leaf order, so its roots became
    // unreproducible. Rebuilding from the recorded order must be exact.
    for (const n of [1, 2, 3, 8, 9, 17, 64, 1000]) {
      const plan = planSupplementaryBatch(leaves(n));
      const rebuilt = buildMerkleTree(plan.leafOrder.map((l) => l.fingerprint));
      expect(rebuilt.root).toBe(plan.root);
      expect(plan.leafOrder).toHaveLength(n);
    }
  });

  it('emits a branch per leaf that verifies against its own root', () => {
    const plan = planSupplementaryBatch(leaves(17));
    plan.leafOrder.forEach((leaf, i) => {
      expect(verifyMerkleProof(leaf.fingerprint, plan.proofsByIndex[i], plan.root)).toBe(true);
    });
  });

  it('produces the same root regardless of the order rows arrive in', () => {
    const ls = leaves(33);
    expect(planSupplementaryBatch([...ls].reverse()).root).toBe(planSupplementaryBatch(ls).root);
  });

  it('refuses an empty batch', () => {
    expect(() => planSupplementaryBatch([])).toThrow(/empty/i);
  });
});

describe('buildVerifiedSupplementaryProofRows — never write an unverified proof', () => {
  const txId = 'b'.repeat(64);

  it('constructs rows when the committed root matches and every branch verifies', () => {
    const ls = leaves(12);
    const plan = planSupplementaryBatch(ls);
    const rows = buildVerifiedSupplementaryProofRows({
      plan,
      committedRoot: plan.root,
      supplementaryTxId: txId,
      originalTxIdByAnchorId: originals(ls),
      batchId: 'supp_1',
      blockHeight: 961982,
      blockTimestamp: '2026-08-11T08:17:15.000Z',
    });
    expect(rows).toHaveLength(12);
    rows.forEach((row, i) => {
      expect(row.receiptId).toBe(txId);
      expect(row.merkleIndex).toBe(i);
      expect(row.isSupplementary).toBe(true);
      expect(row.supplementsChainTxId).toBe('a'.repeat(64));
      expect(row.proofCompletenessClass).toBe('supplementary_anchored');
      expect(verifyMerkleProof(row.fingerprint, row.proofPath, row.merkleRoot)).toBe(true);
    });
  });

  it('REFUSES when the chain committed a different root than we planned', () => {
    const ls = leaves(6);
    const plan = planSupplementaryBatch(ls);
    expect(() => buildVerifiedSupplementaryProofRows({
      plan,
      committedRoot: 'f'.repeat(64), // what the chain actually says
      supplementaryTxId: txId,
      originalTxIdByAnchorId: originals(ls),
      batchId: 'supp_1',
    })).toThrow(UnverifiedSupplementaryProofError);
  });

  it('REFUSES when a single branch has been tampered with', () => {
    const ls = leaves(8);
    const plan = planSupplementaryBatch(ls);
    // Corrupt one sibling hash — the root still matches, only the branch lies.
    const tampered = {
      ...plan,
      proofsByIndex: plan.proofsByIndex.map((branch, i) =>
        i === 3 ? [{ ...branch[0], hash: 'c'.repeat(64) }, ...branch.slice(1)] : branch,
      ),
    };
    expect(() => buildVerifiedSupplementaryProofRows({
      plan: tampered,
      committedRoot: plan.root,
      supplementaryTxId: txId,
      originalTxIdByAnchorId: originals(ls),
      batchId: 'supp_1',
    })).toThrow(UnverifiedSupplementaryProofError);
  });

  it('REFUSES a batch-of-1, where fabrication is easiest, unless it verifies', () => {
    const ls = leaves(1);
    const plan = planSupplementaryBatch(ls);
    // Single-leaf root IS the fingerprint; a mismatched commitment must fail.
    expect(() => buildVerifiedSupplementaryProofRows({
      plan,
      committedRoot: fp(99),
      supplementaryTxId: txId,
      originalTxIdByAnchorId: originals(ls),
      batchId: 'supp_1',
    })).toThrow(UnverifiedSupplementaryProofError);

    const ok = buildVerifiedSupplementaryProofRows({
      plan,
      committedRoot: plan.root,
      supplementaryTxId: txId,
      originalTxIdByAnchorId: originals(ls),
      batchId: 'supp_1',
    });
    expect(ok).toHaveLength(1);
    expect(ok[0].proofPath).toEqual([]);
  });

  it('REFUSES to write a proof for an anchor whose original attestation is unknown', () => {
    // Writing a supplementary proof without recording what it supplements would
    // let the new tx be read as the record's first attestation — the exact
    // backdate-shift this design exists to prevent.
    const ls = leaves(4);
    const plan = planSupplementaryBatch(ls);
    const partial = originals(ls);
    partial.delete(ls[0].anchorId);
    expect(() => buildVerifiedSupplementaryProofRows({
      plan,
      committedRoot: plan.root,
      supplementaryTxId: txId,
      originalTxIdByAnchorId: partial,
      batchId: 'supp_1',
    })).toThrow(/original attestation/i);
  });

  it('REFUSES when the supplementary txid equals the original txid', () => {
    // A supplementary anchor is by definition a SECOND transaction.
    const ls = leaves(3);
    const plan = planSupplementaryBatch(ls);
    expect(() => buildVerifiedSupplementaryProofRows({
      plan,
      committedRoot: plan.root,
      supplementaryTxId: txId,
      originalTxIdByAnchorId: originals(ls, txId),
      batchId: 'supp_1',
    })).toThrow(/must differ/i);
  });

  it('REFUSES a malformed supplementary txid', () => {
    const ls = leaves(2);
    const plan = planSupplementaryBatch(ls);
    expect(() => buildVerifiedSupplementaryProofRows({
      plan,
      committedRoot: plan.root,
      supplementaryTxId: 'nope',
      originalTxIdByAnchorId: originals(ls),
      batchId: 'supp_1',
    })).toThrow(/txid/i);
  });

  it('never emits a row carrying the original attestation in receipt_id', () => {
    const ls = leaves(5);
    const plan = planSupplementaryBatch(ls);
    const rows = buildVerifiedSupplementaryProofRows({
      plan,
      committedRoot: plan.root,
      supplementaryTxId: txId,
      originalTxIdByAnchorId: originals(ls),
      batchId: 'supp_1',
    });
    // receipt_id is the NEW tx; the original is preserved separately and the
    // two are never conflated.
    rows.forEach((r) => {
      expect(r.receiptId).not.toBe(r.supplementsChainTxId);
    });
  });
});

describe('assessSupplementarySpend — bounded, never drains the treasury', () => {
  const base = {
    confirmedBalanceSats: 413_658,
    feeRateSatVb: 3,
    remainingBatches: 297,
    feeCeilingSatVb: 5,
    treasuryReserveSats: 100_000,
  };

  it('permits a run that fits under the ceiling and keeps the reserve', () => {
    const v = assessSupplementarySpend(base);
    expect(v.affordable).toBe(true);
    expect(v.estimatedTotalSats).toBe(Math.ceil(SUPPLEMENTARY_TX_VSIZE * 3) * 297);
  });

  it('refuses when the fee rate exceeds the ceiling', () => {
    const v = assessSupplementarySpend({ ...base, feeRateSatVb: 9 });
    expect(v.affordable).toBe(false);
    expect(v.reason).toMatch(/ceiling/i);
  });

  it('refuses when completing the run would breach the treasury reserve', () => {
    // Production anchoring spends from the same treasury; a supplementary run
    // must never starve it.
    const v = assessSupplementarySpend({ ...base, confirmedBalanceSats: 150_000 });
    expect(v.affordable).toBe(false);
    expect(v.reason).toMatch(/reserve/i);
  });

  it('reports the maximum batches affordable so a partial run can proceed', () => {
    const v = assessSupplementarySpend({ ...base, confirmedBalanceSats: 150_000 });
    expect(v.affordableBatches).toBeGreaterThan(0);
    expect(v.affordableBatches).toBeLessThan(297);
  });
});

describe('estimateSupplementaryRun — the dry-run number', () => {
  it('matches the measured production tx shape at the real backlog size', () => {
    const e = estimateSupplementaryRun({
      anchorCount: 2_969_630,
      batchSize: 10_000,
      feeRateSatVb: 3,
    });
    expect(e.transactions).toBe(297);
    expect(e.satsPerTx).toBe(469);
    expect(e.totalSats).toBe(139_293);
  });

  it('never reports a zero-cost run for a non-empty backlog', () => {
    const e = estimateSupplementaryRun({ anchorCount: 1, batchSize: 10_000, feeRateSatVb: 1 });
    expect(e.transactions).toBe(1);
    expect(e.totalSats).toBeGreaterThan(0);
  });
});
