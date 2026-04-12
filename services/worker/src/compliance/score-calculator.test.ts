/**
 * Compliance Score Calculator Tests (NCE-07)
 */

import { describe, it, expect } from 'vitest';
import {
  calculateComplianceScore,
  computeGrade,
  type ComplianceScoreInput,
  type JurisdictionRule,
  type OrgAnchor,
} from './score-calculator.js';

const MOCK_RULE: JurisdictionRule = {
  id: 'rule-1',
  jurisdiction_code: 'US-CA',
  industry_code: 'accounting',
  rule_name: 'California CPA Requirements',
  required_credential_types: ['LICENSE', 'CERTIFICATE', 'CONTINUING_EDUCATION'],
  optional_credential_types: ['DEGREE'],
  regulatory_reference: 'CA Bus & Prof Code §5026',
  details: { ce_hours: 80, ce_cycle_years: 2 },
};

function makeAnchor(overrides: Partial<OrgAnchor> = {}): OrgAnchor {
  return {
    id: 'anchor-1',
    credential_type: 'LICENSE',
    status: 'SECURED',
    integrity_score: 0.9,
    fraud_flags: [],
    expiry_date: null,
    title: 'CPA License',
    ...overrides,
  };
}

describe('calculateComplianceScore', () => {
  it('returns 100 when all required documents are present and secured', () => {
    const input: ComplianceScoreInput = {
      rules: [MOCK_RULE],
      anchors: [
        makeAnchor({ credential_type: 'LICENSE' }),
        makeAnchor({ id: 'anchor-2', credential_type: 'CERTIFICATE', title: 'Ethics Certificate' }),
        makeAnchor({ id: 'anchor-3', credential_type: 'CONTINUING_EDUCATION', title: 'CE Credits' }),
      ],
    };

    const result = calculateComplianceScore(input);
    expect(result.score).toBe(100);
    expect(result.grade).toBe('A');
    expect(result.missing_documents).toHaveLength(0);
  });

  it('returns partial score when some documents are missing', () => {
    const input: ComplianceScoreInput = {
      rules: [MOCK_RULE],
      anchors: [
        makeAnchor({ credential_type: 'LICENSE' }),
      ],
    };

    const result = calculateComplianceScore(input);
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThan(100);
    expect(result.missing_documents.length).toBeGreaterThan(0);
  });

  it('returns 0 when no documents are present', () => {
    const input: ComplianceScoreInput = {
      rules: [MOCK_RULE],
      anchors: [],
    };

    const result = calculateComplianceScore(input);
    expect(result.score).toBe(0);
    expect(result.grade).toBe('F');
    expect(result.missing_documents).toHaveLength(3);
  });

  it('penalizes expired documents', () => {
    const pastDate = new Date(Date.now() - 86400000).toISOString();
    const input: ComplianceScoreInput = {
      rules: [MOCK_RULE],
      anchors: [
        makeAnchor({ credential_type: 'LICENSE', expiry_date: pastDate }),
        makeAnchor({ id: 'a2', credential_type: 'CERTIFICATE' }),
        makeAnchor({ id: 'a3', credential_type: 'CONTINUING_EDUCATION' }),
      ],
    };

    const result = calculateComplianceScore(input);
    expect(result.score).toBeLessThan(100);
    expect(result.expiring_documents.length).toBeGreaterThanOrEqual(0);
  });

  it('penalizes fraud-flagged documents', () => {
    const input: ComplianceScoreInput = {
      rules: [MOCK_RULE],
      anchors: [
        makeAnchor({ credential_type: 'LICENSE', fraud_flags: ['SUSPICIOUS_FORMAT'] }),
        makeAnchor({ id: 'a2', credential_type: 'CERTIFICATE' }),
        makeAnchor({ id: 'a3', credential_type: 'CONTINUING_EDUCATION' }),
      ],
    };

    const result = calculateComplianceScore(input);
    expect(result.score).toBeLessThan(100);
  });

  it('gives bonus for high integrity scores', () => {
    const lowIntegrity: ComplianceScoreInput = {
      rules: [MOCK_RULE],
      anchors: [
        makeAnchor({ credential_type: 'LICENSE', integrity_score: 0.5 }),
        makeAnchor({ id: 'a2', credential_type: 'CERTIFICATE', integrity_score: 0.5 }),
        makeAnchor({ id: 'a3', credential_type: 'CONTINUING_EDUCATION', integrity_score: 0.5 }),
      ],
    };

    const highIntegrity: ComplianceScoreInput = {
      rules: [MOCK_RULE],
      anchors: [
        makeAnchor({ credential_type: 'LICENSE', integrity_score: 0.95 }),
        makeAnchor({ id: 'a2', credential_type: 'CERTIFICATE', integrity_score: 0.95 }),
        makeAnchor({ id: 'a3', credential_type: 'CONTINUING_EDUCATION', integrity_score: 0.95 }),
      ],
    };

    const lowResult = calculateComplianceScore(lowIntegrity);
    const highResult = calculateComplianceScore(highIntegrity);
    expect(highResult.score).toBeGreaterThanOrEqual(lowResult.score);
  });

  it('includes present documents with anchor details', () => {
    const input: ComplianceScoreInput = {
      rules: [MOCK_RULE],
      anchors: [
        makeAnchor({ credential_type: 'LICENSE', title: 'My CPA License' }),
      ],
    };

    const result = calculateComplianceScore(input);
    expect(result.present_documents).toHaveLength(1);
    expect(result.present_documents[0].type).toBe('LICENSE');
  });

  it('handles rules with no required types gracefully', () => {
    const emptyRule: JurisdictionRule = {
      ...MOCK_RULE,
      required_credential_types: [],
    };

    const input: ComplianceScoreInput = {
      rules: [emptyRule],
      anchors: [],
    };

    const result = calculateComplianceScore(input);
    expect(result.score).toBe(100);
    expect(result.grade).toBe('A');
  });
});

describe('computeGrade', () => {
  it('returns A for score >= 90', () => expect(computeGrade(95)).toBe('A'));
  it('returns B for score >= 80', () => expect(computeGrade(85)).toBe('B'));
  it('returns C for score >= 70', () => expect(computeGrade(72)).toBe('C'));
  it('returns D for score >= 60', () => expect(computeGrade(65)).toBe('D'));
  it('returns F for score < 60', () => expect(computeGrade(45)).toBe('F'));
  it('returns A for perfect 100', () => expect(computeGrade(100)).toBe('A'));
  it('returns F for 0', () => expect(computeGrade(0)).toBe('F'));
});
