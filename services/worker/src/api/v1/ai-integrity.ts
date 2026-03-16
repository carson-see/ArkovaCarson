/**
 * AI Integrity Score Endpoint (P8-S8)
 *
 * POST /api/v1/ai/integrity/compute — Compute integrity score for an anchor
 * GET  /api/v1/ai/integrity/:anchorId — Get integrity score for an anchor
 *
 * Scores are computed server-side and stored via service_role.
 * Constitution 4A: Only metadata analyzed, no document content.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import {
  computeIntegrityScore,
  upsertIntegrityScore,
  getIntegrityScore,
} from '../../ai/integrity.js';
import { createReviewItem } from '../../ai/review-queue.js';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

const router = Router();

const ComputeRequestSchema = z.object({
  anchorId: z.string().uuid(),
});

/** Threshold below which items are auto-flagged for review */
const REVIEW_THRESHOLD = 60;

// POST /compute — Compute integrity score
router.post('/compute', async (req: Request, res: Response) => {
  const userId = req.authUserId;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const parsed = ComputeRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'validation_error', details: parsed.error.issues });
    return;
  }

  try {
    // Get org_id from profile
    const { data: profile } = await db
      .from('profiles')
      .select('org_id')
      .eq('id', userId)
      .single();

    const orgId = profile?.org_id ?? undefined;
    const result = await computeIntegrityScore(parsed.data.anchorId, orgId);
    const stored = await upsertIntegrityScore(parsed.data.anchorId, orgId, result);

    // Auto-create review item if score is below threshold
    if (result.overallScore < REVIEW_THRESHOLD && orgId) {
      // Get the integrity score record ID for linking
      const scoreRecord = await getIntegrityScore(parsed.data.anchorId);
      await createReviewItem(
        parsed.data.anchorId,
        orgId,
        scoreRecord?.id ?? null,
        `Integrity score ${result.overallScore}/100 (${result.level}) — below review threshold`,
        result.flags,
        result.overallScore < 40 ? 8 : 5,
      );
    }

    res.json({
      anchorId: parsed.data.anchorId,
      score: result.overallScore,
      level: result.level,
      breakdown: result.breakdown,
      flags: result.flags,
      stored,
    });
  } catch (err) {
    logger.error({ error: err }, 'Failed to compute integrity score');
    res.status(500).json({ error: 'Failed to compute integrity score' });
  }
});

// GET /:anchorId — Get integrity score
router.get('/:anchorId', async (req: Request, res: Response) => {
  const userId = req.authUserId;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const { anchorId } = req.params;
  if (!anchorId) {
    res.status(400).json({ error: 'anchorId is required' });
    return;
  }

  try {
    const score = await getIntegrityScore(anchorId);
    if (!score) {
      res.status(404).json({ error: 'No integrity score found for this anchor' });
      return;
    }

    res.json(score);
  } catch (err) {
    logger.error({ error: err, anchorId }, 'Failed to get integrity score');
    res.status(500).json({ error: 'Failed to get integrity score' });
  }
});

export { router as aiIntegrityRouter };
