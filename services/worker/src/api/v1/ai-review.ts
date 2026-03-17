/**
 * AI Review Queue Endpoint (P8-S9)
 *
 * GET    /api/v1/ai/review — List review queue items
 * GET    /api/v1/ai/review/stats — Queue statistics
 * PATCH  /api/v1/ai/review/:itemId — Apply review action
 *
 * EU AI Act: Human-in-the-loop for automated AI decisions.
 */

import { Router, Request, Response } from 'express';
import {
  listReviewItems,
  updateReviewItem,
  getReviewQueueStats,
  ReviewActionSchema,
} from '../../ai/review-queue.js';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

const router = Router();

// GET / — List review queue items
router.get('/', async (req: Request, res: Response) => {
  const userId = req.authUserId;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    const { data: profile } = await db
      .from('profiles')
      .select('org_id, role')
      .eq('id', userId)
      .single();

    if (!profile?.org_id) {
      res.status(403).json({ error: 'Organization membership required' });
      return;
    }

    if (profile.role !== 'ORG_ADMIN') {
      res.status(403).json({ error: 'Admin access required to view review queue' });
      return;
    }

    const status = req.query.status as string | undefined;
    const limit = Math.max(0, parseInt(req.query.limit as string, 10) || 20);
    const offset = Math.max(0, parseInt(req.query.offset as string, 10) || 0);

    const items = await listReviewItems({
      orgId: profile.org_id,
      status: status as 'PENDING' | 'INVESTIGATING' | 'ESCALATED' | 'APPROVED' | 'DISMISSED' | undefined,
      limit: Math.min(limit, 100),
      offset,
    });

    res.json({ items, limit, offset });
  } catch (err) {
    logger.error({ error: err }, 'Failed to list review items');
    res.status(500).json({ error: 'Failed to list review items' });
  }
});

// GET /stats — Queue statistics
router.get('/stats', async (req: Request, res: Response) => {
  const userId = req.authUserId;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    const { data: profile } = await db
      .from('profiles')
      .select('org_id, role')
      .eq('id', userId)
      .single();

    if (!profile?.org_id) {
      res.status(403).json({ error: 'Organization membership required' });
      return;
    }

    if (profile.role !== 'ORG_ADMIN') {
      res.status(403).json({ error: 'Admin access required to view review queue stats' });
      return;
    }

    const stats = await getReviewQueueStats(profile.org_id);
    res.json(stats);
  } catch (err) {
    logger.error({ error: err }, 'Failed to get queue stats');
    res.status(500).json({ error: 'Failed to get queue stats' });
  }
});

// PATCH /:itemId — Apply review action
router.patch('/:itemId', async (req: Request, res: Response) => {
  const userId = req.authUserId;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const { itemId } = req.params;
  if (!itemId) {
    res.status(400).json({ error: 'itemId is required' });
    return;
  }

  try {
    // Verify admin role
    const { data: profile } = await db
      .from('profiles')
      .select('org_id, role')
      .eq('id', userId)
      .single();

    if (!profile?.org_id || profile.role !== 'ORG_ADMIN') {
      res.status(403).json({ error: 'Admin access required to review items' });
      return;
    }

    const parsed = ReviewActionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation_error', details: parsed.error.issues });
      return;
    }

    const success = await updateReviewItem(
      itemId,
      userId,
      profile.org_id,
      parsed.data.action,
      parsed.data.notes,
    );

    if (!success) {
      res.status(500).json({ error: 'Failed to update review item' });
      return;
    }

    res.json({ success: true, itemId, action: parsed.data.action });
  } catch (err) {
    logger.error({ error: err, itemId }, 'Failed to update review item');
    res.status(500).json({ error: 'Failed to update review item' });
  }
});

export { router as aiReviewRouter };
