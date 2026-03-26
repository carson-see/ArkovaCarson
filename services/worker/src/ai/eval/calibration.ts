/**
 * Confidence Calibration Analysis (AI-EVAL-02)
 *
 * Analyzes correlation between AI-reported confidence and actual accuracy.
 * If correlation < 0.80, generates recalibration recommendations.
 *
 * Calibration methods:
 * 1. Bucketed analysis — compare reported vs actual accuracy in bins
 * 2. Pearson correlation — overall linear relationship
 * 3. Expected Calibration Error (ECE) — weighted absolute gap per bin
 * 4. Recalibration via isotonic regression approximation
 */

import type { EntryEvalResult, EvalRunResult } from './types.js';
import { pearsonCorrelation } from './scoring.js';

export interface CalibrationBucket {
  min: number;
  max: number;
  label: string;
  count: number;
  meanReportedConfidence: number;
  meanActualAccuracy: number;
  gap: number; // positive = overconfident, negative = underconfident
}

export interface CalibrationResult {
  pearsonR: number;
  expectedCalibrationError: number;
  maxCalibrationError: number;
  buckets: CalibrationBucket[];
  isCalibrated: boolean; // pearsonR >= threshold
  overconfidentBuckets: CalibrationBucket[];
  underconfidentBuckets: CalibrationBucket[];
  recalibrationNeeded: boolean;
  recalibrationSuggestions: string[];
}

const DEFAULT_BUCKETS = [
  { min: 0, max: 0.2, label: '0-20%' },
  { min: 0.2, max: 0.4, label: '20-40%' },
  { min: 0.4, max: 0.6, label: '40-60%' },
  { min: 0.6, max: 0.8, label: '60-80%' },
  { min: 0.8, max: 0.9, label: '80-90%' },
  { min: 0.9, max: 1.01, label: '90-100%' },
];

/**
 * Analyze confidence calibration from eval results.
 */
export function analyzeCalibration(
  entries: EntryEvalResult[],
  correlationThreshold = 0.80,
): CalibrationResult {
  if (entries.length === 0) {
    return {
      pearsonR: 0,
      expectedCalibrationError: 1,
      maxCalibrationError: 1,
      buckets: [],
      isCalibrated: false,
      overconfidentBuckets: [],
      underconfidentBuckets: [],
      recalibrationNeeded: true,
      recalibrationSuggestions: ['No data available for calibration analysis'],
    };
  }

  const confidences = entries.map(e => e.reportedConfidence);
  const accuracies = entries.map(e => e.actualAccuracy);
  const pearsonR = pearsonCorrelation(confidences, accuracies);

  // Bucketed analysis
  const buckets: CalibrationBucket[] = [];
  for (const b of DEFAULT_BUCKETS) {
    const bucketEntries = entries.filter(
      e => e.reportedConfidence >= b.min && e.reportedConfidence < b.max,
    );
    if (bucketEntries.length === 0) {
      buckets.push({
        ...b,
        count: 0,
        meanReportedConfidence: 0,
        meanActualAccuracy: 0,
        gap: 0,
      });
      continue;
    }
    const meanConf = bucketEntries.reduce((s, e) => s + e.reportedConfidence, 0) / bucketEntries.length;
    const meanAcc = bucketEntries.reduce((s, e) => s + e.actualAccuracy, 0) / bucketEntries.length;
    buckets.push({
      ...b,
      count: bucketEntries.length,
      meanReportedConfidence: meanConf,
      meanActualAccuracy: meanAcc,
      gap: meanConf - meanAcc, // positive = overconfident
    });
  }

  // Expected Calibration Error (ECE)
  const totalEntries = entries.length;
  let ece = 0;
  let mce = 0;
  for (const bucket of buckets) {
    if (bucket.count === 0) continue;
    const absGap = Math.abs(bucket.gap);
    ece += (bucket.count / totalEntries) * absGap;
    mce = Math.max(mce, absGap);
  }

  const overconfident = buckets.filter(b => b.count > 0 && b.gap > 0.1);
  const underconfident = buckets.filter(b => b.count > 0 && b.gap < -0.1);
  const isCalibrated = pearsonR >= correlationThreshold;
  const recalibrationNeeded = !isCalibrated;

  // Generate suggestions
  const suggestions: string[] = [];
  if (recalibrationNeeded) {
    suggestions.push(
      `Pearson r = ${pearsonR.toFixed(3)} (target >= ${correlationThreshold.toFixed(2)}). Confidence scores do not reliably predict accuracy.`,
    );
  }
  if (ece > 0.15) {
    suggestions.push(
      `ECE = ${(ece * 100).toFixed(1)}% — expected calibration error is high. Model is ${overconfident.length > underconfident.length ? 'generally overconfident' : 'generally underconfident'}.`,
    );
  }
  for (const b of overconfident) {
    suggestions.push(
      `Bucket ${b.label}: overconfident by ${(b.gap * 100).toFixed(1)}pp (reports ${(b.meanReportedConfidence * 100).toFixed(0)}% confidence, actual ${(b.meanActualAccuracy * 100).toFixed(0)}% accuracy). Consider adding a prompt instruction to lower confidence when ${b.label.replace('%', '')} confidence.`,
    );
  }
  for (const b of underconfident) {
    suggestions.push(
      `Bucket ${b.label}: underconfident by ${(Math.abs(b.gap) * 100).toFixed(1)}pp (reports ${(b.meanReportedConfidence * 100).toFixed(0)}% confidence, actual ${(b.meanActualAccuracy * 100).toFixed(0)}% accuracy).`,
    );
  }

  // Suggest prompt-level recalibration
  if (recalibrationNeeded && entries.length >= 50) {
    const meanConf = confidences.reduce((a, b) => a + b, 0) / entries.length;
    const meanAcc = accuracies.reduce((a, b) => a + b, 0) / entries.length;
    if (meanConf > meanAcc + 0.1) {
      suggestions.push(
        `PROMPT FIX: Add instruction "Your confidence scores tend to be ${((meanConf - meanAcc) * 100).toFixed(0)}pp higher than actual accuracy. Be more conservative — lower your confidence by approximately ${((meanConf - meanAcc) * 100).toFixed(0)} points."`,
      );
    } else if (meanAcc > meanConf + 0.1) {
      suggestions.push(
        `PROMPT FIX: Add instruction "Your confidence scores are ${((meanAcc - meanConf) * 100).toFixed(0)}pp lower than actual accuracy. Be more confident in your extractions."`,
      );
    }
  }

  return {
    pearsonR,
    expectedCalibrationError: ece,
    maxCalibrationError: mce,
    buckets,
    isCalibrated,
    overconfidentBuckets: overconfident,
    underconfidentBuckets: underconfident,
    recalibrationNeeded,
    recalibrationSuggestions: suggestions,
  };
}

// ============================================================================
// ACTIVE CALIBRATION LAYER
// ============================================================================
// Empirical mapping from model-reported confidence → calibrated confidence.
// Derived from 310-entry eval dataset (2026-03-24).
//
// Mapping table (piecewise linear interpolation):
//   reported 0.00 → calibrated 0.65 (model reports 0 but gets ~67% accuracy)
//   reported 0.20 → calibrated 0.75 (model reports 20% but gets ~92% accuracy)
//   reported 0.60 → calibrated 0.85 (model reports 60% but gets ~92% accuracy)
//   reported 0.70 → calibrated 0.92 (model reports 70% but gets ~95% accuracy)
//   reported 0.80 → calibrated 0.94 (model reports 80% but gets ~94% accuracy)
//   reported 0.90 → calibrated 0.95 (model reports 90% but gets ~94% accuracy)
//   reported 1.00 → calibrated 0.95 (cap — model rarely reaches 100% accuracy)

/** Calibration knots: [rawConfidence, calibratedConfidence] */
const CALIBRATION_KNOTS: [number, number][] = [
  [0.00, 0.65],
  [0.20, 0.75],
  [0.60, 0.85],
  [0.70, 0.92],
  [0.80, 0.94],
  [0.90, 0.95],
  [1.00, 0.95],
];

/**
 * Apply post-hoc calibration to a raw model confidence score.
 *
 * Uses piecewise linear interpolation between empirically-derived knots.
 * The model is systematically underconfident (reports ~76% when accuracy is ~94%),
 * so this function maps raw scores upward to better reflect actual accuracy.
 *
 * @param rawConfidence - Model-reported confidence (0.0–1.0)
 * @returns Calibrated confidence (0.0–1.0)
 */
export function calibrateConfidence(rawConfidence: number): number {
  if (rawConfidence <= 0) return CALIBRATION_KNOTS[0][1];
  if (rawConfidence >= 1) return CALIBRATION_KNOTS[CALIBRATION_KNOTS.length - 1][1];

  // Find the two surrounding knots
  for (let i = 0; i < CALIBRATION_KNOTS.length - 1; i++) {
    const [x0, y0] = CALIBRATION_KNOTS[i];
    const [x1, y1] = CALIBRATION_KNOTS[i + 1];
    if (rawConfidence >= x0 && rawConfidence <= x1) {
      // Linear interpolation
      const t = (rawConfidence - x0) / (x1 - x0);
      return y0 + t * (y1 - y0);
    }
  }

  // Fallback (shouldn't reach here)
  return rawConfidence;
}

/** Per-type calibration analysis result */
export interface TypeCalibrationResult {
  credentialType: string;
  count: number;
  meanConfidence: number;
  meanAccuracy: number;
  gap: number;
  pearsonR: number;
}

/**
 * Analyze calibration broken down by credential type.
 * Useful for identifying types where the model is systematically off.
 */
export function analyzeCalibrationByType(
  entries: EntryEvalResult[],
): TypeCalibrationResult[] {
  const byType = new Map<string, EntryEvalResult[]>();
  for (const e of entries) {
    const type = e.credentialType;
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type)!.push(e);
  }

  const results: TypeCalibrationResult[] = [];
  for (const [type, typeEntries] of byType) {
    if (typeEntries.length < 2) continue; // need ≥2 for correlation

    const confs = typeEntries.map(e => e.reportedConfidence);
    const accs = typeEntries.map(e => e.actualAccuracy);
    const meanConf = confs.reduce((a, b) => a + b, 0) / confs.length;
    const meanAcc = accs.reduce((a, b) => a + b, 0) / accs.length;
    const r = pearsonCorrelation(confs, accs);

    results.push({
      credentialType: type,
      count: typeEntries.length,
      meanConfidence: meanConf,
      meanAccuracy: meanAcc,
      gap: meanConf - meanAcc,
      pearsonR: r,
    });
  }

  return results.sort((a, b) => a.gap - b.gap);
}

/**
 * Derive optimal calibration knots from eval data.
 *
 * Groups entries into confidence buckets, computes mean actual accuracy
 * per bucket, and returns knots for piecewise linear interpolation.
 *
 * @param entries - Eval results with confidence and accuracy
 * @param numBuckets - Number of buckets (default 7 to match existing knot count)
 * @returns Array of [rawConfidence, calibratedConfidence] knots
 */
export function deriveCalibrationKnots(
  entries: EntryEvalResult[],
  numBuckets = 7,
): [number, number][] {
  if (entries.length < numBuckets) {
    return CALIBRATION_KNOTS; // Not enough data, return current knots
  }

  // Sort by reported confidence
  const sorted = [...entries].sort((a, b) => a.reportedConfidence - b.reportedConfidence);

  const bucketSize = Math.floor(sorted.length / numBuckets);
  const knots: [number, number][] = [];

  for (let i = 0; i < numBuckets; i++) {
    const start = i * bucketSize;
    const end = i === numBuckets - 1 ? sorted.length : (i + 1) * bucketSize;
    const bucket = sorted.slice(start, end);

    const meanConf = bucket.reduce((s, e) => s + e.reportedConfidence, 0) / bucket.length;
    const meanAcc = bucket.reduce((s, e) => s + e.actualAccuracy, 0) / bucket.length;

    knots.push([
      Math.round(meanConf * 100) / 100,
      Math.round(meanAcc * 100) / 100,
    ]);
  }

  // Ensure monotonicity — calibrated values should be non-decreasing
  for (let i = 1; i < knots.length; i++) {
    if (knots[i][1] < knots[i - 1][1]) {
      knots[i][1] = knots[i - 1][1];
    }
  }

  // Ensure first knot starts at 0 and last at 1
  knots[0][0] = 0;
  knots[knots.length - 1][0] = 1;

  return knots;
}

/** Export current knots for testing */
export function getCurrentCalibrationKnots(): [number, number][] {
  return [...CALIBRATION_KNOTS];
}

/**
 * Format calibration report as markdown.
 */
export function formatCalibrationReport(cal: CalibrationResult): string {
  const lines: string[] = [];
  lines.push('# Confidence Calibration Report (AI-EVAL-02)');
  lines.push('');
  lines.push(`## Calibration Status: ${cal.isCalibrated ? 'CALIBRATED' : 'NEEDS RECALIBRATION'}`);
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  lines.push(`| Pearson Correlation (r) | ${cal.pearsonR.toFixed(3)} |`);
  lines.push(`| Expected Calibration Error | ${(cal.expectedCalibrationError * 100).toFixed(1)}% |`);
  lines.push(`| Max Calibration Error | ${(cal.maxCalibrationError * 100).toFixed(1)}% |`);
  lines.push(`| Overconfident Buckets | ${cal.overconfidentBuckets.length} |`);
  lines.push(`| Underconfident Buckets | ${cal.underconfidentBuckets.length} |`);
  lines.push('');

  lines.push('## Calibration Table');
  lines.push('');
  lines.push('| Confidence Bucket | Count | Mean Confidence | Mean Accuracy | Gap |');
  lines.push('|-------------------|-------|-----------------|---------------|-----|');
  for (const b of cal.buckets) {
    if (b.count === 0) {
      lines.push(`| ${b.label} | 0 | — | — | — |`);
    } else {
      const gapStr = b.gap > 0 ? `+${(b.gap * 100).toFixed(1)}pp` : `${(b.gap * 100).toFixed(1)}pp`;
      const gapIcon = Math.abs(b.gap) > 0.1 ? (b.gap > 0 ? ' (overconfident)' : ' (underconfident)') : '';
      lines.push(
        `| ${b.label} | ${b.count} | ${(b.meanReportedConfidence * 100).toFixed(1)}% | ${(b.meanActualAccuracy * 100).toFixed(1)}% | ${gapStr}${gapIcon} |`,
      );
    }
  }
  lines.push('');

  if (cal.recalibrationSuggestions.length > 0) {
    lines.push('## Recalibration Recommendations');
    lines.push('');
    for (const s of cal.recalibrationSuggestions) {
      lines.push(`- ${s}`);
    }
  }

  return lines.join('\n');
}
