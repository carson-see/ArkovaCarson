import type { FraudDetectionResult, FraudSignal } from '../lib/fraudDetection';

const FRAUD_ANALYSIS_METHOD = 'client_side_worker_v2';

interface FraudWorkerRequest {
  documentBytes: ArrayBuffer;
  credentialType: string;
  metadataHints?: Record<string, string>;
}

const MAX_TEXT_SAMPLE_BYTES = 32_768;
const FUTURE_YEAR_BUFFER = 1;

export function analyzeDocumentBytes(
  documentBytes: ArrayBuffer,
  options: Omit<FraudWorkerRequest, 'documentBytes'>,
): FraudDetectionResult {
  const start = Date.now();
  const textSample = decodeTextSample(documentBytes);
  const signals = [
    ...detectDateSignals(textSample),
    ...detectLayoutSignals(textSample),
    ...detectMetadataHintSignals(textSample, options.metadataHints ?? {}),
  ];
  const fraudScore = normalizeScore(signals.reduce((sum, signal) => sum + signal.score, 0));

  return {
    fraud_risk_level: riskLevelForScore(fraudScore),
    fraud_score: fraudScore,
    fraud_signals: signals,
    analysis_method: FRAUD_ANALYSIS_METHOD,
    processing_time_ms: Date.now() - start,
  };
}

function decodeTextSample(documentBytes: ArrayBuffer): string {
  const sample = documentBytes.slice(0, MAX_TEXT_SAMPLE_BYTES);
  return new TextDecoder('utf-8', { fatal: false }).decode(sample);
}

function detectDateSignals(text: string): FraudSignal[] {
  const currentYear = new Date().getUTCFullYear();
  const years = [...text.matchAll(/\b(19\d{2}|20\d{2}|21\d{2})\b/g)]
    .map(match => Number(match[1]));

  return years
    .filter(year => year > currentYear + FUTURE_YEAR_BUFFER)
    .slice(0, 3)
    .map(year => ({
      signal_type: 'future_date',
      score: 0.35,
      reason: `Document contains future year ${year}.`,
      field_affected: 'issuedDate',
    }));
}

function detectLayoutSignals(text: string): FraudSignal[] {
  const signals: FraudSignal[] = [];
  const replacementCharacters = (text.match(/\uFFFD/g) ?? []).length;
  if (replacementCharacters > 12) {
    signals.push({
      signal_type: 'binary_or_corrupt_text_sample',
      score: 0.15,
      reason: 'Document sample contains repeated undecodable regions.',
      field_affected: null,
    });
  }

  const whitespaceRuns = (text.match(/[ \t]{12,}/g) ?? []).length;
  if (whitespaceRuns > 5) {
    signals.push({
      signal_type: 'layout_spacing_anomaly',
      score: 0.2,
      reason: 'Document has repeated long spacing runs that may indicate manual layout edits.',
      field_affected: null,
    });
  }

  return signals;
}

function detectMetadataHintSignals(
  text: string,
  metadataHints: Record<string, string>,
): FraudSignal[] {
  const issuerName = metadataHints.issuerName?.trim();
  if (!issuerName || text.toLowerCase().includes(issuerName.toLowerCase())) {
    return [];
  }

  return [{
    signal_type: 'issuer_hint_missing',
    score: 0.1,
    reason: 'Issuer hint was not found in the document sample.',
    field_affected: 'issuerName',
  }];
}

function normalizeScore(score: number): number {
  return Math.max(0, Math.min(1, Number(score.toFixed(2))));
}

function riskLevelForScore(score: number): FraudDetectionResult['fraud_risk_level'] {
  if (score >= 0.75) return 'critical';
  if (score >= 0.5) return 'high';
  if (score >= 0.2) return 'medium';
  return 'low';
}

function fallbackFraudResult(): FraudDetectionResult {
  return {
    fraud_risk_level: 'unknown',
    fraud_score: 0,
    fraud_signals: [],
    analysis_method: FRAUD_ANALYSIS_METHOD,
    processing_time_ms: 0,
  };
}

function toArrayBuffer(value: unknown): ArrayBuffer | null {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    const view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    const copy = new Uint8Array(view.byteLength);
    copy.set(view);
    return copy.buffer;
  }
  return null;
}

function parseWorkerRequest(value: unknown): FraudWorkerRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const documentBytes = toArrayBuffer(record.documentBytes);
  if (!documentBytes || typeof record.credentialType !== 'string') return null;

  const metadataHints = record.metadataHints;
  if (metadataHints !== undefined) {
    if (typeof metadataHints !== 'object' || metadataHints === null || Array.isArray(metadataHints)) {
      return null;
    }
    const entries = Object.entries(metadataHints);
    if (!entries.every(([key, val]) => typeof key === 'string' && typeof val === 'string')) {
      return null;
    }
  }

  return {
    documentBytes,
    credentialType: record.credentialType,
    metadataHints: metadataHints as Record<string, string> | undefined,
  };
}

export function handleFraudWorkerMessage(value: unknown): FraudDetectionResult {
  try {
    const request = parseWorkerRequest(value);
    if (!request) return fallbackFraudResult();

    const { documentBytes, ...options } = request;
    return analyzeDocumentBytes(documentBytes, options);
  } catch {
    return fallbackFraudResult();
  }
}

if (typeof self !== 'undefined' && 'postMessage' in self) {
  self.onmessage = (event: MessageEvent<unknown>) => {
    self.postMessage(handleFraudWorkerMessage(event.data));
  };
}
