/**
 * Mount-level gate for the ComputeID integration (SCRUM-4492).
 *
 * Reads the typed `config` flag (never `process.env`) and answers 503
 * `vendor_gated` BEFORE the raw-body parser, the rate limiter's bucket, or
 * `requireScopeAnyAuth`'s profile lookup run — while the integration is dark
 * nothing downstream should spend work on it. The handlers keep their own
 * check as defense in depth against a mis-mount.
 */
import type { Request, Response, NextFunction } from 'express';
import { config } from '../config.js';

export function computeidGate(req: Request, res: Response, next: NextFunction): void {
  if (!config.enableComputeidIntegration) {
    res.status(503).json({
      error: {
        code: 'vendor_gated',
        message: 'ComputeID integration is not enabled in this environment (ENABLE_COMPUTEID_INTEGRATION).',
      },
    });
    return;
  }
  next();
}
