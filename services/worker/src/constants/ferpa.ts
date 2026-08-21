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

/**
 * FD-FERPA-1 — does this record have to suppress directory information
 * (FERPA §99.37)? The TS twin of `private.is_directory_info_suppressed`
 * (migration 0415); the two must answer alike, and
 * `src/tests/ferpa-directory-info-opt-out.contract.test.ts` pins that they do.
 *
 * ── WHY THIS IS A NAMED PREDICATE AND NOT AN INLINE `&&` ────────────────────
 *
 * It used to be inline, and it was WRONG in a way that was invisible:
 *
 *     const isEducationType = anchor.credential_type &&
 *       FERPA_EDUCATION_TYPES.includes(anchor.credential_type);
 *     const suppressDirectory = anchor.directory_info_opt_out && isEducationType;
 *
 * A `null` credential type makes the first line FALSY, so `suppressDirectory`
 * was false and every directory field shipped. Measured on prod
 * (vzwyaatejekddvltxyye, 2026-08-21): **all three** anchors carrying
 * `directory_info_opt_out` have `credential_type IS NULL`. So the surface the
 * FD-FERPA-1 finding describes as "does consult the flag" consulted it and then
 * published anyway, for 100% of the affected records. Six tests covered this
 * block; none of them passed a null type.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 *
 * An ABSENT type FAILS CLOSED. The education set recognises which records the
 * opt-out COVERS, so a record it cannot classify has not been shown to be
 * outside FERPA's reach — the same inversion migration 0390 applied to the
 * academic free-text gate. A PRESENT non-education type still publishes:
 * §99.37 is an education-records right, and blanking an insurance or licence
 * record because someone set a flag on it is not the obligation. That boundary
 * is pinned by verify.test.ts on this path and by the live suite on the SQL one.
 */
export function suppressesDirectoryInfo(
  optOut: boolean | null | undefined,
  credentialType: string | null | undefined,
): boolean {
  // An unreadable flag is doubt, and doubt suppresses. The column is NOT NULL
  // in the database, so this is the direction to fail if that ever changes.
  if (optOut === null || optOut === undefined) return true;
  if (!optOut) return false;
  const type = credentialType?.trim();
  if (!type) return true;
  return (FERPA_EDUCATION_TYPES as readonly string[]).includes(type.toUpperCase());
}

/** FERPA re-disclosure notice text (Section 99.33) — included in verification API responses */
export const FERPA_REDISCLOSURE_NOTICE =
  'This verification result contains information from education records. Re-disclosure of personally identifiable information to third parties is prohibited under FERPA Section 99.33 unless an exception applies.';
