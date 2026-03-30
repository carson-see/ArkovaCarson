/**
 * Tests for Worker-Side Compliance Mapping (CML-02)
 */

import { describe, it, expect } from 'vitest';
import { getComplianceControlIds } from './complianceMapping.js';

describe('getComplianceControlIds', () => {
  it('returns universal controls for any credential type', () => {
    const ids = getComplianceControlIds('OTHER');
    expect(ids).toContain('SOC2-CC6.1');
    expect(ids).toContain('SOC2-CC6.7');
    expect(ids).toContain('GDPR-5.1f');
    expect(ids).toContain('GDPR-25');
    expect(ids).toContain('ISO27001-A.10');
    expect(ids).toContain('eIDAS-25');
    expect(ids).toContain('eIDAS-35');
    expect(ids).toHaveLength(7);
  });

  it('adds FERPA for DEGREE', () => {
    const ids = getComplianceControlIds('DEGREE');
    expect(ids).toContain('FERPA-99.31');
    expect(ids).toHaveLength(8);
  });

  it('adds FERPA for TRANSCRIPT', () => {
    const ids = getComplianceControlIds('TRANSCRIPT');
    expect(ids).toContain('FERPA-99.31');
  });

  it('adds ISO A.14 for LICENSE', () => {
    const ids = getComplianceControlIds('LICENSE');
    expect(ids).toContain('ISO27001-A.14');
  });

  it('adds HIPAA for INSURANCE', () => {
    const ids = getComplianceControlIds('INSURANCE');
    expect(ids).toContain('HIPAA-164.312');
  });

  it('adds multiple type-specific controls for LEGAL', () => {
    const ids = getComplianceControlIds('LEGAL');
    expect(ids).toContain('ISO27001-A.14');
    // eIDAS-35 is already universal, but LEGAL also maps it — no duplicates via Set
    const unique = [...new Set(ids)];
    expect(ids).toEqual(unique);
  });

  it('handles null credential type', () => {
    const ids = getComplianceControlIds(null);
    expect(ids.length).toBe(7); // universal only
  });

  it('handles undefined credential type', () => {
    const ids = getComplianceControlIds(undefined);
    expect(ids.length).toBe(7);
  });

  it('returns string array suitable for JSONB storage', () => {
    const ids = getComplianceControlIds('DEGREE');
    expect(Array.isArray(ids)).toBe(true);
    for (const id of ids) {
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    }
  });

  it('matches frontend control IDs', () => {
    // Ensure worker IDs match what frontend expects
    const ids = getComplianceControlIds('DEGREE');
    const knownFrontendIds = [
      'SOC2-CC6.1', 'SOC2-CC6.7', 'GDPR-5.1f', 'GDPR-25',
      'ISO27001-A.10', 'eIDAS-25', 'eIDAS-35', 'FERPA-99.31',
    ];
    for (const expected of knownFrontendIds) {
      expect(ids).toContain(expected);
    }
  });
});
