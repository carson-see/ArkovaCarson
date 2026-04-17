import { describe, expect, it } from 'vitest';
import { calculateOrgAudit, type OrgAuditInput } from './org-audit.js';
import type { JurisdictionRule, OrgAnchor } from './score-calculator.js';

const PAST = new Date(Date.now() - 30 * 86_400_000).toISOString();
const SOON = new Date(Date.now() + 10 * 86_400_000).toISOString(); // within 90 days

function anchor(partial: Partial<OrgAnchor>): OrgAnchor {
  return {
    id: partial.id ?? 'a1',
    credential_type: partial.credential_type ?? 'LICENSE',
    status: partial.status ?? 'SECURED',
    integrity_score: partial.integrity_score ?? 0.9,
    fraud_flags: partial.fraud_flags ?? [],
    expiry_date: partial.expiry_date ?? null,
    title: partial.title ?? 'Test Anchor',
  };
}

const CA_ACCOUNTING_RULE: JurisdictionRule = {
  id: 'r1',
  jurisdiction_code: 'US-CA',
  industry_code: 'accounting',
  rule_name: 'CA CPA',
  required_credential_types: ['LICENSE', 'CERTIFICATE', 'CONTINUING_EDUCATION'],
  optional_credential_types: ['DEGREE'],
  regulatory_reference: 'CA Bus & Prof Code §5026',
  details: {},
};

const NY_ACCOUNTING_RULE: JurisdictionRule = {
  id: 'r2',
  jurisdiction_code: 'US-NY',
  industry_code: 'accounting',
  rule_name: 'NY CPA',
  required_credential_types: ['LICENSE', 'CONTINUING_EDUCATION'],
  optional_credential_types: [],
  regulatory_reference: 'NY Educ Law §7404',
  details: {},
};

describe('NCA-03 calculateOrgAudit', () => {
  it('produces 100% when all requirements met across multiple jurisdictions', () => {
    const input: OrgAuditInput = {
      orgId: 'org-1',
      jurisdictions: [
        { jurisdiction_code: 'US-CA', industry_code: 'accounting' },
        { jurisdiction_code: 'US-NY', industry_code: 'accounting' },
      ],
      rules: [CA_ACCOUNTING_RULE, NY_ACCOUNTING_RULE],
      anchors: [
        anchor({ id: 'a-lic', credential_type: 'LICENSE' }),
        anchor({ id: 'a-cert', credential_type: 'CERTIFICATE' }),
        anchor({ id: 'a-ce', credential_type: 'CONTINUING_EDUCATION' }),
      ],
    };
    const r = calculateOrgAudit(input);
    expect(r.overall_score).toBe(100);
    expect(r.overall_grade).toBe('A');
    expect(r.gaps.length).toBe(0);
  });

  it('weights by requirement count: a single-rule jurisdiction does not dominate', () => {
    const NY_UNIQUE_RULE: JurisdictionRule = {
      ...NY_ACCOUNTING_RULE,
      required_credential_types: ['LICENSE', 'CONTINUING_EDUCATION', 'ATTESTATION'], // NY-only requires ATTESTATION
    };
    const input: OrgAuditInput = {
      orgId: 'org-1',
      jurisdictions: [
        { jurisdiction_code: 'US-CA', industry_code: 'accounting' }, // 3 reqs, all met
        { jurisdiction_code: 'US-NY', industry_code: 'accounting' }, // 3 reqs, ATTESTATION missing
      ],
      rules: [CA_ACCOUNTING_RULE, NY_UNIQUE_RULE],
      anchors: [
        anchor({ id: 'a-lic', credential_type: 'LICENSE' }),
        anchor({ id: 'a-cert', credential_type: 'CERTIFICATE' }),
        anchor({ id: 'a-ce', credential_type: 'CONTINUING_EDUCATION' }),
      ],
    };
    const r = calculateOrgAudit(input);
    // NY missing ATTESTATION; CA full; overall is weighted mean
    expect(r.overall_score).toBeLessThan(100);
    expect(r.overall_score).toBeGreaterThan(50);
    expect(
      r.gaps.some(
        (g) => g.jurisdiction_code === 'US-NY' && g.type === 'ATTESTATION' && g.category === 'MISSING',
      ),
    ).toBe(true);
    expect(r.gaps.some((g) => g.jurisdiction_code === 'US-CA' && g.category === 'MISSING')).toBe(false);
  });

  it('emits EXPIRING_SOON gaps within 90 days', () => {
    const input: OrgAuditInput = {
      orgId: 'org-1',
      jurisdictions: [{ jurisdiction_code: 'US-CA', industry_code: 'accounting' }],
      rules: [CA_ACCOUNTING_RULE],
      anchors: [
        anchor({ id: 'a-lic', credential_type: 'LICENSE', expiry_date: SOON }),
        anchor({ id: 'a-cert', credential_type: 'CERTIFICATE' }),
        anchor({ id: 'a-ce', credential_type: 'CONTINUING_EDUCATION' }),
      ],
    };
    const r = calculateOrgAudit(input);
    const expiring = r.gaps.find((g) => g.category === 'EXPIRING_SOON');
    expect(expiring).toBeDefined();
    expect(expiring?.days_remaining).toBeGreaterThan(0);
    expect(expiring?.severity).toBe('high'); // ≤30 days → high
  });

  it('emits EXPIRED gaps for past expiry dates', () => {
    const input: OrgAuditInput = {
      orgId: 'org-1',
      jurisdictions: [{ jurisdiction_code: 'US-CA', industry_code: 'accounting' }],
      rules: [CA_ACCOUNTING_RULE],
      anchors: [
        anchor({ id: 'a-lic', credential_type: 'LICENSE', expiry_date: PAST }),
        anchor({ id: 'a-cert', credential_type: 'CERTIFICATE' }),
        anchor({ id: 'a-ce', credential_type: 'CONTINUING_EDUCATION' }),
      ],
    };
    const r = calculateOrgAudit(input);
    expect(r.gaps.some((g) => g.category === 'EXPIRED')).toBe(true);
  });

  it('emits INSUFFICIENT gaps for anchors with fraud flags', () => {
    const input: OrgAuditInput = {
      orgId: 'org-1',
      jurisdictions: [{ jurisdiction_code: 'US-CA', industry_code: 'accounting' }],
      rules: [CA_ACCOUNTING_RULE],
      anchors: [
        anchor({ id: 'a-lic', credential_type: 'LICENSE', fraud_flags: ['high_risk_issuer'] }),
        anchor({ id: 'a-cert', credential_type: 'CERTIFICATE' }),
        anchor({ id: 'a-ce', credential_type: 'CONTINUING_EDUCATION' }),
      ],
    };
    const r = calculateOrgAudit(input);
    const insuf = r.gaps.find((g) => g.category === 'INSUFFICIENT');
    expect(insuf).toBeDefined();
    expect(insuf?.severity).toBe('critical');
  });

  it('attaches quarantine caveats for HIPAA v28 and FERPA v29', () => {
    const input: OrgAuditInput = {
      orgId: 'org-1',
      jurisdictions: [{ jurisdiction_code: 'US-FEDERAL', industry_code: 'healthcare' }],
      rules: [],
      anchors: [],
      activeRegulations: [
        { regulation: 'HIPAA', version: 'v28.0' },
        { regulation: 'FERPA', version: 'v29.0' },
        { regulation: 'SOX', version: 'v1.0' }, // CLEAR, should not appear
      ],
    };
    const r = calculateOrgAudit(input);
    expect(r.quarantines.length).toBe(2);
    expect(r.quarantines.map((q) => q.regulation).sort()).toEqual(['FERPA', 'HIPAA']);
    for (const q of r.quarantines) expect(q.caveat.length).toBeGreaterThan(20);
  });

  it('sorts gaps critical → low, and EXPIRED/INSUFFICIENT before MISSING', () => {
    const input: OrgAuditInput = {
      orgId: 'org-1',
      jurisdictions: [{ jurisdiction_code: 'US-CA', industry_code: 'accounting' }],
      rules: [CA_ACCOUNTING_RULE],
      anchors: [
        anchor({ id: 'a-lic', credential_type: 'LICENSE', fraud_flags: ['bad'] }), // INSUFFICIENT + critical
        anchor({ id: 'a-cert', credential_type: 'CERTIFICATE', expiry_date: PAST }), // EXPIRED + high
        // CONTINUING_EDUCATION missing → MISSING + medium
      ],
    };
    const r = calculateOrgAudit(input);
    expect(r.gaps[0].severity).toBe('critical');
    const severities = r.gaps.map((g) => g.severity);
    // non-decreasing severity
    for (let i = 1; i < severities.length; i++) {
      const ordCurr = ['critical','high','medium','low'].indexOf(severities[i]);
      const ordPrev = ['critical','high','medium','low'].indexOf(severities[i - 1]);
      expect(ordCurr).toBeGreaterThanOrEqual(ordPrev);
    }
  });

  it('yields 100 and empty gaps for an org with no jurisdictions', () => {
    const r = calculateOrgAudit({
      orgId: 'org-1',
      jurisdictions: [],
      rules: [],
      anchors: [],
    });
    expect(r.overall_score).toBe(100);
    expect(r.gaps).toEqual([]);
    expect(r.per_jurisdiction).toEqual([]);
    expect(r.recommendations.recommendations).toEqual([]);
    expect(r.recommendations.overflow_count).toBe(0);
  });

  it('NCA-05 recommendations are attached and prioritised for each audit', () => {
    const input: OrgAuditInput = {
      orgId: 'org-1',
      jurisdictions: [{ jurisdiction_code: 'US-CA', industry_code: 'accounting' }],
      rules: [CA_ACCOUNTING_RULE],
      anchors: [
        // Missing LICENSE (critical severity), CERTIFICATE, CONTINUING_EDUCATION
      ],
    };
    const r = calculateOrgAudit(input);
    expect(r.recommendations.recommendations.length).toBeGreaterThan(0);
    expect(r.recommendations.recommendations[0].priority_score).toBeGreaterThanOrEqual(
      r.recommendations.recommendations[r.recommendations.recommendations.length - 1].priority_score,
    );
    // Every recommendation links to at least one gap key
    for (const rec of r.recommendations.recommendations) {
      expect(rec.gap_keys.length).toBeGreaterThan(0);
    }
  });

  it('handles unknown jurisdiction (no rules) with score 100 for that slot', () => {
    const r = calculateOrgAudit({
      orgId: 'org-1',
      jurisdictions: [{ jurisdiction_code: 'US-XX', industry_code: 'accounting' }],
      rules: [],
      anchors: [],
    });
    expect(r.per_jurisdiction[0].score).toBe(100);
    expect(r.per_jurisdiction[0].rule_count).toBe(0);
  });
});
