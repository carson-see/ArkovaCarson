import type { EntryEvalResult, EvalRunResult } from './types.js';

export interface EvalGateFieldRequirement {
  field: string;
  minimumF1: number;
}

export interface EvalGateConfig {
  gateId: 'SCRUM-1962' | 'SCRUM-1963' | 'SCRUM-2187' | 'SCRUM-2382';
  label: string;
  blocksStory: string;
  minimumEntries: number;
  minimumWeightedF1: number;
  requiredFields: EvalGateFieldRequirement[];
  matchesEntry: (entry: EntryEvalResult) => boolean;
}

export interface EvalGateFieldResult extends EvalGateFieldRequirement {
  f1: number;
  passed: boolean;
}

export interface EvalGateResult {
  gateId: EvalGateConfig['gateId'];
  label: string;
  blocksStory: string;
  passed: boolean;
  reason: 'passed' | 'dataset_coverage_missing' | 'aggregate_threshold_failed' | 'field_threshold_failed';
  matchingEntries: number;
  weightedF1: number;
  minimumWeightedF1: number;
  fieldResults: EvalGateFieldResult[];
}

export const EVAL_GATE_CONFIGS: EvalGateConfig[] = [
  {
    gateId: 'SCRUM-1962',
    label: 'CPE extraction merge gate',
    blocksStory: 'SCRUM-1854',
    minimumEntries: 20,
    minimumWeightedF1: 0.8,
    requiredFields: [
      { field: 'creditHours', minimumF1: 0.85 },
      { field: 'fieldOfStudy', minimumF1: 0.8 },
      { field: 'deliveryMethod', minimumF1: 0.8 },
      // courseId is scored on the CPE gate too: a regression that stops reading
      // course IDs off CPE documents must fail here, not slip through because the
      // SCRUM-2187 course-id gate only covers course-id-only fixtures.
      { field: 'courseId', minimumF1: 0.75 },
    ],
    matchesEntry: (entry) => hasTag(entry, 'cpe') && isGateFixture(entry),
  },
  {
    gateId: 'SCRUM-1963',
    label: 'CLE ethics-hours merge gate',
    blocksStory: 'SCRUM-1880',
    minimumEntries: 20,
    minimumWeightedF1: 0.8,
    requiredFields: [
      { field: 'creditHours', minimumF1: 0.8 },
      { field: 'ethicsHours', minimumF1: 0.8 },
      // courseId is scored on the CLE gate too, mirroring SCRUM-1962: a regression
      // that stops reading course IDs off CLE documents must fail here, not slip
      // through the SCRUM-2187 gate's course-id-only coverage.
      { field: 'courseId', minimumF1: 0.75 },
    ],
    matchesEntry: (entry) => hasTag(entry, 'cle') && !hasTag(entry, 'cpe') && isGateFixture(entry),
  },
  {
    gateId: 'SCRUM-2187',
    label: 'Course-ID extraction merge gate',
    blocksStory: 'SCRUM-1921',
    minimumEntries: 20,
    minimumWeightedF1: 0.75,
    requiredFields: [{ field: 'courseId', minimumF1: 0.75 }],
    matchesEntry: (entry) =>
      hasTag(entry, 'course-id') && !hasTag(entry, 'cpe') && !hasTag(entry, 'cle') && isGateFixture(entry),
  },
  {
    // AI-02 (S3): deterministic F1 gate for the S3 CPE/CLE golden set
    // (golden-dataset-cpe-cle-s3.ts). Aggregate weighted F1 >= 0.80 AND
    // per-critical-field floors — creditHours, issuedDate, credentialType —
    // fail below either. minimumEntries is HARD-CODED to the full 48-entry
    // gate split so a shrinking dataset fails the gate instead of silently
    // lowering the coverage bar. Held-out entries are excluded by
    // isGateFixture (NON_GATE_SPLIT_TAGS).
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
    matchesEntry: (entry) => hasTag(entry, 's3-cpe-cle') && isGateFixture(entry),
  },
];

export function getEvalGateConfig(gateId: string): EvalGateConfig | undefined {
  return EVAL_GATE_CONFIGS.find((gate) => gate.gateId === gateId);
}

export function evaluateEvalGates(
  result: EvalRunResult,
  gateIds: Array<EvalGateConfig['gateId']> = EVAL_GATE_CONFIGS.map((gate) => gate.gateId),
): EvalGateResult[] {
  return gateIds.map((gateId) => {
    const config = getEvalGateConfig(gateId);
    if (!config) {
      throw new Error(`Unknown eval gate: ${gateId}`);
    }
    return evaluateEvalGate(result, config);
  });
}

export function evaluateEvalGate(result: EvalRunResult, config: EvalGateConfig): EvalGateResult {
  const entries = result.entryResults.filter(config.matchesEntry);
  const fieldResults = config.requiredFields.map((requirement) => {
    const f1 = computeFieldF1(entries, requirement.field);
    return {
      ...requirement,
      f1,
      passed: f1 >= requirement.minimumF1,
    };
  });
  const weightedF1 = computeWeightedF1(entries);

  if (entries.length < config.minimumEntries) {
    return buildGateResult(config, false, 'dataset_coverage_missing', entries.length, weightedF1, fieldResults);
  }

  if (fieldResults.some((field) => !field.passed)) {
    return buildGateResult(config, false, 'field_threshold_failed', entries.length, weightedF1, fieldResults);
  }

  if (weightedF1 < config.minimumWeightedF1) {
    return buildGateResult(config, false, 'aggregate_threshold_failed', entries.length, weightedF1, fieldResults);
  }

  return buildGateResult(config, true, 'passed', entries.length, weightedF1, fieldResults);
}

function buildGateResult(
  config: EvalGateConfig,
  passed: boolean,
  reason: EvalGateResult['reason'],
  matchingEntries: number,
  weightedF1: number,
  fieldResults: EvalGateFieldResult[],
): EvalGateResult {
  return {
    gateId: config.gateId,
    label: config.label,
    blocksStory: config.blocksStory,
    passed,
    reason,
    matchingEntries,
    weightedF1,
    minimumWeightedF1: config.minimumWeightedF1,
    fieldResults,
  };
}

function hasTag(entry: EntryEvalResult, tag: string): boolean {
  return entry.tags.some((entryTag) => entryTag.toLowerCase() === tag);
}

/**
 * Tags that mark an entry as belonging to a non-gate split. Gates score only
 * the curated gate fixtures; the held-out TEST set and the synthetic TRAIN set
 * must never be scored as merge-gate evidence, even if their arrays are ever
 * concatenated into a single eval run. This is the train/test contamination
 * guard (SCRUM-2200).
 */
const NON_GATE_SPLIT_TAGS = ['held-out', 'synthetic-train'] as const;

function isGateFixture(entry: EntryEvalResult): boolean {
  return !NON_GATE_SPLIT_TAGS.some((tag) => hasTag(entry, tag));
}

function computeFieldF1(entries: EntryEvalResult[], field: string): number {
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

  return f1(truePositives, falsePositives, falseNegatives);
}

/**
 * CAVEAT (round-1 review): `missing_both` — the ground truth omits the field
 * AND the extractor omitted it — is counted as a TRUE POSITIVE. Correctly
 * abstaining is treated as scoring credit, which INFLATES aggregate F1 on
 * sparse datasets relative to the classical definition (where true negatives
 * simply don't enter F1). The per-field floors in each gate config are the
 * guard against this: they are computed by computeFieldF1, where an entry
 * missing the field entirely counts as a false negative. Do not compare this
 * aggregate number against externally-reported extraction F1 scores.
 */
function computeWeightedF1(entries: EntryEvalResult[]): number {
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

function f1(truePositives: number, falsePositives: number, falseNegatives: number): number {
  const precisionDenominator = truePositives + falsePositives;
  const recallDenominator = truePositives + falseNegatives;
  const precision = precisionDenominator > 0 ? truePositives / precisionDenominator : 0;
  const recall = recallDenominator > 0 ? truePositives / recallDenominator : 0;
  return precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
}
