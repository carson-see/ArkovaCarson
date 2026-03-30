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

interface FlagCache {
  value: boolean;
  expiresAt: number;
}

const FLAG_CACHE_TTL_MS = 60_000; // 60 seconds
let flagCache: FlagCache | null = null;

/**
 * Read the ENABLE_VERIFICATION_API flag with TTL caching.
 * Falls back to false (disabled) if the flag can't be read.
 */
export async function isVerificationApiEnabled(): Promise<boolean> {
  const now = Date.now();

  if (flagCache && flagCache.expiresAt > now) {
    return flagCache.value;
  }

  try {
    const { data, error } = await db
      .from('switchboard_flags')
      .select('value')
      .eq('id', 'ENABLE_VERIFICATION_API')
      .single() as { data: { value: boolean } | null; error: unknown };

    if (error || !data) {
      // Fall back to env var if DB flag not found
      const envValue = process.env.ENABLE_VERIFICATION_API === 'true';
      logger.warn({ error, envFallback: envValue }, 'Failed to read ENABLE_VERIFICATION_API flag from DB, falling back to env');
      flagCache = { value: envValue, expiresAt: now + FLAG_CACHE_TTL_MS };
      return envValue;
    }

    const enabled = data.value === true;
    flagCache = { value: enabled, expiresAt: now + FLAG_CACHE_TTL_MS };
    return enabled;
  } catch (err) {
    logger.error({ error: err }, 'Error reading switchboard flag');
    flagCache = { value: false, expiresAt: now + FLAG_CACHE_TTL_MS };
    return false;
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
