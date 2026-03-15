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

export async function processMonthlyCredits(): Promise<number> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (db.rpc as any)('allocate_monthly_credits');

    if (error) {
      logger.error({ error }, 'Failed to process monthly credit allocations');
      return 0;
    }

    const processed = typeof data === 'number' ? data : 0;

    if (processed > 0) {
      logger.info({ processed }, 'Monthly credit allocations processed');
    }

    return processed;
  } catch (error) {
    logger.error({ error }, 'Credit expiry job failed');
    return 0;
  }
}
