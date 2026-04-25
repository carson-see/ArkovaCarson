import { Request, Response, NextFunction } from 'express';
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbAny = db as any;

export function requirePaymentCurrent() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const orgId = (req as unknown as { orgId?: string }).orgId
      ?? req.apiKey?.orgId
      ?? null;

    if (!orgId) {
      next();
      return;
    }

    try {
      const { data, error } = await dbAny
        .from('organizations')
        .select('payment_state')
        .eq('id', orgId)
        .maybeSingle();

      if (error) {
        logger.error({ error, orgId }, 'payment-state lookup failed');
        next();
        return;
      }

      const state = data?.payment_state as string | null;
      if (state === 'suspended' || state === 'cancelled') {
        res.status(402).json({
          error: 'payment_required',
          detail: 'This organization\'s account is suspended. Please update your payment method.',
        });
        return;
      }
    } catch (err) {
      logger.error({ err, orgId }, 'payment-state middleware error');
    }

    next();
  };
}
