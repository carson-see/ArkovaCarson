import { Router, Request, Response } from 'express';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

const router = Router();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbAny = db as any;

function parseDetails(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return {};
}

router.get('/:publicId/lifecycle', async (req: Request, res: Response) => {
  const { publicId } = req.params;

  if (!publicId || publicId.length < 3) {
    res.status(400).json({ error: 'Invalid anchor ID' });
    return;
  }

  try {
    const { data: events, error } = await dbAny
      .from('audit_events')
      .select('event_type, event_category, created_at, actor_id, details')
      .eq('target_id', publicId)
      .order('created_at', { ascending: true });

    if (error) {
      logger.error({ error, publicId }, 'Lifecycle query failed');
      res.status(500).json({ error: 'Internal server error' });
      return;
    }

    const lifecycle = (events ?? []).map((e: Record<string, unknown>) => ({
      event_type: e.event_type,
      event_category: e.event_category,
      timestamp: e.created_at,
      actor_id: e.actor_id ?? null,
      details: parseDetails(e.details),
    }));

    res.json({
      public_id: publicId,
      lifecycle,
      total: lifecycle.length,
    });
  } catch (error) {
    logger.error({ error, publicId }, 'Lifecycle lookup failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as anchorLifecycleRouter };
