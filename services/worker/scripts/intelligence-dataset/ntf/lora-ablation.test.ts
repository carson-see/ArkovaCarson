/**
 * NTF-02 (SCRUM-774) — LoRA ablation winner selector tests.
 *
 * Pure logic, no training. Every branch of the selection rubric has both
 * a pass-case and a fail-case so the winner choice is auditable offline.
 */

import { describe, expect, it } from 'vitest';
import {
  MIN_PER_TYPE_F1_GATE,
  renderAblationSummary,
  selectAblationWinner,
  type RankMetrics,
} from './lora-ablation';

function candidate(over: Partial<RankMetrics> = {}): RankMetrics {
  return {
    rank: 32,
    macroF1: 0.82,
    weightedF1: 0.9,
    confidenceCorrelation: 0.72,
    minPerTypeF1: 0.75,
    ...over,
  };
}

const BASELINE = { macroF1: 0.80 };

describe('selectAblationWinner', () => {
  it('picks the highest macroF1 when all gates clear', () => {
    const r = selectAblationWinner(
      [
        candidate({ rank: 32, macroF1: 0.82 }),
        candidate({ rank: 64, macroF1: 0.86 }),
        candidate({ rank: 128, macroF1: 0.85 }),
      ],
      BASELINE,
    );
    expect(r.winner?.rank).toBe(64);
    expect(r.shortlisted).toHaveLength(3);
    expect(r.rejected).toHaveLength(0);
  });

  it('tie-breaks on confidence correlation, then smaller rank', () => {
    const r = selectAblationWinner(
      [
        candidate({ rank: 32, macroF1: 0.86, confidenceCorrelation: 0.70 }),
        candidate({ rank: 64, macroF1: 0.86, confidenceCorrelation: 0.75 }),
        candidate({ rank: 128, macroF1: 0.86, confidenceCorrelation: 0.75 }),
      ],
      BASELINE,
    );
    // rank=64 wins: ties on macro w/ 128, ties on confR, tie-breaks on smaller rank.
    expect(r.winner?.rank).toBe(64);
  });

  it('rejects any rank that regresses below baseline macro F1', () => {
    const r = selectAblationWinner(
      [
        candidate({ rank: 32, macroF1: 0.79 }),
        candidate({ rank: 64, macroF1: 0.85 }),
      ],
      BASELINE,
    );
    expect(r.winner?.rank).toBe(64);
    expect(r.rejected.map((x) => x.rank)).toContain(32);
    expect(r.rejected[0].reason).toMatch(/regresses below baseline/);
  });

  it('rejects any rank with minPerTypeF1 below the 0.70 gate', () => {
    const r = selectAblationWinner(
      [
        candidate({ rank: 32, minPerTypeF1: 0.65 }),
        candidate({ rank: 64, minPerTypeF1: 0.72 }),
      ],
      BASELINE,
    );
    expect(r.winner?.rank).toBe(64);
    expect(r.rejected.map((x) => x.rank)).toContain(32);
    expect(r.rejected[0].reason).toContain(`${MIN_PER_TYPE_F1_GATE}`);
  });

  it('returns winner=null when every rank fails some gate', () => {
    const r = selectAblationWinner(
      [
        candidate({ rank: 32, macroF1: 0.70 }),
        candidate({ rank: 64, minPerTypeF1: 0.60 }),
      ],
      BASELINE,
    );
    expect(r.winner).toBeNull();
    expect(r.shortlisted).toHaveLength(0);
    expect(r.rejected).toHaveLength(2);
  });

  it('handles an empty candidate list', () => {
    const r = selectAblationWinner([], BASELINE);
    expect(r.winner).toBeNull();
    expect(r.shortlisted).toEqual([]);
    expect(r.rejected).toEqual([]);
  });
});

describe('renderAblationSummary', () => {
  it('produces a PR-ready one-liner when a winner exists', () => {
    const r = selectAblationWinner([candidate({ rank: 64, macroF1: 0.87 })], BASELINE);
    const line = renderAblationSummary(r);
    expect(line).toContain('winner: rank=64');
    expect(line).toContain('macroF1=0.870');
  });

  it('surfaces every rejection reason when no winner exists', () => {
    const r = selectAblationWinner(
      [
        candidate({ rank: 32, macroF1: 0.7 }),
        candidate({ rank: 64, minPerTypeF1: 0.5 }),
      ],
      BASELINE,
    );
    const line = renderAblationSummary(r);
    expect(line).toContain('no winner');
    expect(line).toContain('r=32');
    expect(line).toContain('r=64');
  });
});
