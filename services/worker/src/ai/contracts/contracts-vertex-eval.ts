export interface ContractsEvalEntry {
  id: string;
  stratum: string;
  prompt: string;
  expected: Record<string, unknown>;
}

export interface ContractsEvalPlanOptions {
  targetSize: number;
  requiredStrata: string[];
}

export interface ContractsEvalPlan {
  entries: ContractsEvalEntry[];
  countsByStratum: Record<string, number>;
}

export interface VertexContractsTuningManifest {
  displayName: 'arkova-gemini-contracts-expert-v1';
  baseModel: 'gemini-2.5-flash';
  epochCount: 8;
  adapterSize: 'ADAPTER_SIZE_FOUR';
  gcsTrainingUri: string;
  gcsValidationUri: string;
  intermediateCheckpointsMustRemainUndeployed: true;
}

export interface VertexContractsTuningManifestInput {
  gcsTrainingUri: string;
  gcsValidationUri: string;
}

export interface ContractsExpertMetrics {
  macroF1: number;
  structuredTermAccuracy: number;
  autoRenewalF1: number;
  unusualClauseF1: number;
  missingClauseF1: number;
  crossDocumentF1: number;
  urlAccuracy: number;
  latencyP50Ms: number;
  v7UpliftPp: number;
}

export interface ThresholdResult {
  passed: boolean;
  failures: string[];
}

const THRESHOLDS: Record<keyof ContractsExpertMetrics, number> = {
  macroF1: 0.85,
  structuredTermAccuracy: 0.90,
  autoRenewalF1: 0.85,
  unusualClauseF1: 0.75,
  missingClauseF1: 0.70,
  crossDocumentF1: 0.85,
  urlAccuracy: 1,
  latencyP50Ms: 5_000,
  v7UpliftPp: 10,
};

export function buildContractsExpertStratifiedEvalPlan(
  entries: ContractsEvalEntry[],
  options: ContractsEvalPlanOptions,
): ContractsEvalPlan {
  if (options.targetSize % options.requiredStrata.length !== 0) {
    throw new Error('targetSize must divide evenly by required strata');
  }

  const perStratum = options.targetSize / options.requiredStrata.length;
  const selected: ContractsEvalEntry[] = [];
  const countsByStratum: Record<string, number> = {};

  for (const stratum of options.requiredStrata) {
    const bucket = entries.filter((entry) => entry.stratum === stratum).slice(0, perStratum);
    if (bucket.length < perStratum) {
      throw new Error(`Not enough entries for stratum ${stratum}: ${bucket.length} < ${perStratum}`);
    }
    countsByStratum[stratum] = bucket.length;
    selected.push(...bucket);
  }

  return { entries: selected, countsByStratum };
}

export function buildVertexContractsTuningManifest(
  input: VertexContractsTuningManifestInput,
): VertexContractsTuningManifest {
  return {
    displayName: 'arkova-gemini-contracts-expert-v1',
    baseModel: 'gemini-2.5-flash',
    epochCount: 8,
    adapterSize: 'ADAPTER_SIZE_FOUR',
    gcsTrainingUri: input.gcsTrainingUri,
    gcsValidationUri: input.gcsValidationUri,
    intermediateCheckpointsMustRemainUndeployed: true,
  };
}

export function assertContractsExpertThresholds(metrics: ContractsExpertMetrics): ThresholdResult {
  const failures: string[] = [];

  for (const [metricName, threshold] of Object.entries(THRESHOLDS) as Array<[keyof ContractsExpertMetrics, number]>) {
    const value = metrics[metricName];
    if (metricName === 'latencyP50Ms') {
      if (value > threshold) failures.push(`${metricName} ${value} > ${threshold}`);
    } else if (value < threshold) {
      failures.push(`${metricName} ${value} < ${threshold}`);
    }
  }

  return {
    passed: failures.length === 0,
    failures,
  };
}
