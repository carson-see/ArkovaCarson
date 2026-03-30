/**
 * Cross-Field Consistency Fraud Checks
 *
 * Post-extraction validation that checks for logical inconsistencies
 * between extracted fields. These checks catch sophisticated fraud
 * that single-field analysis misses.
 *
 * Constitution 4A: Only operates on PII-stripped extracted metadata.
 */

import type { ExtractedFields } from './types.js';

// =============================================================================
// TYPES
// =============================================================================

export interface CrossFieldCheckResult {
  /** Fraud signal identifiers to merge into extraction result */
  additionalFraudSignals: string[];
  /** Negative confidence adjustment (0 or negative) */
  confidenceAdjustment: number;
  /** Non-fraud warnings for logging (e.g., missing optional fields) */
  warnings: string[];
}

// =============================================================================
// KNOWN DIPLOMA MILLS
// =============================================================================

/**
 * Known diploma mills and unaccredited degree factories.
 * Comprehensive database compiled from DOE, CHEA, GAO investigations,
 * and Oregon ODA unaccredited school list.
 * Lowercase for case-insensitive matching.
 */
const KNOWN_DIPLOMA_MILLS: string[] = [
  // Original 24
  'belford university',
  'belford high school',
  'ashwood university',
  'almeda university',
  'corllins university',
  'rochville university',
  'bircham international university',
  'breyer state university',
  'hill university',
  'richardton university',
  'lexington university',
  'redding university',
  'suffield university',
  'lorenz university',
  'mcford university',
  'wexford university',
  'headway university',
  'americus university',
  'concordia college and university',
  'paramount university',
  'stanton university',
  'madison university',
  'hamilton university',
  'colombo american university',
  // GAO investigation additions (2004 report + 2015 update)
  'axact university',
  'columbiana university',
  'deansville institute of technology',
  'dunham university',
  'glendale university',
  'greenleaf university',
  'kennedy-western university',
  'lacrosse university',
  'nation university',
  'northfield university',
  'pacific western university',
  'preston university',
  'saint regis university',
  'trinity southern university',
  'university of berkley', // intentional misspelling by the mill
  'western pacific university',
  'warren national university',
  'american coastline university',
  // Oregon ODA unaccredited list
  'adam smith university',
  'american state university',
  'barrington university',
  'century university',
  'columbia pacific university',
  'columbus university',
  'greenwich university',
  'henley-putnam university', // not the legitimate one
  'james monroe university',
  'knightsbridge university',
  'northfield university',
  'pacific college',
  'phoenix university', // not University of Phoenix
  'stanford international university', // not Stanford
  // International diploma mills
  'irish international university',
  'university of south wales online', // fake, not the legitimate USW
  'commonwealth university london',
  'european school of economics', // revoked accreditation
  'global academy online',
  'international university of management',
  'metropolitan university of london', // fake
  'oxford online academy', // not University of Oxford
  'royal university of science and technology',
  'cambridge international university', // fake
];

/**
 * Suspicious name patterns that suggest unaccredited institutions.
 */
const SUSPICIOUS_ISSUER_PATTERNS: RegExp[] = [
  /universal\s+life\s+church/i,
  /university\s+of\s+nowhere/i,
  /degree\s+mill/i,
  /instant\s+degree/i,
  /buy\s+degree/i,
  /accreditation\s+mill/i,
  /life\s+experience\s+degree/i,
  /verified\s+credentials\s+online/i,
  /fast\s+track\s+degree/i,
  /diploma\s+at\s+home/i,
  /accredited\s+online\s+university/i,  // overly generic name
  /global\s+online\s+university/i,
  /international\s+open\s+university/i,  // common mill naming pattern
  /free\s+degree/i,
  /instant\s+certificate/i,
];

// =============================================================================
// US STATES / FOREIGN COUNTRIES for jurisdiction checks
// =============================================================================

const US_STATES = new Set([
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado',
  'connecticut', 'delaware', 'florida', 'georgia', 'hawaii', 'idaho',
  'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana',
  'maine', 'maryland', 'massachusetts', 'michigan', 'minnesota',
  'mississippi', 'missouri', 'montana', 'nebraska', 'nevada',
  'new hampshire', 'new jersey', 'new mexico', 'new york',
  'north carolina', 'north dakota', 'ohio', 'oklahoma', 'oregon',
  'pennsylvania', 'rhode island', 'south carolina', 'south dakota',
  'tennessee', 'texas', 'utah', 'vermont', 'virginia', 'washington',
  'west virginia', 'wisconsin', 'wyoming', 'district of columbia',
]);

const US_STATE_ABBREVIATIONS = new Set([
  'al', 'ak', 'az', 'ar', 'ca', 'co', 'ct', 'de', 'fl', 'ga',
  'hi', 'id', 'il', 'in', 'ia', 'ks', 'ky', 'la', 'me', 'md',
  'ma', 'mi', 'mn', 'ms', 'mo', 'mt', 'ne', 'nv', 'nh', 'nj',
  'nm', 'ny', 'nc', 'nd', 'oh', 'ok', 'or', 'pa', 'ri', 'sc',
  'sd', 'tn', 'tx', 'ut', 'vt', 'va', 'wa', 'wv', 'wi', 'wy', 'dc',
]);

/** Common non-US country indicators in issuer or jurisdiction fields */
const FOREIGN_COUNTRY_KEYWORDS = [
  'united kingdom', 'uk', 'england', 'scotland', 'wales',
  'australia', 'canada', 'india', 'germany', 'france', 'japan',
  'china', 'brazil', 'mexico', 'nigeria', 'south africa',
  'singapore', 'hong kong', 'philippines', 'pakistan', 'bangladesh',
  'kenya', 'ghana', 'malaysia', 'indonesia', 'thailand', 'vietnam',
  'european union', 'eu',
];

const US_BOARD_KEYWORDS = [
  'state board', 'state bar', 'department of', 'division of',
  'board of registration', 'board of professional',
  'secretary of state', 'state licensing',
];

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function parseDate(dateStr: string | undefined): Date | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d;
}

function containsUSState(text: string): boolean {
  const lower = text.toLowerCase();
  for (const state of US_STATES) {
    if (lower.includes(state)) return true;
  }
  // Check abbreviations — only match as whole words
  for (const abbr of US_STATE_ABBREVIATIONS) {
    const regex = new RegExp(`\\b${abbr}\\b`, 'i');
    if (regex.test(text)) return true;
  }
  return false;
}

function containsForeignCountry(text: string): boolean {
  const lower = text.toLowerCase();
  return FOREIGN_COUNTRY_KEYWORDS.some((kw) => lower.includes(kw));
}

function containsUSBoard(text: string): boolean {
  const lower = text.toLowerCase();
  return US_BOARD_KEYWORDS.some((kw) => lower.includes(kw));
}

// =============================================================================
// CHECK FUNCTIONS
// =============================================================================

function checkDateLogic(fields: ExtractedFields, result: CrossFieldCheckResult): void {
  const issuedDate = parseDate(fields.issuedDate);
  const expiryDate = parseDate(fields.expiryDate);
  const now = new Date();

  // issuedDate after expiryDate
  if (issuedDate && expiryDate && issuedDate > expiryDate) {
    result.additionalFraudSignals.push('SUSPICIOUS_DATES');
    result.confidenceAdjustment -= 0.10;
  }

  // issuedDate more than 5 years in the future
  if (issuedDate) {
    const fiveYearsFromNow = new Date(now);
    fiveYearsFromNow.setFullYear(fiveYearsFromNow.getFullYear() + 5);
    if (issuedDate > fiveYearsFromNow) {
      result.additionalFraudSignals.push('SUSPICIOUS_DATES');
      result.confidenceAdjustment -= 0.15;
    }
  }

  // Credential older than 80 years — log as warning only, NOT fraud
  // Old credentials are legitimate (people archive decades-old degrees)
  if (issuedDate) {
    const eightyYearsAgo = new Date(now);
    eightyYearsAgo.setFullYear(eightyYearsAgo.getFullYear() - 80);
    if (issuedDate < eightyYearsAgo) {
      result.warnings.push('Credential issued more than 80 years ago — flag for review');
    }
  }

  // License/certificate valid for more than 20 years
  if (issuedDate && expiryDate) {
    const validityYears = (expiryDate.getTime() - issuedDate.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
    if (validityYears > 20) {
      const type = fields.credentialType?.toUpperCase();
      if (type === 'LICENSE' || type === 'CERTIFICATE') {
        result.additionalFraudSignals.push('SUSPICIOUS_DATES');
        result.warnings.push(`${type} valid for ${Math.round(validityYears)} years — unusual duration`);
      }
    }
  }

  // Same-day issue and expiry — only flag for multi-year credentials, NOT workshops
  if (issuedDate && expiryDate) {
    const sameDay =
      issuedDate.getFullYear() === expiryDate.getFullYear() &&
      issuedDate.getMonth() === expiryDate.getMonth() &&
      issuedDate.getDate() === expiryDate.getDate();
    if (sameDay) {
      // Same-day is normal for workshops, one-day events, and CLE courses
      // Only log as warning, not fraud signal
      result.warnings.push('Same-day issue and expiry — may be a workshop or event');
    }
  }
}

function checkIssuerValidation(fields: ExtractedFields, result: CrossFieldCheckResult): void {
  const issuer = fields.issuerName?.toLowerCase().trim();
  if (!issuer) return;

  // Known diploma mills
  if (KNOWN_DIPLOMA_MILLS.some((mill) => issuer.includes(mill))) {
    result.additionalFraudSignals.push('EXPIRED_ISSUER');
    result.confidenceAdjustment -= 0.20;
  }

  // Suspicious name patterns
  if (SUSPICIOUS_ISSUER_PATTERNS.some((pattern) => pattern.test(issuer))) {
    result.additionalFraudSignals.push('EXPIRED_ISSUER');
    result.confidenceAdjustment -= 0.15;
  }

  // Degree from issuer with no accrediting body and suspicious patterns
  const type = fields.credentialType?.toUpperCase();
  if (type === 'DEGREE' || type === 'DIPLOMA') {
    if (!fields.accreditingBody) {
      // Doctorate from "online" issuer with no accrediting body
      if (
        fields.degreeLevel?.toLowerCase().includes('doctor') &&
        issuer.includes('online')
      ) {
        result.additionalFraudSignals.push('MISSING_ACCREDITATION');
        result.confidenceAdjustment -= 0.15;
      }
    }
  }
}

function checkTypeConsistency(fields: ExtractedFields, result: CrossFieldCheckResult): void {
  const type = fields.credentialType?.toUpperCase();

  // DEGREE but no degreeLevel and no fieldOfStudy
  if (type === 'DEGREE' && !fields.degreeLevel && !fields.fieldOfStudy) {
    result.additionalFraudSignals.push('FORMAT_ANOMALY');
    result.confidenceAdjustment -= 0.05;
  }

  // LICENSE but no jurisdiction — weak signal, only log
  if (type === 'LICENSE' && !fields.jurisdiction) {
    result.warnings.push('LICENSE credential without jurisdiction — weak signal');
  }

  // CLE but no creditHours
  if (type === 'CLE' && !fields.creditHours) {
    result.additionalFraudSignals.push('FORMAT_ANOMALY');
    result.confidenceAdjustment -= 0.05;
  }

  // Doctorate degreeLevel with CERTIFICATE type — possible misclassification
  if (
    fields.degreeLevel?.toLowerCase().includes('doctor') &&
    type === 'CERTIFICATE'
  ) {
    result.warnings.push('Doctorate degreeLevel with CERTIFICATE type — may be misclassified');
  }
}

function checkJurisdiction(fields: ExtractedFields, result: CrossFieldCheckResult): void {
  const jurisdiction = fields.jurisdiction;
  const issuer = fields.issuerName;

  if (!jurisdiction || !issuer) return;

  // jurisdiction contains US state but issuer is a foreign body
  if (containsUSState(jurisdiction) && containsForeignCountry(issuer)) {
    result.additionalFraudSignals.push('JURISDICTION_MISMATCH');
    result.confidenceAdjustment -= 0.10;
  }

  // jurisdiction contains non-US country but issuer is a US state board
  if (containsForeignCountry(jurisdiction) && containsUSBoard(issuer)) {
    result.additionalFraudSignals.push('JURISDICTION_MISMATCH');
    result.confidenceAdjustment -= 0.10;
  }
}

/**
 * Check license number format validity.
 * Many fake credentials use placeholder or obviously invalid license numbers.
 */
function checkLicenseFormat(fields: ExtractedFields, result: CrossFieldCheckResult): void {
  const type = fields.credentialType?.toUpperCase();
  if (type !== 'LICENSE' && type !== 'PROFESSIONAL') return;

  const licenseNumber = fields.licenseNumber;
  if (!licenseNumber) return;

  // Check for obvious placeholder patterns
  const placeholderPatterns = [
    /^[0]{5,}$/,                    // All zeros: 000000
    /^1234/,                        // Sequential: 1234...
    /^(XX|xx|NA|na|N\/A|TBD)/,     // Explicit placeholders
    /^\[.*\]$/,                     // Bracketed: [REDACTED], [NUMBER]
    /^test/i,                       // Test values
    /^sample/i,                     // Sample values
    /^example/i,                    // Example values
  ];

  if (placeholderPatterns.some(p => p.test(licenseNumber.trim()))) {
    result.additionalFraudSignals.push('FORMAT_ANOMALY');
    result.confidenceAdjustment -= 0.10;
    result.warnings.push(`License number "${licenseNumber}" appears to be a placeholder`);
  }

  // Suspiciously short license numbers (< 3 chars)
  if (licenseNumber.replace(/[\s-]/g, '').length < 3) {
    result.warnings.push('License number unusually short — verify authenticity');
  }
}

/**
 * Check for degree level / credential type mismatches.
 * E.g., a "PhD" from an institution that only grants certificates.
 */
function checkDegreeLevelConsistency(fields: ExtractedFields, result: CrossFieldCheckResult): void {
  const type = fields.credentialType?.toUpperCase();
  const degreeLevel = fields.degreeLevel?.toLowerCase();
  const issuer = fields.issuerName?.toLowerCase() ?? '';

  if (!degreeLevel) return;

  // Doctorate from a "training center" or "academy" (typically non-degree-granting)
  const nonDegreeIssuers = [
    'training center', 'training centre', 'academy of',
    'institute of technology', 'coding bootcamp', 'bootcamp',
  ];

  if (
    (degreeLevel.includes('doctor') || degreeLevel.includes('phd')) &&
    nonDegreeIssuers.some(p => issuer.includes(p))
  ) {
    result.additionalFraudSignals.push('FORMAT_ANOMALY');
    result.confidenceAdjustment -= 0.10;
    result.warnings.push(`Doctorate from non-degree-granting institution: "${fields.issuerName}"`);
  }

  // Master's or Doctorate with BADGE or CERTIFICATE type
  if (
    (degreeLevel.includes('master') || degreeLevel.includes('doctor') || degreeLevel.includes('phd')) &&
    (type === 'BADGE' || type === 'CERTIFICATE')
  ) {
    result.additionalFraudSignals.push('FORMAT_ANOMALY');
    result.confidenceAdjustment -= 0.05;
    result.warnings.push(`Graduate-level degreeLevel with ${type} credentialType — possible misclassification`);
  }
}

/**
 * Check for accrediting body red flags.
 * Some fake credentials cite non-existent accrediting bodies.
 */
function checkAccreditingBody(fields: ExtractedFields, result: CrossFieldCheckResult): void {
  const body = fields.accreditingBody?.toLowerCase();
  if (!body) return;

  // Known fake accrediting bodies
  const fakeAccreditors = [
    'world association of universities and colleges',
    'universal accreditation council',
    'international accreditation association',
    'world online accreditation',
    'global accreditation body',
    'international commission on higher education',
  ];

  if (fakeAccreditors.some(fake => body.includes(fake))) {
    result.additionalFraudSignals.push('MISSING_ACCREDITATION');
    result.confidenceAdjustment -= 0.20;
    result.warnings.push(`Known fake accrediting body: "${fields.accreditingBody}"`);
  }
}

// =============================================================================
// MAIN EXPORT
// =============================================================================

/**
 * Run all cross-field consistency fraud checks on extracted fields.
 *
 * @param fields - PII-stripped extracted metadata fields
 * @returns Cross-field check results with fraud signals, confidence adjustment, and warnings
 */
export function runCrossFieldChecks(fields: ExtractedFields): CrossFieldCheckResult {
  const result: CrossFieldCheckResult = {
    additionalFraudSignals: [],
    confidenceAdjustment: 0,
    warnings: [],
  };

  checkDateLogic(fields, result);
  checkIssuerValidation(fields, result);
  checkTypeConsistency(fields, result);
  checkJurisdiction(fields, result);
  checkLicenseFormat(fields, result);
  checkDegreeLevelConsistency(fields, result);
  checkAccreditingBody(fields, result);

  // Deduplicate fraud signals
  result.additionalFraudSignals = [...new Set(result.additionalFraudSignals)];

  // Cap the total confidence adjustment at -0.40 to avoid zeroing out
  result.confidenceAdjustment = Math.max(-0.40, result.confidenceAdjustment);

  return result;
}

// =============================================================================
// CLE-ONLY FIELD SANITIZER
// =============================================================================

/**
 * CLE-only fields that MUST be stripped from non-CLE extraction results.
 * This is a hard guardrail against model hallucination — the model sometimes
 * includes barNumber, providerName, or approvedBy on non-CLE credentials.
 */
const CLE_ONLY_FIELDS = [
  'barNumber',
  'providerName',
  'approvedBy',
  'creditHours',
  'creditType',
  'activityNumber',
] as const;

/**
 * Strip CLE-only fields from non-CLE extraction results.
 * Call this AFTER extraction, BEFORE storing results.
 *
 * @param fields - Extracted fields (mutated in place)
 * @returns List of fields that were stripped (for logging)
 */
export function sanitizeCLEFields(fields: ExtractedFields): string[] {
  const type = fields.credentialType?.toUpperCase();
  if (type === 'CLE') return []; // CLE documents keep all fields

  const stripped: string[] = [];
  for (const field of CLE_ONLY_FIELDS) {
    if (field in fields && (fields as Record<string, unknown>)[field] !== undefined) {
      stripped.push(field);
      delete (fields as Record<string, unknown>)[field];
    }
  }
  return stripped;
}
