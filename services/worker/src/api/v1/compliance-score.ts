/**
 * Compliance Score API (NCE-07)
 *
 * GET /api/v1/compliance/score — returns compliance score for the caller's org
 *
 * Jira: SCRUM-597
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { calculateComplianceScore, type OrgAnchor, type JurisdictionRule } from '../../compliance/score-calculator.js';

const router = Router();

const ScoreQuerySchema = z.object({
  jurisdiction: z.string().min(2).max(50),
  industry: z.string().min(1).max(50),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbAny = db as any;

router.get('/', async (req: Request, res: Response) => {
  const parsed = ScoreQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  if (!req.authUserId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const { jurisdiction, industry } = parsed.data;

  try {
    // Get caller's org
    const { data: membership } = await dbAny
      .from('org_members')
      .select('org_id')
      .eq('user_id', req.authUserId)
      .single();

    if (!membership?.org_id) {
      res.status(403).json({ error: 'Must belong to an organization' });
      return;
    }

    const orgId = membership.org_id;

    // Check for cached score (less than 1hr old)
    const { data: cached } = await dbAny
      .from('compliance_scores')
      .select('*')
      .eq('org_id', orgId)
      .eq('jurisdiction_code', jurisdiction)
      .eq('industry_code', industry)
      .single();

    if (cached && cached.last_calculated) {
      const age = Date.now() - new Date(cached.last_calculated).getTime();
      if (age < 3_600_000) {
        res.json({
          score: cached.score,
          grade: cached.grade,
          jurisdiction: cached.jurisdiction_code,
          industry: cached.industry_code,
          present_documents: cached.present_documents,
          missing_documents: cached.missing_documents,
          expiring_documents: cached.expiring_documents,
          recommendations: cached.recommendations,
          last_calculated: cached.last_calculated,
          cached: true,
        });
        return;
      }
    }

    // Load jurisdiction rules
    const { data: rules, error: rulesError } = await dbAny
      .from('jurisdiction_rules')
      .select('*')
      .eq('jurisdiction_code', jurisdiction)
      .eq('industry_code', industry);

    if (rulesError || !rules?.length) {
      res.status(404).json({ error: `No rules found for ${jurisdiction} / ${industry}` });
      return;
    }

    // Load org's SECURED anchors
    const { data: anchors, error: anchorsError } = await dbAny
      .from('anchors')
      .select('id, credential_type, status, integrity_score, fraud_flags, not_after, title')
      .eq('org_id', orgId)
      .eq('status', 'SECURED');

    if (anchorsError) {
      logger.error({ error: anchorsError }, 'Failed to load org anchors for scoring');
      res.status(500).json({ error: 'Failed to load documents' });
      return;
    }

    const orgAnchors: OrgAnchor[] = (anchors ?? []).map((a: Record<string, unknown>) => ({
      id: a.id as string,
      credential_type: (a.credential_type as string) ?? 'OTHER',
      status: a.status as string,
      integrity_score: a.integrity_score as number | null,
      fraud_flags: (a.fraud_flags as string[]) ?? [],
      expiry_date: (a.not_after as string) ?? null,
      title: (a.title as string) ?? null,
    }));

    const result = calculateComplianceScore({
      rules: rules as JurisdictionRule[],
      anchors: orgAnchors,
    });

    // Upsert score to DB
    const { error: upsertError } = await dbAny
      .from('compliance_scores')
      .upsert({
        org_id: orgId,
        jurisdiction_code: jurisdiction,
        industry_code: industry,
        score: result.score,
        grade: result.grade,
        present_documents: result.present_documents,
        missing_documents: result.missing_documents,
        expiring_documents: result.expiring_documents,
        recommendations: [],
        last_calculated: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, {
        onConflict: 'org_id,jurisdiction_code,industry_code',
      });

    if (upsertError) {
      logger.warn({ error: upsertError }, 'Failed to cache compliance score');
    }

    res.json({
      score: result.score,
      grade: result.grade,
      jurisdiction,
      industry,
      present_documents: result.present_documents,
      missing_documents: result.missing_documents,
      expiring_documents: result.expiring_documents,
      total_required: result.total_required,
      total_present: result.total_present,
      recommendations: [],
      last_calculated: new Date().toISOString(),
      cached: false,
    });
  } catch (err) {
    logger.error({ error: err }, 'Unexpected error calculating compliance score');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as complianceScoreRouter };
