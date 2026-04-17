/**
 * Compliance Audit PDF Export (NCA-09)
 *
 * Client-side PDF generation — documents never leave the user's device
 * (Constitution 1.6). Renders the latest compliance audit as a
 * US Letter (8.5 x 11 in) document using jsPDF.
 *
 * The generator returns the filename it wrote, and also returns the
 * generated jsPDF instance so unit tests can inspect pages / size
 * without touching the DOM.
 *
 * Jira: SCRUM-764 (NCA-09)
 */

import jsPDF from 'jspdf';

export interface AuditPdfInput {
  id: string;
  overall_score: number;
  overall_grade: string;
  completed_at: string | null;
  started_at: string;
  per_jurisdiction: Array<{
    jurisdiction_code: string;
    industry_code: string;
    score: number;
    grade: string;
  }>;
  gaps: Array<{
    type: string;
    category: string;
    severity: string;
    jurisdiction_code: string;
    requirement: string;
    regulatory_reference: string | null;
    remediation_hint: string;
  }>;
  metadata?: {
    recommendations?: {
      recommendations: Array<{
        title: string;
        description: string;
        expected_score_improvement: number;
        effort_hours: number;
        affected_jurisdictions: string[];
        group: string;
      }>;
      overflow_count: number;
    };
  };
}

export interface AuditPdfContext {
  orgName: string;
}

export interface AuditPdfResult {
  filename: string;
  doc: jsPDF;
  pageCount: number;
}

const DISCLAIMER =
  'This report reflects credential status as of the audit date. It is not legal advice.';

export function generateAuditPdf(audit: AuditPdfInput, ctx: AuditPdfContext): AuditPdfResult {
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 54;
  let y = margin;

  // Header
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.text('Compliance Audit Report', margin, y);
  y += 24;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.setTextColor(90);
  doc.text(`Organization: ${ctx.orgName}`, margin, y);
  y += 14;
  const dateStr = audit.completed_at ? new Date(audit.completed_at).toLocaleDateString() : new Date(audit.started_at).toLocaleDateString();
  doc.text(`Audit date: ${dateStr}`, margin, y);
  y += 14;
  doc.text(`Audit ID: ${audit.id}`, margin, y);
  y += 24;

  // Overall score block
  doc.setTextColor(0);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.text('Overall compliance score', margin, y);
  y += 20;
  doc.setFontSize(36);
  doc.setTextColor(gradeColor(audit.overall_grade));
  doc.text(`${audit.overall_score} / 100`, margin, y);
  y += 8;
  doc.setFontSize(14);
  doc.text(`Grade ${audit.overall_grade}`, margin + 180, y - 8);
  doc.setTextColor(0);
  y += 16;

  // Per-jurisdiction
  y = ensurePageSpace(doc, y, 120, margin);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text('Per-jurisdiction scores', margin, y);
  y += 16;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  for (const p of audit.per_jurisdiction) {
    y = ensurePageSpace(doc, y, 14, margin);
    doc.text(
      `${p.jurisdiction_code} (${p.industry_code}): ${p.score} / 100 · Grade ${p.grade}`,
      margin,
      y,
    );
    y += 12;
  }
  y += 12;

  // Gaps
  y = ensurePageSpace(doc, y, 80, margin);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text(`Open compliance gaps (${audit.gaps.length})`, margin, y);
  y += 16;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  if (audit.gaps.length === 0) {
    doc.text('None. All required credentials are present and valid.', margin, y);
    y += 14;
  }
  for (const g of audit.gaps) {
    y = ensurePageSpace(doc, y, 42, margin);
    doc.setFont('helvetica', 'bold');
    doc.text(
      `[${g.severity.toUpperCase()}] ${g.category} — ${g.type} (${g.jurisdiction_code})`,
      margin,
      y,
    );
    y += 12;
    doc.setFont('helvetica', 'normal');
    const reqLines = doc.splitTextToSize(g.requirement, pageWidth - margin * 2);
    doc.text(reqLines, margin, y);
    y += reqLines.length * 12;
    if (g.regulatory_reference) {
      const refLines = doc.splitTextToSize(`Ref: ${g.regulatory_reference}`, pageWidth - margin * 2);
      doc.text(refLines, margin, y);
      y += refLines.length * 12;
    }
    const hintLines = doc.splitTextToSize(`Next step: ${g.remediation_hint}`, pageWidth - margin * 2);
    doc.text(hintLines, margin, y);
    y += hintLines.length * 12 + 6;
  }

  // Recommendations (NCA-05)
  const recs = audit.metadata?.recommendations?.recommendations ?? [];
  if (recs.length > 0) {
    y = ensurePageSpace(doc, y, 60, margin);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.text('Recommended actions', margin, y);
    y += 16;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    for (const r of recs) {
      y = ensurePageSpace(doc, y, 36, margin);
      doc.setFont('helvetica', 'bold');
      doc.text(`[${r.group}] ${r.title}`, margin, y);
      y += 12;
      doc.setFont('helvetica', 'normal');
      const descLines = doc.splitTextToSize(r.description, pageWidth - margin * 2);
      doc.text(descLines, margin, y);
      y += descLines.length * 12;
      doc.text(
        `Estimated score improvement: +${r.expected_score_improvement} pts · Effort: ~${r.effort_hours}h · Affects: ${r.affected_jurisdictions.join(', ')}`,
        margin,
        y,
      );
      y += 16;
    }
    const overflow = audit.metadata?.recommendations?.overflow_count ?? 0;
    if (overflow > 0) {
      y = ensurePageSpace(doc, y, 16, margin);
      doc.setFont('helvetica', 'italic');
      doc.text(`${overflow} additional recommendation${overflow === 1 ? '' : 's'} not shown.`, margin, y);
      y += 16;
    }
  }

  // Disclaimer footer on every page.
  stampFooter(doc, ctx, margin);

  const filename = buildFilename(ctx.orgName, audit);
  return { filename, doc, pageCount: doc.getNumberOfPages() };
}

export function downloadAuditPdf(audit: AuditPdfInput, ctx: AuditPdfContext): AuditPdfResult {
  const result = generateAuditPdf(audit, ctx);
  result.doc.save(result.filename);
  return result;
}

function ensurePageSpace(doc: jsPDF, y: number, needed: number, margin: number): number {
  const pageHeight = doc.internal.pageSize.getHeight();
  if (y + needed > pageHeight - margin) {
    doc.addPage();
    return margin;
  }
  return y;
}

function stampFooter(doc: jsPDF, ctx: AuditPdfContext, margin: number): void {
  const pages = doc.getNumberOfPages();
  const pageHeight = doc.internal.pageSize.getHeight();
  const pageWidth = doc.internal.pageSize.getWidth();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(8);
    doc.setTextColor(120);
    const footer = `${ctx.orgName} · Arkova · ${DISCLAIMER}`;
    const lines = doc.splitTextToSize(footer, pageWidth - margin * 2);
    doc.text(lines, margin, pageHeight - 28);
    doc.text(`${i} / ${pages}`, pageWidth - margin, pageHeight - 28, { align: 'right' });
  }
}

function buildFilename(orgName: string, audit: AuditPdfInput): string {
  const slug = orgName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'organization';
  const dateIso = (audit.completed_at ?? audit.started_at).slice(0, 10);
  return `arkova-compliance-audit-${slug}-${dateIso}.pdf`;
}

function gradeColor(grade: string): string {
  switch (grade) {
    case 'A': return '#059669';
    case 'B': return '#2563eb';
    case 'C': return '#d97706';
    case 'D': return '#ea580c';
    case 'F': return '#dc2626';
    default: return '#000000';
  }
}
