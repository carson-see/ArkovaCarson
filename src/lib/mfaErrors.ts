/**
 * MFA error classification — SCRUM-3167 review batch (items 14/S3, 30).
 *
 * Both the every-login challenge (`MfaChallenge.tsx`) and the forced
 * enrollment screen's post-enroll verify step (`MfaEnrollmentRequired.tsx`)
 * need to make the same call on an `mfa.challenge()`/`mfa.verify()` error:
 * is this the USER's mistake (wrong/expired code — stay put, let them
 * retry) or a PLATFORM failure (fail open via `onCapabilityUnavailable`)?
 * One shared classifier keeps that boundary from drifting between the two
 * call sites.
 *
 * `validation_failed` was removed from the wrong-code set (item 30): it is
 * GoTrue's generic malformed-request code (bad shape/params), not evidence
 * the user's TOTP code itself was wrong — treating it as user-fixable could
 * mask a real client/server contract bug behind an endless "try again."
 */

/** Error codes that mean "the user's TOTP code was wrong or expired" — every other code is a platform failure. */
const WRONG_CODE_ERROR_CODES = new Set([
  'mfa_verification_failed',
  'mfa_verification_rejected',
  'mfa_challenge_expired',
]);

export type MfaErrorClassification =
  | { kind: 'wrong_code'; message: string }
  | { kind: 'platform'; code: string };

/**
 * Classify an `mfa.challenge()`/`mfa.verify()` error. `genericMessage` is
 * the caller's own fallback copy, used when a wrong-code error carries no
 * `message` of its own.
 */
export function classifyMfaError(
  error: { code?: string; message?: string } | null | undefined,
  genericMessage: string,
): MfaErrorClassification {
  if (error?.code && WRONG_CODE_ERROR_CODES.has(error.code)) {
    return { kind: 'wrong_code', message: error.message || genericMessage };
  }
  return { kind: 'platform', code: error?.code ?? 'unknown' };
}
