/**
 * Tests for HIPAA MFA Enforcement Gate — REG-05 (SCRUM-564)
 */

import { describe, it, expect } from 'vitest';
import { isHealthcareCredentialType } from './useHipaaMfaGate';

describe('isHealthcareCredentialType — REG-05', () => {
  it('returns true for INSURANCE', () => {
    expect(isHealthcareCredentialType('INSURANCE')).toBe(true);
  });

  it('returns true for MEDICAL', () => {
    expect(isHealthcareCredentialType('MEDICAL')).toBe(true);
  });

  it('returns true for MEDICAL_LICENSE', () => {
    expect(isHealthcareCredentialType('MEDICAL_LICENSE')).toBe(true);
  });

  it('returns true for IMMUNIZATION', () => {
    expect(isHealthcareCredentialType('IMMUNIZATION')).toBe(true);
  });

  it('returns false for DEGREE (education type)', () => {
    expect(isHealthcareCredentialType('DEGREE')).toBe(false);
  });

  it('returns false for CERTIFICATE', () => {
    expect(isHealthcareCredentialType('CERTIFICATE')).toBe(false);
  });

  it('returns false for PROFESSIONAL', () => {
    expect(isHealthcareCredentialType('PROFESSIONAL')).toBe(false);
  });

  it('returns false for null', () => {
    expect(isHealthcareCredentialType(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isHealthcareCredentialType(undefined)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isHealthcareCredentialType('')).toBe(false);
  });
});
