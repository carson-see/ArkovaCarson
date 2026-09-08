/**
 * MFA error classification — SCRUM-3167 (PR #2637 review; round 2 R17-R21
 * addendum, R18).
 *
 * CTO ruling (round-2 addendum, supersedes the earlier "fail open on any
 * platform error"): fail-open is allowed ONLY on the ENROLLMENT path — a
 * user with NO verified factor who cannot enroll because the platform
 * cannot issue one (the 2026-08-03 lockout class). The CHALLENGE path (an
 * aal1 session whose user HAS a verified factor) must FAIL CLOSED: any
 * error shows a retry screen, never renders protected content. A
 * client-observable "platform error" is trivially attacker-triggerable
 * (block one request in DevTools), so classifying it as a bypass signal
 * made MFA optional for anyone holding a password.
 *
 * Three outcomes now, not two:
 *   - 'wrong_code': the user's TOTP code was wrong/expired. Stay put, let
 *     them retry — the same on both the challenge and enrollment paths.
 *   - 'rejected': an EXPLICIT rejection (rate limit, IP mismatch, or any
 *     OTHER code this module doesn't specifically recognize) — an inline
 *     error, NEVER a fail-open signal, no cooldown involvement, on EITHER
 *     path. This is the DEFAULT for an unrecognized code: fail-open is a
 *     narrow allowlist, not a catch-all for "we don't know this code."
 *   - 'platform': ONLY the two explicit TOTP-capability-disabled codes, or
 *     no code at all (network failure/timeout/thrown exception).
 *     `MfaEnrollmentRequired` (enrollment path) treats this as its
 *     fail-open signal. `MfaChallenge` (challenge path) must NOT — per the
 *     ruling above it fails closed on 'platform' exactly like 'rejected'.
 */

/** Error codes that mean "the user's TOTP code was wrong or expired" — retryable on either path. */
const WRONG_CODE_ERROR_CODES = new Set([
  'mfa_verification_failed',
  'mfa_verification_rejected',
  'mfa_challenge_expired',
]);

/**
 * Error codes that mean "the platform cannot issue/verify TOTP factors at
 * all right now" — the ONLY codes narrow enough to justify fail-open, and
 * only on the enrollment path. Deliberately does NOT include
 * `mfa_factor_name_conflict` (a name collision, not a capability outage —
 * TwoFactorSetup/MfaEnrollmentRequired handle it as its own bespoke case).
 */
const CAPABILITY_ERROR_CODES = new Set(['mfa_totp_enroll_not_enabled', 'mfa_totp_verify_not_enabled']);

export type MfaErrorClassification =
  | { kind: 'wrong_code'; message: string }
  | { kind: 'rejected'; code: string; message: string }
  | { kind: 'platform'; code: string };

/**
 * Classify an `mfa.challenge()`/`mfa.verify()`/`mfa.enroll()` error.
 * `genericMessage` is the caller's own fallback copy, used when a
 * wrong-code or rejected error carries no `message` of its own.
 */
export function classifyMfaError(
  error: { code?: string; message?: string } | null | undefined,
  genericMessage: string,
): MfaErrorClassification {
  const code = error?.code;

  if (code && WRONG_CODE_ERROR_CODES.has(code)) {
    return { kind: 'wrong_code', message: error?.message || genericMessage };
  }

  if (code && CAPABILITY_ERROR_CODES.has(code)) {
    return { kind: 'platform', code };
  }

  if (!code) {
    // No code at all — a network failure, timeout, or thrown exception.
    return { kind: 'platform', code: 'unknown' };
  }

  // Any OTHER code — over_request_rate_limit, mfa_ip_address_mismatch,
  // validation_failed, or a code this module has never seen. Fails CLOSED
  // by default: fail-open is a narrow, deliberate allowlist above, never
  // the default for "we don't recognize this."
  return { kind: 'rejected', code, message: error?.message || genericMessage };
}
