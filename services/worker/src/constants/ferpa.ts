/**
 * Shared FERPA constants — used by keys.ts, ferpa-disclosures.ts, verify.ts.
 * Single source of truth for FERPA enum values.
 */

/** FERPA Section 99.31(a) requesting party types */
export const FERPA_PARTY_TYPES = [
  'school_official', 'employer', 'government', 'accreditor',
  'financial_aid', 'research', 'health_safety', 'subpoena',
  'directory_info', 'other',
] as const;

/** FERPA Section 99.31(a) disclosure exception categories */
export const FERPA_EXCEPTION_CATEGORIES = [
  '99.31(a)(1)', '99.31(a)(2)', '99.31(a)(3)', '99.31(a)(4)',
  '99.31(a)(5)', '99.31(a)(6)', '99.31(a)(7)', '99.31(a)(8)',
  '99.31(a)(9)', '99.31(a)(10)', '99.31(a)(11)', '99.31(a)(12)',
  'other', 'not_applicable',
] as const;

/** Institution types for API key provisioning */
export const INSTITUTION_TYPES = [
  'k12_school', 'university', 'community_college',
  'employer', 'government', 'accreditor', 'financial_aid',
  'research', 'legal', 'healthcare', 'other',
] as const;

/** Credential types that trigger FERPA re-disclosure notice in verification API */
export const FERPA_EDUCATION_TYPES = ['DEGREE', 'TRANSCRIPT', 'CERTIFICATE', 'CLE'] as const;

/** FERPA re-disclosure notice text (Section 99.33) — included in verification API responses */
export const FERPA_REDISCLOSURE_NOTICE =
  'This verification result contains information from education records. Re-disclosure of personally identifiable information to third parties is prohibited under FERPA Section 99.33 unless an exception applies.';
