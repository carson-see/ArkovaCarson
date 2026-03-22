/**
 * GET /api/v1/usage (P4.5-TS-08)
 *
 * Returns current month's API usage for the requesting key's org.
 * Aggregates across all org API keys.
 */

import { Router } from 'express';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { getCurrentMonth, getNextResetDate } from '../../middleware/usageTracking.js';

const router = Router();

const FREE_TIER_MONTHLY_QUOTA = 10_000;

export interface UsageResponse {
  used: number;
  limit: number | 'unlimited';
  remaining: number | 'unlimited';
  reset_date: string;
  month: string;
  keys: Array<{
    key_prefix: string;
    name: string;
    used: number;
  }>;
}

/**
 * GET /api/v1/usage
 */
router.get('/', async (req, res) => {
  if (!req.apiKey) {
    res.status(401).json({
      error: 'authentication_required',
      message: 'API key required to check usage',
    });
    return;
  }

  const { orgId, rateLimitTier } = req.apiKey;
  const month = getCurrentMonth();

  try {
    // Get all API keys for this org
    const { data: orgKeys, error: keysError } = await db
      .from('api_keys')
      .select('id, key_prefix, name')
      .eq('org_id', orgId)
      .eq('is_active', true);

    if (keysError) {
      logger.error({ error: keysError, orgIdPrefix: orgId?.slice(0, 8) }, 'Failed to fetch org keys for usage');
      res.status(500).json({ error: 'internal_error', message: 'Failed to retrieve usage' });
      return;
    }

    const keys = orgKeys ?? [];

    // Get usage for all keys this month
    const keyIds = keys.map((k) => k.id);
    let usageRows: Array<{ api_key_id: string; request_count: number }> = [];

    if (keyIds.length > 0) {
      const { data: usageData } = await db
        .from('api_key_usage')
        .select('api_key_id, request_count')
        .in('api_key_id', keyIds)
        .eq('month', month);

      usageRows = usageData ?? [];
    }

    // Build per-key usage map
    const usageMap = new Map<string, number>();
    for (const row of usageRows) {
      usageMap.set(row.api_key_id, row.request_count);
    }

    // Aggregate
    const totalUsed = usageRows.reduce((sum, r) => sum + r.request_count, 0);
    const quota = rateLimitTier === 'free' ? FREE_TIER_MONTHLY_QUOTA : Infinity;

    const response: UsageResponse = {
      used: totalUsed,
      limit: quota === Infinity ? 'unlimited' : quota,
      remaining: quota === Infinity ? 'unlimited' : Math.max(0, quota - totalUsed),
      reset_date: getNextResetDate(),
      month,
      keys: keys.map((k) => ({
        key_prefix: k.key_prefix,
        name: k.name ?? '',
        used: usageMap.get(k.id) ?? 0,
      })),
    };

    res.json(response);
  } catch (err) {
    logger.error({ error: err, orgIdPrefix: orgId?.slice(0, 8) }, 'Usage lookup failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to retrieve usage' });
  }
});

export { router as usageRouter };
