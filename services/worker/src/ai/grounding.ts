/**
 * Grounding Verification (CRIT-5 / GAP-3)
 *
 * Cross-checks AI-extracted fields against the source strippedText to detect
 * hallucinated metadata. Fields that don't appear in the source text get
 * a `grounded: false` flag and confidence penalty.
 *
 * This is the single most critical reliability layer — hallucinated metadata
 * anchored to Bitcoin is permanently incorrect and cryptographically immutable.
 *
 * Constitution 4A: Only PII-stripped text is processed here.
 */

import { logger } from '../utils/logger.js';

/** Result of grounding verification for a single field. */
export interface FieldGroundingResult {
  field: string;
  value: string;
  grounded: boolean;
  /** How the field was matched: 'exact' | 'normalized' | 'fuzzy' | 'not_found' */
  matchType: 'exact' | 'normalized' | 'fuzzy' | 'not_found';
}

/** Full grounding report for an extraction. */
export interface GroundingReport {
  /** Per-field grounding results */
  fieldResults: FieldGroundingResult[];
  /** Fraction of groundable fields that were grounded (0.0-1.0) */
  groundingScore: number;
  /** Number of fields that could be checked (excludes numeric-only fields) */
  groundableFieldCount: number;
  /** Number of fields that were grounded */
  groundedFieldCount: number;
  /** Recommended confidence adjustment (negative = reduce) */
  confidenceAdjustment: number;
}

/**
 * Fields that are inherently not groundable in source text
 * (numeric calculations, AI-generated signals, etc.)
 */
const NON_GROUNDABLE_FIELDS = new Set([
  'confidence',
  'fraudSignals',
  'creditHours', // numeric — often OCR'd differently
]);

/**
 * Normalize text for fuzzy comparison:
 * - lowercase
 * - collapse whitespace
 * - strip common OCR artifacts
 */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\u00A0]+/g, ' ')
    .replace(/[''`]/g, "'")
    .replace(/[""]/g, '"')
    .replace(/[-–—]/g, '-')
    .trim();
}

/**
 * Check if a value appears in the source text using multiple strategies.
 */
function findInSource(
  value: string,
  normalizedSource: string,
): 'exact' | 'normalized' | 'fuzzy' | 'not_found' {
  const normalizedValue = normalize(value);

  // Skip very short values (likely abbreviations that match everywhere)
  if (normalizedValue.length < 2) return 'exact';

  // Strategy 1: Exact normalized match
  if (normalizedSource.includes(normalizedValue)) {
    return 'exact';
  }

  // Strategy 2: Token-based fuzzy match — check if most words appear
  const tokens = normalizedValue.split(/\s+/).filter((t) => t.length > 2);
  if (tokens.length > 0) {
    const matchedTokens = tokens.filter((t) => normalizedSource.includes(t));
    const matchRatio = matchedTokens.length / tokens.length;

    if (matchRatio >= 0.8) return 'normalized';
    if (matchRatio >= 0.5) return 'fuzzy';
  }

  // Strategy 3: Date format variations (ISO vs display)
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    // Try MM/DD/YYYY and DD/MM/YYYY variants
    const [y, m, d] = value.split('-');
    const variants = [
      `${m}/${d}/${y}`,
      `${d}/${m}/${y}`,
      `${m}-${d}-${y}`,
      `${m}.${d}.${y}`,
      // Also try without leading zeros
      `${parseInt(m)}/${parseInt(d)}/${y}`,
    ];
    for (const variant of variants) {
      if (normalizedSource.includes(variant.toLowerCase())) {
        return 'normalized';
      }
    }
  }

  return 'not_found';
}

/**
 * Verify that AI-extracted fields are grounded in the source text.
 *
 * @param fields - The extracted fields from AI
 * @param strippedText - The PII-stripped source text
 * @returns GroundingReport with per-field results and confidence adjustment
 */
export function verifyGrounding(
  fields: Record<string, unknown>,
  strippedText: string,
): GroundingReport {
  const normalizedSource = normalize(strippedText);
  const fieldResults: FieldGroundingResult[] = [];
  let groundableCount = 0;
  let groundedCount = 0;

  for (const [field, value] of Object.entries(fields)) {
    // Skip non-groundable fields
    if (NON_GROUNDABLE_FIELDS.has(field)) continue;

    // Skip null/undefined/empty
    if (value === null || value === undefined || value === '') continue;

    // Skip non-string values (arrays, numbers)
    if (typeof value !== 'string') continue;

    // Skip redacted values — they won't match stripped text
    if (value.includes('[REDACTED]') || value.includes('_REDACTED]')) continue;

    groundableCount++;

    const matchType = findInSource(value, normalizedSource);
    const grounded = matchType !== 'not_found';

    if (grounded) groundedCount++;

    fieldResults.push({
      field,
      value,
      grounded,
      matchType,
    });
  }

  // Calculate grounding score
  const groundingScore = groundableCount > 0 ? groundedCount / groundableCount : 1.0;

  // Calculate confidence adjustment:
  // - All grounded: no adjustment
  // - 50-100% grounded: -0.1 to 0.0
  // - <50% grounded: -0.2 to -0.3
  let confidenceAdjustment = 0;
  if (groundableCount > 0) {
    if (groundingScore < 0.5) {
      confidenceAdjustment = -0.3;
    } else if (groundingScore < 0.75) {
      confidenceAdjustment = -0.2;
    } else if (groundingScore < 1.0) {
      confidenceAdjustment = -0.1;
    }
  }

  const ungroundedFields = fieldResults.filter((r) => !r.grounded);
  if (ungroundedFields.length > 0) {
    logger.info(
      {
        groundingScore,
        groundedCount,
        groundableCount,
        ungroundedFields: ungroundedFields.map((f) => f.field),
        confidenceAdjustment,
      },
      'Grounding verification: ungrounded fields detected',
    );
  }

  return {
    fieldResults,
    groundingScore,
    groundableFieldCount: groundableCount,
    groundedFieldCount: groundedCount,
    confidenceAdjustment,
  };
}
