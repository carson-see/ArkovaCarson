/**
 * Unit tests for the treasury ↔ anchor reconciliation core.
 *
 * The numbers in the "measured prod shape" block are the real 2026-08-21 figures
 * for bc1qtm2kk33k6ht4agt48kh7rfkmmhfkapqn4zwerc, scaled down to a handful of
 * rows: 3,314 outbound txs / 828,189 sats total fees, of which 853 txs and
 * 243,752 sats (29.4%) had no anchor row in prod.
 */

import { describe, it, expect } from 'vitest';
import {
  reconcile,
  orphansByMonth,
  DEFAULT_TREASURY_ADDRESS,
  ESPLORA_HOSTS,
  type SpendTx,
} from './treasury-anchor-reconcile.js';

const tx = (txid: string, fee: number, blockTime?: number): SpendTx => ({ txid, fee, blockTime });

describe('constants', () => {
  it('defaults to the treasury address in src/lib/platform.ts', () => {
    expect(DEFAULT_TREASURY_ADDRESS).toBe('bc1qtm2kk33k6ht4agt48kh7rfkmmhfkapqn4zwerc');
  });

  it('has more than one Esplora mirror', () => {
    // A single mirror rate-limits long before 3,300 transactions are drained;
    // that is exactly how the first manual pass failed at page 27.
    expect(ESPLORA_HOSTS.length).toBeGreaterThan(1);
  });
});

describe('reconcile — matching', () => {
  it('matches a spend whose txid appears in the database', () => {
    const r = reconcile([tx('aa', 100)], ['aa']);
    expect(r.matched).toEqual(['aa']);
    expect(r.orphans).toEqual([]);
    expect(r.orphanFeeSats).toBe(0);
  });

  it('is case-insensitive on both sides', () => {
    // Esplora emits lowercase hex; nothing guarantees the DB column does.
    const r = reconcile([tx('AABB', 100)], ['aabb']);
    expect(r.matched).toEqual(['aabb']);
    expect(r.orphans).toEqual([]);
  });

  it('counts a spend with no anchor row as an orphan and bills its fee', () => {
    const r = reconcile([tx('aa', 100), tx('bb', 250)], ['aa']);
    expect(r.orphans.map((o) => o.txid)).toEqual(['bb']);
    expect(r.orphanFeeSats).toBe(250);
    expect(r.totalFeeSats).toBe(350);
  });

  it('reports phantoms — anchor txids the treasury never broadcast', () => {
    // The real class: 21 prod rows cite Bitcoin SIGNET transactions and 3 cite
    // transactions that resolve on no network at all (migration 0415).
    const r = reconcile([tx('aa', 100)], ['aa', 'signet1', 'fabricated1']);
    expect(r.phantoms).toEqual(['fabricated1', 'signet1']);
  });

  it('does not double-count a txid claimed by many anchor rows', () => {
    // A batch tx carries up to 10,000 anchors, so the DB side has heavy repeats.
    const r = reconcile([tx('aa', 100)], ['aa', 'aa', 'aa']);
    expect(r.matched).toEqual(['aa']);
    expect(r.phantoms).toEqual([]);
  });
});

describe('reconcile — fee accounting', () => {
  it('computes the orphaned share of total fee spend', () => {
    const r = reconcile([tx('a', 700), tx('b', 300)], ['a']);
    expect(r.totalFeeSats).toBe(1000);
    expect(r.orphanFeeSats).toBe(300);
    expect(r.orphanFeeRatio).toBeCloseTo(0.3);
  });

  it('does not divide by zero on an empty history', () => {
    const r = reconcile([], []);
    expect(r.totalFeeSats).toBe(0);
    expect(r.orphanFeeRatio).toBe(0);
  });

  it('reproduces the measured prod shape: ~29.4% of fees orphaned', () => {
    const spends = [tx('matched', 584_280), tx('orphan', 243_752)];
    const r = reconcile(spends, ['matched']);
    expect(r.totalFeeSats).toBe(828_032);
    expect(r.orphanFeeSats).toBe(243_752);
    expect(r.orphanFeeRatio).toBeCloseTo(0.294, 3);
  });
});

describe('reconcile — inputs that must not be mistaken for spends', () => {
  it('a database with no txids makes every spend an orphan, not a crash', () => {
    // This is the "fresh/empty environment" shape. It must read as 100%
    // orphaned rather than silently passing.
    const r = reconcile([tx('a', 10), tx('b', 20)], []);
    expect(r.orphans).toHaveLength(2);
    expect(r.orphanFeeRatio).toBe(1);
  });

  it('ignores null/empty txids on the database side', () => {
    const r = reconcile([tx('a', 10)], ['', 'a']);
    expect(r.phantoms).toEqual([]);
    expect(r.matched).toEqual(['a']);
  });
});

describe('orphansByMonth', () => {
  it('buckets orphaned fee burn by calendar month', () => {
    const march = Date.UTC(2026, 2, 28) / 1000;
    const april = Date.UTC(2026, 3, 17) / 1000;
    const out = orphansByMonth([
      tx('a', 100, march),
      tx('b', 200, april),
      tx('c', 300, april),
    ]);
    expect(out['2026-03']).toEqual({ txs: 1, feeSats: 100 });
    expect(out['2026-04']).toEqual({ txs: 2, feeSats: 500 });
  });

  it('skips unconfirmed orphans rather than bucketing them under 1970', () => {
    expect(orphansByMonth([tx('pending', 157)])).toEqual({});
  });
});
