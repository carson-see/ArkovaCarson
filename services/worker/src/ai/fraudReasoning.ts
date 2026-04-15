/**
 * GRE-03: Fraud Reasoning Engine
 *
 * Multi-factor fraud analysis that combines extraction results,
 * cross-reference verification, and content analysis to produce
 * an explainable fraud assessment with scoring.
 *
 * This is a post-extraction step — it takes the output of AI extraction
 * and cross-reference checks, then applies rule-based reasoning to
 * produce a structured fraud assessment.
 *
 * Constitution 1.6: Only operates on PII-stripped metadata and text.
 * Never receives raw document bytes.
 */

import type { ExtractedFields } from './types.js';
import type { CrossReferenceResult } from './crossReference.js';
import { KNOWN_DIPLOMA_MILLS, SUSPICIOUS_ISSUER_PATTERNS } from './crossFieldFraudChecks.js';

// =============================================================================
// TYPES
// =============================================================================

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface FraudAssessment {
  /** Overall risk level */
  riskLevel: RiskLevel;
  /** Specific fraud signal codes detected */
  signals: string[];
  /** Human-readable explanation (1-3 sentences) */
  reasoning: string;
  /** Specific concerns about this credential */
  concerns: string[];
  /** Fraud score: 0.0 = definitely legitimate, 1.0 = definitely fraud */
  score: number;
}

export interface FraudAssessmentInput {
  /** Extracted fields from the credential */
  extractedFields: ExtractedFields;
  /** Cross-reference verification result (issuer lookup against pipeline DBs) */
  crossReferenceResult: CrossReferenceResult;
  /** PII-stripped raw text of the credential */
  rawText: string;
}

// =============================================================================
// KNOWN FAKE ACCREDITING BODIES
// =============================================================================

const FAKE_ACCREDITORS: string[] = [
  'world association of universities and colleges',
  'universal accreditation council',
  'international accreditation association',
  'world online accreditation',
  'global accreditation body',
  'international commission on higher education',
];

// =============================================================================
// CONTENT RED-FLAG PATTERNS
// =============================================================================

/** Phrases that indicate a credential is likely fraudulent or from a diploma mill. */
const IMPLAUSIBILITY_PATTERNS: RegExp[] = [
  /no\s+coursework\s+required/i,
  /life\s+experience\s+(degree|credit|based)/i,
  /deliver(ed|y)\s+within\s+\d+\s+days/i,
  /processing\s+fee\s*:\s*\$/i,
  /just\s+pay\s+the\s+fee/i,
  /no\s+classes/i,
  /no\s+exams/i,
  /instant\s+degree/i,
  /buy\s+(a\s+)?degree/i,
  /degree\s+in\s+\d+\s+days/i,
  /accredited\s+by\s+.*universal/i,
];

// =============================================================================
// FACTOR ANALYSIS FUNCTIONS
// =============================================================================

interface FactorResult {
  score: number;          // 0.0–1.0 contribution
  signals: string[];
  concerns: string[];
}

/**
 * Check issuer against known diploma mill list and suspicious patterns.
 */
function checkIssuerLegitimacy(
  fields: ExtractedFields,
  crossRef: CrossReferenceResult,
): FactorResult {
  const result: FactorResult = { score: 0, signals: [], concerns: [] };
  const issuer = fields.issuerName?.toLowerCase().trim() ?? '';

  if (!issuer) {
    // No issuer is suspicious for degrees/diplomas
    if (fields.credentialType?.toUpperCase() === 'DEGREE') {
      result.score = 0.3;
      result.concerns.push('Degree credential has no issuer name');
    }
    return result;
  }

  // Check against known diploma mills
  if (KNOWN_DIPLOMA_MILLS.some(mill => issuer.includes(mill))) {
    result.score = 0.9;
    result.signals.push('DIPLOMA_MILL');
    result.concerns.push(`Issuer "${fields.issuerName}" is a known diploma mill`);
    return result;
  }

  // Check suspicious issuer name patterns
  if (SUSPICIOUS_ISSUER_PATTERNS.some(pattern => pattern.test(issuer))) {
    result.score = 0.6;
    result.signals.push('SUSPICIOUS_ISSUER');
    result.concerns.push(`Issuer name "${fields.issuerName}" matches suspicious patterns`);
    return result;
  }

  // Cross-reference: issuer found in pipeline reduces risk
  if (crossRef.issuerFound) {
    const bestConfidence = crossRef.matches[0]?.confidence;
    if (bestConfidence === 'exact') {
      result.score = 0; // Verified — no risk from issuer
    } else {
      result.score = 0.05; // Partial match — tiny risk
    }
  } else {
    // Not found — mild risk, but NOT fraud by itself
    result.score = 0.15;
    result.concerns.push(
      `Issuer "${fields.issuerName}" was not found in Arkova's verified databases`,
    );
  }

  return result;
}

/**
 * Check date consistency.
 */
function checkDateConsistency(fields: ExtractedFields): FactorResult {
  const result: FactorResult = { score: 0, signals: [], concerns: [] };

  const issuedDate = fields.issuedDate ? new Date(fields.issuedDate) : null;
  const expiryDate = fields.expiryDate ? new Date(fields.expiryDate) : null;
  const now = new Date();

  // issuedDate after expiryDate
  if (issuedDate && expiryDate && !isNaN(issuedDate.getTime()) && !isNaN(expiryDate.getTime())) {
    if (issuedDate > expiryDate) {
      result.score = 0.6;
      result.signals.push('SUSPICIOUS_DATES');
      result.concerns.push(
        `Issue date (${fields.issuedDate}) is after expiry date (${fields.expiryDate})`,
      );
      return result;
    }
  }

  // Far-future issued date (> 3 years from now)
  if (issuedDate && !isNaN(issuedDate.getTime())) {
    const threeYearsFromNow = new Date(now);
    threeYearsFromNow.setFullYear(threeYearsFromNow.getFullYear() + 3);
    if (issuedDate > threeYearsFromNow) {
      result.score = 0.5;
      result.signals.push('SUSPICIOUS_DATES');
      result.concerns.push(`Issue date ${fields.issuedDate} is more than 3 years in the future`);
      return result;
    }
  }

  // Expired credential is NOT fraud — it's normal lifecycle
  // No penalty for expired credentials

  return result;
}

/**
 * Check for format anomalies and missing required fields.
 */
function checkFormatAnomalies(fields: ExtractedFields): FactorResult {
  const result: FactorResult = { score: 0, signals: [], concerns: [] };
  const type = fields.credentialType?.toUpperCase();

  // Carry forward extraction-detected FORMAT_ANOMALY
  if (fields.fraudSignals?.includes('FORMAT_ANOMALY')) {
    result.score = 0.25;
    result.signals.push('FORMAT_ANOMALY');
    result.concerns.push('Extraction detected format anomalies in the document');
  }

  // Carry forward MISSING_ACCREDITATION
  if (fields.fraudSignals?.includes('MISSING_ACCREDITATION')) {
    result.score = Math.max(result.score, 0.3);
    if (!result.signals.includes('FORMAT_ANOMALY')) {
      result.signals.push('FORMAT_ANOMALY');
    }
    result.concerns.push('Missing accreditation information');
  }

  // Degree with no issuer AND no accrediting body — very suspicious
  if (type === 'DEGREE' && !fields.issuerName && !fields.accreditingBody) {
    result.score = Math.max(result.score, 0.4);
    if (!result.signals.includes('FORMAT_ANOMALY')) {
      result.signals.push('FORMAT_ANOMALY');
    }
    result.concerns.push('Degree credential has neither issuer nor accrediting body');
  }

  return result;
}

/**
 * Check content plausibility from the raw text.
 */
function checkContentPlausibility(
  fields: ExtractedFields,
  rawText: string,
): FactorResult {
  const result: FactorResult = { score: 0, signals: [], concerns: [] };

  if (!rawText) return result;

  const textLower = rawText.toLowerCase();

  // Check for implausibility patterns
  const matchedPatterns: string[] = [];
  for (const pattern of IMPLAUSIBILITY_PATTERNS) {
    if (pattern.test(textLower)) {
      matchedPatterns.push(pattern.source);
    }
  }

  if (matchedPatterns.length > 0) {
    // More matched patterns = higher score
    result.score = Math.min(0.7, 0.3 + matchedPatterns.length * 0.15);
    result.signals.push('CONTENT_IMPLAUSIBILITY');
    result.concerns.push(
      `Document contains ${matchedPatterns.length} suspicious phrase(s) suggesting fraudulent credential`,
    );
  }

  // Doctorate from non-degree-granting institution
  const degreeLevel = fields.degreeLevel?.toLowerCase() ?? '';
  const issuer = fields.issuerName?.toLowerCase() ?? '';
  if (
    (degreeLevel.includes('doctor') || degreeLevel.includes('phd')) &&
    (issuer.includes('bootcamp') || issuer.includes('training center') || issuer.includes('academy'))
  ) {
    result.score = Math.max(result.score, 0.5);
    if (!result.signals.includes('CONTENT_IMPLAUSIBILITY')) {
      result.signals.push('CONTENT_IMPLAUSIBILITY');
    }
    result.concerns.push(
      `Doctorate claimed from non-degree-granting institution type: "${fields.issuerName}"`,
    );
  }

  return result;
}

/**
 * Check for fake accrediting bodies.
 */
function checkAccreditingBody(fields: ExtractedFields): FactorResult {
  const result: FactorResult = { score: 0, signals: [], concerns: [] };
  const body = fields.accreditingBody?.toLowerCase() ?? '';

  if (!body) return result;

  if (FAKE_ACCREDITORS.some(fake => body.includes(fake))) {
    result.score = 0.6;
    result.signals.push('FAKE_ACCREDITOR');
    result.concerns.push(`"${fields.accreditingBody}" is a known fake accrediting body`);
  }

  return result;
}

/**
 * Check jurisdiction consistency.
 */
function checkJurisdiction(fields: ExtractedFields): FactorResult {
  const result: FactorResult = { score: 0, signals: [], concerns: [] };

  if (fields.fraudSignals?.includes('JURISDICTION_MISMATCH')) {
    result.score = 0.35;
    result.signals.push('JURISDICTION_MISMATCH');
    result.concerns.push('Jurisdiction does not match the issuing authority');
  }

  return result;
}

// =============================================================================
// SCORE TO RISK LEVEL MAPPING
// =============================================================================

function scoreToRiskLevel(score: number): RiskLevel {
  if (score >= 0.8) return 'CRITICAL';
  if (score >= 0.5) return 'HIGH';
  if (score >= 0.25) return 'MEDIUM';
  return 'LOW';
}

// =============================================================================
// REASONING GENERATOR
// =============================================================================

function generateReasoning(
  riskLevel: RiskLevel,
  concerns: string[],
  fields: ExtractedFields,
  crossRef: CrossReferenceResult,
): string {
  const issuer = fields.issuerName ?? 'unknown issuer';

  if (riskLevel === 'CRITICAL') {
    return `This credential from "${issuer}" shows critical fraud indicators: ${concerns.slice(0, 2).join('; ')}. This document is almost certainly fraudulent or from a diploma mill.`;
  }

  if (riskLevel === 'HIGH') {
    return `This credential from "${issuer}" has significant concerns: ${concerns.slice(0, 2).join('; ')}. Manual verification is strongly recommended.`;
  }

  if (riskLevel === 'MEDIUM') {
    const verifiedNote = crossRef.issuerFound
      ? 'The issuer was found in verified databases, which is positive.'
      : 'The issuer was not found in verified databases.';
    return `This credential from "${issuer}" has some concerns: ${concerns.slice(0, 2).join('; ')}. ${verifiedNote}`;
  }

  // LOW
  if (crossRef.issuerFound) {
    return `This credential from "${issuer}" appears legitimate. The issuer was verified in Arkova's pipeline databases with no fraud indicators detected.`;
  }
  return `This credential from "${issuer}" shows no fraud indicators. The issuer was not found in Arkova's databases, but no suspicious patterns were detected.`;
}

// =============================================================================
// MAIN EXPORT
// =============================================================================

/**
 * Perform a multi-factor fraud assessment on a credential.
 *
 * Combines:
 * 1. Issuer legitimacy (diploma mill list + pipeline verification)
 * 2. Date consistency (future dates, impossible timelines)
 * 3. Format anomaly detection (missing required fields, structural issues)
 * 4. Content plausibility (suspicious phrases, implausible claims)
 * 5. Cross-reference verification (issuer found/not found in pipeline)
 * 6. Accrediting body verification
 * 7. Jurisdiction consistency
 *
 * @param input - Extraction results, cross-reference data, and raw text
 * @returns FraudAssessment with risk level, signals, reasoning, and score
 */
export function assessFraud(input: FraudAssessmentInput): FraudAssessment {
  const { extractedFields, crossReferenceResult, rawText } = input;

  // Run all factor checks
  const factors: FactorResult[] = [
    checkIssuerLegitimacy(extractedFields, crossReferenceResult),
    checkDateConsistency(extractedFields),
    checkFormatAnomalies(extractedFields),
    checkContentPlausibility(extractedFields, rawText),
    checkAccreditingBody(extractedFields),
    checkJurisdiction(extractedFields),
  ];

  // Carry forward any pre-existing extraction fraud signals
  const extractionSignals = extractedFields.fraudSignals ?? [];

  // Merge signals and concerns from all factors
  const allSignals = new Set<string>();
  const allConcerns: string[] = [];

  for (const factor of factors) {
    for (const signal of factor.signals) {
      allSignals.add(signal);
    }
    allConcerns.push(...factor.concerns);
  }

  // Carry forward extraction signals not already covered
  for (const sig of extractionSignals) {
    allSignals.add(sig);
  }

  // Compute composite score
  // Use max-of-factors as base, with small additive bonus for multiple factors
  const factorScores = factors.map(f => f.score);
  const maxScore = Math.max(...factorScores, 0);
  const nonZeroFactors = factorScores.filter(s => s > 0.1).length;

  // Multiple independent risk factors compound the risk
  const compoundBonus = Math.min(0.15, nonZeroFactors * 0.05);
  const rawScore = Math.min(1.0, maxScore + compoundBonus);

  // Cross-reference verification can reduce score slightly —
  // but only if the risk is purely from unknown issuer, not from active fraud signals
  let finalScore = rawScore;
  const hasActiveFraudSignals = allSignals.size > 0 && !([...allSignals].every(s => s === 'EXPIRED_ISSUER'));
  if (crossReferenceResult.issuerFound && rawScore < 0.8 && !hasActiveFraudSignals) {
    finalScore = Math.max(0, rawScore - 0.1);
  }

  // Clamp
  finalScore = Math.max(0, Math.min(1.0, finalScore));

  const riskLevel = scoreToRiskLevel(finalScore);
  const signals = [...allSignals];
  const reasoning = generateReasoning(
    riskLevel,
    allConcerns,
    extractedFields,
    crossReferenceResult,
  );

  return {
    riskLevel,
    signals,
    reasoning,
    concerns: allConcerns,
    score: Math.round(finalScore * 100) / 100, // 2 decimal places
  };
}
