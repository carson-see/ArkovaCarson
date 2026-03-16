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

const UuidSchema = z.string().uuid();

/** Threshold below which items are auto-flagged for review */
const REVIEW_THRESHOLD = 60;

/** Helper: get profile and verify org membership */
async function getOrgProfile(userId: string) {
  const { data: profile } = await db
    .from('profiles')
    .select('org_id')
    .eq('id', userId)
    .single();
  return profile;
}

/** Helper: verify anchor belongs to the caller's org */
async function verifyAnchorOwnership(anchorId: string, orgId: string): Promise<boolean> {
  const { count } = await db
    .from('anchors')
    .select('id', { count: 'exact', head: true })
    .eq('id', anchorId)
    .eq('org_id', orgId);
  return (count ?? 0) > 0;
}

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
    const profile = await getOrgProfile(userId);
    const orgId = profile?.org_id ?? undefined;

    if (!orgId) {
      res.status(403).json({ error: 'Organization membership required' });
      return;
    }

    // Verify anchor belongs to caller's org (cross-tenant protection)
    const owns = await verifyAnchorOwnership(parsed.data.anchorId, orgId);
    if (!owns) {
      res.status(404).json({ error: 'Anchor not found' });
      return;
    }

    const result = await computeIntegrityScore(parsed.data.anchorId, orgId);
    const stored = await upsertIntegrityScore(parsed.data.anchorId, orgId, result);

    // Auto-create review item if score is below threshold
    if (result.overallScore < REVIEW_THRESHOLD) {
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
  const uuidParsed = UuidSchema.safeParse(anchorId);
  if (!uuidParsed.success) {
    res.status(400).json({ error: 'Invalid anchorId format' });
    return;
  }

  try {
    // Verify org ownership before returning score
    const profile = await getOrgProfile(userId);
    if (!profile?.org_id) {
      res.status(403).json({ error: 'Organization membership required' });
      return;
    }

    const owns = await verifyAnchorOwnership(anchorId, profile.org_id);
    if (!owns) {
      res.status(404).json({ error: 'No integrity score found for this anchor' });
      return;
    }

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
