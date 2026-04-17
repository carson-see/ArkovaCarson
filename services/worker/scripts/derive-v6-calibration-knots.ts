#!/usr/bin/env tsx
/**
 * Derive Gemini Golden v6 Calibration Knots (v7 bet 2)
 *
 * Reads a v6 eval JSON dump and computes piecewise linear calibration knots
 * that map raw model confidence → calibrated confidence. The resulting knots
 * replace `CALIBRATION_KNOTS` in `src/ai/eval/calibration.ts`.
 *
 * Why: v6 confidence Pearson r = 0.117 (systematically underconfident — reports
 * 52% mean confidence, achieves 81% mean accuracy). Fitting new knots from v6
 * eval data recovers calibration without retraining the base model.
 *
 * Usage:
 *   npx tsx scripts/derive-v6-calibration-knots.ts \
 *     --input docs/eval/eval-gemini-<ts>.json \
 *     [--apply]     # if set, rewrites calibration.ts CALIBRATION_KNOTS in place
 *
 * Without --apply, prints the proposed knot table for review.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  deriveCalibrationKnots,
  pearsonCorrelation as _unused,
} from '../src/ai/eval/calibration.js';
import { pearsonCorrelation } from '../src/ai/eval/scoring.js';

const args = process.argv.slice(2);
const inputIdx = args.indexOf('--input');
if (inputIdx < 0) {
  console.error('ERROR: --input <path-to-eval-json> is required');
  process.exit(1);
}
const inputPath = resolve(args[inputIdx + 1]);
const apply = args.includes('--apply');
const numBucketsIdx = args.indexOf('--buckets');
const numBuckets = numBucketsIdx >= 0 ? parseInt(args[numBucketsIdx + 1], 10) : 7;

interface EntryResult {
  entryId: string;
  reportedConfidence: number;
  actualAccuracy: number;
}
interface EvalJson {
  entryResults: EntryResult[];
  overall: { confidenceCorrelation: number };
}

const data: EvalJson = JSON.parse(readFileSync(inputPath, 'utf-8'));
const entries = data.entryResults;
console.log(`\n--- Deriving v6 calibration knots ---`);
console.log(`Input:          ${inputPath}`);
console.log(`Entries:        ${entries.length}`);
console.log(`Raw Pearson r:  ${data.overall.confidenceCorrelation.toFixed(3)}`);

// Derive new knots
const knots = deriveCalibrationKnots(entries as never, numBuckets);
console.log(`\nProposed knots (${numBuckets} buckets):`);
console.log('| raw    | calibrated |');
console.log('|--------|------------|');
for (const [raw, cal] of knots) {
  console.log(`| ${raw.toFixed(2)}   | ${cal.toFixed(2)}       |`);
}

// Simulate applying the knots and recomputing Pearson r
function interp(raw: number): number {
  if (raw <= knots[0][0]) return knots[0][1];
  if (raw >= knots[knots.length - 1][0]) return knots[knots.length - 1][1];
  for (let i = 0; i < knots.length - 1; i++) {
    const [x0, y0] = knots[i];
    const [x1, y1] = knots[i + 1];
    if (raw >= x0 && raw <= x1) {
      const t = (raw - x0) / (x1 - x0);
      return y0 + t * (y1 - y0);
    }
  }
  return raw;
}

const calibrated = entries.map(e => interp(e.reportedConfidence));
const actuals = entries.map(e => e.actualAccuracy);
const newR = pearsonCorrelation(calibrated, actuals);
const meanCal = calibrated.reduce((s, v) => s + v, 0) / calibrated.length;
const meanAct = actuals.reduce((s, v) => s + v, 0) / actuals.length;
const meanGap = meanCal - meanAct;

console.log(`\n--- Projected results with new knots ---`);
console.log(`New Pearson r:       ${newR.toFixed(3)}   (was ${data.overall.confidenceCorrelation.toFixed(3)})`);
console.log(`Mean calibrated conf: ${(meanCal * 100).toFixed(1)}%`);
console.log(`Mean actual accuracy: ${(meanAct * 100).toFixed(1)}%`);
console.log(`Gap (overconf if +):  ${(meanGap * 100).toFixed(1)}pp`);

if (!apply) {
  console.log(`\n(--apply not set; calibration.ts not modified. Re-run with --apply to persist.)`);
  process.exit(0);
}

// Apply: rewrite the CALIBRATION_KNOTS block in calibration.ts
const calibFile = resolve(import.meta.dirname ?? '.', '../src/ai/eval/calibration.ts');
const src = readFileSync(calibFile, 'utf-8');

const knotBlock = knots.map(([r, c]) => `  [${r.toFixed(2)}, ${c.toFixed(2)}],`).join('\n');
const newBlock = `const CALIBRATION_KNOTS: [number, number][] = [\n${knotBlock}\n];`;

// Replace between 'const CALIBRATION_KNOTS:' and the first '];' that follows
const start = src.indexOf('const CALIBRATION_KNOTS: [number, number][] = [');
if (start < 0) {
  console.error('Could not locate CALIBRATION_KNOTS block in calibration.ts');
  process.exit(2);
}
const endRel = src.slice(start).indexOf('];');
if (endRel < 0) {
  console.error('Could not locate end of CALIBRATION_KNOTS block in calibration.ts');
  process.exit(2);
}
const end = start + endRel + 2; // include '];'
const updated = src.slice(0, start) + newBlock + src.slice(end);
writeFileSync(calibFile, updated);
console.log(`\n✓ Wrote new knots to ${calibFile}`);
console.log(`  Re-run the eval to verify calibrated Pearson r actually lands at ${newR.toFixed(3)}.`);
