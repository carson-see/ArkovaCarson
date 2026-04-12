/**
 * Compliance Report API (NCE-18)
 *
 * POST /api/v1/compliance/report — generates audit-ready compliance report
 *
 * Jira: SCRUM-609
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { calculateComplianceScore, type OrgAnchor, type JurisdictionRule } from '../../compliance/score-calculator.js';
import { detectGaps, type GapAnchor } from '../../compliance/gap-detector.js';
import { crossReferenceDocuments, type CrossRefAnchor } from '../../compliance/cross-reference.js';
import { buildAuditReport, type ReportTemplate } from '../../compliance/audit-report.js';
import { getCallerOrgId } from '../../compliance/auth-helpers.js';

const router = Router();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbAny = db as any;

const ReportSchema = z.object({
  jurisdiction: z.string().min(2).max(50),
  industry: z.string().min(1).max(50),
  template: z.enum(['general', 'soc2', 'hipaa', 'ferpa']).default('general'),
});

router.post('/', async (req: Request, res: Response) => {
  const parsed = ReportSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  const { jurisdiction, industry, template } = parsed.data;

  try {
    const orgId = await getCallerOrgId(req, res);
    if (!orgId) return;

    const { data: org } = await dbAny
      .from('organizations')
      .select('name')
      .eq('id', orgId)
      .single();

    // Load rules + anchors in parallel
    const [rulesResult, anchorsResult] = await Promise.all([
      dbAny.from('jurisdiction_rules').select('*').eq('jurisdiction_code', jurisdiction).eq('industry_code', industry),
      dbAny.from('anchors').select('id, credential_type, status, integrity_score, fraud_flags, not_after, title, extracted_metadata, org_id').eq('org_id', orgId).eq('status', 'SECURED'),
    ]);

    if (rulesResult.error || !rulesResult.data?.length) {
      res.status(404).json({ error: `No rules found for ${jurisdiction} / ${industry}` });
      return;
    }

    const rules = rulesResult.data as JurisdictionRule[];
    const rawAnchors = anchorsResult.data ?? [];

    const orgAnchors: OrgAnchor[] = rawAnchors.map((a: Record<string, unknown>) => ({
      id: a.id as string,
      credential_type: (a.credential_type as string) ?? 'OTHER',
      status: a.status as string,
      integrity_score: a.integrity_score as number | null,
      fraud_flags: (a.fraud_flags as string[]) ?? [],
      expiry_date: (a.not_after as string) ?? null,
      title: (a.title as string) ?? null,
    }));

    const gapAnchors: GapAnchor[] = rawAnchors.map((a: Record<string, unknown>) => ({
      id: a.id as string,
      credential_type: (a.credential_type as string) ?? 'OTHER',
      status: a.status as string,
    }));

    const crossRefAnchors: CrossRefAnchor[] = rawAnchors.map((a: Record<string, unknown>) => {
      const meta = (a.extracted_metadata as Record<string, unknown>) ?? {};
      return {
        id: a.id as string,
        credential_type: (a.credential_type as string) ?? 'OTHER',
        title: (a.title as string) ?? null,
        extracted_name: (meta.holder_name as string) ?? (meta.name as string) ?? null,
        extracted_date: (meta.issue_date as string) ?? null,
        jurisdiction: (meta.jurisdiction as string) ?? null,
        org_id: a.org_id as string,
      };
    });

    // Compute all analyses
    const score = calculateComplianceScore({ rules, anchors: orgAnchors });
    const gaps = detectGaps({ rules, anchors: gapAnchors, aggregateData: null });
    const crossRefFindings = crossReferenceDocuments(crossRefAnchors);

    const report = buildAuditReport({
      orgName: org?.name ?? 'Organization',
      jurisdiction,
      industry,
      template: template as ReportTemplate,
      score,
      gaps,
      crossRefFindings,
      generatedAt: new Date().toISOString(),
    });

    // Log audit event
    try {
      await dbAny.from('audit_events').insert({
        event_type: 'COMPLIANCE_REPORT_GENERATED',
        event_category: 'COMPLIANCE',
        actor_id: req.authUserId,
        org_id: orgId,
        target_type: 'compliance_report',
        details: { template, jurisdiction, industry, score: score.score, grade: score.grade },
      });
    } catch {
      // Non-fatal
    }

    res.json(report);
  } catch (err) {
    logger.error({ error: err }, 'Unexpected error generating compliance report');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as complianceReportRouter };
