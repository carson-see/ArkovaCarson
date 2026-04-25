/**
 * Veremark webhook handler (SCRUM-1030 / SCRUM-1151).
 *
 * Live route is gated behind `ENABLE_VEREMARK_WEBHOOK=true` AND
 * `VEREMARK_WEBHOOK_SECRET` being set. Per the SCRUM-1151 spike, Veremark
 * has not published sufficient public webhook documentation for us to
 * commit to a stable contract without a vendor NDA. Until that lands the
 * route returns 503 with `code: 'vendor_gated'` so admins clearly see the
 * connector is not enabled in this environment.
 *
 * The reusable plumbing (HMAC verifier, idempotent enqueue, DLQ) lives in
 * the Checkr handler in this same folder. When Veremark docs are confirmed
 * we'll fork the Checkr handler shape and lift this stub.
 */
import { Router, type Request, type Response } from 'express';
import { logger } from '../../../utils/logger.js';

export const veremarkWebhookRouter = Router();

veremarkWebhookRouter.post('/', async (req: Request, res: Response) => {
  if (process.env.ENABLE_VEREMARK_WEBHOOK !== 'true') {
    res.status(503).json({
      error: {
        code: 'vendor_gated',
        message:
          'Veremark webhook intake is currently gated. Set ENABLE_VEREMARK_WEBHOOK=true once the vendor agreement + signed docs are in place.',
      },
    });
    return;
  }
  const secret = process.env.VEREMARK_WEBHOOK_SECRET;
  if (!secret) {
    logger.error('VEREMARK_WEBHOOK_SECRET not set — webhook rejected');
    res.status(503).json({ error: { code: 'webhook_unconfigured' } });
    return;
  }
  // TODO(SCRUM-1151 follow-up): port the Checkr handler shape once Veremark
  // publishes their HMAC + event-type contract. Until then this branch is
  // unreachable in any non-flagged environment.
  void req;
  res.status(501).json({
    error: {
      code: 'not_implemented',
      message: 'Veremark live receiver not yet wired — see SCRUM-1151 spike doc.',
    },
  });
});
