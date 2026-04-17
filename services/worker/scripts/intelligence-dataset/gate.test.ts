/**
 * NVI-14 — FCRA Single-Domain Mastery Gate tests (SCRUM-818).
 *
 * Offline. The gate evaluator is a pure function over programmatic inputs:
 * verification registry counts, attorney-review state, distillation
 * counts, benchmark scores, canary match rate.
 */

import { describe, expect, it } from 'vitest';
import {
  evaluateFcraMasteryGate,
  renderGateStatusMarkdown,
  type FcraMasteryGateInputs,
  type GateCriterionStatus,
} from './gate';

const PASSING: FcraMasteryGateInputs = {
  verification: { total: 100, passing: 100, orphans: 0, hardFails: 0 },
  attorneyReview: { tier3Open: 0, tier3Resolved: 27 },
  chainOfThought: { scenariosWithCot: 302, scenariosTotal: 302 },
  distillation: { acceptedQa: 5000, target: 5000 },
  auxiliary: { multiTurn: 100, documentGrounded: 150, adversarial: 50 },
  benchmark: { attorneyQuestions: 50, nessieScorePercent: 72, geminiBaselinePercent: 70 },
  canary: { reviewedResponses: 120, matchRatePercent: 0.72 },
};

describe('evaluateFcraMasteryGate — 8 criteria', () => {
  it('passes when every input meets its bar', () => {
    const r = evaluateFcraMasteryGate(PASSING);
    expect(r.passes).toBe(true);
    expect(r.criteria.every((c) => c.status === 'pass')).toBe(true);
  });

  it('fails verification when hardFails exist', () => {
    const r = evaluateFcraMasteryGate({
      ...PASSING,
      verification: { total: 100, passing: 99, orphans: 0, hardFails: 1 },
    });
    expect(r.passes).toBe(false);
    const ver = r.criteria.find((c) => c.id === 'verification')!;
    expect(ver.status).toBe('fail');
  });

  it('fails verification when orphans exist', () => {
    const r = evaluateFcraMasteryGate({
      ...PASSING,
      verification: { total: 100, passing: 97, orphans: 3, hardFails: 0 },
    });
    expect(r.criteria.find((c) => c.id === 'verification')!.status).toBe('fail');
  });

  it('fails attorney-review when any tier-3 open', () => {
    const r = evaluateFcraMasteryGate({
      ...PASSING,
      attorneyReview: { tier3Open: 5, tier3Resolved: 22 },
    });
    expect(r.criteria.find((c) => c.id === 'attorney-review')!.status).toBe('fail');
  });

  it('fails distillation when under target', () => {
    const r = evaluateFcraMasteryGate({
      ...PASSING,
      distillation: { acceptedQa: 2500, target: 5000 },
    });
    expect(r.criteria.find((c) => c.id === 'distillation')!.status).toBe('fail');
  });

  it('fails auxiliary when any sub-target is short', () => {
    const r = evaluateFcraMasteryGate({
      ...PASSING,
      auxiliary: { multiTurn: 20, documentGrounded: 150, adversarial: 50 },
    });
    expect(r.criteria.find((c) => c.id === 'auxiliary')!.status).toBe('fail');
  });

  it('fails benchmark when Nessie score < Gemini baseline', () => {
    const r = evaluateFcraMasteryGate({
      ...PASSING,
      benchmark: { attorneyQuestions: 50, nessieScorePercent: 40, geminiBaselinePercent: 70 },
    });
    expect(r.criteria.find((c) => c.id === 'benchmark')!.status).toBe('fail');
  });

  it('fails professional-benchmark when attorney question count < 50', () => {
    const r = evaluateFcraMasteryGate({
      ...PASSING,
      benchmark: { attorneyQuestions: 10, nessieScorePercent: 80, geminiBaselinePercent: 70 },
    });
    expect(r.criteria.find((c) => c.id === 'professional-benchmark')!.status).toBe('fail');
  });

  it('fails canary when reviewed < 100', () => {
    const r = evaluateFcraMasteryGate({
      ...PASSING,
      canary: { reviewedResponses: 30, matchRatePercent: 0.8 },
    });
    expect(r.criteria.find((c) => c.id === 'canary')!.status).toBe('fail');
  });

  it('fails canary when match rate < 70%', () => {
    const r = evaluateFcraMasteryGate({
      ...PASSING,
      canary: { reviewedResponses: 150, matchRatePercent: 0.6 },
    });
    expect(r.criteria.find((c) => c.id === 'canary')!.status).toBe('fail');
  });

  it('has exactly 8 criteria', () => {
    const r = evaluateFcraMasteryGate(PASSING);
    expect(r.criteria).toHaveLength(8);
  });

  it('lists criterion ids in canonical order', () => {
    const r = evaluateFcraMasteryGate(PASSING);
    expect(r.criteria.map((c) => c.id)).toEqual([
      'verification',
      'attorney-review',
      'chain-of-thought',
      'distillation',
      'auxiliary',
      'professional-benchmark',
      'benchmark',
      'canary',
    ]);
  });
});

describe('renderGateStatusMarkdown', () => {
  it('renders a PASS banner when every criterion is green', () => {
    const md = renderGateStatusMarkdown(evaluateFcraMasteryGate(PASSING));
    expect(md).toMatch(/FCRA Mastery Gate: ✅ PASS/);
  });

  it('renders a HOLD banner when any criterion fails', () => {
    const md = renderGateStatusMarkdown(
      evaluateFcraMasteryGate({
        ...PASSING,
        canary: { reviewedResponses: 0, matchRatePercent: 0 },
      }),
    );
    expect(md).toMatch(/FCRA Mastery Gate: 🛑 HOLD/);
    expect(md).toMatch(/canary/i);
  });

  it('shows one line per criterion', () => {
    const md = renderGateStatusMarkdown(evaluateFcraMasteryGate(PASSING));
    const lines = md.split('\n').filter((l) => l.startsWith('- ['));
    expect(lines.length).toBe(8);
  });
});

describe('GateCriterionStatus union', () => {
  it('accepts "pass" and "fail" values', () => {
    const ok: GateCriterionStatus[] = ['pass', 'fail'];
    expect(ok).toHaveLength(2);
  });
});
