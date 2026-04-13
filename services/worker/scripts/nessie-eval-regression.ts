#!/usr/bin/env tsx
/**
 * Nessie Eval Regression Pipeline (NMT-13)
 *
 * Runs a 50-sample eval against the current RunPod endpoint and compares
 * against stored baselines. Exits with code 1 if regression detected.
 *
 * Usage:
 *   cd services/worker
 *   npx tsx scripts/nessie-eval-regression.ts
 *   npx tsx scripts/nessie-eval-regression.ts --sample 100 --baseline gemini
 *   npx tsx scripts/nessie-eval-regression.ts --strict  # tighter thresholds
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — regression detected
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';

dotenvConfig({ path: resolve(import.meta.dirname ?? '.', '../.env') });

import { FULL_GOLDEN_DATASET } from '../src/ai/eval/golden-dataset.js';
import { runEval, formatEvalReport } from '../src/ai/eval/runner.js';
import { analyzeCalibration } from '../src/ai/eval/calibration.js';
import {
  checkRegression,
  formatRegressionReport,
  NESSIE_V5_BASELINE,
  GEMINI_GOLDEN_BASELINE,
  DEFAULT_THRESHOLDS,
  type BaselineMetrics,
  type RegressionThresholds,
} from '../src/ai/eval/baseline-metrics.js';
import { createAIProvider } from '../src/ai/factory.js';

// --- CLI args ---
const args = process.argv.slice(2);
function getArg(name: string, defaultVal: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : defaultVal;
}
const hasFlag = (name: string) => args.includes(`--${name}`);

const SAMPLE_SIZE = parseInt(getArg('sample', '50'), 10);
const BASELINE_NAME = getArg('baseline', 'nessie-v5');
const STRICT = hasFlag('strict');

// Strict thresholds: half the allowed drift
const STRICT_THRESHOLDS: RegressionThresholds = {
  maxWeightedF1Drop: 1.0,
  maxECEIncrease: 2.5,
  maxConfCorrDrop: 0.05,
  maxLatencyFactor: 1.5,
};

async function main() {
  console.log('=== Nessie Eval Regression Pipeline (NMT-13) ===\n');

  // Select baseline
  const baseline: BaselineMetrics = BASELINE_NAME === 'gemini'
    ? GEMINI_GOLDEN_BASELINE
    : NESSIE_V5_BASELINE;
  const thresholds = STRICT ? STRICT_THRESHOLDS : DEFAULT_THRESHOLDS;

  console.log(`Baseline: ${baseline.model} (${baseline.recordedAt})`);
  console.log(`Sample size: ${SAMPLE_SIZE}`);
  console.log(`Thresholds: ${STRICT ? 'STRICT' : 'DEFAULT'}`);
  console.log('');

  // Create provider
  const provider = createAIProvider();
  console.log(`Provider: ${provider.name}\n`);

  // Sample from golden dataset (deterministic shuffle based on sample size)
  const shuffled = [...FULL_GOLDEN_DATASET].sort(
    (a, b) => a.id.localeCompare(b.id),
  );
  const entries = shuffled.slice(0, SAMPLE_SIZE);
  console.log(`Evaluating ${entries.length} entries...\n`);

  // Run eval
  const evalResult = await runEval({
    provider,
    entries,
    concurrency: 3,
    onProgress: (completed, total) => {
      process.stdout.write(`\r  Progress: ${completed}/${total}`);
    },
  });
  console.log('\n');

  // Compute calibration
  const confidences = evalResult.entryResults.map(r => r.reportedConfidence);
  const accuracies = evalResult.entryResults.map(r => r.actualAccuracy);
  const calibration = analyzeCalibration(confidences, accuracies);

  // Build current metrics
  const current: BaselineMetrics = {
    model: provider.name,
    recordedAt: new Date().toISOString(),
    weightedF1: evalResult.overall.weightedF1,
    macroF1: evalResult.overall.macroF1,
    ece: calibration.expectedCalibrationError,
    confidenceCorrelation: evalResult.overall.confidenceCorrelation,
    meanLatencyMs: evalResult.overall.meanLatencyMs,
    evalSampleSize: entries.length,
  };

  // Run regression check
  const regressionResult = checkRegression(baseline, current, thresholds);
  const regressionReport = formatRegressionReport(regressionResult);

  // Print results
  console.log(regressionReport);
  console.log('');

  // Save reports
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const evalDir = resolve(import.meta.dirname ?? '.', '../docs/eval');
  mkdirSync(evalDir, { recursive: true });

  // Save full eval report
  const evalReport = formatEvalReport(evalResult);
  const evalPath = resolve(evalDir, `eval-regression-${timestamp}.md`);
  writeFileSync(evalPath, evalReport);
  console.log(`Eval report: ${evalPath}`);

  // Save regression report
  const regPath = resolve(evalDir, `regression-${timestamp}.md`);
  writeFileSync(regPath, regressionReport);
  console.log(`Regression report: ${regPath}`);

  // Save JSON for programmatic consumption
  const jsonPath = resolve(evalDir, `regression-${timestamp}.json`);
  writeFileSync(jsonPath, JSON.stringify({
    ...regressionResult,
    evalResult: {
      timestamp: evalResult.timestamp,
      provider: evalResult.provider,
      totalEntries: evalResult.totalEntries,
      overall: evalResult.overall,
    },
  }, null, 2));
  console.log(`JSON report: ${jsonPath}`);

  // Exit with appropriate code
  if (!regressionResult.passed) {
    console.log('\nREGRESSION DETECTED — exiting with code 1');
    process.exit(1);
  } else {
    console.log('\nAll checks passed.');
    process.exit(0);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(2);
});
