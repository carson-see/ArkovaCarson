import { getFlag } from './switchboard';

export const FRAUD_DETECTION_FLAG = 'ENABLE_FRAUD_DETECTION' as const;
export const FRAUD_ANALYSIS_METHOD = 'client_side_worker_v2' as const;
export const FRAUD_DETECTION_WORKER_TIMEOUT_MS = 4_000;

export type FraudRiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type FraudRiskLevelWithFallback = FraudRiskLevel | 'unknown';

export interface FraudSignal {
  signal_type: string;
  score: number;
  reason: string;
  field_affected: string | null;
}

export interface FraudDetectionResult {
  fraud_risk_level: FraudRiskLevelWithFallback;
  fraud_score: number;
  fraud_signals: FraudSignal[];
  analysis_method: typeof FRAUD_ANALYSIS_METHOD;
  processing_time_ms: number;
}

export interface FraudDetectionOptions {
  credentialType: string;
  metadataHints?: Record<string, string>;
}

interface FraudWorkerRequest extends FraudDetectionOptions {
  documentBytes: ArrayBuffer;
}

export function unknownFraudDetectionResult(): FraudDetectionResult {
  return {
    fraud_risk_level: 'unknown',
    fraud_score: 0,
    fraud_signals: [],
    analysis_method: FRAUD_ANALYSIS_METHOD,
    processing_time_ms: 0,
  };
}

export function fraudResultToMetadata(
  result: FraudDetectionResult | null,
): Record<string, unknown> {
  if (!result) return {};

  return {
    fraud_risk_level: result.fraud_risk_level,
    fraud_score: result.fraud_score,
    fraud_signals: result.fraud_signals,
    fraud_analysis_method: result.analysis_method,
    fraud_processing_time_ms: result.processing_time_ms,
  };
}

export async function detectFraudForDocument(
  file: File,
  options: FraudDetectionOptions,
): Promise<FraudDetectionResult | null> {
  const enabled = await getFlag(FRAUD_DETECTION_FLAG);
  if (!enabled) return null;

  if (typeof Worker === 'undefined') {
    return unknownFraudDetectionResult();
  }

  try {
    const documentBytes = await file.arrayBuffer();
    return await runFraudWorker({
      documentBytes,
      credentialType: options.credentialType,
      metadataHints: options.metadataHints ?? {},
    });
  } catch {
    return unknownFraudDetectionResult();
  }
}

function runFraudWorker(request: FraudWorkerRequest): Promise<FraudDetectionResult> {
  const worker = new Worker(new URL('../workers/fraud-detection.worker.ts', import.meta.url), {
    type: 'module',
  });

  return new Promise((resolve) => {
    let settled = false;

    const finish = (result: FraudDetectionResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      worker.terminate();
      resolve(result);
    };

    const timeoutId = setTimeout(() => {
      finish(unknownFraudDetectionResult());
    }, FRAUD_DETECTION_WORKER_TIMEOUT_MS);

    worker.onmessage = (event: MessageEvent<FraudDetectionResult>) => {
      finish(event.data);
    };

    worker.onerror = () => {
      finish(unknownFraudDetectionResult());
    };

    worker.postMessage(request, [request.documentBytes]);
  });
}
