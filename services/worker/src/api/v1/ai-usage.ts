/**
 * AI Usage Endpoint (P8-S2)
 *
 * GET /api/v1/ai/usage — Returns AI credit balance and usage stats.
 * Requires Supabase JWT auth.
 */

import { Router, Request, Response } from 'express';
import { checkAICredits } from '../../ai/cost-tracker.js';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

const router = Router();

router.get('/', async (req: Request, res: Response) => {
  const userId = req.authUserId;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
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

    // Get credit balance
    const credits = await checkAICredits(orgId, userId);

    // Get recent usage events (table not yet in generated types — use any bypass)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query = (db as any)
      .from('ai_usage_events')
      .select('event_type, provider, credits_consumed, success, created_at')
      .order('created_at', { ascending: false })
      .limit(50);

    if (orgId) {
      query = query.eq('org_id', orgId);
    } else {
      query = query.eq('user_id', userId);
    }

    const { data: recentEvents } = await query;

    res.json({
      credits: credits ?? {
        monthlyAllocation: 0,
        usedThisMonth: 0,
        remaining: 0,
        hasCredits: false,
      },
      recentEvents: recentEvents ?? [],
    });
  } catch (err) {
    logger.error({ error: err }, 'Failed to fetch AI usage');
    res.status(500).json({ error: 'Failed to fetch AI usage data' });
  }
});

export { router as aiUsageRouter };
