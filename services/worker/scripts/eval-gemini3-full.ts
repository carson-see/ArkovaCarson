#!/usr/bin/env tsx
/**
 * GME-06: Full Golden Dataset Eval on Gemini 3 Flash
 *
 * Runs the complete golden dataset eval against Gemini 3 Flash (base).
 * Produces per-credential-type F1 breakdown, flags regressions >5pp,
 * and outputs ECE calibration metrics.
 *
 * Usage:
 *   cd services/worker
 *   GEMINI_API_KEY=... npx tsx scripts/eval-gemini3-full.ts [--sample N] [--compare PATH]
 *
 * Options:
 *   --sample N      Run on N random entries (default: full dataset)
 *   --compare PATH  Compare against a previous eval JSON file
 *   --output DIR    Output directory (default: ../../docs/eval/)
 */

import 'dotenv/config';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { FULL_GOLDEN_DATASET } from '../src/ai/eval/golden-dataset.js';
import { runEval, formatEvalReport, getPromptVersionHash } from '../src/ai/eval/runner.js';
import { analyzeCalibration, formatCalibrationReport } from '../src/ai/eval/calibration.js';
import { GEMINI_GENERATION_MODEL } from '../src/ai/gemini-config.js';
import type { EvalRunResult, AggregateMetrics } from '../src/ai/eval/types.js';

const args = process.argv.slice(2);

function getArg(name: string, defaultVal: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : defaultVal;
}

const sampleSize = args.includes('--sample')
  ? parseInt(getArg('sample', '0'), 10)
  : 0;
const comparePath = args.includes('--compare')
  ? getArg('compare', '')
  : '';
const outputDir = resolve(
  import.meta.dirname ?? '.',
  getArg('output', '../../docs/eval/'),
);

// Gemini 2.5 Flash baseline metrics (from AI-EVAL-02 eval, 2026-03-30)
const BASELINE_METRICS: Record<string, number> = {
  ALL: 82.1,
  DEGREE: 89.3,
  LICENSE: 88.7,
  CERTIFICATE: 82.6,
  SEC_FILING: 95.2,
  LEGAL: 78.4,
  CLE: 90.1,
  PATENT: 91.8,
  PUBLICATION: 75.3,
  MEDICAL: 80.2,
  MILITARY: 72.6,
  IDENTITY: 76.9,
  REGULATION: 81.0,
  INSURANCE: 85.4,
  OTHER: 60.3,
};

const REGRESSION_THRESHOLD_PP = 5; // Flag regressions >5 percentage points

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    console.error('ERROR: GEMINI_API_KEY required');
    process.exit(1);
  }

  const model = GEMINI_GENERATION_MODEL;
  let dataset = FULL_GOLDEN_DATASET;
  if (sampleSize > 0 && sampleSize < dataset.length) {
    // Deterministic shuffle using entry IDs
    const shuffled = [...dataset].sort((a, b) => a.id.localeCompare(b.id));
    dataset = shuffled.slice(0, sampleSize);
  }

  console.log(`\n=== GME-06: Full Golden Dataset Eval on Gemini 3 ===`);
  console.log(`  Model:   ${model}`);
  console.log(`  Dataset: ${dataset.length} entries (of ${FULL_GOLDEN_DATASET.length} total)`);
  console.log(`  Prompt:  ${getPromptVersionHash()}`);
  console.log(`  Baseline: Gemini 2.5 Flash (wF1=82.1%)`);
  console.log('');

  // Create provider
  const { GeminiProvider } = await import('../src/ai/gemini.js');
  const provider = new GeminiProvider();

  // Run eval
  console.log('Running evaluation...');
  const startTime = Date.now();
  const result = await runEval({
    provider,
    entries: dataset,
    concurrency: 3,
    onProgress: (completed, total) => {
      process.stdout.write(`\r  Progress: ${completed}/${total} (${Math.round((completed / total) * 100)}%)`);
    },
  });
  const elapsedMinutes = ((Date.now() - startTime) / 60_000).toFixed(1);
  console.log(`\n  Done in ${elapsedMinutes} minutes.\n`);

  // Print overall results
  console.log('=== Overall Results ===');
  console.log(`  Weighted F1:  ${(result.overall.weightedF1 * 100).toFixed(1)}%`);
  console.log(`  Macro F1:     ${(result.overall.macroF1 * 100).toFixed(1)}%`);
  console.log(`  Mean Confidence: ${(result.overall.meanReportedConfidence * 100).toFixed(1)}%`);
  console.log(`  Mean Latency: ${result.overall.meanLatencyMs.toFixed(0)}ms`);
  console.log('');

  // Per-type F1 breakdown
  console.log('=== Per-Credential-Type F1 ===');
  console.log('  Type                  | wF1    | n    | Baseline | Delta  | Status');
  console.log('  ----------------------|--------|------|----------|--------|-------');
  const regressions: Array<{ type: string; current: number; baseline: number; delta: number }> = [];

  for (const typeMetrics of result.byCredentialType.sort((a, b) => b.weightedF1 - a.weightedF1)) {
    const baseline = BASELINE_METRICS[typeMetrics.credentialType] ?? 0;
    const current = typeMetrics.weightedF1 * 100;
    const delta = current - baseline;
    const status = delta < -REGRESSION_THRESHOLD_PP ? 'REGRESSION' : delta > REGRESSION_THRESHOLD_PP ? 'IMPROVED' : 'OK';

    console.log(
      `  ${typeMetrics.credentialType.padEnd(22)}| ${current.toFixed(1).padStart(5)}% | ${String(typeMetrics.entryCount).padStart(4)} | ${baseline.toFixed(1).padStart(7)}% | ${(delta >= 0 ? '+' : '') + delta.toFixed(1).padStart(5)}pp | ${status}`,
    );

    if (delta < -REGRESSION_THRESHOLD_PP) {
      regressions.push({ type: typeMetrics.credentialType, current, baseline, delta });
    }
  }
  console.log('');

  // Regression alerts
  if (regressions.length > 0) {
    console.log('⚠️  REGRESSIONS DETECTED (>5pp):');
    for (const r of regressions) {
      console.log(`  ${r.type}: ${r.current.toFixed(1)}% (was ${r.baseline.toFixed(1)}%, delta: ${r.delta.toFixed(1)}pp)`);
    }
    console.log('');
  } else {
    console.log('✓ No regressions >5pp detected.');
    console.log('');
  }

  // ECE calibration
  const calibration = analyzeCalibration(result.entryResults);
  console.log('=== Confidence Calibration (ECE) ===');
  console.log(`  ECE: ${(calibration.ece * 100).toFixed(1)}% (target: <15%)`);
  console.log(`  ${calibration.ece < 0.15 ? '✓ PASS' : '✗ FAIL — calibration needs improvement'}`);
  console.log('');

  // Compare with previous results if provided
  if (comparePath && existsSync(comparePath)) {
    const previous = JSON.parse(readFileSync(comparePath, 'utf-8')) as EvalRunResult;
    console.log('=== Comparison with Previous Eval ===');
    console.log(`  Previous: ${previous.provider} (${previous.timestamp})`);
    console.log(`  Previous wF1: ${(previous.overall.weightedF1 * 100).toFixed(1)}%`);
    console.log(`  Current wF1:  ${(result.overall.weightedF1 * 100).toFixed(1)}%`);
    const overallDelta = (result.overall.weightedF1 - previous.overall.weightedF1) * 100;
    console.log(`  Delta:        ${(overallDelta >= 0 ? '+' : '') + overallDelta.toFixed(1)}pp`);
    console.log('');
  }

  // Write outputs
  mkdirSync(outputDir, { recursive: true });
  const timestamp = new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-');
  const baseName = `eval-gemini3-${model.replace(/[^a-z0-9]/gi, '-')}-${timestamp}`;

  // Full JSON results
  writeFileSync(
    resolve(outputDir, `${baseName}.json`),
    JSON.stringify(result, null, 2),
  );

  // Markdown report
  const report = formatEvalReport(result);
  const calReport = formatCalibrationReport(result.entryResults);
  writeFileSync(
    resolve(outputDir, `${baseName}.md`),
    report + '\n\n' + calReport,
  );

  console.log(`Results written to:`);
  console.log(`  ${resolve(outputDir, `${baseName}.json`)}`);
  console.log(`  ${resolve(outputDir, `${baseName}.md`)}`);
}

main().catch((err) => {
  console.error('\nEVAL FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
