/**
 * Tests for Worker-Side Compliance Mapping (CML-02)
 */

import { describe, it, expect } from 'vitest';
import {
  COMPLIANCE_CONTROLS_NOTE,
  RETIRED_CONTROL_IDS,
  getComplianceControlIds,
  sanitizeStoredComplianceControls,
} from './complianceMapping.js';

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

  it('never emits the retired EU-US DPF controls (SCRUM-2283)', () => {
    // Arkova holds no active EU-US Data Privacy Framework certification. These
    // were removed from the frontend mapping under SCRUM-2283 as a false
    // external-status claim; the worker mirror kept emitting them, so every
    // SECURED anchor persisted the claim into `anchors.compliance_controls`.
    for (const type of [null, 'OTHER', 'DEGREE', 'LEGAL', 'INSURANCE', 'FINANCIAL']) {
      const ids = getComplianceControlIds(type);
      expect(ids).not.toContain('DPF-NOTICE');
      expect(ids).not.toContain('DPF-ACCOUNTABILITY');
    }
  });

  it('adds FERPA for DEGREE', () => {
    const ids = getComplianceControlIds('DEGREE');
    expect(ids).toContain('FERPA-99.31');
    expect(ids).toContain('FERPA-99.31-DL');
    expect(ids).toContain('FERPA-99.37');
    expect(ids).toHaveLength(10);
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
    expect(ids).toContain('HIPAA-164.312-MFA');
    expect(ids).toContain('HIPAA-164.312-AUDIT');
    expect(ids).toContain('HIPAA-164.312-SESSION');
  });

  it('adds multiple type-specific controls for LEGAL', () => {
    const ids = getComplianceControlIds('LEGAL');
    expect(ids).toContain('ISO27001-A.14');
    // eIDAS-35 is already universal, but LEGAL also maps it — no duplicates via Set
    const unique = [...new Set(ids)];
    expect(ids).toEqual(unique);
  });

  it('adds LGPD and PDPA for INSURANCE', () => {
    const ids = getComplianceControlIds('INSURANCE');
    expect(ids).toContain('LGPD-6');
    expect(ids).toContain('PDPA-24');
  });

  it('adds LGPD and LFPDPPP for FINANCIAL', () => {
    const ids = getComplianceControlIds('FINANCIAL');
    expect(ids).toContain('LGPD-6');
    expect(ids).toContain('LFPDPPP-6');
  });

  it('adds international transfer controls for LEGAL', () => {
    const ids = getComplianceControlIds('LEGAL');
    expect(ids).toContain('LGPD-33');
    expect(ids).toContain('PDPA-26');
    expect(ids).toContain('LFPDPPP-36');
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
      'ISO27001-A.10', 'eIDAS-25', 'eIDAS-35',
      'FERPA-99.31', 'FERPA-99.31-DL', 'FERPA-99.37',
    ];
    expect([...ids].sort()).toEqual([...knownFrontendIds].sort());
  });
});

describe('sanitizeStoredComplianceControls', () => {
  it('drops retired control IDs already persisted on historical anchors', () => {
    const stored = ['SOC2-CC6.1', 'DPF-NOTICE', 'GDPR-25', 'DPF-ACCOUNTABILITY'];
    expect(sanitizeStoredComplianceControls(stored)).toEqual(['SOC2-CC6.1', 'GDPR-25']);
  });

  it('returns null when every stored ID is retired', () => {
    expect(sanitizeStoredComplianceControls([...RETIRED_CONTROL_IDS])).toBeNull();
  });

  it('returns null for null, undefined, empty, and non-array values', () => {
    expect(sanitizeStoredComplianceControls(null)).toBeNull();
    expect(sanitizeStoredComplianceControls(undefined)).toBeNull();
    expect(sanitizeStoredComplianceControls([])).toBeNull();
    // Legacy/object-shaped values are passed through untouched rather than
    // silently reshaped — the API must not invent a shape it did not store.
    expect(sanitizeStoredComplianceControls({ soc2: ['CC6.1'] })).toEqual({ soc2: ['CC6.1'] });
  });

  it('drops non-string entries', () => {
    expect(sanitizeStoredComplianceControls(['SOC2-CC6.1', 42, null])).toEqual(['SOC2-CC6.1']);
  });
});

describe('COMPLIANCE_CONTROLS_NOTE', () => {
  it('states that control IDs are informational and NOT an attestation', () => {
    expect(COMPLIANCE_CONTROLS_NOTE).toMatch(/informational/i);
    expect(COMPLIANCE_CONTROLS_NOTE).toMatch(/not an? (audit|attestation)/i);
  });

  it('explicitly disclaims eIDAS qualified status (the named misread risk)', () => {
    expect(COMPLIANCE_CONTROLS_NOTE).toMatch(/eIDAS/);
    expect(COMPLIANCE_CONTROLS_NOTE).toMatch(/qualified/i);
  });

  it('asserts no certification or conformity assessment', () => {
    expect(COMPLIANCE_CONTROLS_NOTE).toMatch(/certif/i);
    expect(COMPLIANCE_CONTROLS_NOTE).toMatch(/conformity assessment/i);
  });
});
