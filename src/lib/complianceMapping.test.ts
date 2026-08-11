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
    expect(ids).toContain('FERPA-99.31-DL');
    expect(ids).toContain('FERPA-99.37');
  });

  it('includes FERPA for TRANSCRIPT type', () => {
    const controls = getComplianceControls('TRANSCRIPT', true);
    const ids = controls.map(c => c.id);
    expect(ids).toContain('FERPA-99.31');
    expect(ids).toContain('FERPA-99.31-DL');
    expect(ids).toContain('FERPA-99.37');
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
    expect(ids).toContain('HIPAA-164.312-MFA');
    expect(ids).toContain('HIPAA-164.312-AUDIT');
    expect(ids).toContain('HIPAA-164.312-SESSION');
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
    // Tracks the full INTL expansion (INTL-01..03 LGPD + PDPA + LFPDPPP). New
    // frameworks added to complianceMapping.ts must also land here.
    // SCRUM-2283: 'EU-US DPF' removed — Arkova holds no active DPF certification,
    // so it is no longer a valid framework (false external-status claim).
    const validFrameworks = [
      'SOC 2',
      'GDPR',
      'FERPA',
      'ISO 27001',
      'eIDAS',
      'HIPAA',
      'Kenya DPA',
      'APP',
      'POPIA',
      'NDPA',
      'LGPD',
      'PDPA',
      'LFPDPPP',
    ];
    for (const control of Object.values(COMPLIANCE_CONTROLS)) {
      expect(validFrameworks).toContain(control.framework);
    }
  });

  it('SCRUM-2283: defines no EU-US DPF control (false external-status claim removed)', () => {
    for (const [id, control] of Object.entries(COMPLIANCE_CONTROLS)) {
      expect(id.startsWith('DPF-')).toBe(false);
      // 'EU-US DPF' is no longer in the framework union type — compare as string.
      expect(control.framework as string).not.toBe('EU-US DPF');
    }
  });

  it('includes international framework controls (REG-27)', () => {
    expect(COMPLIANCE_CONTROLS['KENYA-DPA-25']).toBeDefined();
    expect(COMPLIANCE_CONTROLS['KENYA-DPA-25'].framework).toBe('Kenya DPA');
    expect(COMPLIANCE_CONTROLS['KENYA-DPA-48']).toBeDefined();
    expect(COMPLIANCE_CONTROLS['APP-8']).toBeDefined();
    expect(COMPLIANCE_CONTROLS['APP-8'].framework).toBe('APP');
    expect(COMPLIANCE_CONTROLS['APP-11']).toBeDefined();
    expect(COMPLIANCE_CONTROLS['APP-13']).toBeDefined();
    expect(COMPLIANCE_CONTROLS['POPIA-19']).toBeDefined();
    expect(COMPLIANCE_CONTROLS['POPIA-19'].framework).toBe('POPIA');
    expect(COMPLIANCE_CONTROLS['POPIA-72']).toBeDefined();
    expect(COMPLIANCE_CONTROLS['NDPA-24']).toBeDefined();
    expect(COMPLIANCE_CONTROLS['NDPA-24'].framework).toBe('NDPA');
    expect(COMPLIANCE_CONTROLS['NDPA-43']).toBeDefined();
  });

  it('includes FERPA sub-controls for disclosure log and opt-out (REG-26)', () => {
    expect(COMPLIANCE_CONTROLS['FERPA-99.31-DL']).toBeDefined();
    expect(COMPLIANCE_CONTROLS['FERPA-99.31-DL'].framework).toBe('FERPA');
    expect(COMPLIANCE_CONTROLS['FERPA-99.37']).toBeDefined();
    expect(COMPLIANCE_CONTROLS['FERPA-99.37'].framework).toBe('FERPA');
  });

  it('includes HIPAA sub-controls for MFA, audit, and session (REG-26)', () => {
    expect(COMPLIANCE_CONTROLS['HIPAA-164.312-MFA']).toBeDefined();
    expect(COMPLIANCE_CONTROLS['HIPAA-164.312-AUDIT']).toBeDefined();
    expect(COMPLIANCE_CONTROLS['HIPAA-164.312-SESSION']).toBeDefined();
  });

  /**
   * R-7 claims gate (CLAUDE.md §1.13) / §1.5.
   *
   * A control *description* is a factual statement about Arkova's control
   * environment, unlike the control ID itself — which `COMPLIANCE_CONTROLS_NOTE`
   * explicitly disclaims as an informational credential-type mapping and NOT an
   * attestation. So a description may describe the control's subject matter, but
   * it may not assert that we operate the control unless we actually do.
   *
   * MFA is NOT enforced: the login-challenge enforcement shipped in PR #1973 was
   * reverted in 6d10032b4 after an MFA lockout incident, there is no `aal2` check
   * anywhere in the app or worker, and `useHipaaMfaGate` has zero non-test
   * importers. Enrollment is *available* (TwoFactorSetup is wired into
   * SettingsPage) but opt-in and unenforced.
   *
   * Automatic logoff is NOT enforced either: `useIdleTimeout` has zero non-test
   * importers, so `organizations.session_timeout_minutes` is stored and never
   * acted on.
   *
   * This pins the wording so a future edit cannot silently reintroduce the claim.
   */
  it('does not assert unimplemented controls as enforced (R-7 claims gate)', () => {
    const mfa = COMPLIANCE_CONTROLS['HIPAA-164.312-MFA'].description;
    expect(mfa).not.toMatch(/enforced/i);
    expect(mfa).toMatch(/not enforced|available|opt-in/i);

    const session = COMPLIANCE_CONTROLS['HIPAA-164.312-SESSION'].description;
    expect(session).not.toMatch(/\benforced\b/i);
    expect(session).toMatch(/not enforced|configurable|not currently/i);
  });

  it('no control description claims enforcement language we cannot evidence', () => {
    // Blanket ratchet: a detector beats a human census (memory: lint-rule-beats-
    // human-census). Any NEW control added with "enforced"/"guaranteed" wording
    // must be justified here deliberately rather than slipping in unreviewed.
    const offenders = Object.values(COMPLIANCE_CONTROLS)
      .filter((c) => /\b(enforced|guaranteed|certified|accredited)\b/i.test(c.description))
      .map((c) => c.id);
    expect(offenders).toEqual([]);
  });
});
