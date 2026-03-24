/**
 * Feature-Based Confidence Meta-Model (AI Accuracy Sprint — Session 13)
 *
 * A lightweight model that uses extraction features to predict actual accuracy,
 * producing an adjustedConfidence with better Pearson r than raw model confidence.
 *
 * Features used:
 * 1. Number of fields extracted (more fields = higher accuracy)
 * 2. Raw model confidence (base signal)
 * 3. Credential type (CERTIFICATE/OTHER have lower baseline accuracy)
 * 4. Text length / OCR noise indicators
 * 5. Whether key fields (issuerName, issuedDate) were extracted
 *
 * The meta-model is a simple weighted linear combination — no ML library needed.
 * Weights are derived from eval dataset analysis.
 */

import type { ExtractedFields } from './types.js';

/** Features extracted from an AI extraction result for confidence prediction. */
export interface ConfidenceFeatures {
  /** Raw model-reported confidence (0.0–1.0) */
  rawConfidence: number;
  /** Number of non-null fields extracted (excluding fraudSignals) */
  fieldsExtracted: number;
  /** Credential type reported by model */
  credentialType: string;
  /** Length of input text in characters */
  textLength: number;
  /** Whether issuerName was extracted */
  hasIssuerName: boolean;
  /** Whether issuedDate was extracted */
  hasIssuedDate: boolean;
  /** Whether fieldOfStudy was extracted */
  hasFieldOfStudy: boolean;
  /** OCR noise score (0.0 = clean, 1.0 = very noisy) */
  ocrNoiseScore: number;
}

/**
 * Type-specific baseline accuracy offsets.
 * CERTIFICATE and OTHER historically have lower accuracy.
 */
const TYPE_OFFSETS: Record<string, number> = {
  DEGREE: 0.02,
  LICENSE: 0.01,
  CLE: 0.02,
  TRANSCRIPT: 0.01,
  CERTIFICATE: -0.04,
  PROFESSIONAL: -0.01,
  BADGE: -0.02,
  ATTESTATION: -0.02,
  FINANCIAL: -0.01,
  LEGAL: -0.02,
  INSURANCE: -0.01,
  SEC_FILING: 0.01,
  PATENT: 0.01,
  REGULATION: 0.0,
  PUBLICATION: 0.0,
  OTHER: -0.08, // heavily penalize — should rarely be used now
};

/**
 * Meta-model weights for the linear combination.
 * These are tuned based on eval dataset correlation analysis.
 */
const WEIGHTS = {
  /** Base intercept */
  intercept: 0.50,
  /** Raw confidence weight (primary signal) */
  rawConfidence: 0.30,
  /** Fields extracted (normalized: fields / 8 typical max) */
  fieldsNormalized: 0.10,
  /** Key fields bonus (0.0 to 0.15 depending on which key fields present) */
  keyFieldsBonus: 0.05,
  /** OCR noise penalty (0.0 = clean, up to -0.10 for noisy) */
  ocrNoisePenalty: -0.10,
  /** Text length factor (very short text = lower confidence) */
  textLengthFactor: 0.05,
};

/**
 * Estimate OCR noise score from input text.
 *
 * Heuristics:
 * - Digit-letter substitutions (0→O, 1→l, etc.)
 * - Unusual slash/pipe patterns
 * - Very short text
 */
export function estimateOcrNoise(text: string): number {
  if (!text || text.trim().length === 0) return 1.0;

  const len = text.length;
  if (len < 10) return 0.8;

  let noiseIndicators = 0;

  // Count digit-letter substitutions (common OCR errors)
  const substitutionPatterns = /[0O][1Il][0O]|[1Il][0O][1Il]|rn(?=\w)|[0O](?=[a-z]{2})|(?<=[a-z]{2})[0O]/g;
  const substitutions = (text.match(substitutionPatterns) || []).length;
  noiseIndicators += Math.min(substitutions / (len / 100), 1.0) * 0.3;

  // Count unusual character ratios
  const digits = (text.match(/\d/g) || []).length;
  const letters = (text.match(/[a-zA-Z]/g) || []).length;
  if (letters > 0) {
    const digitRatio = digits / letters;
    if (digitRatio > 0.3) noiseIndicators += 0.2;
  }

  // Mixed case within words (like "CompT1A" or "Cert1fied")
  const mixedCaseWords = (text.match(/\b\w*[a-z]\d[a-z]\w*\b/gi) || []).length;
  noiseIndicators += Math.min(mixedCaseWords / 5, 0.3);

  // Very short text suggests truncation
  if (len < 50) noiseIndicators += 0.2;

  return Math.min(noiseIndicators, 1.0);
}

/**
 * Extract confidence features from extraction result and input text.
 */
export function extractConfidenceFeatures(
  fields: ExtractedFields,
  rawConfidence: number,
  inputText: string,
): ConfidenceFeatures {
  // Count non-null fields (excluding fraudSignals and credentialType which is always present)
  const fieldKeys = [
    'issuerName', 'issuedDate', 'expiryDate', 'fieldOfStudy',
    'degreeLevel', 'licenseNumber', 'accreditingBody', 'jurisdiction',
    'creditHours', 'creditType', 'activityNumber', 'providerName', 'approvedBy',
  ];

  const fieldsExtracted = fieldKeys.filter(k => {
    const val = fields[k];
    return val !== undefined && val !== null && val !== '';
  }).length;

  return {
    rawConfidence,
    fieldsExtracted,
    credentialType: fields.credentialType ?? 'OTHER',
    textLength: inputText.length,
    hasIssuerName: !!fields.issuerName,
    hasIssuedDate: !!fields.issuedDate,
    hasFieldOfStudy: !!fields.fieldOfStudy,
    ocrNoiseScore: estimateOcrNoise(inputText),
  };
}

/**
 * Predict adjusted confidence using the meta-model.
 *
 * @param features - Extracted confidence features
 * @returns adjustedConfidence (0.0–1.0) with better correlation to actual accuracy
 */
export function predictConfidence(features: ConfidenceFeatures): number {
  const {
    rawConfidence,
    fieldsExtracted,
    credentialType,
    textLength,
    hasIssuerName,
    hasIssuedDate,
    hasFieldOfStudy,
    ocrNoiseScore,
  } = features;

  // Start with base intercept
  let score = WEIGHTS.intercept;

  // Primary signal: raw model confidence
  score += WEIGHTS.rawConfidence * rawConfidence;

  // Fields extracted (normalized to ~0-1 range, typical max ~8 fields)
  const fieldsNorm = Math.min(fieldsExtracted / 8, 1.0);
  score += WEIGHTS.fieldsNormalized * fieldsNorm;

  // Key fields bonus
  let keyFieldScore = 0;
  if (hasIssuerName) keyFieldScore += 0.4;
  if (hasIssuedDate) keyFieldScore += 0.35;
  if (hasFieldOfStudy) keyFieldScore += 0.25;
  score += WEIGHTS.keyFieldsBonus * keyFieldScore;

  // OCR noise penalty
  score += WEIGHTS.ocrNoisePenalty * ocrNoiseScore;

  // Text length factor (very short text = lower confidence)
  const textLenNorm = Math.min(textLength / 500, 1.0);
  score += WEIGHTS.textLengthFactor * textLenNorm;

  // Type-specific offset
  const typeOffset = TYPE_OFFSETS[credentialType] ?? -0.02;
  score += typeOffset;

  // Clamp to [0.0, 1.0]
  return Math.max(0.0, Math.min(1.0, score));
}

/**
 * Convenience: compute adjusted confidence from extraction result + input text.
 *
 * Combines feature extraction + prediction in one call.
 */
export function computeAdjustedConfidence(
  fields: ExtractedFields,
  rawConfidence: number,
  inputText: string,
): number {
  const features = extractConfidenceFeatures(fields, rawConfidence, inputText);
  return predictConfidence(features);
}
