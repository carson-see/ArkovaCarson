/**
 * Credit Expiry Job
 *
 * Monthly cron job to expire unused monthly credits and allocate new ones.
 * Calls the allocate_monthly_credits() RPC which handles:
 *   1. Expiring unused monthly credits
 *   2. Resetting balance (purchased carry over + new monthly allocation)
 *   3. Logging both EXPIRY and ALLOCATION transactions
 *
 * @see MVP-25
 */

import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { callRpc } from '../utils/rpc.js';
import { captureCreditRpcFailureAlert } from '../utils/sentry.js';

export async function processMonthlyCredits(): Promise<number> {
  try {
    const { data, error } = await callRpc<number>(db, 'allocate_monthly_credits');

    if (error) {
      // No fallback: a failure here means monthly allocation/expiry silently
      // does not happen for this cron tick. Without alerting, that could go
      // undetected for a full billing cycle (next tick is a month away).
      logger.error({ error }, 'Failed to process monthly credit allocations');
      captureCreditRpcFailureAlert({
        rpc: 'allocate_monthly_credits',
        operation: 'credit-expiry.processMonthlyCredits',
        failMode: 'closed',
        error: new Error('allocate_monthly_credits RPC failed — no allocations processed this run'),
      });
      return 0;
    }

    const processed = typeof data === 'number' ? data : 0;

    if (processed > 0) {
      logger.info({ processed }, 'Monthly credit allocations processed');
    }

    return processed;
  } catch (error) {
    logger.error({ error }, 'Credit expiry job failed');
    captureCreditRpcFailureAlert({
      rpc: 'allocate_monthly_credits',
      operation: 'credit-expiry.processMonthlyCredits.thrown',
      failMode: 'closed',
      error,
    });
    return 0;
  }
}
