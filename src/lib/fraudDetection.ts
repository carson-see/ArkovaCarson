import { z } from 'zod';
import { getFlag } from './switchboard';

export const FRAUD_DETECTION_FLAG = 'ENABLE_FRAUD_DETECTION' as const;
export const FRAUD_ANALYSIS_METHOD = 'client_side_worker_v2' as const;
export const FRAUD_DETECTION_WORKER_TIMEOUT_MS = 4_000;
export const FRAUD_DETECTION_SAMPLE_BYTES = 32_768;

export type FraudRiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type FraudRiskLevelWithFallback = FraudRiskLevel | 'unknown';
export type FraudSignalType =
  | 'future_date'
  | 'binary_or_corrupt_text_sample'
  | 'layout_spacing_anomaly'
  | 'issuer_hint_missing';
export type FraudSignalField = 'issuedDate' | 'issuerName';

export interface FraudSignal {
  signal_type: FraudSignalType;
  score: number;
  field_affected: FraudSignalField | null;
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

const FraudSignalSchema = z.object({
  signal_type: z.enum([
    'future_date',
    'binary_or_corrupt_text_sample',
    'layout_spacing_anomaly',
    'issuer_hint_missing',
  ]),
  score: z.number().min(0).max(1),
  field_affected: z.enum(['issuedDate', 'issuerName']).nullable(),
}).strict();

const FraudDetectionResultSchema = z.object({
  fraud_risk_level: z.enum(['low', 'medium', 'high', 'critical', 'unknown']),
  fraud_score: z.number().min(0).max(1),
  fraud_signals: z.array(FraudSignalSchema),
  analysis_method: z.literal(FRAUD_ANALYSIS_METHOD),
  processing_time_ms: z.number().min(0),
}).strict();

export function unknownFraudDetectionResult(): FraudDetectionResult {
  return {
    fraud_risk_level: 'unknown',
    fraud_score: 0,
    fraud_signals: [],
    analysis_method: FRAUD_ANALYSIS_METHOD,
    processing_time_ms: 0,
  };
}

/**
 * BUG-2026-07-17-009 / BUG-2026-07-17-010 (SCRUM-2910, P0): fraud-derived
 * metadata must never render on any display surface (owner document view,
 * records list, credential card, PUBLIC verification page). Historical anchors
 * carry `fraud_*` keys (fraud_score, fraud_risk_level, fraud_signals, ...) and
 * Gemini extraction emits a camelCase `fraudSignals` field — this predicate
 * matches all of them. Conservative by design: any key whose normalized form
 * starts with "fraud" is hidden everywhere.
 */
export function isFraudMetadataKey(key: string): boolean {
  return key.trim().toLowerCase().replace(/[\s-]+/g, '_').startsWith('fraud');
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
    const documentBytes = await file.slice(0, FRAUD_DETECTION_SAMPLE_BYTES).arrayBuffer();
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
      const parsed = FraudDetectionResultSchema.safeParse(event.data);
      finish(parsed.success ? parsed.data : unknownFraudDetectionResult());
    };

    worker.onerror = () => {
      finish(unknownFraudDetectionResult());
    };

    worker.postMessage(request, [request.documentBytes]);
  });
}
