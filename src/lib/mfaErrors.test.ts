/**
 * classifyMfaError tests — SCRUM-3167 (PR #2637 review round 2, R18).
 *
 * CTO ruling (round-2 addendum, supersedes the earlier "fail open on any
 * platform error"): fail-open is allowed ONLY on the ENROLLMENT path (no
 * verified factor, platform can't issue one). The CHALLENGE path (a
 * verified factor already exists) must FAIL CLOSED on every other outcome.
 * A client-observable "platform error" is trivially attacker-triggerable
 * (block one request in DevTools), so treating it as a bypass signal made
 * MFA optional for anyone holding a password.
 *
 * This classifier now has THREE outcomes, not two:
 *   - 'wrong_code': the user's TOTP code was wrong/expired — unchanged.
 *   - 'rejected': an EXPLICIT rejection from the platform (rate limit, IP
 *     mismatch, or any OTHER code not recognized below) — inline error,
 *     NEVER a fail-open signal, no cooldown involvement. This is now the
 *     DEFAULT for any code this module doesn't specifically recognize —
 *     fail-open is a narrow, deliberate allowlist, not a catch-all.
 *   - 'platform': ONLY the two explicit TOTP-capability-disabled codes,
 *     OR no code at all (network failure/timeout/thrown exception). This
 *     is the ONLY classification the enrollment path may treat as a
 *     fail-open signal — MfaChallenge (challenge path) must treat
 *     'platform' exactly like 'rejected' (fail closed) per the ruling
 *     above; only MfaEnrollmentRequired's enroll() failures use this
 *     distinction to decide fail-open.
 */
import { describe, expect, it } from 'vitest';
import { classifyMfaError } from './mfaErrors';

describe('classifyMfaError', () => {
  it.each(['mfa_verification_failed', 'mfa_verification_rejected', 'mfa_challenge_expired'])(
    'classifies %s as wrong_code',
    (code) => {
      const result = classifyMfaError({ code, message: 'bad code' }, 'generic fallback');
      expect(result).toEqual({ kind: 'wrong_code', message: 'bad code' });
    },
  );

  it('falls back to the generic message when a wrong-code error carries no message', () => {
    const result = classifyMfaError({ code: 'mfa_verification_failed' }, 'generic fallback');
    expect(result).toEqual({ kind: 'wrong_code', message: 'generic fallback' });
  });

  it('validation_failed is a rejected error (not wrong_code, not platform)', () => {
    const result = classifyMfaError({ code: 'validation_failed', message: 'bad request' }, 'generic fallback');
    expect(result).toEqual({ kind: 'rejected', code: 'validation_failed', message: 'bad request' });
  });

  it.each(['over_request_rate_limit', 'mfa_ip_address_mismatch'])(
    'R18: classifies the explicit rejection code %s as rejected — inline error, never fail-open',
    (code) => {
      const result = classifyMfaError({ code, message: 'rejected' }, 'generic fallback');
      expect(result).toEqual({ kind: 'rejected', code, message: 'rejected' });
    },
  );

  it('R18: falls back to the generic message when a rejected error carries no message', () => {
    const result = classifyMfaError({ code: 'over_request_rate_limit' }, 'generic fallback');
    expect(result).toEqual({ kind: 'rejected', code: 'over_request_rate_limit', message: 'generic fallback' });
  });

  it.each(['mfa_totp_enroll_not_enabled', 'mfa_totp_verify_not_enabled'])(
    'classifies the explicit capability code %s as platform',
    (code) => {
      const result = classifyMfaError({ code, message: 'disabled' }, 'generic fallback');
      expect(result).toEqual({ kind: 'platform', code });
    },
  );

  it('R18 CHANGED: an UNRECOGNIZED code now defaults to rejected, NOT platform — fail-open is an allowlist, not a catch-all', () => {
    const result = classifyMfaError({ code: 'some_future_gotrue_code' }, 'generic fallback');
    expect(result).toEqual({ kind: 'rejected', code: 'some_future_gotrue_code', message: 'generic fallback' });
  });

  it('classifies a missing code (network failure / thrown exception) as platform with code "unknown"', () => {
    expect(classifyMfaError({ message: 'network down' }, 'generic fallback')).toEqual({
      kind: 'platform',
      code: 'unknown',
    });
    expect(classifyMfaError(null, 'generic fallback')).toEqual({ kind: 'platform', code: 'unknown' });
    expect(classifyMfaError(undefined, 'generic fallback')).toEqual({ kind: 'platform', code: 'unknown' });
  });
});
