/**
 * Industry Benchmarking API (NCE-17)
 *
 * GET /api/v1/compliance/benchmark — anonymous aggregate comparison
 *
 * Jira: SCRUM-608
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { computeBenchmark } from '../../compliance/benchmarking.js';

const router = Router();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbAny = db as any;

const BenchmarkQuerySchema = z.object({
  jurisdiction: z.string().min(2).max(50),
  industry: z.string().min(1).max(50),
});

router.get('/', async (req: Request, res: Response) => {
  const parsed = BenchmarkQuerySchema.safeParse(req.query);
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

    // Get caller's own score
    const { data: ownScore } = await dbAny
      .from('compliance_scores')
      .select('score')
      .eq('org_id', membership.org_id)
      .eq('jurisdiction_code', jurisdiction)
      .eq('industry_code', industry)
      .single();

    if (!ownScore) {
      res.status(404).json({ error: 'No score calculated yet. Calculate your compliance score first.' });
      return;
    }

    // Get all peer scores (anonymized — exclude caller's org)
    const { data: peerData, error } = await dbAny
      .from('compliance_scores')
      .select('score')
      .eq('jurisdiction_code', jurisdiction)
      .eq('industry_code', industry)
      .neq('org_id', membership.org_id);

    if (error) {
      logger.error({ error }, 'Failed to fetch benchmark data');
      res.status(500).json({ error: 'Failed to fetch benchmark data' });
      return;
    }

    const peerScores = (peerData ?? []).map((r: { score: number }) => r.score);
    const result = computeBenchmark({ orgScore: ownScore.score, peerScores });

    if (!result) {
      res.json({
        available: false,
        reason: 'Insufficient data — minimum 5 organizations required for anonymous benchmarking',
        jurisdiction,
        industry,
      });
      return;
    }

    res.json({
      available: true,
      your_score: ownScore.score,
      percentile: result.percentile,
      industry_average: result.industry_average,
      top_quartile_threshold: result.top_quartile_threshold,
      org_count: result.org_count,
      jurisdiction,
      industry,
    });
  } catch (err) {
    logger.error({ error: err }, 'Unexpected error in benchmark');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as complianceBenchmarkRouter };
