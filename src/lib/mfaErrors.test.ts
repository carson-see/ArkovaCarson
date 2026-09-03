/**
 * classifyMfaError tests — SCRUM-3167 review batch (items 14/S3, 30).
 *
 * `MfaChallenge.tsx` and `MfaEnrollmentRequired.tsx` each need to split an
 * `mfa.challenge()`/`mfa.verify()` error into "the user typed the wrong
 * code" (stay on screen, let them retry) versus "the MFA platform itself
 * failed" (fail open — `onCapabilityUnavailable`). This is the single
 * shared classifier both now use.
 *
 * Item 30: `validation_failed` is a generic malformed-request code (bad
 * shape/params), NOT "the TOTP code was wrong" — classifying it as
 * wrong-code was overly permissive. It is now a platform failure like any
 * other unrecognized code.
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

  it('CHANGED (item 30): validation_failed is now a platform error, not wrong_code', () => {
    const result = classifyMfaError({ code: 'validation_failed', message: 'bad request' }, 'generic fallback');
    expect(result).toEqual({ kind: 'platform', code: 'validation_failed' });
  });

  it('classifies an unrecognized code as platform', () => {
    const result = classifyMfaError({ code: 'mfa_totp_verify_not_enabled' }, 'generic fallback');
    expect(result).toEqual({ kind: 'platform', code: 'mfa_totp_verify_not_enabled' });
  });

  it('classifies a missing code as platform with code "unknown"', () => {
    expect(classifyMfaError({ message: 'network down' }, 'generic fallback')).toEqual({
      kind: 'platform',
      code: 'unknown',
    });
    expect(classifyMfaError(null, 'generic fallback')).toEqual({ kind: 'platform', code: 'unknown' });
    expect(classifyMfaError(undefined, 'generic fallback')).toEqual({ kind: 'platform', code: 'unknown' });
  });
});
