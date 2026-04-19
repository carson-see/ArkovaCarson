#!/usr/bin/env tsx
/**
 * Derive Per-Type Calibration Knots (GME7.2 — SCRUM-855)
 *
 * Reads an eval JSON dump and computes per-credential-type piecewise linear
 * calibration knots. Types with ≥10 eval samples get their own curve; types
 * with fewer fall back to the global isotonic knots.
 *
 * Output: a TypeScript-ready PER_TYPE_CALIBRATION_KNOTS constant suitable for
 * pasting into `src/ai/eval/calibration.ts`.
 *
 * Usage:
 *   npx tsx scripts/derive-per-type-calibration.ts \
 *     --input docs/eval/eval-gemini-<ts>.json \
 *     [--min-samples 10]    # minimum entries per type
 *     [--buckets 5]         # number of buckets per type
 *     [--json]              # output machine-readable JSON instead of TS
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { derivePerTypeCalibrationKnots } from '../src/ai/eval/calibration.js';
import { pearsonCorrelation } from '../src/ai/eval/scoring.js';
import type { EntryEvalResult } from '../src/ai/eval/types.js';

const args = process.argv.slice(2);
const inputIdx = args.indexOf('--input');
if (inputIdx < 0) {
  console.error('ERROR: --input <path-to-eval-json> is required');
  process.exit(1);
}
const inputPath = resolve(args[inputIdx + 1]);
const minSamplesIdx = args.indexOf('--min-samples');
const minSamples = minSamplesIdx >= 0 ? parseInt(args[minSamplesIdx + 1], 10) : 10;
const bucketsIdx = args.indexOf('--buckets');
const numBuckets = bucketsIdx >= 0 ? parseInt(args[bucketsIdx + 1], 10) : 5;
const jsonOutput = args.includes('--json');

interface EvalJson {
  entryResults: Array<{
    entryId: string;
    credentialType: string;
    reportedConfidence: number;
    actualAccuracy: number;
  }>;
}

const data: EvalJson = JSON.parse(readFileSync(inputPath, 'utf-8'));
const entries = data.entryResults as EntryEvalResult[];

console.log(`\n--- Deriving per-type calibration knots (GME7.2) ---`);
console.log(`Input:        ${inputPath}`);
console.log(`Entries:      ${entries.length}`);
console.log(`Min samples:  ${minSamples}`);
console.log(`Buckets:      ${numBuckets}`);

const byType = new Map<string, typeof entries>();
for (const e of entries) {
  if (!byType.has(e.credentialType)) byType.set(e.credentialType, []);
  byType.get(e.credentialType)!.push(e);
}

console.log(`\nType distribution:`);
for (const [type, typeEntries] of [...byType].sort((a, b) => b[1].length - a[1].length)) {
  const confs = typeEntries.map(e => e.reportedConfidence);
  const accs = typeEntries.map(e => e.actualAccuracy);
  const r = typeEntries.length >= 2 ? pearsonCorrelation(confs, accs) : NaN;
  const marker = typeEntries.length >= minSamples ? '  [FITTED]' : '  [GLOBAL FALLBACK]';
  console.log(`  ${type.padEnd(20)} n=${String(typeEntries.length).padStart(3)}  r=${isNaN(r) ? '  N/A' : r.toFixed(3)}${marker}`);
}

const perTypeKnots = derivePerTypeCalibrationKnots(entries, minSamples, numBuckets);

if (jsonOutput) {
  const obj: Record<string, [number, number][]> = {};
  for (const [type, knots] of perTypeKnots) {
    obj[type] = knots;
  }
  console.log(JSON.stringify(obj, null, 2));
} else {
  console.log(`\n// Generated ${new Date().toISOString()} from ${entries.length} eval entries`);
  console.log(`// ${perTypeKnots.size} types fitted (min ${minSamples} samples, ${numBuckets} buckets)`);
  console.log(`const PER_TYPE_CALIBRATION_KNOTS: Record<string, [number, number][]> = {`);
  for (const [type, knots] of [...perTypeKnots].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  ${type}: [`);
    for (const [raw, cal] of knots) {
      console.log(`    [${raw.toFixed(2)}, ${cal.toFixed(2)}],`);
    }
    console.log(`  ],`);
  }
  console.log(`};`);
}

console.log(`\nDone. ${perTypeKnots.size} types with per-type knots.`);
