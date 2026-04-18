/**
 * NCA-09 generateAuditPdf — verify filename, pagination, and content presence.
 *
 * We don't render the PDF visually; instead we assert that the underlying
 * jsPDF instance recorded the expected strings in its internal text stream.
 */
import { describe, expect, it } from 'vitest';
import { generateAuditPdf, type AuditPdfInput } from './compliancePdf';

function baseAudit(overrides: Partial<AuditPdfInput> = {}): AuditPdfInput {
  return {
    id: 'aud-1',
    overall_score: 72,
    overall_grade: 'C',
    completed_at: '2026-04-17T00:00:00Z',
    started_at: '2026-04-17T00:00:00Z',
    per_jurisdiction: [
      { jurisdiction_code: 'US-CA', industry_code: 'accounting', score: 80, grade: 'B' },
      { jurisdiction_code: 'US-NY', industry_code: 'accounting', score: 60, grade: 'D' },
    ],
    gaps: [
      { type: 'LICENSE', category: 'MISSING', severity: 'critical', jurisdiction_code: 'US-NY', requirement: 'Required: LICENSE', regulatory_reference: 'NY Educ Law §7404', remediation_hint: 'Upload the current license issued by the regulating board.' },
      { type: 'CERTIFICATE', category: 'EXPIRING_SOON', severity: 'high', jurisdiction_code: 'US-CA', requirement: 'Renew CERTIFICATE', regulatory_reference: null, remediation_hint: 'Provide the certificate.' },
    ],
    metadata: {
      recommendations: {
        recommendations: [
          { title: 'Upload missing LICENSE', description: 'Upload the board-issued license', expected_score_improvement: 18, effort_hours: 4, affected_jurisdictions: ['US-NY'], group: 'CRITICAL' },
        ],
        overflow_count: 0,
      },
    },
    ...overrides,
  };
}

describe('NCA-09 generateAuditPdf', () => {
  it('produces a PDF with a filename matching the required pattern', () => {
    const r = generateAuditPdf(baseAudit(), { orgName: 'Acme Corp' });
    expect(r.filename).toBe('arkova-compliance-audit-acme-corp-2026-04-17.pdf');
    expect(r.pageCount).toBeGreaterThanOrEqual(1);
  });

  it('handles organisation names with punctuation by slugging safely', () => {
    const r = generateAuditPdf(baseAudit(), { orgName: 'Foo & Bar, Inc.' });
    expect(r.filename).toBe('arkova-compliance-audit-foo-bar-inc-2026-04-17.pdf');
  });

  it('falls back to "organization" when the org name slug is empty', () => {
    const r = generateAuditPdf(baseAudit(), { orgName: '!!!' });
    expect(r.filename).toBe('arkova-compliance-audit-organization-2026-04-17.pdf');
  });

  it('includes headline sections and the disclaimer in the PDF body', () => {
    const r = generateAuditPdf(baseAudit(), { orgName: 'Acme' });
    const output = r.doc.output();
    // Strings embedded via .text() end up as literals in the PDF stream.
    expect(output).toContain('Compliance Audit Report');
    expect(output).toContain('Overall compliance score');
    expect(output).toContain('Per-jurisdiction scores');
    expect(output).toContain('Open compliance gaps');
    expect(output).toContain('Recommended actions');
    expect(output).toContain('not legal advice');
  });

  it('produces multiple pages when given many gaps and recommendations', () => {
    const manyGaps = Array.from({ length: 50 }, (_, i) => ({
      type: `TYPE_${i}`,
      category: 'MISSING',
      severity: 'medium',
      jurisdiction_code: 'US-CA',
      requirement: `Required: TYPE_${i}`,
      regulatory_reference: null,
      remediation_hint: 'Resolve this gap by uploading a valid document that matches the requirement set out by the regulator. The document must include issuer, dates, and identifiers.',
    }));
    const r = generateAuditPdf(baseAudit({ gaps: manyGaps }), { orgName: 'Acme Corp' });
    expect(r.pageCount).toBeGreaterThan(1);
  });

  it('survives an audit with zero gaps and zero recommendations', () => {
    const r = generateAuditPdf(
      baseAudit({ gaps: [], metadata: {} }),
      { orgName: 'Acme Corp' },
    );
    const output = r.doc.output();
    expect(output).toContain('None. All required credentials are present and valid.');
  });
});
