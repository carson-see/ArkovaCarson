import { describe, expect, it } from 'vitest';
import {
  NESSIE_QUARANTINE,
  applyConfidenceDowngrade,
  getQuarantineStatus,
  isCustomerRoutable,
} from './nessie-quarantine.js';

describe('NVI-15 Nessie quarantine policy', () => {
  it('marks v28.x HIPAA as QUARANTINED', () => {
    const e = getQuarantineStatus('HIPAA', 'v28.0');
    expect(e.status).toBe('QUARANTINED');
    expect(e.confidenceDowngrade).toBeGreaterThan(0);
    expect(e.caveat).toMatch(/HIPAA/);
  });

  it('marks v29.x FERPA as QUARANTINED', () => {
    const e = getQuarantineStatus('FERPA', 'v29.0');
    expect(e.status).toBe('QUARANTINED');
    expect(e.caveat).toMatch(/FERPA/);
  });

  it('marks v27.x FCRA as UNDER_REVIEW', () => {
    const e = getQuarantineStatus('FCRA', 'v27.3');
    expect(e.status).toBe('UNDER_REVIEW');
    expect(e.confidenceDowngrade).toBeLessThan(0.1);
  });

  it('returns CLEAR for unknown regulation/version', () => {
    const e = getQuarantineStatus('SOX', 'v1.0');
    expect(e.status).toBe('CLEAR');
    expect(e.confidenceDowngrade).toBe(0);
    expect(e.caveat).toBe('');
  });

  it('matches "v28.x" pattern only at the "v28." prefix', () => {
    expect(getQuarantineStatus('HIPAA', 'v28.0').status).toBe('QUARANTINED');
    expect(getQuarantineStatus('HIPAA', 'v28.10').status).toBe('QUARANTINED');
    expect(getQuarantineStatus('HIPAA', 'v29.0').status).toBe('CLEAR');
    expect(getQuarantineStatus('HIPAA', 'v27.0').status).toBe('CLEAR');
  });

  it('is case-insensitive on regulation code', () => {
    expect(getQuarantineStatus('hipaa', 'v28.0').status).toBe('QUARANTINED');
    expect(getQuarantineStatus('Hipaa', 'v28.0').status).toBe('QUARANTINED');
  });

  it('allows QUARANTINED + UNDER_REVIEW to remain customer-routable', () => {
    expect(isCustomerRoutable('QUARANTINED')).toBe(true);
    expect(isCustomerRoutable('UNDER_REVIEW')).toBe(true);
    expect(isCustomerRoutable('CLEAR')).toBe(true);
  });

  it('refuses to route DISABLED endpoints', () => {
    expect(isCustomerRoutable('DISABLED')).toBe(false);
  });

  it('downgrades confidence within [0, 1]', () => {
    const e = getQuarantineStatus('HIPAA', 'v28.0');
    expect(applyConfidenceDowngrade(0.85, e)).toBeCloseTo(0.75, 5);
    expect(applyConfidenceDowngrade(0.05, e)).toBeCloseTo(0, 5); // clamp at 0
    expect(applyConfidenceDowngrade(1.0, e)).toBeLessThanOrEqual(1);
  });

  it('does not downgrade CLEAR confidence', () => {
    const e = getQuarantineStatus('SOX', 'v1.0');
    expect(applyConfidenceDowngrade(0.85, e)).toBe(0.85);
  });

  it('every roster entry has a tracking Jira ref', () => {
    for (const e of NESSIE_QUARANTINE) {
      expect(e.tracking.length).toBeGreaterThan(0);
      expect(e.caveat.length).toBeGreaterThan(20);
    }
  });
});
