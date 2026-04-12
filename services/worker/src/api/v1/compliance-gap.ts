/**
 * Gap Analysis API (NCE-08)
 *
 * POST /api/v1/compliance/gap-analysis
 *
 * Jira: SCRUM-598
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { detectGaps, type GapAnchor } from '../../compliance/gap-detector.js';
import type { JurisdictionRule } from '../../compliance/score-calculator.js';
import { getCallerOrgId } from '../../compliance/auth-helpers.js';

const router = Router();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbAny = db as any;

const GapAnalysisSchema = z.object({
  jurisdiction: z.string().min(2).max(50),
  industry: z.string().min(1).max(50),
});

router.post('/', async (req: Request, res: Response) => {
  const parsed = GapAnalysisSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  const { jurisdiction, industry } = parsed.data;

  try {
    const orgId = await getCallerOrgId(req, res);
    if (!orgId) return;

    const [rulesResult, anchorsResult, peerResult] = await Promise.all([
      dbAny.from('jurisdiction_rules').select('*').eq('jurisdiction_code', jurisdiction).eq('industry_code', industry),
      dbAny.from('anchors').select('id, credential_type, status').eq('org_id', orgId).eq('status', 'SECURED').limit(1000),
      dbAny.from('compliance_scores').select('present_documents').eq('jurisdiction_code', jurisdiction).eq('industry_code', industry).neq('org_id', orgId).limit(500),
    ]);

    const { data: rules, error: rulesError } = rulesResult;
    if (rulesError || !rules?.length) {
      res.status(404).json({ error: `No rules found for ${jurisdiction} / ${industry}` });
      return;
    }

    const orgAnchors: GapAnchor[] = (anchorsResult.data ?? []).map((a: Record<string, unknown>) => ({
      id: a.id as string,
      credential_type: (a.credential_type as string) ?? 'OTHER',
      status: a.status as string,
    }));

    let aggregateData: Record<string, number> | null = null;
    try {
      const peerScores = peerResult.data;
      if (peerScores && peerScores.length >= 5) {
        const typeCounts: Record<string, number> = {};
        for (const score of peerScores) {
          const docs = score.present_documents as Array<{ type: string }>;
          for (const doc of docs ?? []) {
            typeCounts[doc.type] = (typeCounts[doc.type] ?? 0) + 1;
          }
        }
        aggregateData = {};
        for (const [type, count] of Object.entries(typeCounts)) {
          aggregateData[type] = Math.round((count / peerScores.length) * 100);
        }
      }
    } catch {
      // Non-fatal — proceed without aggregate data
    }

    const result = detectGaps({
      rules: rules as JurisdictionRule[],
      anchors: orgAnchors,
      aggregateData,
    });

    res.json({
      jurisdiction,
      industry,
      ...result,
    });
  } catch (err) {
    logger.error({ error: err }, 'Unexpected error in gap analysis');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as complianceGapRouter };
