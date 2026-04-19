/**
 * NPH-14 (SCRUM-711) — Nessie v8 Retrain Eval Gates.
 *
 * Pure gate logic that decides whether a v8 training run is deploy-ready.
 * No LLM calls, no network I/O — feed it the measured eval metrics and it
 * returns a pass/fail breakdown mirroring the 7 gates in
 * `docs/plans/nessie-training-parameters-v8.md`.
 *
 * Written before the tuning job is submitted so the acceptance criteria
 * are executable the moment weights land. NVI gate closure is still
 * required before any run — see the plan doc for the execution order.
 */

import { NESSIE_V5_BASELINE } from '../../../src/ai/eval/baseline-metrics.js';

export interface V8EvalInput {
  /** Macro F1 across all credential types, 0-1. */
  macroF1: number;
  /** Weighted F1, 0-1. */
  weightedF1: number;
  /** Pearson r between confidence and accuracy, -1..1. */
  confidenceCorrelation: number;
  /** F1 of fraudSignals extraction, 0-1. */
  fraudSignalsF1: number;
  /** Expected Calibration Error, 0-1. */
  ece: number;
  /** Minimum per-type F1 across all credential types, 0-1. */
  minPerTypeF1: number;
  /** Citation accuracy on the regulation-specific eval harness, 0-1. */
  citationAccuracy: number;
}

export interface V8Gate {
  metric: keyof V8EvalInput;
  target: number;
  operator: '>=' | '>' | '<' | '<=';
  actual: number;
  passed: boolean;
  label: string;
}

export interface V8GateReport {
  passes: boolean;
  gates: V8Gate[];
  failing: V8Gate[];
}

/**
 * v5 baseline for the seven v8 gates. Reuses the frozen canonical
 * baseline in `baseline-metrics.ts` and extends it with the v8-only
 * dimensions (fraud signals, min per-type F1, citation accuracy) that
 * aren't tracked on the generic regression shape.
 */
export const V5_BASELINE: V8EvalInput = {
  macroF1: NESSIE_V5_BASELINE.macroF1,
  weightedF1: NESSIE_V5_BASELINE.weightedF1,
  confidenceCorrelation: NESSIE_V5_BASELINE.confidenceCorrelation,
  ece: NESSIE_V5_BASELINE.ece,
  // v8-only dimensions — not on the generic BaselineMetrics shape.
  fraudSignalsF1: 0.0,
  minPerTypeF1: 0.548,
  citationAccuracy: 0.570,
};

/**
 * v8 deploy targets from `docs/plans/nessie-training-parameters-v8.md`
 * §Evaluation gates. Any miss fails the build — no partial deploys.
 */
export const V8_TARGETS = {
  macroF1: 0.85,
  weightedF1: 0.90,
  confidenceCorrelation: 0.70,
  fraudSignalsF1: 0.30,
  ece: 0.08,
  minPerTypeF1: 0.70,
  citationAccuracy: 0.55,
} as const;

export function evaluateV8Gates(input: V8EvalInput): V8GateReport {
  const gates: V8Gate[] = [
    mkGate('macroF1', '>=', V8_TARGETS.macroF1, input.macroF1, 'Macro F1 across all credential types'),
    mkGate('weightedF1', '>=', V8_TARGETS.weightedF1, input.weightedF1, 'Weighted F1 (sample-count weighted)'),
    mkGate('confidenceCorrelation', '>=', V8_TARGETS.confidenceCorrelation, input.confidenceCorrelation, 'Confidence–accuracy Pearson r'),
    mkGate('fraudSignalsF1', '>=', V8_TARGETS.fraudSignalsF1, input.fraudSignalsF1, 'fraudSignals extraction F1'),
    mkGate('ece', '<', V8_TARGETS.ece, input.ece, 'Expected Calibration Error (lower is better)'),
    mkGate('minPerTypeF1', '>=', V8_TARGETS.minPerTypeF1, input.minPerTypeF1, 'Worst per-type F1 must still clear 70%'),
    mkGate('citationAccuracy', '>=', V8_TARGETS.citationAccuracy, input.citationAccuracy, 'Canonical citation ID accuracy'),
  ];
  const failing = gates.filter((g) => !g.passed);
  return { passes: failing.length === 0, gates, failing };
}

function mkGate(
  metric: keyof V8EvalInput,
  operator: V8Gate['operator'],
  target: number,
  actual: number,
  label: string,
): V8Gate {
  let passed: boolean;
  switch (operator) {
    case '>=': passed = actual >= target; break;
    case '>':  passed = actual > target; break;
    case '<=': passed = actual <= target; break;
    case '<':  passed = actual < target; break;
  }
  return { metric, target, operator, actual, passed, label };
}

export function renderV8GateReport(report: V8GateReport): string {
  const lines: string[] = [];
  lines.push(`# v8 Eval Gate Report — ${report.passes ? 'PASS' : 'FAIL'}`);
  lines.push('');
  lines.push('| Gate | Target | Actual | Status |');
  lines.push('|------|--------|--------|--------|');
  for (const g of report.gates) {
    const fmt = formatMetric(g.metric, g.actual);
    const tgt = formatMetric(g.metric, g.target);
    lines.push(`| ${g.label} | ${g.operator} ${tgt} | ${fmt} | ${g.passed ? 'PASS' : 'FAIL'} |`);
  }
  if (!report.passes) {
    lines.push('');
    lines.push('## Failing gates');
    for (const g of report.failing) {
      lines.push(`- **${g.label}** — need ${g.operator} ${formatMetric(g.metric, g.target)}, got ${formatMetric(g.metric, g.actual)}`);
    }
  }
  return lines.join('\n');
}

function formatMetric(metric: keyof V8EvalInput, value: number): string {
  if (metric === 'confidenceCorrelation') return value.toFixed(3);
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * Compute the delta v8 must clear above v5. Used in release notes.
 */
export function v8GainOverV5(current: V8EvalInput): Record<keyof V8EvalInput, number> {
  return {
    macroF1: current.macroF1 - V5_BASELINE.macroF1,
    weightedF1: current.weightedF1 - V5_BASELINE.weightedF1,
    confidenceCorrelation: current.confidenceCorrelation - V5_BASELINE.confidenceCorrelation,
    fraudSignalsF1: current.fraudSignalsF1 - V5_BASELINE.fraudSignalsF1,
    ece: V5_BASELINE.ece - current.ece,
    minPerTypeF1: current.minPerTypeF1 - V5_BASELINE.minPerTypeF1,
    citationAccuracy: current.citationAccuracy - V5_BASELINE.citationAccuracy,
  };
}
