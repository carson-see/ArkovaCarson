/**
 * Audit-Ready Report Generator (NCE-18)
 *
 * Builds structured compliance reports for SOC 2, FERPA, HIPAA, and general audits.
 * Returns structured JSON; PDF rendering delegated to VAI-03 infrastructure.
 *
 * Jira: SCRUM-609
 */

import type { ComplianceScoreResult } from './score-calculator.js';
import type { GapDetectorResult } from './gap-detector.js';
import type { CrossRefResult } from './cross-reference.js';

export type ReportTemplate = 'general' | 'soc2' | 'hipaa' | 'ferpa';

export interface AuditReportInput {
  orgName: string;
  jurisdiction: string;
  industry: string;
  template: ReportTemplate;
  score: ComplianceScoreResult;
  gaps: GapDetectorResult;
  crossRefFindings: CrossRefResult;
  generatedAt: string;
}

export interface AuditReport {
  metadata: {
    org_name: string;
    jurisdiction: string;
    industry: string;
    template: ReportTemplate;
    generated_at: string;
    report_version: string;
  };
  sections: string[];
  content: Record<string, string>;
}

const TEMPLATE_HEADERS: Record<ReportTemplate, string> = {
  general: 'Compliance Posture Report',
  soc2: 'SOC 2 Trust Services Compliance Report',
  hipaa: 'HIPAA Security & Privacy Compliance Report',
  ferpa: 'FERPA Education Records Compliance Report',
};

const TEMPLATE_SUMMARIES: Record<ReportTemplate, string> = {
  general: 'This report presents the current compliance posture of the organization, including document inventory, gap analysis, and risk assessment.',
  soc2: 'This SOC 2 compliance report evaluates the organization against Trust Services Criteria (TSC) for Security, Availability, Processing Integrity, Confidentiality, and Privacy.',
  hipaa: 'This HIPAA compliance report assesses the organization\'s adherence to the Health Insurance Portability and Accountability Act, covering Administrative, Physical, and Technical Safeguards.',
  ferpa: 'This FERPA compliance report evaluates the organization\'s handling of education records under the Family Educational Rights and Privacy Act.',
};

export function buildAuditReport(input: AuditReportInput): AuditReport {
  const { orgName, jurisdiction, industry, template, score, gaps, crossRefFindings, generatedAt } = input;

  const sections = [
    'executive_summary',
    'compliance_score',
    'document_inventory',
    'gap_analysis',
    'expiring_documents',
    'cross_reference',
  ];

  const content: Record<string, string> = {};

  // Executive Summary
  content.executive_summary = [
    `# ${TEMPLATE_HEADERS[template]}`,
    '',
    `**Organization:** ${orgName}`,
    `**Jurisdiction:** ${jurisdiction}`,
    `**Industry:** ${industry}`,
    `**Report Date:** ${new Date(generatedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`,
    '',
    TEMPLATE_SUMMARIES[template],
    '',
    `**Overall Compliance Score:** ${score.score}/100 (Grade: ${score.grade})`,
    `**Documents Present:** ${score.total_present} of ${score.total_required} required`,
    `**Gaps Identified:** ${gaps.missing_required.length} missing required documents`,
    `**Cross-Reference Findings:** ${crossRefFindings.findings.length} inconsistencies detected`,
  ].join('\n');

  // Compliance Score
  content.compliance_score = [
    '## Compliance Score Breakdown',
    '',
    `**Score:** ${score.score}/100`,
    `**Grade:** ${score.grade}`,
    '',
    '### Present Documents',
    ...score.present_documents.map(d =>
      `- **${d.type}**: ${d.title ?? 'Untitled'} (Status: ${d.status}, Integrity: ${d.integrity_score ?? 'N/A'})`
    ),
    '',
    '### Missing Documents',
    ...score.missing_documents.map(d =>
      `- **${d.type}**: ${d.requirement} (Impact: +${d.score_impact} points)${d.regulatory_reference ? ` — ${d.regulatory_reference}` : ''}`
    ),
  ].join('\n');

  // Document Inventory
  content.document_inventory = [
    '## Document Inventory',
    '',
    `Total documents analyzed: ${score.total_present + score.missing_documents.length}`,
    `Verified and anchored: ${score.total_present}`,
    `Missing: ${score.missing_documents.length}`,
    `Expiring within 90 days: ${score.expiring_documents.length}`,
  ].join('\n');

  // Gap Analysis
  content.gap_analysis = [
    '## Gap Analysis',
    '',
    gaps.summary,
    '',
    '### Required Documents Missing',
    ...gaps.missing_required.map(g =>
      `- **${g.type}**: ${g.requirement}${g.regulatory_reference ? ` (${g.regulatory_reference})` : ''} — Impact: +${g.score_impact} points`
    ),
    '',
    '### Recommended Documents',
    ...(gaps.missing_recommended.length > 0
      ? gaps.missing_recommended.map(g => `- **${g.type}**: ${g.requirement}`)
      : ['None — all recommended documents are present.']),
  ].join('\n');

  // Expiring Documents
  content.expiring_documents = [
    '## Expiring Documents',
    '',
    ...(score.expiring_documents.length > 0
      ? score.expiring_documents.map(d =>
          `- **${d.title ?? d.type}**: Expires ${new Date(d.expiry_date).toLocaleDateString()} (${d.days_remaining} days remaining)`
        )
      : ['No documents expiring within the next 90 days.']),
  ].join('\n');

  // Cross-Reference Findings
  content.cross_reference = [
    '## Cross-Reference Findings',
    '',
    `Documents analyzed: ${crossRefFindings.documents_analyzed}`,
    `Findings: ${crossRefFindings.findings.length}`,
    '',
    ...(crossRefFindings.findings.length > 0
      ? crossRefFindings.findings.map(f =>
          `- **[${f.severity}]** ${f.type}: ${f.description}`
        )
      : ['No inconsistencies detected across documents.']),
  ].join('\n');

  return {
    metadata: {
      org_name: orgName,
      jurisdiction,
      industry,
      template,
      generated_at: generatedAt,
      report_version: '1.0.0',
    },
    sections,
    content,
  };
}
