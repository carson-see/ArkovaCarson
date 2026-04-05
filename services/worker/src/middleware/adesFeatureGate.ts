/**
 * AdES Signature Feature Gate Middleware (PH3-ESIG-01)
 *
 * Gates /api/v1/sign and /api/v1/signatures/* behind ENABLE_ADES_SIGNATURES flag.
 * Returns HTTP 503 when disabled.
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

async function isAdesEnabled(): Promise<boolean> {
  const now = Date.now();

  if (flagCache && flagCache.expiresAt > now) {
    return flagCache.value;
  }

  try {
    const { data, error } = await db
      .from('switchboard_flags')
      .select('value')
      .eq('id', 'ENABLE_ADES_SIGNATURES')
      .single() as { data: { value: boolean } | null; error: unknown };

    if (error || !data) {
      const envValue = process.env.ENABLE_ADES_SIGNATURES === 'true';
      flagCache = { value: envValue, expiresAt: now + FLAG_CACHE_TTL_MS };
      return envValue;
    }

    const enabled = data.value === true;
    flagCache = { value: enabled, expiresAt: now + FLAG_CACHE_TTL_MS };
    return enabled;
  } catch {
    const envValue = process.env.ENABLE_ADES_SIGNATURES === 'true';
    flagCache = { value: envValue, expiresAt: now + FLAG_CACHE_TTL_MS };
    return envValue;
  }
}

export function adesSignatureGate() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const enabled = await isAdesEnabled();
    if (!enabled) {
      res.status(503).json({
        error: 'AdES signature service is not currently enabled',
        code: 'ADES_SIGNATURES_DISABLED',
      });
      return;
    }
    next();
  };
}
