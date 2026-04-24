import { describe, expect, it } from 'vitest';
import {
  assertContractsExpertThresholds,
  buildContractsExpertStratifiedEvalPlan,
  buildVertexContractsTuningManifest,
  type ContractsEvalEntry,
} from './contracts-vertex-eval.js';

function fixtureEntries(): ContractsEvalEntry[] {
  const strata = ['auto_renewal', 'unusual_clause', 'missing_clause', 'cross_document', 'url_accuracy'];
  return Array.from({ length: 250 }, (_, index) => ({
    id: `contracts-eval-${index}`,
    stratum: strata[index % strata.length],
    prompt: `Extract contract terms ${index}`,
    expected: { answer: index },
  }));
}

describe('contracts Vertex eval preparation', () => {
  it('builds a 200-entry stratified eval plan with every required contract stratum represented', () => {
    const plan = buildContractsExpertStratifiedEvalPlan(fixtureEntries(), {
      targetSize: 200,
      requiredStrata: ['auto_renewal', 'unusual_clause', 'missing_clause', 'cross_document', 'url_accuracy'],
    });

    expect(plan.entries).toHaveLength(200);
    expect(plan.countsByStratum).toEqual({
      auto_renewal: 40,
      unusual_clause: 40,
      missing_clause: 40,
      cross_document: 40,
      url_accuracy: 40,
    });
  });

  it('encodes the SCRUM-864 tuning job parameters without submitting the job', () => {
    const manifest = buildVertexContractsTuningManifest({
      gcsTrainingUri: 'gs://arkova-training-data/contracts-v1/train.jsonl',
      gcsValidationUri: 'gs://arkova-training-data/contracts-v1/validation.jsonl',
    });

    expect(manifest.displayName).toBe('arkova-gemini-contracts-expert-v1');
    expect(manifest.baseModel).toBe('gemini-2.5-flash');
    expect(manifest.epochCount).toBe(8);
    expect(manifest.adapterSize).toBe('ADAPTER_SIZE_FOUR');
  });

  it('fails the release gate when required metrics miss thresholds', () => {
    const result = assertContractsExpertThresholds({
      macroF1: 0.86,
      structuredTermAccuracy: 0.91,
      autoRenewalF1: 0.84,
      unusualClauseF1: 0.76,
      missingClauseF1: 0.72,
      crossDocumentF1: 0.88,
      urlAccuracy: 1,
      latencyP50Ms: 4_900,
      v7UpliftPp: 11,
    });

    expect(result.passed).toBe(false);
    expect(result.failures).toEqual(['autoRenewalF1 0.84 < 0.85']);
  });
});
