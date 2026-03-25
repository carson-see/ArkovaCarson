/**
 * Ensemble-Based Confidence Scoring (AI-002)
 *
 * Improves confidence correlation from r=0.426 to target r>0.70 by running
 * extraction through multiple prompt framings and measuring inter-prompt
 * agreement. Higher agreement between independent extractions = higher
 * confidence that the result is correct.
 *
 * Strategy:
 *   1. Run 3 extractions with different prompt framings (strict, lenient, adversarial)
 *   2. Compare field-level agreement across all 3 results
 *   3. Weight ensemble score: all agree → 0.95+, 2/3 → 0.70–0.85, none → 0.30–0.50
 *
 * Constitution 4A: Only PII-stripped text flows to providers.
 */

import type { ExtractedFields, ExtractionResult, ExtractionRequest, IAIProvider } from './types.js';

/** Result of ensemble confidence scoring */
export interface EnsembleResult {
  /** Best extraction result (from the majority or highest-confidence run) */
  fields: ExtractedFields;
  /** Ensemble confidence score (0.0–1.0) — should correlate better with actual accuracy */
  confidence: number;
  /** Per-field agreement rates */
  fieldAgreement: Record<string, number>;
  /** Number of extractions that succeeded */
  runsCompleted: number;
  /** Provider used */
  provider: string;
  /** Total tokens across all runs */
  totalTokensUsed: number;
  /** Original individual results for debugging */
  individualConfidences: number[];
}

/** The key fields we measure agreement on */
const AGREEMENT_FIELDS = [
  'credentialType',
  'issuerName',
  'issuedDate',
  'expiryDate',
  'fieldOfStudy',
  'degreeLevel',
  'licenseNumber',
  'accreditingBody',
  'jurisdiction',
] as const;

/**
 * Prompt framing variants for ensemble extraction.
 * Each returns a modified system prompt suffix that changes the extraction behavior.
 */
export const PROMPT_FRAMINGS = {
  /** Default: standard extraction */
  standard: '',

  /** Strict: only extract fields with high certainty */
  strict: `\n\nADDITIONAL INSTRUCTION: Be STRICT in this extraction. Only include a field if you are highly certain of its value. When in doubt, OMIT the field entirely. It is better to return fewer fields with higher accuracy than more fields with guesses.`,

  /** Lenient: extract aggressively, including reasonable inferences */
  lenient: `\n\nADDITIONAL INSTRUCTION: Be THOROUGH in this extraction. Extract every field you can reasonably infer from the text. Use context clues to determine values even if they are not explicitly stated. Include fields where you have moderate confidence.`,
} as const;

export type PromptFraming = keyof typeof PROMPT_FRAMINGS;

/**
 * Compare two field values for agreement.
 * Handles string normalization and date format variations.
 */
export function fieldsAgree(a: unknown, b: unknown): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  if (a === b) return true;

  const strA = String(a).trim().toLowerCase();
  const strB = String(b).trim().toLowerCase();

  if (strA === strB) return true;

  // Date normalization: "2025-01-15" vs "2025-1-15"
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(strA) && /^\d{4}-\d{1,2}-\d{1,2}$/.test(strB)) {
    const normalize = (d: string) => {
      const [y, m, da] = d.split('-');
      return `${y}-${m.padStart(2, '0')}-${da.padStart(2, '0')}`;
    };
    return normalize(strA) === normalize(strB);
  }

  // Fuzzy match: one contains the other (e.g., "MIT" vs "Massachusetts Institute of Technology")
  if (strA.length > 3 && strB.length > 3) {
    if (strA.includes(strB) || strB.includes(strA)) return true;
  }

  return false;
}

/**
 * Compute per-field agreement rates across multiple extraction results.
 *
 * @param results - Array of extraction results from different framings
 * @returns Record mapping field name to agreement rate (0.0–1.0)
 */
export function computeFieldAgreement(
  results: ExtractedFields[],
): Record<string, number> {
  const agreement: Record<string, number> = {};

  if (results.length < 2) {
    // Single result — no agreement to measure
    for (const field of AGREEMENT_FIELDS) {
      agreement[field] = results[0]?.[field] !== undefined ? 0.5 : 0;
    }
    return agreement;
  }

  for (const field of AGREEMENT_FIELDS) {
    const values = results.map((r) => r[field]);
    const defined = values.filter((v) => v !== undefined);

    if (defined.length === 0) {
      agreement[field] = 0;
      continue;
    }

    if (defined.length === 1) {
      // Only one result extracted this field — moderate agreement
      agreement[field] = 0.4;
      continue;
    }

    // Count pairwise agreements
    let pairCount = 0;
    let agreeCount = 0;
    for (let i = 0; i < values.length; i++) {
      for (let j = i + 1; j < values.length; j++) {
        if (values[i] !== undefined && values[j] !== undefined) {
          pairCount++;
          if (fieldsAgree(values[i], values[j])) {
            agreeCount++;
          }
        }
      }
    }

    agreement[field] = pairCount > 0 ? agreeCount / pairCount : 0;
  }

  return agreement;
}

/**
 * Select the best extraction result from multiple runs.
 * Prefers the result that agrees most with others (majority vote).
 */
export function selectBestResult(results: ExtractionResult[]): ExtractedFields {
  if (results.length === 1) return results[0].fields;

  // Score each result by how much it agrees with the others
  const scores = results.map((result, i) => {
    let agreementScore = 0;
    for (let j = 0; j < results.length; j++) {
      if (i === j) continue;
      for (const field of AGREEMENT_FIELDS) {
        if (fieldsAgree(result.fields[field], results[j].fields[field])) {
          agreementScore++;
        }
      }
    }
    return { index: i, agreementScore, confidence: result.confidence };
  });

  // Sort by agreement first, then by confidence
  scores.sort((a, b) => b.agreementScore - a.agreementScore || b.confidence - a.confidence);

  return results[scores[0].index].fields;
}

/**
 * Compute ensemble confidence from field agreement rates.
 *
 * Scoring:
 *   - All 3 agree on a field → field contributes 0.95+
 *   - 2/3 agree → field contributes 0.70–0.85
 *   - None agree → field contributes 0.30–0.50
 *
 * Final score is weighted average across extracted fields,
 * with key fields (issuerName, issuedDate) getting higher weight.
 */
export function computeEnsembleConfidence(
  fieldAgreement: Record<string, number>,
  runsCompleted: number,
  individualConfidences: number[],
): number {
  if (runsCompleted === 0) return 0;

  // If only one run succeeded, fall back to individual confidence
  if (runsCompleted === 1 && individualConfidences.length > 0) {
    return individualConfidences[0] * 0.8; // penalty for no ensemble
  }

  // Field weights (key fields count more)
  const fieldWeights: Record<string, number> = {
    credentialType: 1.5,
    issuerName: 2.0,
    issuedDate: 1.5,
    expiryDate: 1.0,
    fieldOfStudy: 1.0,
    degreeLevel: 0.8,
    licenseNumber: 1.2,
    accreditingBody: 0.8,
    jurisdiction: 1.0,
  };

  let weightedSum = 0;
  let totalWeight = 0;
  let fieldsWithData = 0;

  for (const [field, rate] of Object.entries(fieldAgreement)) {
    const weight = fieldWeights[field] ?? 1.0;

    // Skip fields that no run extracted
    if (rate === 0) continue;

    fieldsWithData++;

    // Map agreement rate to confidence contribution
    let contribution: number;
    if (rate >= 0.95) {
      contribution = 0.95; // Full agreement
    } else if (rate >= 0.6) {
      contribution = 0.70 + (rate - 0.6) * 0.625; // 0.70–0.95 range
    } else if (rate >= 0.3) {
      contribution = 0.50 + (rate - 0.3) * 0.667; // 0.50–0.70 range
    } else {
      contribution = 0.30 + rate; // 0.30–0.60 range
    }

    weightedSum += contribution * weight;
    totalWeight += weight;
  }

  if (totalWeight === 0) {
    // No fields extracted by any run
    return 0.2;
  }

  let ensembleScore = weightedSum / totalWeight;

  // Bonus for more fields being extracted consistently
  if (fieldsWithData >= 5) ensembleScore = Math.min(1.0, ensembleScore + 0.03);
  if (fieldsWithData >= 7) ensembleScore = Math.min(1.0, ensembleScore + 0.02);

  // Penalty if not all 3 runs completed
  if (runsCompleted < 3) {
    ensembleScore *= 0.90;
  }

  return Math.max(0.0, Math.min(1.0, ensembleScore));
}

/**
 * Run ensemble extraction: 3 prompt framings, measure agreement.
 *
 * This is the main entry point for AI-002.
 *
 * @param provider - AI provider to use for extraction
 * @param request - Original extraction request
 * @param framings - Which prompt framings to use (default: all 3)
 * @returns EnsembleResult with improved confidence score
 */
export async function runEnsembleExtraction(
  provider: IAIProvider,
  request: ExtractionRequest,
  framings: PromptFraming[] = ['standard', 'strict', 'lenient'],
): Promise<EnsembleResult> {
  const results: ExtractionResult[] = [];
  let totalTokens = 0;

  // Run all framings (could be parallelized in production)
  for (const framing of framings) {
    try {
      // Create a modified request with the framing suffix appended to the text
      // The framing suffix gets picked up by the extraction prompt builder
      const modifiedRequest: ExtractionRequest = {
        ...request,
        strippedText: request.strippedText + PROMPT_FRAMINGS[framing],
      };

      const result = await provider.extractMetadata(modifiedRequest);
      results.push(result);
      totalTokens += result.tokensUsed ?? 0;
    } catch {
      // Continue with remaining framings — graceful degradation
    }
  }

  if (results.length === 0) {
    return {
      fields: {},
      confidence: 0,
      fieldAgreement: {},
      runsCompleted: 0,
      provider: provider.name,
      totalTokensUsed: totalTokens,
      individualConfidences: [],
    };
  }

  const bestFields = selectBestResult(results);
  const fieldAgreement = computeFieldAgreement(results.map((r) => r.fields));
  const individualConfidences = results.map((r) => r.confidence);
  const confidence = computeEnsembleConfidence(fieldAgreement, results.length, individualConfidences);

  return {
    fields: bestFields,
    confidence,
    fieldAgreement,
    runsCompleted: results.length,
    provider: provider.name,
    totalTokensUsed: totalTokens,
    individualConfidences,
  };
}
