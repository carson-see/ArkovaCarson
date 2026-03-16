/**
 * AI Extraction Feedback Endpoint (P8-S6)
 *
 * POST /api/v1/ai/feedback — Store user corrections to AI suggestions
 * GET  /api/v1/ai/feedback/accuracy — Get extraction accuracy stats
 *
 * Constitution 4A: Only field keys/values stored, no document content.
 */

import { Router, Request, Response } from 'express';
import { FeedbackBatchSchema, storeExtractionFeedback, getExtractionAccuracy } from '../../ai/feedback.js';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

const router = Router();

// POST / — Store extraction feedback
router.post('/', async (req: Request, res: Response) => {
  const userId = req.authUserId;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const parsed = FeedbackBatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'validation_error',
      details: parsed.error.issues.map((i) => ({
        field: i.path.join('.'),
        message: i.message,
      })),
    });
    return;
  }

  try {
    // Get org_id from profile — require org membership for feedback
    const { data: profile } = await db
      .from('profiles')
      .select('org_id')
      .eq('id', userId)
      .single();

    if (!profile?.org_id) {
      res.status(403).json({ error: 'Organization membership required' });
      return;
    }

    const result = await storeExtractionFeedback(profile.org_id, userId, parsed.data.items);

    res.json({
      stored: result.stored,
      errors: result.errors,
      total: parsed.data.items.length,
    });
  } catch (err) {
    logger.error({ error: err, userId }, 'Failed to store extraction feedback');
    res.status(500).json({ error: 'Failed to store feedback' });
  }
});

// GET /accuracy — Get extraction accuracy stats
router.get('/accuracy', async (req: Request, res: Response) => {
  const userId = req.authUserId;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    const { data: profile } = await db
      .from('profiles')
      .select('org_id')
      .eq('id', userId)
      .single();

    if (!profile?.org_id) {
      res.status(403).json({ error: 'Organization membership required' });
      return;
    }

    const credentialType = req.query.credentialType as string | undefined;
    const rawDays = Number.parseInt(req.query.days as string, 10) || 30;
    const days = Math.max(1, Math.min(rawDays, 365));

    const stats = await getExtractionAccuracy(credentialType, profile.org_id, days);
    res.json({ stats, days });
  } catch (err) {
    logger.error({ error: err }, 'Failed to get accuracy stats');
    res.status(500).json({ error: 'Failed to get accuracy stats' });
  }
});

export { router as aiFeedbackRouter };
