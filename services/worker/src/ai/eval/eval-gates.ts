import type { EntryEvalResult, EvalRunResult } from './types.js';

export interface EvalGateFieldRequirement {
  field: string;
  minimumF1: number;
}

export interface EvalGateConfig {
  gateId: 'SCRUM-1962' | 'SCRUM-1963';
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
    ],
    matchesEntry: (entry) => hasTag(entry, 'cpe'),
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
    ],
    matchesEntry: (entry) => hasTag(entry, 'cle') && !hasTag(entry, 'cpe'),
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
