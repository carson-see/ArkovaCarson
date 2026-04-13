/**
 * Baseline Eval Metrics (NMT-13)
 *
 * Stored baselines for regression detection.
 * Updated after each model deployment that passes eval.
 *
 * These baselines represent the minimum acceptable performance.
 * The eval regression pipeline fails if current metrics drop below
 * these baselines beyond allowed thresholds.
 */

export interface BaselineMetrics {
  /** Model name / label */
  model: string;
  /** ISO timestamp when baseline was recorded */
  recordedAt: string;
  /** Weighted F1 (primary metric) */
  weightedF1: number;
  /** Macro F1 */
  macroF1: number;
  /** Expected Calibration Error (lower is better) */
  ece: number;
  /** Confidence-accuracy correlation (Pearson r) */
  confidenceCorrelation: number;
  /** Mean latency in ms */
  meanLatencyMs: number;
  /** Number of entries in the eval run that produced this baseline */
  evalSampleSize: number;
}

export interface RegressionThresholds {
  /** Max allowed drop in weighted F1 (in percentage points, e.g., 2 = 2pp) */
  maxWeightedF1Drop: number;
  /** Max allowed increase in ECE (in percentage points) */
  maxECEIncrease: number;
  /** Max allowed drop in confidence correlation */
  maxConfCorrDrop: number;
  /** Max allowed latency increase factor (e.g., 2.0 = 2x slower) */
  maxLatencyFactor: number;
}

export interface RegressionResult {
  passed: boolean;
  checks: RegressionCheck[];
  baseline: BaselineMetrics;
  current: BaselineMetrics;
}

export interface RegressionCheck {
  metric: string;
  baselineValue: number;
  currentValue: number;
  threshold: number;
  passed: boolean;
  message: string;
}

/**
 * Default regression thresholds.
 * Fail if weighted F1 drops >2pp, ECE increases >5pp,
 * confidence correlation drops >0.1, or latency doubles.
 */
export const DEFAULT_THRESHOLDS: RegressionThresholds = {
  maxWeightedF1Drop: 2.0,
  maxECEIncrease: 5.0,
  maxConfCorrDrop: 0.1,
  maxLatencyFactor: 2.0,
};

/**
 * Nessie v5 baseline — recorded 2026-03-31 from NMT-04 full-precision eval.
 * RunPod A6000 48GB, fp16, 100 samples, condensed prompt.
 */
export const NESSIE_V5_BASELINE: BaselineMetrics = {
  model: 'nessie-v5-fp16',
  recordedAt: '2026-03-31T14:00:26.000Z',
  weightedF1: 0.872,
  macroF1: 0.757,
  ece: 0.110,
  confidenceCorrelation: 0.539,
  meanLatencyMs: 1500,
  evalSampleSize: 100,
};

/**
 * Gemini Golden baseline — recorded 2026-03-30 from NMT-01 eval.
 */
export const GEMINI_GOLDEN_BASELINE: BaselineMetrics = {
  model: 'gemini-golden-v1',
  recordedAt: '2026-03-30T06:51:14.000Z',
  weightedF1: 0.904,
  macroF1: 0.814,
  ece: 0.095,
  confidenceCorrelation: 0.426,
  meanLatencyMs: 5400,
  evalSampleSize: 100,
};

/**
 * Compare current metrics against a baseline and return regression results.
 */
export function checkRegression(
  baseline: BaselineMetrics,
  current: BaselineMetrics,
  thresholds: RegressionThresholds = DEFAULT_THRESHOLDS,
): RegressionResult {
  const checks: RegressionCheck[] = [];

  // Weighted F1 — must not drop more than threshold
  const f1Drop = (baseline.weightedF1 - current.weightedF1) * 100;
  checks.push({
    metric: 'weightedF1',
    baselineValue: baseline.weightedF1,
    currentValue: current.weightedF1,
    threshold: thresholds.maxWeightedF1Drop,
    passed: f1Drop <= thresholds.maxWeightedF1Drop,
    message: f1Drop <= thresholds.maxWeightedF1Drop
      ? `Weighted F1: ${(current.weightedF1 * 100).toFixed(1)}% (${f1Drop > 0 ? '-' : '+'}${Math.abs(f1Drop).toFixed(1)}pp from baseline)`
      : `REGRESSION: Weighted F1 dropped ${f1Drop.toFixed(1)}pp (${(current.weightedF1 * 100).toFixed(1)}% vs baseline ${(baseline.weightedF1 * 100).toFixed(1)}%, threshold: ${thresholds.maxWeightedF1Drop}pp)`,
  });

  // ECE — must not increase more than threshold
  const eceIncrease = (current.ece - baseline.ece) * 100;
  checks.push({
    metric: 'ece',
    baselineValue: baseline.ece,
    currentValue: current.ece,
    threshold: thresholds.maxECEIncrease,
    passed: eceIncrease <= thresholds.maxECEIncrease,
    message: eceIncrease <= thresholds.maxECEIncrease
      ? `ECE: ${(current.ece * 100).toFixed(1)}% (${eceIncrease > 0 ? '+' : ''}${eceIncrease.toFixed(1)}pp from baseline)`
      : `REGRESSION: ECE increased ${eceIncrease.toFixed(1)}pp (${(current.ece * 100).toFixed(1)}% vs baseline ${(baseline.ece * 100).toFixed(1)}%, threshold: ${thresholds.maxECEIncrease}pp)`,
  });

  // Confidence correlation — must not drop more than threshold
  const corrDrop = baseline.confidenceCorrelation - current.confidenceCorrelation;
  checks.push({
    metric: 'confidenceCorrelation',
    baselineValue: baseline.confidenceCorrelation,
    currentValue: current.confidenceCorrelation,
    threshold: thresholds.maxConfCorrDrop,
    passed: corrDrop <= thresholds.maxConfCorrDrop,
    message: corrDrop <= thresholds.maxConfCorrDrop
      ? `Confidence Correlation: ${current.confidenceCorrelation.toFixed(3)} (${corrDrop > 0 ? '-' : '+'}${Math.abs(corrDrop).toFixed(3)} from baseline)`
      : `REGRESSION: Confidence correlation dropped ${corrDrop.toFixed(3)} (${current.confidenceCorrelation.toFixed(3)} vs baseline ${baseline.confidenceCorrelation.toFixed(3)}, threshold: ${thresholds.maxConfCorrDrop})`,
  });

  // Latency — must not exceed factor
  const latencyFactor = current.meanLatencyMs / baseline.meanLatencyMs;
  checks.push({
    metric: 'latency',
    baselineValue: baseline.meanLatencyMs,
    currentValue: current.meanLatencyMs,
    threshold: thresholds.maxLatencyFactor,
    passed: latencyFactor <= thresholds.maxLatencyFactor,
    message: latencyFactor <= thresholds.maxLatencyFactor
      ? `Latency: ${current.meanLatencyMs.toFixed(0)}ms (${latencyFactor.toFixed(1)}x baseline)`
      : `REGRESSION: Latency ${latencyFactor.toFixed(1)}x baseline (${current.meanLatencyMs.toFixed(0)}ms vs ${baseline.meanLatencyMs.toFixed(0)}ms, threshold: ${thresholds.maxLatencyFactor}x)`,
  });

  return {
    passed: checks.every(c => c.passed),
    checks,
    baseline,
    current,
  };
}

/**
 * Format regression results as a readable report.
 */
export function formatRegressionReport(result: RegressionResult): string {
  const lines: string[] = [];
  const status = result.passed ? 'PASSED' : 'FAILED';

  lines.push(`# Eval Regression Report — ${status}`);
  lines.push('');
  lines.push(`- **Baseline:** ${result.baseline.model} (${result.baseline.recordedAt})`);
  lines.push(`- **Current:** ${result.current.model} (${result.current.recordedAt})`);
  lines.push('');
  lines.push('## Checks');
  lines.push('');
  lines.push('| Metric | Baseline | Current | Status |');
  lines.push('|--------|----------|---------|--------|');

  for (const check of result.checks) {
    const icon = check.passed ? 'PASS' : 'FAIL';
    lines.push(`| ${check.metric} | ${formatMetricValue(check.metric, check.baselineValue)} | ${formatMetricValue(check.metric, check.currentValue)} | ${icon} |`);
  }

  lines.push('');
  if (!result.passed) {
    lines.push('## Failures');
    lines.push('');
    for (const check of result.checks.filter(c => !c.passed)) {
      lines.push(`- ${check.message}`);
    }
  }

  return lines.join('\n');
}

function formatMetricValue(metric: string, value: number): string {
  switch (metric) {
    case 'weightedF1':
    case 'ece':
      return `${(value * 100).toFixed(1)}%`;
    case 'confidenceCorrelation':
      return value.toFixed(3);
    case 'latency':
      return `${value.toFixed(0)}ms`;
    default:
      return value.toFixed(3);
  }
}
