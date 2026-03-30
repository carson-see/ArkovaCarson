/**
 * GRC Feature Gate Middleware (CML-05)
 *
 * Gates /api/v1/grc/* endpoints behind the ENABLE_GRC_INTEGRATIONS switchboard flag.
 * Same TTL-cached pattern as featureGate.ts and aiFeatureGate.ts.
 */

import { Request, Response, NextFunction } from 'express';
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';

interface FlagCache {
  value: boolean;
  expiresAt: number;
}

const FLAG_CACHE_TTL_MS = 60_000;
let flagCache: FlagCache | null = null;

async function isGrcEnabled(): Promise<boolean> {
  const now = Date.now();
  if (flagCache && flagCache.expiresAt > now) return flagCache.value;

  try {
    const { data, error } = await db
      .from('switchboard_flags')
      .select('value')
      .eq('id', 'ENABLE_GRC_INTEGRATIONS')
      .single() as { data: { value: boolean } | null; error: unknown };

    if (error || !data) {
      const envValue = process.env.ENABLE_GRC_INTEGRATIONS === 'true';
      flagCache = { value: envValue, expiresAt: now + FLAG_CACHE_TTL_MS };
      return envValue;
    }

    const enabled = data.value === true;
    flagCache = { value: enabled, expiresAt: now + FLAG_CACHE_TTL_MS };
    return enabled;
  } catch (err) {
    logger.error({ error: err }, 'Error reading ENABLE_GRC_INTEGRATIONS flag');
    flagCache = { value: false, expiresAt: now + FLAG_CACHE_TTL_MS };
    return false;
  }
}

export function grcFeatureGate() {
  return async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    const enabled = await isGrcEnabled();
    if (!enabled) {
      res.setHeader('Retry-After', '60');
      res.status(503).json({
        error: 'service_unavailable',
        message: 'GRC integrations are not currently enabled',
        retry_after: 60,
      });
      return;
    }
    next();
  };
}

export function _resetGrcFlagCache(): void {
  flagCache = null;
}
