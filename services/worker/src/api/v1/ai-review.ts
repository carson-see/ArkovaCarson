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
import { z } from 'zod';
import {
  listReviewItems,
  updateReviewItem,
  getReviewQueueStats,
  ReviewActionSchema,
} from '../../ai/review-queue.js';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

const router = Router();

const VALID_STATUSES = ['PENDING', 'INVESTIGATING', 'ESCALATED', 'APPROVED', 'DISMISSED'] as const;
const UuidSchema = z.string().uuid();

/** Helper: get profile with org + role */
async function getAdminProfile(userId: string) {
  const { data: profile } = await db
    .from('profiles')
    .select('org_id, role')
    .eq('id', userId)
    .single();
  return profile;
}

// GET / — List review queue items
router.get('/', async (req: Request, res: Response) => {
  const userId = req.authUserId;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    const profile = await getAdminProfile(userId);

    if (!profile?.org_id) {
      res.status(403).json({ error: 'Organization membership required' });
      return;
    }

    if (profile.role !== 'ORG_ADMIN') {
      res.status(403).json({ error: 'Admin access required to view review queue' });
      return;
    }

    const statusParam = req.query.status as string | undefined;
    const status = statusParam && VALID_STATUSES.includes(statusParam as typeof VALID_STATUSES[number])
      ? statusParam as typeof VALID_STATUSES[number]
      : undefined;
    const limit = Math.max(1, Math.min(Number.parseInt(req.query.limit as string, 10) || 20, 100));
    const offset = Math.max(0, Number.parseInt(req.query.offset as string, 10) || 0);

    const items = await listReviewItems({
      orgId: profile.org_id,
      status,
      limit,
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
    const profile = await getAdminProfile(userId);

    if (!profile?.org_id) {
      res.status(403).json({ error: 'Organization membership required' });
      return;
    }

    if (profile.role !== 'ORG_ADMIN') {
      res.status(403).json({ error: 'Admin access required to view queue stats' });
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
  const uuidParsed = UuidSchema.safeParse(itemId);
  if (!uuidParsed.success) {
    res.status(400).json({ error: 'Invalid itemId format' });
    return;
  }

  try {
    const profile = await getAdminProfile(userId);

    if (!profile?.org_id || profile.role !== 'ORG_ADMIN') {
      res.status(403).json({ error: 'Admin access required to review items' });
      return;
    }

    const parsed = ReviewActionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'validation_error', details: parsed.error.issues });
      return;
    }

    // Pass org_id for cross-tenant protection
    const success = await updateReviewItem(
      itemId,
      profile.org_id,
      userId,
      parsed.data.action,
      parsed.data.notes,
    );

    if (!success) {
      res.status(404).json({ error: 'Review item not found' });
      return;
    }

    res.json({ success: true, itemId, action: parsed.data.action });
  } catch (err) {
    logger.error({ error: err, itemId }, 'Failed to update review item');
    res.status(500).json({ error: 'Failed to update review item' });
  }
});

export { router as aiReviewRouter };
