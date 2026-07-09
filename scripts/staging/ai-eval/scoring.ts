/**
 * scripts/staging/ai-eval/scoring.ts — VENDORED field scorer + F1 / SCRUM-2382
 * eval-gate logic for the standalone AI T3 soak tooling.
 *
 * ── Provenance / attribution ────────────────────────────────────────────────
 * This is a FAITHFUL, behaviour-equivalent PORT of the eval scoring that the
 * SCRUM-2382 merge gate runs in-process, vendored so the soak tooling can score
 * LIVE HTTP `/api/v1/ai/extract` output against the AI-01 golden set WITHOUT
 * importing from `services/worker/` (the worker is a separate TS project the
 * root tsconfig excludes, and the SCRUM-2382 gate config lives only on the
 * soaking PR #1413 — which this tooling must NOT depend on or modify).
 *
 * Sources (read-only origin; do NOT edit those files from here):
 *   - compareField / compareFields / normalizers:
 *       services/worker/src/ai/eval/scoring.ts       (identical on origin/main and
 *       origin/lane3/s3-ai — stable, not touched by #1413)
 *   - SCRUM-2382 gate config + computeFieldF1 / computeWeightedF1 / f1 /
 *     evaluateEvalGate:
 *       services/worker/src/ai/eval/eval-gates.ts     (SCRUM-2382 block added by
 *       PR #1413 @ b95851d57a59f32bc0425f43715339806d511fc3)
 *
 * If either upstream file changes, re-vendor this port and re-run the parity
 * test (scoring.test.ts) that pins the SCRUM-2382 gate config values.
 *
 * The intent: the F1 this module computes on a live-extraction run equals the F1
 * the SCRUM-2382 merge gate would compute on the same field maps — so the soak's
 * recorded ">= 0.80" is the SAME number that gates the merge.
 */

// ── Ground-truth + result shapes (subset of the worker's eval types) ─────────

/** Golden-set ground-truth field map (superset; only ALL_FIELDS are scored). */
export type GroundTruthFields = Record<string, string | number | string[] | boolean | undefined>;
export type FieldValue = string | number | string[] | undefined;

export interface GoldenEntry {
  id: string;
  description: string;
  strippedText: string;
  credentialTypeHint: string;
  issuerHint?: string;
  groundTruth: GroundTruthFields;
  source: string;
  category: string;
  tags: string[];
}

export type MatchType =
  | 'exact'
  | 'normalized'
  | 'missing_both'
  | 'false_positive'
  | 'false_negative'
  | 'mismatch';

export interface FieldResult {
  field: string;
  expected: FieldValue;
  actual: FieldValue;
  correct: boolean;
  matchType: MatchType;
}

export interface EntryEvalResult {
  entryId: string;
  tags: string[];
  fieldResults: FieldResult[];
  extractionError?: string;
  /** true when the server returned a degraded / fast-fallback (false reading). */
  falseReading?: boolean;
}

// ── ALL_FIELDS + field classes (verbatim from scoring.ts) ────────────────────

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
  'courseId',
  'providerName',
  'approvedBy',
  'deliveryMethod',
  'ethicsHours',
  'nasbaStatus',
  'fraudSignals',
] as const;

const DATE_FIELDS = new Set(['issuedDate', 'expiryDate']);
const ARRAY_FIELDS = new Set(['fraudSignals']);
const NUMERIC_FIELDS = new Set(['creditHours', 'ethicsHours']);
const FUZZY_FIELDS = new Set(['fieldOfStudy', 'issuerName', 'accreditingBody']);

// degreeLevel normalization is not exercised by the CPE/CLE golden set, but is
// retained (abridged) for parity with the upstream scorer's code path.
const DEGREE_LEVEL_MAP: Record<string, string> = {
  bachelor: 'bachelor', "bachelor's": 'bachelor', bs: 'bachelor', ba: 'bachelor',
  bsc: 'bachelor', master: 'master', "master's": 'master', ms: 'master', ma: 'master',
  msc: 'master', doctorate: 'doctorate', phd: 'doctorate', 'ph.d.': 'doctorate',
  associate: 'associate', "associate's": 'associate', as: 'associate', aa: 'associate',
};

export function normalizeDegreeLevel(value: string | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  const lower = String(value).trim().toLowerCase().replace(/['’]/g, "'");
  return DEGREE_LEVEL_MAP[lower] ?? lower;
}

export function normalizeString(value: string | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  return String(value).trim().toLowerCase().replace(/\s+/g, ' ');
}

export function normalizeDate(value: string | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  const parts = String(value).split('-');
  if (parts.length !== 3) return value;
  const [year, month, day] = parts;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

function resultFor(
  field: string,
  expected: FieldValue,
  actual: FieldValue,
  correct: boolean,
  matchType: MatchType,
): FieldResult {
  return { field, expected, actual, correct, matchType };
}

function isEmptyValue(value: FieldValue | null): boolean {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
}

function compareMissingValues(field: string, expected: FieldValue, actual: FieldValue): FieldResult | undefined {
  const expectedEmpty = isEmptyValue(expected);
  const actualEmpty = isEmptyValue(actual);
  if (expectedEmpty && actualEmpty) {
    return resultFor(field, expected, actual, true, 'missing_both');
  }
  if (actualEmpty) {
    return resultFor(field, expected, actual, false, 'false_negative');
  }
  if (expectedEmpty) {
    return resultFor(field, expected, actual, false, 'false_positive');
  }
  return undefined;
}

function sortedStrings(value: FieldValue): string[] {
  return Array.isArray(value) ? [...value].sort((a, b) => String(a).localeCompare(String(b))) : [];
}

function compareArrayField(field: string, expected: FieldValue, actual: FieldValue): FieldResult {
  const expArr = sortedStrings(expected);
  const actArr = sortedStrings(actual);
  const match = expArr.length === actArr.length && expArr.every((v, i) => v === actArr[i]);
  return resultFor(field, expected, actual, match, match ? 'exact' : 'mismatch');
}

function compareNumericField(field: string, expected: FieldValue, actual: FieldValue): FieldResult {
  const match = Number(expected) === Number(actual);
  return resultFor(field, expected, actual, match, match ? 'exact' : 'mismatch');
}

function compareDateField(field: string, expected: FieldValue, actual: FieldValue): FieldResult {
  const normExp = normalizeDate(String(expected));
  const normAct = normalizeDate(String(actual));
  if (normExp === normAct) {
    return resultFor(field, expected, actual, true, 'exact');
  }
  const monthMatches = field === 'expiryDate' && normExp && normAct && normExp.slice(0, 7) === normAct.slice(0, 7);
  return resultFor(field, expected, actual, Boolean(monthMatches), monthMatches ? 'normalized' : 'mismatch');
}

function compareDegreeLevel(field: string, expected: FieldValue, actual: FieldValue): FieldResult {
  const normExp = normalizeDegreeLevel(String(expected));
  const normAct = normalizeDegreeLevel(String(actual));
  if (normExp && normAct && normExp === normAct) {
    return resultFor(field, expected, actual, true, 'normalized');
  }
  const match = normExp === normAct;
  return resultFor(field, expected, actual, match, match ? 'exact' : 'mismatch');
}

function fuzzyTokens(value: string): string[] {
  return value.replaceAll(/[/\-,&]/g, ' ').split(/\s+/).filter((token) => token.length > 1);
}

function tokenOverlapRatio(expTokens: string[], actTokens: string[]): number {
  const matchedFromExp = expTokens.filter((token) => actTokens.some((actual) => actual.includes(token) || token.includes(actual)));
  const matchedFromAct = actTokens.filter((token) => expTokens.some((expected) => expected.includes(token) || token.includes(expected)));
  return Math.max(
    matchedFromExp.length / expTokens.length,
    matchedFromAct.length / actTokens.length,
  );
}

function compareFuzzyField(field: string, expected: FieldValue, actual: FieldValue, normExp: string, normAct: string): FieldResult | undefined {
  if (!FUZZY_FIELDS.has(field)) return undefined;
  if (normExp.includes(normAct) || normAct.includes(normExp)) {
    return resultFor(field, expected, actual, true, 'normalized');
  }
  const expTokens = fuzzyTokens(normExp);
  const actTokens = fuzzyTokens(normAct);
  if (expTokens.length === 0 || actTokens.length === 0) return undefined;
  return tokenOverlapRatio(expTokens, actTokens) >= 0.6
    ? resultFor(field, expected, actual, true, 'normalized')
    : undefined;
}

function compareStringField(field: string, expected: FieldValue, actual: FieldValue): FieldResult {
  const expStr = String(expected);
  const actStr = String(actual);
  if (expStr === actStr) return resultFor(field, expected, actual, true, 'exact');

  const normExp = normalizeString(expStr);
  const normAct = normalizeString(actStr);
  if (normExp === normAct) return resultFor(field, expected, actual, true, 'normalized');
  if (normExp && normAct) {
    const fuzzy = compareFuzzyField(field, expected, actual, normExp, normAct);
    if (fuzzy) return fuzzy;
  }

  return resultFor(field, expected, actual, false, 'mismatch');
}

/** Faithful port of scoring.ts:compareField. */
export function compareField(
  field: string,
  expected: FieldValue,
  actual: FieldValue,
): FieldResult {
  const missing = compareMissingValues(field, expected, actual);
  if (missing) return missing;
  if (ARRAY_FIELDS.has(field)) return compareArrayField(field, expected, actual);
  if (NUMERIC_FIELDS.has(field)) return compareNumericField(field, expected, actual);
  if (DATE_FIELDS.has(field)) return compareDateField(field, expected, actual);
  if (field === 'degreeLevel') return compareDegreeLevel(field, expected, actual);
  return compareStringField(field, expected, actual);
}

/** Faithful port of scoring.ts:compareFields. */
export function compareFields(
  groundTruth: GroundTruthFields,
  extracted: Record<string, unknown>,
): FieldResult[] {
  const results: FieldResult[] = [];
  for (const field of ALL_FIELDS) {
    const expected = groundTruth[field] as FieldValue;
    const actual = extracted[field] as FieldValue;
    if (expected === undefined && actual === undefined) continue;
    results.push(compareField(field, expected, actual));
  }
  return results;
}

// ── SCRUM-2382 gate config (vendored from eval-gates.ts, #1413) ──────────────

export interface EvalGateFieldRequirement {
  field: string;
  minimumF1: number;
}

export interface EvalGateConfig {
  gateId: 'SCRUM-2382';
  label: string;
  blocksStory: string;
  minimumEntries: number;
  minimumWeightedF1: number;
  requiredFields: EvalGateFieldRequirement[];
  datasetTag: string;
}

/**
 * The SCRUM-2382 (AI-02) merge gate. Values are pinned to #1413's eval-gates.ts
 * SCRUM-2382 block (aggregate weighted F1 >= 0.80; per-field floors on
 * creditHours/issuedDate/credentialType; 48-entry gate split). scoring.test.ts
 * fails if any value drifts from that source.
 */
export const SCRUM_2382_GATE: EvalGateConfig = {
  gateId: 'SCRUM-2382',
  label: 'S3 CPE/CLE extraction eval gate',
  blocksStory: 'SCRUM-2383',
  minimumEntries: 48,
  minimumWeightedF1: 0.8,
  requiredFields: [
    { field: 'creditHours', minimumF1: 0.85 },
    { field: 'issuedDate', minimumF1: 0.8 },
    { field: 'credentialType', minimumF1: 0.8 },
  ],
  datasetTag: 's3-cpe-cle',
};

/** Held-out / synthetic-train splits are never gate-scored (train/test guard). */
const NON_GATE_SPLIT_TAGS = ['held-out', 'synthetic-train'] as const;

function hasTag(entry: EntryEvalResult, tag: string): boolean {
  return entry.tags.some((entryTag) => entryTag.toLowerCase() === tag);
}

export function isGateFixture(entry: EntryEvalResult): boolean {
  return !NON_GATE_SPLIT_TAGS.some((tag) => hasTag(entry, tag));
}

/** An entry belongs to the SCRUM-2382 gate iff it is a non-held-out s3-cpe-cle fixture. */
export function matchesGate(entry: EntryEvalResult): boolean {
  return hasTag(entry, SCRUM_2382_GATE.datasetTag) && isGateFixture(entry);
}

// ── F1 math (verbatim port from eval-gates.ts) ───────────────────────────────

export function f1(truePositives: number, falsePositives: number, falseNegatives: number): number {
  const precisionDenominator = truePositives + falsePositives;
  const recallDenominator = truePositives + falseNegatives;
  const precision = precisionDenominator > 0 ? truePositives / precisionDenominator : 0;
  const recall = recallDenominator > 0 ? truePositives / recallDenominator : 0;
  return precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
}

export interface PrecisionRecall {
  precision: number;
  recall: number;
  f1: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
}

/** Per-field precision/recall/F1 (mirrors computeFieldF1, plus P/R for the record). */
export function computeFieldMetrics(entries: EntryEvalResult[], field: string): PrecisionRecall {
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;

  for (const entry of entries) {
    const result = entry.fieldResults.find((fieldResult) => fieldResult.field === field);
    if (!result) {
      falseNegatives++;
      continue;
    }
    if (result.correct) {
      truePositives++;
    } else if (result.matchType === 'false_positive' || result.matchType === 'mismatch') {
      falsePositives++;
    } else {
      falseNegatives++;
    }
  }

  const precisionDenominator = truePositives + falsePositives;
  const recallDenominator = truePositives + falseNegatives;
  return {
    precision: precisionDenominator > 0 ? truePositives / precisionDenominator : 0,
    recall: recallDenominator > 0 ? truePositives / recallDenominator : 0,
    f1: f1(truePositives, falsePositives, falseNegatives),
    truePositives,
    falsePositives,
    falseNegatives,
  };
}

/**
 * Aggregate weighted F1 (verbatim port of computeWeightedF1). NOTE the upstream
 * caveat: `missing_both` counts as a TRUE POSITIVE, inflating aggregate F1 on
 * sparse datasets vs the classical definition. The per-field floors are the
 * guard. Do not compare this against externally-reported extraction F1.
 */
export function computeWeightedF1(entries: EntryEvalResult[]): number {
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  for (const entry of entries) {
    for (const result of entry.fieldResults) {
      if (result.correct || result.matchType === 'missing_both') {
        truePositives++;
      } else if (result.matchType === 'false_positive' || result.matchType === 'mismatch') {
        falsePositives++;
      } else {
        falseNegatives++;
      }
    }
  }
  return f1(truePositives, falsePositives, falseNegatives);
}

export interface GateFieldResult extends EvalGateFieldRequirement {
  f1: number;
  precision: number;
  recall: number;
  passed: boolean;
}

export interface GateEvaluation {
  gateId: EvalGateConfig['gateId'];
  label: string;
  blocksStory: string;
  passed: boolean;
  reason: 'passed' | 'dataset_coverage_missing' | 'aggregate_threshold_failed' | 'field_threshold_failed';
  matchingEntries: number;
  minimumEntries: number;
  weightedF1: number;
  minimumWeightedF1: number;
  fieldResults: GateFieldResult[];
}

/**
 * Evaluate the SCRUM-2382 gate against a set of scored entries. Faithful port of
 * eval-gates.ts:evaluateEvalGate (fail-closed on coverage/field/aggregate).
 */
export function evaluateGate(
  allEntries: EntryEvalResult[],
  config: EvalGateConfig = SCRUM_2382_GATE,
): GateEvaluation {
  const entries = allEntries.filter(matchesGate);
  const fieldResults: GateFieldResult[] = config.requiredFields.map((requirement) => {
    const metrics = computeFieldMetrics(entries, requirement.field);
    return {
      ...requirement,
      f1: metrics.f1,
      precision: metrics.precision,
      recall: metrics.recall,
      passed: metrics.f1 >= requirement.minimumF1,
    };
  });
  const weightedF1 = computeWeightedF1(entries);

  let passed = true;
  let reason: GateEvaluation['reason'] = 'passed';
  if (entries.length < config.minimumEntries) {
    passed = false;
    reason = 'dataset_coverage_missing';
  } else if (fieldResults.some((field) => !field.passed)) {
    passed = false;
    reason = 'field_threshold_failed';
  } else if (weightedF1 < config.minimumWeightedF1) {
    passed = false;
    reason = 'aggregate_threshold_failed';
  }

  return {
    gateId: config.gateId,
    label: config.label,
    blocksStory: config.blocksStory,
    passed,
    reason,
    matchingEntries: entries.length,
    minimumEntries: config.minimumEntries,
    weightedF1,
    minimumWeightedF1: config.minimumWeightedF1,
    fieldResults,
  };
}
