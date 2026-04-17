#!/usr/bin/env tsx
/**
 * AI Eval CLI Script (AI-EVAL-01)
 *
 * Run extraction accuracy evaluation against the golden dataset.
 *
 * Usage:
 *   npx tsx services/worker/src/ai/eval/run-eval.ts [--provider mock|gemini] [--output docs/eval/]
 *
 * Default: mock provider, output to docs/eval/
 */

import { writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { FULL_GOLDEN_DATASET } from './golden-dataset.js';
import { runEval, formatEvalReport, getPromptVersionHash } from './runner.js';
import { analyzeCalibration, formatCalibrationReport } from './calibration.js';
import type { IAIProvider } from '../types.js';

// Parse args
const args = process.argv.slice(2);
const providerArg = args.includes('--provider')
  ? args[args.indexOf('--provider') + 1]
  : 'mock';
const outputDir = args.includes('--output')
  ? args[args.indexOf('--output') + 1]
  : resolve(process.cwd(), '../../docs/eval');
const modelOverride = args.includes('--model')
  ? args[args.indexOf('--model') + 1]
  : undefined;
const sampleSize = args.includes('--sample')
  ? parseInt(args[args.indexOf('--sample') + 1], 10)
  : 0; // 0 = full dataset

// v7: stratified sampling — N entries PER credential type (not total).
// Produces statistically meaningful per-type F1 even for rare types.
// Usage: --stratified 10   → take 10 entries of each credential type
const stratifiedPerType = args.includes('--stratified')
  ? parseInt(args[args.indexOf('--stratified') + 1], 10)
  : 0;

async function main() {
  console.log(`\n🔬 AI Extraction Eval Framework (AI-EVAL-01)`);
  console.log(`   Provider: ${providerArg}`);
  console.log(`   Dataset: ${FULL_GOLDEN_DATASET.length} entries`);
  console.log(`   Prompt version: ${getPromptVersionHash()}`);
  console.log('');

  let provider: IAIProvider;

  if (providerArg === 'mock') {
    // Import mock provider
    const { MockAIProvider } = await import('../mock.js');
    provider = new MockAIProvider();
  } else if (providerArg === 'gemini') {
    if (!process.env.GEMINI_API_KEY) {
      console.error('ERROR: GEMINI_API_KEY required for gemini provider');
      process.exit(1);
    }
    const { GeminiProvider } = await import('../gemini.js');
    provider = new GeminiProvider();
  } else if (providerArg === 'nessie') {
    if (!process.env.RUNPOD_API_KEY || !process.env.RUNPOD_ENDPOINT_ID) {
      console.error('ERROR: RUNPOD_API_KEY and RUNPOD_ENDPOINT_ID required for nessie provider');
      process.exit(1);
    }
    const { NessieProvider } = await import('../nessie.js');
    provider = new NessieProvider(undefined, undefined, modelOverride);
    if (modelOverride) {
      console.log(`   Model override: ${modelOverride}`);
    }
  } else if (providerArg === 'together') {
    if (!process.env.TOGETHER_API_KEY) {
      console.error('ERROR: TOGETHER_API_KEY required for together provider');
      process.exit(1);
    }
    const { TogetherProvider } = await import('../together.js');
    // TogetherProvider takes (apiKey, model, embeddingModel) — pass model override as 2nd arg
    provider = new TogetherProvider(undefined, modelOverride);
    if (modelOverride) {
      console.log(`   Model override: ${modelOverride}`);
    } else {
      console.log(`   Model: ${process.env.TOGETHER_MODEL ?? '(default base Llama)'}`);
    }
  } else {
    console.error(`ERROR: Unknown provider "${providerArg}". Use "mock", "gemini", "nessie", or "together".`);
    process.exit(1);
  }

  // Optionally sample the dataset for faster iteration
  let evalEntries = FULL_GOLDEN_DATASET;
  if (stratifiedPerType > 0) {
    // v7: stratified by credentialType — N entries per type, deterministic ordering
    const byType = new Map<string, typeof FULL_GOLDEN_DATASET>();
    for (const entry of FULL_GOLDEN_DATASET) {
      const ct = (entry.groundTruth.credentialType ?? entry.credentialTypeHint ?? 'UNKNOWN').toUpperCase();
      const existing = byType.get(ct) ?? [];
      existing.push(entry);
      byType.set(ct, existing);
    }
    const stratified: typeof FULL_GOLDEN_DATASET = [];
    const typeCounts: Record<string, number> = {};
    for (const [type, entries] of [...byType.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      // Take first N entries of each type (deterministic).
      // If a type has fewer than N, take all of them.
      const taken = entries.slice(0, stratifiedPerType);
      stratified.push(...taken);
      typeCounts[type] = taken.length;
    }
    evalEntries = stratified;
    console.log(`   Stratified: ${evalEntries.length} entries across ${byType.size} types (${stratifiedPerType}/type target)`);
    console.log('   Per-type counts:');
    for (const [type, n] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
      const total = byType.get(type)?.length ?? 0;
      console.log(`     ${type.padEnd(20)} ${String(n).padStart(3)} / ${total}`);
    }
  } else if (sampleSize > 0 && sampleSize < FULL_GOLDEN_DATASET.length) {
    // Deterministic sample: pick every Nth entry for reproducibility
    const step = Math.floor(FULL_GOLDEN_DATASET.length / sampleSize);
    evalEntries = FULL_GOLDEN_DATASET.filter((_, i) => i % step === 0).slice(0, sampleSize);
    console.log(`   Sampled ${evalEntries.length} of ${FULL_GOLDEN_DATASET.length} entries`);
  }

  console.log(`Running eval against ${evalEntries.length} entries...`);

  const result = await runEval({
    provider,
    entries: evalEntries,
    concurrency: providerArg === 'gemini' ? 1 : 10, // Rate limit for real API (Gemini Flash needs concurrency 1)
    onProgress: (completed, total) => {
      const pct = ((completed / total) * 100).toFixed(0);
      process.stdout.write(`\r   Progress: ${completed}/${total} (${pct}%)`);
    },
  });

  console.log('\n\nEval complete. Generating report...\n');

  // Generate markdown report
  const report = formatEvalReport(result);

  // Ensure output dir exists
  mkdirSync(outputDir, { recursive: true });

  // Write report
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const reportPath = resolve(outputDir, `eval-${providerArg}-${timestamp}.md`);
  writeFileSync(reportPath, report, 'utf-8');
  console.log(`Report saved: ${reportPath}`);

  // Write raw JSON results
  const jsonPath = resolve(outputDir, `eval-${providerArg}-${timestamp}.json`);
  writeFileSync(jsonPath, JSON.stringify(result, null, 2), 'utf-8');
  console.log(`Raw results: ${jsonPath}`);

  // Print summary to stdout
  console.log('\n--- SUMMARY ---');
  console.log(`Entries: ${result.totalEntries}`);
  console.log(`Overall Macro F1: ${(result.overall.macroF1 * 100).toFixed(1)}%`);
  console.log(`Overall Weighted F1: ${(result.overall.weightedF1 * 100).toFixed(1)}%`);
  console.log(`Mean Reported Confidence: ${(result.overall.meanReportedConfidence * 100).toFixed(1)}%`);
  console.log(`Mean Actual Accuracy: ${(result.overall.meanActualAccuracy * 100).toFixed(1)}%`);
  console.log(`Confidence Correlation (r): ${result.overall.confidenceCorrelation.toFixed(3)}`);
  console.log(`Mean Latency: ${result.overall.meanLatencyMs.toFixed(0)}ms`);
  console.log('');

  console.log('Per-type breakdown:');
  for (const tm of result.byCredentialType) {
    console.log(`  ${tm.scope.padEnd(15)} | F1: ${(tm.macroF1 * 100).toFixed(1).padStart(5)}% | n=${tm.totalEntries}`);
  }

  // AI-EVAL-02: Confidence calibration analysis
  console.log('\n--- CONFIDENCE CALIBRATION (AI-EVAL-02) ---');
  const calibration = analyzeCalibration(result.entryResults);
  console.log(`Pearson r: ${calibration.pearsonR.toFixed(3)} (target >= 0.80)`);
  console.log(`ECE: ${(calibration.expectedCalibrationError * 100).toFixed(1)}%`);
  console.log(`MCE: ${(calibration.maxCalibrationError * 100).toFixed(1)}%`);
  console.log(`Status: ${calibration.isCalibrated ? 'CALIBRATED' : 'NEEDS RECALIBRATION'}`);
  if (calibration.overconfidentBuckets.length > 0) {
    console.log(`Overconfident buckets: ${calibration.overconfidentBuckets.map(b => b.label).join(', ')}`);
  }
  if (calibration.recalibrationSuggestions.length > 0) {
    console.log('\nRecalibration suggestions:');
    for (const s of calibration.recalibrationSuggestions) {
      console.log(`  - ${s}`);
    }
  }

  // Write calibration report
  const calReport = formatCalibrationReport(calibration);
  const calPath = resolve(outputDir, `calibration-${providerArg}-${timestamp}.md`);
  writeFileSync(calPath, calReport, 'utf-8');
  console.log(`\nCalibration report: ${calPath}`);
}

main().catch((err) => {
  console.error('Eval failed:', err);
  process.exit(1);
});
