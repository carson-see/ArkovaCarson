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
   * MFA is no longer a blanket "not enforced" story (SCRUM-3167): AuthGuard +
   * mfaPolicy.ts + useMfaEnrollmentRequirement enforce a real login challenge
   * and mandatory enrollment, ROLE-GATED to ORG_ADMIN/platform admins, from the
   * resolved enforcement date (2026-09-21T00:00:00Z by default). The claim this
   * control's description may make is therefore narrower than "enforced" and
   * narrower than the old "not enforced" too — it must name exactly who it is
   * required for and from when, and say plainly that it is NOT YET required for
   * everyone else. Org-level enforcement remains out of scope on purpose (CTO
   * ruling A4-3) — no description may imply an org can mandate this today.
   *
   * Automatic logoff is still NOT enforced: `useIdleTimeout` has zero non-test
   * importers, so `organizations.session_timeout_minutes` is stored and never
   * acted on.
   *
   * This pins the wording so a future edit cannot silently overclaim.
   */
  it('does not assert unimplemented controls as enforced (R-7 claims gate)', () => {
    const mfa = COMPLIANCE_CONTROLS['HIPAA-164.312-MFA'].description;
    expect(mfa).not.toMatch(/\benforced\b/i);
    expect(mfa).toMatch(/available/i);

    const session = COMPLIANCE_CONTROLS['HIPAA-164.312-SESSION'].description;
    expect(session).not.toMatch(/\benforced\b/i);
    expect(session).toMatch(/not enforced|configurable|not currently/i);
  });

  it('HIPAA-164.312-MFA states the real, narrow enforcement boundary — required for two roles from a date, not yet required for anyone else (SCRUM-3167)', () => {
    const mfa = COMPLIANCE_CONTROLS['HIPAA-164.312-MFA'].description;
    // Item 34 (PR #2637 review): the date is no longer a hardcoded literal
    // — it's built from mfaPolicy.ts's resolveMfaEnforceFrom() at module
    // evaluation, so this can never drift from the ACTUAL enforcement date
    // if VITE_MFA_ENFORCE_FROM moves it. Matched by pattern, not a literal
    // "2026-09-21", so the test does not itself go stale the day the
    // baked default is superseded by an env override.
    expect(mfa).toMatch(
      /required for organization administrators and platform administrators from \d{4}-\d{2}-\d{2}/i,
    );
    expect(mfa).toContain('not yet required for other roles');
    // Item 11/C3 (R-7 / §1.5 measured vs asserted): the claim must disclose
    // what kind of "required" this is — an application-level sign-in gate
    // that fails open on a platform error, not a database-level control —
    // and that the stronger control is only PLANNED, under SCRUM-3593.
    expect(mfa).toMatch(/application-level sign-in gate/i);
    expect(mfa).toMatch(/fails open on platform errors/i);
    expect(mfa).toContain('SCRUM-3593');
  });

  it('no control description claims enforcement language we cannot evidence', () => {
    // Blanket ratchet: a detector beats a human census (memory: lint-rule-beats-
    // human-census). Any NEW control added with "enforced"/"guaranteed"/
    // "certified"/"accredited" wording must be justified here deliberately
    // rather than slipping in unreviewed. Deliberately NOT extended to
    // "required": several international-framework controls (POPIA-72,
    // LFPDPPP-36, ...) legitimately use it to describe what the REGULATION
    // requires of a transfer, which is a citation of external law, not an
    // Arkova self-claim needing evidence — a blanket ban would flag those as
    // false positives. HIPAA-164.312-MFA's specific "required" self-claim (it
    // IS a claim that Arkova enforces something, unlike the framework
    // citations) is pinned precisely by the dedicated test above instead.
    //
    // Item 16/B3 (PR #2637 review): restored to the BARE substring
    // `/enforced/i` (not `/\benforced\b/i`) — the narrower word-boundary
    // form would let a future description slip in a word like "unenforced"
    // undetected. HIPAA-164.312-MFA's own text (with the item 34/11
    // additions above) contains "enforcement" but never the substring
    // "enforced", so the bare form still passes today.
    const offenders = Object.values(COMPLIANCE_CONTROLS)
      .filter((c) => /(enforced|guaranteed|certified|accredited)/i.test(c.description))
      .map((c) => c.id);
    expect(offenders).toEqual([]);
  });
});
