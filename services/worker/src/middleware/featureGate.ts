/**
 * Feature Gate Middleware (P4.5-TS-12)
 *
 * Gates /api/v1/* endpoints behind the ENABLE_VERIFICATION_API switchboard flag.
 * Returns HTTP 503 when the flag is false. Uses TTL-based cache (60s) to avoid
 * per-request DB queries.
 *
 * The /health endpoint is ALWAYS available regardless of flag state.
 */

import { Request, Response, NextFunction } from 'express';
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { callRpc } from '../utils/rpc.js';

interface FlagCache {
  value: boolean;
  expiresAt: number;
}

const FLAG_CACHE_TTL_MS = 60_000; // 60 seconds
let flagCache: FlagCache | null = null;

/**
 * Read the ENABLE_VERIFICATION_API flag with TTL caching.
 * Uses get_flag() so production/local switchboard column differences stay
 * behind the database RPC. Falls back to env only if the RPC can't be read.
 */
export async function isVerificationApiEnabled(): Promise<boolean> {
  const now = Date.now();

  if (flagCache && flagCache.expiresAt > now) {
    return flagCache.value;
  }

  const envFallback = process.env.ENABLE_VERIFICATION_API === 'true';

  try {
    const { data, error } = await callRpc<boolean>(db, 'get_flag', {
      p_flag_key: 'ENABLE_VERIFICATION_API',
    });

    if (error || typeof data !== 'boolean') {
      logger.warn(
        { error, envFallback },
        'Failed to read ENABLE_VERIFICATION_API flag from DB, falling back to env',
      );
      flagCache = { value: envFallback, expiresAt: now + FLAG_CACHE_TTL_MS };
      return envFallback;
    }

    flagCache = { value: data, expiresAt: now + FLAG_CACHE_TTL_MS };
    return data;
  } catch (err) {
    logger.error({ error: err, envFallback }, 'Error reading switchboard flag, falling back to env');
    flagCache = { value: envFallback, expiresAt: now + FLAG_CACHE_TTL_MS };
    return envFallback;
  }
}

/**
 * Express middleware that blocks /api/v1/* requests when the verification API is disabled.
 */
export function verificationApiGate() {
  return async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    const enabled = await isVerificationApiEnabled();

    if (!enabled) {
      // IDEM-3: Include Retry-After header per RFC 7231 for automated client retry
      res.setHeader('Retry-After', '60');
      res.status(503).json({
        error: 'service_unavailable',
        message: 'Verification API is not currently enabled',
        retry_after: 60,
      });
      return;
    }

    next();
  };
}

/** Reset cache — for testing only */
export function _resetFlagCache(): void {
  flagCache = null;
}
