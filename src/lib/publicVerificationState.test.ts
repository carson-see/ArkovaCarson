import { describe, expect, it } from 'vitest';
import {
  hasPublicVerificationProof,
  isPreSecuredStatus,
  normalizePublicVerificationStatus,
} from './publicVerificationState';

describe('publicVerificationState', () => {
  it('normalizes the frozen public API ACTIVE alias to SECURED', () => {
    expect(normalizePublicVerificationStatus('ACTIVE')).toBe('SECURED');
  });

  it('preserves all public verification statuses', () => {
    for (const status of ['PENDING', 'SUBMITTED', 'SECURED', 'REVOKED', 'EXPIRED'] as const) {
      expect(normalizePublicVerificationStatus(status)).toBe(status);
    }
  });

  it('falls back unknown statuses to the non-verified state', () => {
    expect(normalizePublicVerificationStatus('UNEXPECTED')).toBe('PENDING');
  });

  it('treats only PENDING and SUBMITTED as pre-secured', () => {
    expect(isPreSecuredStatus('PENDING')).toBe(true);
    expect(isPreSecuredStatus('SUBMITTED')).toBe(true);
    expect(isPreSecuredStatus('SECURED')).toBe(false);
    expect(isPreSecuredStatus('REVOKED')).toBe(false);
    expect(isPreSecuredStatus('EXPIRED')).toBe(false);
  });

  it('exposes proof only after a public record has a terminal proof state', () => {
    expect(hasPublicVerificationProof('PENDING')).toBe(false);
    expect(hasPublicVerificationProof('SUBMITTED')).toBe(false);
    expect(hasPublicVerificationProof('SECURED')).toBe(true);
    expect(hasPublicVerificationProof('REVOKED')).toBe(true);
    expect(hasPublicVerificationProof('EXPIRED')).toBe(true);
  });
});
