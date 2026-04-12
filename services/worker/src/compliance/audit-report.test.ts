/**
 * Audit Report Generator Tests (NCE-18)
 */

import { describe, it, expect } from 'vitest';
import { buildAuditReport, type AuditReportInput } from './audit-report.js';

const MOCK_INPUT: AuditReportInput = {
  orgName: 'Acme Corp',
  jurisdiction: 'US-CA',
  industry: 'accounting',
  template: 'general',
  score: { score: 72, grade: 'C', present_documents: [], missing_documents: [], expiring_documents: [], total_required: 10, total_present: 7 },
  gaps: { missing_required: [{ type: 'CONTINUING_EDUCATION', requirement: 'Required', regulatory_reference: 'CA Bus & Prof §5026', score_impact: 15, peer_adoption_pct: null }], missing_recommended: [], priority_order: ['CONTINUING_EDUCATION'], summary: 'Missing 3 docs' },
  crossRefFindings: { findings: [], documents_analyzed: 5 },
  generatedAt: '2026-04-12T00:00:00Z',
};

describe('buildAuditReport', () => {
  it('produces a report with all required sections', () => {
    const report = buildAuditReport(MOCK_INPUT);
    expect(report.sections).toContain('executive_summary');
    expect(report.sections).toContain('compliance_score');
    expect(report.sections).toContain('document_inventory');
    expect(report.sections).toContain('gap_analysis');
    expect(report.sections).toContain('expiring_documents');
    expect(report.sections).toContain('cross_reference');
  });

  it('includes org name and jurisdiction in metadata', () => {
    const report = buildAuditReport(MOCK_INPUT);
    expect(report.metadata.org_name).toBe('Acme Corp');
    expect(report.metadata.jurisdiction).toBe('US-CA');
  });

  it('supports SOC 2 template variant', () => {
    const report = buildAuditReport({ ...MOCK_INPUT, template: 'soc2' });
    expect(report.metadata.template).toBe('soc2');
    expect(report.content.executive_summary).toContain('SOC 2');
  });

  it('supports HIPAA template variant', () => {
    const report = buildAuditReport({ ...MOCK_INPUT, template: 'hipaa' });
    expect(report.metadata.template).toBe('hipaa');
    expect(report.content.executive_summary).toContain('HIPAA');
  });

  it('supports FERPA template variant', () => {
    const report = buildAuditReport({ ...MOCK_INPUT, template: 'ferpa' });
    expect(report.metadata.template).toBe('ferpa');
    expect(report.content.executive_summary).toContain('FERPA');
  });

  it('includes score and grade in compliance_score section', () => {
    const report = buildAuditReport(MOCK_INPUT);
    expect(report.content.compliance_score).toContain('72');
    expect(report.content.compliance_score).toContain('C');
  });

  it('includes gap analysis details', () => {
    const report = buildAuditReport(MOCK_INPUT);
    expect(report.content.gap_analysis).toContain('CONTINUING_EDUCATION');
  });
});
