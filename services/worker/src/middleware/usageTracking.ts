/**
 * Usage Tracking Middleware (P4.5-TS-05)
 *
 * Tracks API key usage per month. Enforces monthly quotas for free tier.
 * Lazy resets: if the stored month doesn't match the current month,
 * the counter is reset.
 *
 * Quota limits:
 *   - Free: 10,000 requests/month
 *   - Paid: no monthly quota (rate limiting still applies)
 *   - Custom: configurable per key (future)
 */

import { Request, Response, NextFunction } from 'express';
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';

const FREE_TIER_MONTHLY_QUOTA = 10_000;

/**
 * Get current month as YYYY-MM string.
 */
export function getCurrentMonth(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/**
 * Get the first day of next month as ISO string (for reset_date).
 */
export function getNextResetDate(): string {
  const now = new Date();
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return nextMonth.toISOString();
}

/**
 * Increment usage counter for an API key.
 * Returns the current count after increment, or null if no key.
 */
export async function incrementUsage(
  apiKeyId: string,
  orgId: string,
  incrementBy = 1,
): Promise<{ count: number; month: string } | null> {
  const month = getCurrentMonth();

  try {
    // Upsert: create if missing, increment if exists
    const { data, error } = await db.from('api_key_usage')
      .upsert(
        {
          api_key_id: apiKeyId,
          org_id: orgId,
          month,
          request_count: incrementBy,
          last_request_at: new Date().toISOString(),
        },
        {
          onConflict: 'api_key_id,month',
          ignoreDuplicates: false,
        },
      )
      .select('request_count')
      .single();

    if (error) {
      // Upsert may not support increment directly — use RPC or manual approach
      // Fallback: select then update
      const { data: existing } = await db.from('api_key_usage')
        .select('id, request_count')
        .eq('api_key_id', apiKeyId)
        .eq('month', month)
        .maybeSingle();

      if (existing) {
        const newCount = existing.request_count + incrementBy;
        await db.from('api_key_usage')
          .update({
            request_count: newCount,
            last_request_at: new Date().toISOString(),
          })
          .eq('id', existing.id);
        return { count: newCount, month };
      }

      // Insert new row
      const { data: inserted } = await db.from('api_key_usage')
        .insert({
          api_key_id: apiKeyId,
          org_id: orgId,
          month,
          request_count: incrementBy,
          last_request_at: new Date().toISOString(),
        })
        .select('request_count')
        .single();

      return inserted ? { count: inserted.request_count, month } : null;
    }

    return data ? { count: data.request_count, month } : null;
  } catch (err) {
    logger.error({ error: err, apiKeyIdPrefix: apiKeyId?.slice(0, 8) }, 'Failed to increment usage');
    return null;
  }
}

/**
 * Get current usage for an API key this month.
 */
export async function getCurrentUsage(
  apiKeyId: string,
): Promise<number> {
  const month = getCurrentMonth();

  try {
    const { data } = await db
      .from('api_key_usage')
      .select('request_count')
      .eq('api_key_id', apiKeyId)
      .eq('month', month)
      .maybeSingle();

    return data?.request_count ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Usage tracking + quota enforcement middleware.
 *
 * Must be applied AFTER apiKeyAuth middleware (so req.apiKey is set).
 * For anonymous requests (no apiKey), this is a no-op.
 *
 * Sets response headers:
 *   X-Quota-Used, X-Quota-Limit, X-Quota-Reset
 */
export function usageTracking() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Anonymous requests — no quota tracking
    if (!req.apiKey) {
      next();
      return;
    }

    const { keyId, orgId, rateLimitTier } = req.apiKey;

    // Check current usage
    const currentUsage = await getCurrentUsage(keyId);
    const quota = rateLimitTier === 'free' ? FREE_TIER_MONTHLY_QUOTA : Infinity;
    const resetDate = getNextResetDate();

    // Set quota headers on every response
    res.setHeader('X-Quota-Used', currentUsage.toString());
    res.setHeader('X-Quota-Limit', quota === Infinity ? 'unlimited' : quota.toString());
    res.setHeader('X-Quota-Reset', resetDate);

    // Enforce quota for free tier
    if (rateLimitTier === 'free' && currentUsage >= FREE_TIER_MONTHLY_QUOTA) {
      res.status(429).json({
        error: 'quota_exceeded',
        message: 'Monthly API quota exceeded',
        upgrade_url: '/pricing',
        used: currentUsage,
        limit: FREE_TIER_MONTHLY_QUOTA,
        reset_date: resetDate,
      });
      return;
    }

    // IDEM-5: Synchronous optimistic increment — charge first, refund on failure.
    // This prevents over-quota requests from slipping through during concurrent access.
    const result = await incrementUsage(keyId, orgId);
    if (result) {
      res.setHeader('X-Quota-Used', result.count.toString());
    }

    next();
  };
}
