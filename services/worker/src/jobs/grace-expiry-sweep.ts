/**
 * Payment Grace Expiry Sweep (Phase 3b)
 *
 * Cloud Scheduler calls the HTTP route every 15 minutes. The database RPC is
 * idempotent and only transitions organizations whose grace window has elapsed.
 */
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { callRpc } from '../utils/rpc.js';

export const GRACE_EXPIRY_SWEEP_CRON = '*/15 * * * *';

export interface GraceExpirySweepResult {
  expired: number;
}

export async function runGraceExpirySweep(): Promise<GraceExpirySweepResult> {
  try {
    const { data, error } = await callRpc<number>(db, 'expire_payment_grace_if_due');

    if (error) {
      logger.error({ error }, 'Payment grace expiry sweep RPC failed');
      return { expired: 0 };
    }

    const expired = typeof data === 'number' ? data : 0;
    if (expired > 0) {
      logger.info({ expired }, 'Payment grace expiry sweep suspended organizations');
    } else {
      logger.debug('Payment grace expiry sweep found no due organizations');
    }

    return { expired };
  } catch (error) {
    logger.error({ error }, 'Payment grace expiry sweep failed');
    return { expired: 0 };
  }
}
