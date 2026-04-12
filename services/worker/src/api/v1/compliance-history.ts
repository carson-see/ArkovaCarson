/**
 * Compliance Score History API (NCE-16)
 *
 * GET /api/v1/compliance/history — returns score history for the caller's org
 *
 * Jira: SCRUM-607
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { getCallerOrgId } from '../../compliance/auth-helpers.js';

const router = Router();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbAny = db as any;

const HistoryQuerySchema = z.object({
  jurisdiction: z.string().min(2).max(50).optional(),
  industry: z.string().min(1).max(50).optional(),
  days: z.coerce.number().int().min(1).max(365).default(90),
});

router.get('/', async (req: Request, res: Response) => {
  const parsed = HistoryQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  const { jurisdiction, industry, days } = parsed.data;

  try {
    const orgId = await getCallerOrgId(req, res);
    if (!orgId) return;

    const since = new Date(Date.now() - days * 86_400_000).toISOString();

    let query = dbAny
      .from('compliance_scores')
      .select('score, grade, jurisdiction_code, industry_code, last_calculated, present_documents, missing_documents')
      .eq('org_id', orgId)
      .gte('last_calculated', since)
      .order('last_calculated', { ascending: false });

    if (jurisdiction) {
      query = query.eq('jurisdiction_code', jurisdiction);
    }
    if (industry) {
      query = query.eq('industry_code', industry);
    }

    const { data, error } = await query;

    if (error) {
      logger.error({ error }, 'Failed to fetch compliance history');
      res.status(500).json({ error: 'Failed to fetch history' });
      return;
    }

    res.json({
      history: data ?? [],
      count: data?.length ?? 0,
      period_days: days,
      filters: { jurisdiction: jurisdiction ?? null, industry: industry ?? null },
    });
  } catch (err) {
    logger.error({ error: err }, 'Unexpected error fetching compliance history');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as complianceHistoryRouter };
