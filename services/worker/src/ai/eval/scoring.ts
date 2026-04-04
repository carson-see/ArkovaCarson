/**
 * AI Eval Scoring Engine (AI-EVAL-01)
 *
 * Compares AI extraction results against golden dataset ground truth.
 * Computes precision, recall, F1 per field, per credential type.
 */

import type {
  FieldResult,
  FieldMetrics,
  AggregateMetrics,
  EntryEvalResult,
  GroundTruthFields,
} from './types.js';

/** All fields that can be compared */
const ALL_FIELDS = [
  'credentialType',
  'issuerName',
  'recipientIdentifier',
  'issuedDate',
  'expiryDate',
  'fieldOfStudy',
  'degreeLevel',
  'licenseNumber',
  'accreditingBody',
  'jurisdiction',
  'creditHours',
  'creditType',
  'barNumber',
  'activityNumber',
  'providerName',
  'approvedBy',
  'fraudSignals',
] as const;

const DATE_FIELDS = new Set(['issuedDate', 'expiryDate']);
const ARRAY_FIELDS = new Set(['fraudSignals']);
const NUMERIC_FIELDS = new Set(['creditHours']);
/** Fields that accept fuzzy/semantic matching (normalized generalizations are OK) */
const FUZZY_FIELDS = new Set(['fieldOfStudy', 'issuerName', 'accreditingBody']);

/**
 * Canonical degreeLevel normalization map.
 * The golden dataset uses inconsistent labels across phases ("Doctorate" vs "Ph.D."
 * vs "Doctor of Medicine"). The model outputs various forms. All map to one of 4
 * canonical values for fair comparison. Without this, F1=58.6% due to normalization
 * mismatches, not model errors.
 */
const DEGREE_LEVEL_MAP: Record<string, string> = {
  // Bachelor
  'bachelor': 'bachelor', "bachelor's": 'bachelor', 'bs': 'bachelor', 'ba': 'bachelor',
  'bsc': 'bachelor', 'b.s.': 'bachelor', 'b.a.': 'bachelor', 'b.sc.': 'bachelor',
  'bachelor of science': 'bachelor', 'bachelor of arts': 'bachelor',
  'bachelor of engineering': 'bachelor', 'bachelor of fine arts': 'bachelor',
  'bfa': 'bachelor', 'b.e.': 'bachelor', 'beng': 'bachelor',
  // Master
  'master': 'master', "master's": 'master', 'ms': 'master', 'ma': 'master',
  'msc': 'master', 'm.s.': 'master', 'm.a.': 'master', 'm.sc.': 'master',
  'master of science': 'master', 'master of arts': 'master',
  'master of business administration': 'master', 'mba': 'master', 'm.b.a.': 'master',
  'master of public health': 'master', 'mph': 'master', 'm.p.h.': 'master',
  'master of education': 'master', 'med': 'master', 'm.ed.': 'master',
  'master of engineering': 'master', 'meng': 'master', 'm.eng.': 'master',
  'master of fine arts': 'master', 'mfa': 'master', 'm.f.a.': 'master',
  'master of social work': 'master', 'msw': 'master',
  'master of public administration': 'master', 'mpa': 'master',
  'master of laws': 'master', 'llm': 'master', 'll.m.': 'master',
  // Doctorate
  'doctorate': 'doctorate', 'doctoral': 'doctorate', 'doctor': 'doctorate',
  'ph.d.': 'doctorate', 'phd': 'doctorate', 'ph.d': 'doctorate',
  'doctor of philosophy': 'doctorate', 'doctor of medicine': 'doctorate',
  'doctor of education': 'doctorate', 'doctor of science': 'doctorate',
  'doctor of law': 'doctorate', 'doctor of dental surgery': 'doctorate',
  'doctor of pharmacy': 'doctorate', 'doctor of nursing practice': 'doctorate',
  'doctor of veterinary medicine': 'doctorate', 'doctor of psychology': 'doctorate',
  'doctor of physical therapy': 'doctorate', 'doctor of ministry': 'doctorate',
  'doctor of public health': 'doctorate', 'doctor of business administration': 'doctorate',
  'm.d.': 'doctorate', 'md': 'doctorate',
  'j.d.': 'doctorate', 'jd': 'doctorate', 'juris doctor': 'doctorate',
  'ed.d.': 'doctorate', 'edd': 'doctorate',
  'd.d.s.': 'doctorate', 'dds': 'doctorate',
  'pharm.d.': 'doctorate', 'pharmd': 'doctorate',
  'dnp': 'doctorate', 'd.n.p.': 'doctorate',
  'dvm': 'doctorate', 'd.v.m.': 'doctorate',
  'psy.d.': 'doctorate', 'psyd': 'doctorate',
  'dpt': 'doctorate', 'd.p.t.': 'doctorate',
  'd.min.': 'doctorate', 'dmin': 'doctorate',
  'drph': 'doctorate', 'dr.p.h.': 'doctorate',
  'dba': 'doctorate', 'd.b.a.': 'doctorate',
  // Associate
  'associate': 'associate', "associate's": 'associate', 'as': 'associate', 'aa': 'associate',
  'a.s.': 'associate', 'a.a.': 'associate',
  'associate of science': 'associate', 'associate of arts': 'associate',
  'associate of applied science': 'associate', 'aas': 'associate',
};

/**
 * Normalize a degreeLevel value to a canonical form for fair comparison.
 */
export function normalizeDegreeLevel(value: string | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  const lower = String(value).trim().toLowerCase().replace(/['']/g, "'");
  return DEGREE_LEVEL_MAP[lower] ?? lower;
}

/**
 * Normalize a string for comparison: lowercase, trim, collapse whitespace.
 */
export function normalizeString(value: string | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  return String(value).trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Normalize a date string to YYYY-MM-DD with zero-padded month/day.
 */
export function normalizeDate(value: string | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  const parts = String(value).split('-');
  if (parts.length !== 3) return value;
  const [year, month, day] = parts;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

/**
 * Compare a single field between ground truth and extracted value.
 */
export function compareField(
  field: string,
  expected: string | number | string[] | undefined,
  actual: string | number | string[] | undefined,
): FieldResult {
  // Both missing
  if (expected === undefined && actual === undefined) {
    return { field, expected, actual, correct: true, matchType: 'missing_both' };
  }
  if ((expected === undefined || (Array.isArray(expected) && expected.length === 0)) &&
      (actual === undefined || (Array.isArray(actual) && actual.length === 0))) {
    return { field, expected, actual, correct: true, matchType: 'missing_both' };
  }

  // Expected present, actual missing
  if (actual === undefined || actual === null || actual === '') {
    if (expected !== undefined && expected !== null && expected !== '' &&
        !(Array.isArray(expected) && expected.length === 0)) {
      return { field, expected, actual, correct: false, matchType: 'false_negative' };
    }
  }

  // Expected missing, actual present
  if (expected === undefined || expected === null || expected === '' ||
      (Array.isArray(expected) && expected.length === 0)) {
    if (actual !== undefined && actual !== null && actual !== '' &&
        !(Array.isArray(actual) && actual.length === 0)) {
      return { field, expected, actual, correct: false, matchType: 'false_positive' };
    }
  }

  // Array comparison (fraudSignals)
  if (ARRAY_FIELDS.has(field)) {
    const expArr = Array.isArray(expected) ? [...expected].sort() : [];
    const actArr = Array.isArray(actual) ? [...actual].sort() : [];
    const match = expArr.length === actArr.length && expArr.every((v, i) => v === actArr[i]);
    return { field, expected, actual, correct: match, matchType: match ? 'exact' : 'mismatch' };
  }

  // Numeric comparison
  if (NUMERIC_FIELDS.has(field)) {
    const match = Number(expected) === Number(actual);
    return { field, expected, actual, correct: match, matchType: match ? 'exact' : 'mismatch' };
  }

  // Date comparison
  if (DATE_FIELDS.has(field)) {
    const normExp = normalizeDate(String(expected));
    const normAct = normalizeDate(String(actual));
    if (normExp === normAct) {
      return { field, expected, actual, correct: true, matchType: 'exact' };
    }
    // Same-month tolerance for expiryDate: "2026-06-01" ≈ "2026-06-30"
    // Credentials commonly expire at end-of-month; models may output 1st or last day
    if (field === 'expiryDate' && normExp && normAct) {
      const expYM = normExp.slice(0, 7); // "YYYY-MM"
      const actYM = normAct.slice(0, 7);
      if (expYM === actYM) {
        return { field, expected, actual, correct: true, matchType: 'normalized' };
      }
    }
    return { field, expected, actual, correct: false, matchType: 'mismatch' };
  }

  // DegreeLevel: canonical normalization before comparison
  if (field === 'degreeLevel') {
    const normExp = normalizeDegreeLevel(String(expected));
    const normAct = normalizeDegreeLevel(String(actual));
    if (normExp && normAct && normExp === normAct) {
      return { field, expected, actual, correct: true, matchType: 'normalized' };
    }
    return { field, expected, actual, correct: normExp === normAct, matchType: normExp === normAct ? 'exact' : 'mismatch' };
  }

  // String comparison
  const expStr = String(expected);
  const actStr = String(actual);

  if (expStr === actStr) {
    return { field, expected, actual, correct: true, matchType: 'exact' };
  }

  const normExp = normalizeString(expStr);
  const normAct = normalizeString(actStr);

  if (normExp === normAct) {
    return { field, expected, actual, correct: true, matchType: 'normalized' };
  }

  // Fuzzy matching for fields where semantic equivalence is acceptable
  if (FUZZY_FIELDS.has(field) && normExp && normAct) {
    // Containment check: one contains the other (e.g., "Python" ⊂ "Python Programming")
    if (normExp.includes(normAct) || normAct.includes(normExp)) {
      return { field, expected, actual, correct: true, matchType: 'normalized' };
    }

    // Token overlap: >60% of tokens match (e.g., "First Aid / CPR / AED" ~ "CPR/AED")
    const expTokens = normExp.replace(/[/\-,&]/g, ' ').split(/\s+/).filter(t => t.length > 1);
    const actTokens = normAct.replace(/[/\-,&]/g, ' ').split(/\s+/).filter(t => t.length > 1);
    if (expTokens.length > 0 && actTokens.length > 0) {
      const matchedFromExp = expTokens.filter(t => actTokens.some(a => a.includes(t) || t.includes(a)));
      const matchedFromAct = actTokens.filter(t => expTokens.some(e => e.includes(t) || t.includes(e)));
      const overlapRatio = Math.max(
        matchedFromExp.length / expTokens.length,
        matchedFromAct.length / actTokens.length,
      );
      if (overlapRatio >= 0.6) {
        return { field, expected, actual, correct: true, matchType: 'normalized' };
      }
    }
  }

  return { field, expected, actual, correct: false, matchType: 'mismatch' };
}

/**
 * Compare all fields between ground truth and extracted result.
 * Returns a FieldResult for every field that appears in either ground truth or extracted.
 */
export function compareFields(
  groundTruth: GroundTruthFields,
  extracted: Record<string, unknown>,
): FieldResult[] {
  const results: FieldResult[] = [];

  for (const field of ALL_FIELDS) {
    const expected = (groundTruth as Record<string, unknown>)[field] as
      | string
      | number
      | string[]
      | undefined;
    const actual = (extracted as Record<string, unknown>)[field] as
      | string
      | number
      | string[]
      | undefined;

    // Skip fields that are absent from both
    if (expected === undefined && actual === undefined) continue;

    results.push(compareField(field, expected, actual));
  }

  return results;
}

/**
 * Compute precision, recall, F1 for a single field across multiple entry results.
 */
export function computeFieldMetrics(
  field: string,
  fieldResults: FieldResult[],
): FieldMetrics {
  if (fieldResults.length === 0) {
    return {
      field,
      totalExpected: 0,
      totalExtracted: 0,
      truePositives: 0,
      falsePositives: 0,
      falseNegatives: 0,
      precision: 0,
      recall: 0,
      f1: 0,
    };
  }

  let tp = 0;
  let fp = 0;
  let fn = 0;
  let totalExpected = 0;
  let totalExtracted = 0;

  for (const r of fieldResults) {
    const hasExpected = r.expected !== undefined && r.expected !== null && r.expected !== '' &&
      !(Array.isArray(r.expected) && r.expected.length === 0);
    const hasActual = r.actual !== undefined && r.actual !== null && r.actual !== '' &&
      !(Array.isArray(r.actual) && r.actual.length === 0);

    if (hasExpected) totalExpected++;
    if (hasActual) totalExtracted++;

    switch (r.matchType) {
      case 'exact':
      case 'normalized':
        tp++;
        break;
      case 'false_positive':
        fp++;
        break;
      case 'false_negative':
        fn++;
        break;
      case 'mismatch':
        // Mismatch: extracted something wrong. Counts as both FP and FN.
        fp++;
        fn++;
        break;
      case 'missing_both':
        // Neither expected nor present — not counted
        break;
    }
  }

  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  return {
    field,
    totalExpected,
    totalExtracted,
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    precision,
    recall,
    f1,
  };
}

/**
 * Pearson correlation coefficient between two arrays.
 */
export function pearsonCorrelation(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 2 || n !== y.length) return 0;

  const meanX = x.reduce((a, b) => a + b, 0) / n;
  const meanY = y.reduce((a, b) => a + b, 0) / n;

  let numSum = 0;
  let denomX = 0;
  let denomY = 0;

  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    numSum += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }

  const denom = Math.sqrt(denomX * denomY);
  if (denom === 0) return 0;
  return numSum / denom;
}

/**
 * Compute aggregate metrics for a set of entry results.
 */
export function computeAggregateMetrics(
  scope: string,
  entries: EntryEvalResult[],
): AggregateMetrics {
  if (entries.length === 0) {
    return {
      scope,
      totalEntries: 0,
      fieldMetrics: [],
      macroF1: 0,
      weightedF1: 0,
      meanReportedConfidence: 0,
      meanActualAccuracy: 0,
      confidenceCorrelation: 0,
      meanLatencyMs: 0,
    };
  }

  // Collect all field results grouped by field
  const fieldResultsByField = new Map<string, FieldResult[]>();
  for (const entry of entries) {
    for (const fr of entry.fieldResults) {
      const existing = fieldResultsByField.get(fr.field) || [];
      existing.push(fr);
      fieldResultsByField.set(fr.field, existing);
    }
  }

  // Compute per-field metrics
  const fieldMetrics: FieldMetrics[] = [];
  for (const [field, results] of fieldResultsByField) {
    fieldMetrics.push(computeFieldMetrics(field, results));
  }

  // Macro F1: average F1 across all fields that have at least 1 expected value
  const fieldsWithData = fieldMetrics.filter(fm => fm.totalExpected > 0);
  const macroF1 =
    fieldsWithData.length > 0
      ? fieldsWithData.reduce((sum, fm) => sum + fm.f1, 0) / fieldsWithData.length
      : 0;

  // Weighted F1: weighted by totalExpected per field
  const totalExpectedSum = fieldsWithData.reduce((sum, fm) => sum + fm.totalExpected, 0);
  const weightedF1 =
    totalExpectedSum > 0
      ? fieldsWithData.reduce((sum, fm) => sum + fm.f1 * fm.totalExpected, 0) / totalExpectedSum
      : 0;

  // Confidence metrics
  const confidences = entries.map(e => e.reportedConfidence);
  const accuracies = entries.map(e => e.actualAccuracy);
  const meanReportedConfidence = confidences.reduce((a, b) => a + b, 0) / entries.length;
  const meanActualAccuracy = accuracies.reduce((a, b) => a + b, 0) / entries.length;
  const confidenceCorrelation = pearsonCorrelation(confidences, accuracies);

  // Calibrated confidence metrics (if calibration data present)
  const calibratedConfidences = entries
    .map(e => e.calibratedConfidence)
    .filter((c): c is number => c !== undefined);
  const calibratedCorrelation = calibratedConfidences.length === entries.length
    ? pearsonCorrelation(calibratedConfidences, accuracies)
    : undefined;
  const meanCalibratedConfidence = calibratedConfidences.length > 0
    ? calibratedConfidences.reduce((a, b) => a + b, 0) / calibratedConfidences.length
    : undefined;

  // Latency
  const meanLatencyMs =
    entries.reduce((sum, e) => sum + e.latencyMs, 0) / entries.length;

  return {
    scope,
    totalEntries: entries.length,
    fieldMetrics,
    macroF1,
    weightedF1,
    meanReportedConfidence,
    meanActualAccuracy,
    confidenceCorrelation,
    calibratedCorrelation,
    meanCalibratedConfidence,
    meanLatencyMs,
  };
}
