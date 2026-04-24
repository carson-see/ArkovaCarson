import { traceAiProviderCall } from '../observability.js';
import type { RegressionResult } from './baseline-metrics.js';

export type EvalDriftSeverity = 'ok' | 'warning' | 'critical';

export interface EvalDriftAlert {
  provider: string;
  triggered: boolean;
  severity: EvalDriftSeverity;
  driftScore: number;
  failureModes: string[];
  summary: string;
}

export function buildEvalDriftAlert(provider: string, regression: RegressionResult): EvalDriftAlert {
  const failedChecks = regression.checks.filter((check) => !check.passed);
  const weightedF1Drop = Math.max(0, regression.baseline.weightedF1 - regression.current.weightedF1);
  const eceIncrease = Math.max(0, regression.current.ece - regression.baseline.ece);
  const corrDrop = Math.max(
    0,
    regression.baseline.confidenceCorrelation - regression.current.confidenceCorrelation,
  );
  const latencyDrift = Math.max(
    0,
    (regression.current.meanLatencyMs / regression.baseline.meanLatencyMs) - 1,
  );
  const driftScore = Math.max(weightedF1Drop, eceIncrease, corrDrop, latencyDrift);

  return {
    provider,
    triggered: failedChecks.length > 0,
    severity: failedChecks.some((check) => check.metric === 'weightedF1') ? 'critical' : failedChecks.length > 0 ? 'warning' : 'ok',
    driftScore,
    failureModes: failedChecks.map((check) => check.metric),
    summary: failedChecks.length > 0
      ? `${provider} eval drift: ${regression.current.model} failed ${failedChecks.map((check) => check.metric).join(', ')}`
      : `${provider} eval drift: ${regression.current.model} within baseline thresholds`,
  };
}

export async function emitEvalDriftAlert(
  provider: string,
  regression: RegressionResult,
): Promise<EvalDriftAlert> {
  const alert = buildEvalDriftAlert(provider, regression);
  return traceAiProviderCall(
    {
      provider,
      operation: 'eval_drift_alert',
      model: regression.current.model,
      modelVersion: regression.current.recordedAt,
      success: !alert.triggered,
      driftScore: alert.driftScore,
      failureMode: alert.failureModes[0] ?? 'none',
      hallucinationRate: regression.current.ece,
    },
    async () => alert,
    () => ({
      driftScore: alert.driftScore,
      failureMode: alert.failureModes[0] ?? 'none',
      hallucinationRate: regression.current.ece,
    }),
  );
}
