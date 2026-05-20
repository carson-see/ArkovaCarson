import { describe, expect, it } from 'vitest';
import {
  EVAL_GATE_CONFIGS,
  evaluateEvalGates,
  getEvalGateConfig,
} from './eval-gates.js';
import { GOLDEN_DATASET_PROFESSIONAL_EDUCATION } from './golden-dataset-professional-education.js';
import type { EvalRunResult } from './types.js';

function makeEvalResult(entries: EvalRunResult['entryResults']): EvalRunResult {
  return {
    timestamp: '2026-05-20T00:00:00.000Z',
    provider: 'mock',
    promptVersionHash: 'abc123',
    totalEntries: entries.length,
    entryResults: entries,
    overall: {
      scope: 'ALL',
      totalEntries: entries.length,
      fieldMetrics: [],
      macroF1: 1,
      weightedF1: 1,
      meanReportedConfidence: 0.9,
      meanActualAccuracy: 1,
      confidenceCorrelation: 1,
      meanLatencyMs: 10,
    },
    byCredentialType: [],
  };
}

function makeEntry(
  entryId: string,
  tags: string[],
  fields: Array<{ field: string; correct: boolean }>,
): EvalRunResult['entryResults'][number] {
  return {
    entryId,
    credentialType: 'CLE',
    category: 'continuing_education',
    tags,
    fieldResults: fields.map((field) => ({
      field: field.field,
      expected: field.field,
      actual: field.correct ? field.field : undefined,
      correct: field.correct,
      matchType: field.correct ? 'exact' : 'false_negative',
    })),
    reportedConfidence: 0.9,
    calibratedConfidence: 0.9,
    adjustedConfidence: 0.9,
    actualAccuracy: fields.filter((field) => field.correct).length / fields.length,
    latencyMs: 10,
    provider: 'mock',
    tokensUsed: 1,
  };
}

describe('eval gates', () => {
  it('defines fail-closed gates for CPE and CLE adapter merge blockers', () => {
    expect(getEvalGateConfig('SCRUM-1962')?.minimumEntries).toBeGreaterThan(0);
    expect(getEvalGateConfig('SCRUM-1963')?.requiredFields).toContainEqual({
      field: 'ethicsHours',
      minimumF1: 0.8,
    });
  });

  it('fails closed when Phase 5 dataset coverage is missing', () => {
    const result = evaluateEvalGates(makeEvalResult([]), ['SCRUM-1962', 'SCRUM-1963']);

    expect(result.every((gate) => gate.passed)).toBe(false);
    expect(result.map((gate) => gate.reason)).toEqual([
      'dataset_coverage_missing',
      'dataset_coverage_missing',
    ]);
  });

  it('passes a CPE gate only when aggregate and required field F1 thresholds pass', () => {
    const result = evaluateEvalGates(
      makeEvalResult(Array.from({ length: 20 }, (_, index) => (
        makeEntry(`cpe-${index + 1}`, ['cpe', 'phase-5'], [
          { field: 'creditHours', correct: true },
          { field: 'fieldOfStudy', correct: true },
          { field: 'deliveryMethod', correct: true },
        ])
      ))),
      ['SCRUM-1962'],
    );

    expect(result[0]).toMatchObject({
      gateId: 'SCRUM-1962',
      passed: true,
      matchingEntries: 20,
    });
  });

  it('fails the CLE gate when ethicsHours is below threshold even if other fields pass', () => {
    const result = evaluateEvalGates(
      makeEvalResult(Array.from({ length: 20 }, (_, index) => (
        makeEntry(`cle-${index + 1}`, ['cle', 'phase-5'], [
          { field: 'creditHours', correct: true },
          { field: 'ethicsHours', correct: false },
        ])
      ))),
      ['SCRUM-1963'],
    );

    expect(result[0]).toMatchObject({
      gateId: 'SCRUM-1963',
      passed: false,
      reason: 'field_threshold_failed',
    });
    expect(result[0].fieldResults).toContainEqual({
      field: 'ethicsHours',
      f1: 0,
      minimumF1: 0.8,
      passed: false,
    });
  });

  it('matches professional education CPE and CLE entries against separate gates', () => {
    const cpeGate = EVAL_GATE_CONFIGS.find((gate) => gate.gateId === 'SCRUM-1962');
    const cleGate = EVAL_GATE_CONFIGS.find((gate) => gate.gateId === 'SCRUM-1963');

    const cpeEntry = makeEntry('professional-education-cpe', ['professional-education', 'cpe', 'cle'], [
      { field: 'creditHours', correct: true },
    ]);
    const cleEntry = makeEntry('professional-education-cle', ['professional-education', 'cle', 'ethics'], [
      { field: 'ethicsHours', correct: true },
    ]);

    expect(cpeGate?.matchesEntry(cpeEntry)).toBe(true);
    expect(cleGate?.matchesEntry(cpeEntry)).toBe(false);
    expect(cleGate?.matchesEntry(cleEntry)).toBe(true);
  });

  it('has dedicated professional education fixtures for each gate', () => {
    const cpeEntries = GOLDEN_DATASET_PROFESSIONAL_EDUCATION.filter((entry) => entry.tags.includes('cpe'));
    const cleEntries = GOLDEN_DATASET_PROFESSIONAL_EDUCATION.filter(
      (entry) => entry.tags.includes('cle') && !entry.tags.includes('cpe'),
    );

    expect(cpeEntries.length).toBeGreaterThan(0);
    expect(cleEntries.length).toBeGreaterThan(0);
    expect(cpeEntries.every((entry) => entry.groundTruth.creditHours !== undefined)).toBe(true);
    expect(cleEntries.some((entry) => entry.groundTruth.ethicsHours !== undefined)).toBe(true);
  });
});
