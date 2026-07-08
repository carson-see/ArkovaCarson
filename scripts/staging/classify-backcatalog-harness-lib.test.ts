import { describe, expect, it } from 'vitest';

import {
  CLASSIFY_PHASES,
  isClassifyPhase,
  defaultSeedMix,
  seedMixTotal,
  assertCensusMatches,
  classifyScopeKey,
} from './classify-backcatalog-harness-lib';

describe('phase plan', () => {
  it('exposes the five-invariant phase sequence + seed/cleanup', () => {
    expect(CLASSIFY_PHASES).toEqual(['seed', 'guc-off', 'census', 'resume', 'mutex', 'scope', 'cleanup']);
  });
  it('isClassifyPhase accepts known phases + all, rejects junk', () => {
    for (const p of CLASSIFY_PHASES) expect(isClassifyPhase(p)).toBe(true);
    expect(isClassifyPhase('all')).toBe(true);
    expect(isClassifyPhase('drop-table')).toBe(false);
  });
});

describe('defaultSeedMix — deliberately uneven so a collapsed census is caught', () => {
  it('no two class counts are equal', () => {
    const m = defaultSeedMix();
    const counts = [m.fully_proven, m.header_missing, m.index_unreconstructable, m.no_app_tree];
    expect(new Set(counts).size).toBe(counts.length);
  });
  it('scales linearly', () => {
    expect(seedMixTotal(defaultSeedMix(1))).toBe(17);
    expect(seedMixTotal(defaultSeedMix(10))).toBe(170);
  });
});

describe('assertCensusMatches — sum-consistency + exact per-class match', () => {
  const seed = defaultSeedMix();

  it('passes when the observed census equals the seed and sums correctly', () => {
    const v = assertCensusMatches(seed, { ...seed, rowsScanned: seedMixTotal(seed) });
    expect(v.pass).toBe(true);
    expect(v.reasons).toEqual([]);
  });

  it('FAILS when a class is under-counted (a dropped census row)', () => {
    const v = assertCensusMatches(seed, { ...seed, header_missing: seed.header_missing - 1 });
    expect(v.pass).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/header_missing: expected 5, got 4/);
  });

  it('FAILS when rowsScanned disagrees with the per-class sum (double-count signature)', () => {
    const v = assertCensusMatches(seed, { ...seed, rowsScanned: seedMixTotal(seed) + 3 });
    expect(v.pass).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/rowsScanned .* != sum of classes/);
  });

  it('FAILS when two classes are collapsed into one (total right, split wrong)', () => {
    // move all header_missing into fully_proven: total unchanged, split wrong
    const collapsed = {
      ...seed,
      fully_proven: seed.fully_proven + seed.header_missing,
      header_missing: 0,
    };
    const v = assertCensusMatches(seed, { ...collapsed, rowsScanned: seedMixTotal(seed) });
    expect(v.pass).toBe(false);
  });
});

describe('classifyScopeKey — per-org independent advisory keys', () => {
  it('org scopes are distinct from each other and from the global scope', () => {
    expect(classifyScopeKey('orgA')).not.toBe(classifyScopeKey('orgB'));
    expect(classifyScopeKey('orgA')).not.toBe(classifyScopeKey());
    expect(classifyScopeKey()).toBe('classify_proof_backcatalog:ALL');
  });
});
