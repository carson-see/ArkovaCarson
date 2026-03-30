/**
 * Tests for Compliance Mapping (CML-01)
 */

import { describe, it, expect } from 'vitest';
import {
  getComplianceControls,
  getComplianceFrameworks,
  COMPLIANCE_CONTROLS,
} from './complianceMapping';

describe('getComplianceControls', () => {
  it('returns empty array when not secured', () => {
    expect(getComplianceControls('DEGREE', false)).toEqual([]);
  });

  it('returns universal controls for any secured credential', () => {
    const controls = getComplianceControls('OTHER', true);
    const ids = controls.map(c => c.id);

    expect(ids).toContain('SOC2-CC6.1');
    expect(ids).toContain('SOC2-CC6.7');
    expect(ids).toContain('GDPR-5.1f');
    expect(ids).toContain('GDPR-25');
    expect(ids).toContain('ISO27001-A.10');
    expect(ids).toContain('eIDAS-25');
    expect(ids).toContain('eIDAS-35');
  });

  it('includes FERPA for DEGREE type', () => {
    const controls = getComplianceControls('DEGREE', true);
    const ids = controls.map(c => c.id);
    expect(ids).toContain('FERPA-99.31');
  });

  it('includes FERPA for TRANSCRIPT type', () => {
    const controls = getComplianceControls('TRANSCRIPT', true);
    const ids = controls.map(c => c.id);
    expect(ids).toContain('FERPA-99.31');
  });

  it('includes ISO A.14 for LICENSE type', () => {
    const controls = getComplianceControls('LICENSE', true);
    const ids = controls.map(c => c.id);
    expect(ids).toContain('ISO27001-A.14');
  });

  it('includes HIPAA for INSURANCE type', () => {
    const controls = getComplianceControls('INSURANCE', true);
    const ids = controls.map(c => c.id);
    expect(ids).toContain('HIPAA-164.312');
  });

  it('does not include FERPA for non-education types', () => {
    const controls = getComplianceControls('FINANCIAL', true);
    const ids = controls.map(c => c.id);
    expect(ids).not.toContain('FERPA-99.31');
  });

  it('handles null credential type gracefully', () => {
    const controls = getComplianceControls(null, true);
    expect(controls.length).toBeGreaterThan(0);
    // Should still return universal controls
    expect(controls.map(c => c.id)).toContain('SOC2-CC6.1');
  });

  it('handles undefined credential type', () => {
    const controls = getComplianceControls(undefined, true);
    expect(controls.length).toBeGreaterThan(0);
  });

  it('returns no duplicates', () => {
    const controls = getComplianceControls('LEGAL', true);
    const ids = controls.map(c => c.id);
    const uniqueIds = [...new Set(ids)];
    expect(ids).toEqual(uniqueIds);
  });

  it('every returned control has required fields', () => {
    const controls = getComplianceControls('DEGREE', true);
    for (const control of controls) {
      expect(control.id).toBeTruthy();
      expect(control.framework).toBeTruthy();
      expect(control.label).toBeTruthy();
      expect(control.description).toBeTruthy();
      expect(control.color).toBeTruthy();
    }
  });
});

describe('getComplianceFrameworks', () => {
  it('returns empty array when not secured', () => {
    expect(getComplianceFrameworks('DEGREE', false)).toEqual([]);
  });

  it('returns unique framework names', () => {
    const frameworks = getComplianceFrameworks('DEGREE', true);
    expect(frameworks).toContain('SOC 2');
    expect(frameworks).toContain('GDPR');
    expect(frameworks).toContain('ISO 27001');
    expect(frameworks).toContain('eIDAS');
    expect(frameworks).toContain('FERPA');
    // No duplicates
    expect(frameworks.length).toBe(new Set(frameworks).size);
  });

  it('includes HIPAA only for INSURANCE', () => {
    const insuranceFrameworks = getComplianceFrameworks('INSURANCE', true);
    const otherFrameworks = getComplianceFrameworks('OTHER', true);
    expect(insuranceFrameworks).toContain('HIPAA');
    expect(otherFrameworks).not.toContain('HIPAA');
  });
});

describe('COMPLIANCE_CONTROLS', () => {
  it('has at least 10 controls defined', () => {
    expect(Object.keys(COMPLIANCE_CONTROLS).length).toBeGreaterThanOrEqual(10);
  });

  it('all controls have valid framework values', () => {
    const validFrameworks = ['SOC 2', 'GDPR', 'FERPA', 'ISO 27001', 'eIDAS', 'HIPAA'];
    for (const control of Object.values(COMPLIANCE_CONTROLS)) {
      expect(validFrameworks).toContain(control.framework);
    }
  });
});
