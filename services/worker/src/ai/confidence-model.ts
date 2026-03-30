/**
 * Feature-Based Confidence Meta-Model v2 (AI Accuracy Sprint — Session 14)
 *
 * Upgraded from linear combination (r=0.426) to nonlinear model with:
 * - Sigmoid activation for bounded output
 * - Feature interaction terms (rawConfidence × fieldsNormalized, key fields × type)
 * - Grounding score integration
 * - Provider-specific calibration offsets
 * - Piecewise isotonic-style confidence mapping per credential type
 *
 * Target: r > 0.60 (up from 0.426)
 *
 * Features used:
 * 1. Raw model confidence (primary signal)
 * 2. Number of fields extracted (more = higher accuracy)
 * 3. Credential type (type-specific calibration curves)
 * 4. Text length / OCR noise indicators
 * 5. Key field presence (issuerName, issuedDate, fieldOfStudy, jurisdiction)
 * 6. Grounding score (fraction of fields grounded in source text)
 * 7. Provider identity (Gemini vs Nessie have different confidence distributions)
 * 8. Fraud signal count (more signals = lower true accuracy)
 *
 * No ML library needed — uses sigmoid + polynomial features.
 * Weights derived from golden dataset analysis (1,330 entries, 8 phases).
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
  /** Whether jurisdiction was extracted */
  hasJurisdiction: boolean;
  /** OCR noise score (0.0 = clean, 1.0 = very noisy) */
  ocrNoiseScore: number;
  /** Grounding score from grounding verification (0.0–1.0), -1 if not available */
  groundingScore: number;
  /** Provider name ('gemini' | 'nessie' | 'together' | 'mock') */
  provider: string;
  /** Number of fraud signals detected */
  fraudSignalCount: number;
}

/**
 * Type-specific calibration curves.
 * Each type has: baseline offset, confidence scaling factor, and field count bonus.
 * Tuned from golden dataset phase 1-8 analysis.
 */
const TYPE_CALIBRATION: Record<string, { offset: number; scale: number; fieldBonus: number }> = {
  DEGREE:       { offset: 0.04, scale: 1.05, fieldBonus: 0.03 },
  LICENSE:      { offset: 0.02, scale: 1.02, fieldBonus: 0.02 },
  CLE:          { offset: 0.03, scale: 1.03, fieldBonus: 0.02 },
  TRANSCRIPT:   { offset: 0.01, scale: 1.00, fieldBonus: 0.02 },
  CERTIFICATE:  { offset: -0.06, scale: 0.95, fieldBonus: 0.04 }, // broadest category, needs more field evidence
  PROFESSIONAL: { offset: -0.02, scale: 0.98, fieldBonus: 0.03 },
  BADGE:        { offset: -0.04, scale: 0.92, fieldBonus: 0.05 }, // often sparse
  ATTESTATION:  { offset: -0.03, scale: 0.95, fieldBonus: 0.04 },
  FINANCIAL:    { offset: -0.02, scale: 0.97, fieldBonus: 0.03 },
  LEGAL:        { offset: -0.03, scale: 0.96, fieldBonus: 0.02 },
  INSURANCE:    { offset: -0.02, scale: 0.97, fieldBonus: 0.03 },
  SEC_FILING:   { offset: 0.03, scale: 1.04, fieldBonus: 0.01 }, // structured, high quality
  PATENT:       { offset: 0.02, scale: 1.03, fieldBonus: 0.01 },
  REGULATION:   { offset: 0.01, scale: 1.01, fieldBonus: 0.01 },
  PUBLICATION:  { offset: 0.00, scale: 1.00, fieldBonus: 0.02 },
  OTHER:        { offset: -0.10, scale: 0.85, fieldBonus: 0.05 },
};

/**
 * Provider-specific confidence calibration offsets.
 * Gemini tends to be underconfident, Nessie tends to be slightly overconfident
 * on pipeline docs but underconfident on user uploads.
 */
const PROVIDER_OFFSETS: Record<string, number> = {
  gemini: 0.08,    // Gemini is ~20% underconfident, partially compensate
  nessie: 0.03,    // Nessie is slightly underconfident on its training distribution
  together: 0.05,  // Similar to Nessie
  mock: 0.00,
};

/**
 * Nonlinear model weights — sigmoid(w · x + b) formulation.
 * These produce a pre-sigmoid logit that maps to [0, 1] confidence.
 */
const WEIGHTS = {
  intercept: -0.20,
  rawConfidence: 2.80,        // primary signal — amplified through sigmoid
  fieldsNormalized: 0.60,     // more fields = better
  keyFieldsScore: 0.45,       // composite key field score
  ocrNoisePenalty: -0.80,     // strong penalty for noisy text
  textLengthFactor: 0.30,     // short text = lower confidence
  groundingBonus: 0.50,       // grounded fields boost confidence
  fraudPenalty: -0.35,        // each fraud signal reduces confidence
  // Interaction terms — capture nonlinear feature relationships
  confidence_x_fields: 0.40,  // high confidence + many fields = synergy
  confidence_x_grounding: 0.30, // high confidence + well-grounded = strong
  fields_x_keyfields: 0.20,   // many fields including key ones = very good
};

/** Sigmoid activation — maps logit to (0, 1) range. */
function sigmoid(x: number): number {
  // Clamp to prevent overflow
  const clamped = Math.max(-10, Math.min(10, x));
  return 1 / (1 + Math.exp(-clamped));
}

/**
 * Estimate OCR noise score from input text.
 *
 * Heuristics:
 * - Digit-letter substitutions (0→O, 1→l, etc.)
 * - Unusual slash/pipe patterns
 * - Very short text
 * - Excessive special characters
 * - Broken word patterns (missing spaces, garbled tokens)
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

  // Excessive special characters (garbled OCR)
  const specialChars = (text.match(/[^\w\s.,;:'"()\-/]/g) || []).length;
  if (letters > 0) {
    const specialRatio = specialChars / letters;
    if (specialRatio > 0.15) noiseIndicators += 0.25;
  }

  // Broken word patterns: words > 20 chars with no vowels suggest garbled tokens
  const longGarbled = (text.match(/\b[bcdfghjklmnpqrstvwxyz]{8,}\b/gi) || []).length;
  noiseIndicators += Math.min(longGarbled / 3, 0.3);

  // Very short text suggests truncation
  if (len < 50) noiseIndicators += 0.2;

  return Math.min(noiseIndicators, 1.0);
}

/**
 * Extract confidence features from extraction result and input text.
 * Accepts optional grounding score, provider name, and fraud signal count.
 */
export function extractConfidenceFeatures(
  fields: ExtractedFields,
  rawConfidence: number,
  inputText: string,
  options?: {
    groundingScore?: number;
    provider?: string;
    fraudSignalCount?: number;
  },
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

  const fraudSignals = fields.fraudSignals ?? [];

  return {
    rawConfidence,
    fieldsExtracted,
    credentialType: fields.credentialType ?? 'OTHER',
    textLength: inputText.length,
    hasIssuerName: !!fields.issuerName,
    hasIssuedDate: !!fields.issuedDate,
    hasFieldOfStudy: !!fields.fieldOfStudy,
    hasJurisdiction: !!fields.jurisdiction,
    ocrNoiseScore: estimateOcrNoise(inputText),
    groundingScore: options?.groundingScore ?? -1,
    provider: options?.provider ?? 'gemini',
    fraudSignalCount: options?.fraudSignalCount ?? fraudSignals.length,
  };
}

/**
 * Predict adjusted confidence using the nonlinear meta-model v2.
 *
 * Architecture: sigmoid(weighted features + interaction terms + type calibration + provider offset)
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
    hasJurisdiction,
    ocrNoiseScore,
    groundingScore,
    provider,
    fraudSignalCount,
  } = features;

  // Normalize features to [0, 1] range
  const fieldsNorm = Math.min(fieldsExtracted / 10, 1.0);
  const textLenNorm = Math.min(textLength / 500, 1.0);

  // Key fields composite score (0.0 to 1.0)
  let keyFieldScore = 0;
  if (hasIssuerName) keyFieldScore += 0.30;
  if (hasIssuedDate) keyFieldScore += 0.30;
  if (hasFieldOfStudy) keyFieldScore += 0.20;
  if (hasJurisdiction) keyFieldScore += 0.20;

  // Grounding score (use 0.5 neutral if not available)
  const groundingNorm = groundingScore >= 0 ? groundingScore : 0.5;

  // Fraud penalty (0 = clean, scaled up with more signals)
  const fraudNorm = Math.min(fraudSignalCount / 4, 1.0);

  // === Build logit (pre-sigmoid score) ===
  let logit = WEIGHTS.intercept;

  // Main features
  logit += WEIGHTS.rawConfidence * rawConfidence;
  logit += WEIGHTS.fieldsNormalized * fieldsNorm;
  logit += WEIGHTS.keyFieldsScore * keyFieldScore;
  logit += WEIGHTS.ocrNoisePenalty * ocrNoiseScore;
  logit += WEIGHTS.textLengthFactor * textLenNorm;
  logit += WEIGHTS.groundingBonus * groundingNorm;
  logit += WEIGHTS.fraudPenalty * fraudNorm;

  // Interaction terms (capture nonlinear relationships)
  logit += WEIGHTS.confidence_x_fields * rawConfidence * fieldsNorm;
  logit += WEIGHTS.confidence_x_grounding * rawConfidence * groundingNorm;
  logit += WEIGHTS.fields_x_keyfields * fieldsNorm * keyFieldScore;

  // Apply sigmoid for bounded output
  let score = sigmoid(logit);

  // === Post-sigmoid calibration ===

  // Type-specific calibration curve
  const typeCal = TYPE_CALIBRATION[credentialType] ?? TYPE_CALIBRATION.OTHER;
  score = score * typeCal.scale + typeCal.offset;
  // Bonus for more fields (type-specific — BADGE/CERTIFICATE need more evidence)
  score += typeCal.fieldBonus * fieldsNorm;

  // Provider-specific offset
  const providerOffset = PROVIDER_OFFSETS[provider] ?? 0;
  score += providerOffset;

  // Clamp to [0.05, 0.99] — never return absolute 0 or 1
  return Math.max(0.05, Math.min(0.99, score));
}

/**
 * Convenience: compute adjusted confidence from extraction result + input text.
 *
 * Combines feature extraction + prediction in one call.
 * Accepts optional context for richer calibration.
 */
export function computeAdjustedConfidence(
  fields: ExtractedFields,
  rawConfidence: number,
  inputText: string,
  options?: {
    groundingScore?: number;
    provider?: string;
    fraudSignalCount?: number;
  },
): number {
  const features = extractConfidenceFeatures(fields, rawConfidence, inputText, options);
  return predictConfidence(features);
}
