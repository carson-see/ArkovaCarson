/**
 * Jurisdiction Rules API (NCE-06)
 *
 * GET /api/v1/compliance/rules
 *
 * Returns jurisdiction-specific document requirements for compliance scoring.
 * Public read — no auth required.
 *
 * Jira: SCRUM-596
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

const router = Router();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbAny = db as any;

const RulesQuerySchema = z.object({
  jurisdiction: z.string().min(2).max(50).optional(),
  industry: z.string().min(1).max(50).optional(),
});

router.get('/', async (req: Request, res: Response) => {
  const parsed = RulesQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  const { jurisdiction, industry } = parsed.data;

  try {
    let query = dbAny
      .from('jurisdiction_rules')
      .select('*');

    if (jurisdiction) {
      query = query.eq('jurisdiction_code', jurisdiction);
    }
    if (industry) {
      query = query.eq('industry_code', industry);
    }

    query = query.limit(500);
    const { data, error } = await query;

    if (error) {
      logger.error({ error }, 'Failed to fetch jurisdiction rules');
      res.status(500).json({ error: 'Failed to fetch jurisdiction rules' });
      return;
    }

    res.json({
      rules: data ?? [],
      count: data?.length ?? 0,
      filters: { jurisdiction: jurisdiction ?? null, industry: industry ?? null },
    });
  } catch (err) {
    logger.error({ error: err }, 'Unexpected error fetching jurisdiction rules');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as complianceRulesRouter };
