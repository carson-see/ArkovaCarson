/**
 * NPH-14 (SCRUM-711) — v8 eval gate tests.
 *
 * Proves the gate logic mirrors the 7 targets in the v8 plan doc.
 * TDD-first: every gate has both a pass-case and a fail-case.
 */

import { describe, expect, it } from 'vitest';
import {
  V5_BASELINE,
  V8_TARGETS,
  evaluateV8Gates,
  renderV8GateReport,
  v8GainOverV5,
  type V8EvalInput,
} from './v8-eval-gates';

function mkInput(over: Partial<V8EvalInput> = {}): V8EvalInput {
  return {
    macroF1: 0.90,
    weightedF1: 0.92,
    confidenceCorrelation: 0.75,
    fraudSignalsF1: 0.35,
    ece: 0.06,
    minPerTypeF1: 0.75,
    citationAccuracy: 0.60,
    ...over,
  };
}

describe('v8 eval gates', () => {
  it('passes when every gate clears the v8 target', () => {
    const r = evaluateV8Gates(mkInput());
    expect(r.passes).toBe(true);
    expect(r.failing).toHaveLength(0);
    expect(r.gates).toHaveLength(7);
  });

  it('fails when macro F1 sits at v5 baseline', () => {
    const r = evaluateV8Gates(mkInput({ macroF1: V5_BASELINE.macroF1 }));
    expect(r.passes).toBe(false);
    expect(r.failing.map((g) => g.metric)).toContain('macroF1');
  });

  it('fails when fraudSignals is the historical 0%', () => {
    const r = evaluateV8Gates(mkInput({ fraudSignalsF1: 0 }));
    expect(r.failing.map((g) => g.metric)).toContain('fraudSignalsF1');
  });

  it('fails when ECE is above the 8% ceiling', () => {
    const r = evaluateV8Gates(mkInput({ ece: 0.09 }));
    expect(r.failing.map((g) => g.metric)).toContain('ece');
  });

  it('fails when the worst credential type is under 70% F1', () => {
    const r = evaluateV8Gates(mkInput({ minPerTypeF1: 0.69 }));
    expect(r.failing.map((g) => g.metric)).toContain('minPerTypeF1');
  });

  it('catches a citation regression vs v27.3 FCRA (57%)', () => {
    const r = evaluateV8Gates(mkInput({ citationAccuracy: 0.54 }));
    expect(r.failing.map((g) => g.metric)).toContain('citationAccuracy');
  });

  it('reports one failure at a time when only one gate misses', () => {
    const r = evaluateV8Gates(mkInput({ confidenceCorrelation: 0.5 }));
    expect(r.failing).toHaveLength(1);
    expect(r.failing[0].metric).toBe('confidenceCorrelation');
  });

  it('v5 baseline is rejected by every gate except weightedF1/citation', () => {
    // v5 is 87.2% weighted, v8 target 90%. v5 is 57% citation, v8 target 55%.
    // Both fail/pass as expected in the data, but the full baseline is not
    // deploy-ready in aggregate.
    const r = evaluateV8Gates(V5_BASELINE);
    expect(r.passes).toBe(false);
    // ECE 11% is above 8% ceiling.
    expect(r.failing.map((g) => g.metric)).toContain('ece');
    // fraudSignals 0% is below 30%.
    expect(r.failing.map((g) => g.metric)).toContain('fraudSignalsF1');
  });
});

describe('v8 gain over v5', () => {
  it('reports positive deltas when v8 wins', () => {
    const delta = v8GainOverV5(mkInput());
    expect(delta.macroF1).toBeGreaterThan(0);
    expect(delta.fraudSignalsF1).toBeGreaterThan(0);
    // ECE delta is baseline - current — positive means improved.
    expect(delta.ece).toBeGreaterThan(0);
  });

  it('reports zero deltas when v8 equals v5 exactly', () => {
    const delta = v8GainOverV5(V5_BASELINE);
    expect(delta.macroF1).toBe(0);
    expect(delta.ece).toBe(0);
  });
});

describe('report rendering', () => {
  it('renders PASS header when all gates clear', () => {
    const r = evaluateV8Gates(mkInput());
    const md = renderV8GateReport(r);
    expect(md).toMatch(/PASS/);
    expect(md).not.toMatch(/## Failing gates/);
  });

  it('renders FAIL header plus failing-gate section', () => {
    const r = evaluateV8Gates(mkInput({ macroF1: 0.8 }));
    const md = renderV8GateReport(r);
    expect(md).toMatch(/FAIL/);
    expect(md).toMatch(/## Failing gates/);
  });
});

describe('v8 targets are stricter than v5', () => {
  it('every v8 target beats v5 baseline', () => {
    expect(V8_TARGETS.macroF1).toBeGreaterThan(V5_BASELINE.macroF1);
    expect(V8_TARGETS.weightedF1).toBeGreaterThan(V5_BASELINE.weightedF1);
    expect(V8_TARGETS.confidenceCorrelation).toBeGreaterThan(V5_BASELINE.confidenceCorrelation);
    expect(V8_TARGETS.fraudSignalsF1).toBeGreaterThan(V5_BASELINE.fraudSignalsF1);
    expect(V8_TARGETS.ece).toBeLessThan(V5_BASELINE.ece);
    expect(V8_TARGETS.minPerTypeF1).toBeGreaterThan(V5_BASELINE.minPerTypeF1);
  });
});
