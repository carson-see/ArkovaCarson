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
    // Schema: switchboard_flags(id uuid, flag_key text, enabled boolean, ...).
    // See SCRUM-1622. Note: /grc is also gated by `killSwitch('ENABLE_GRC_INTEGRATION')`
    // (env-only, singular flag name) at the router level. That gate is the
    // outer guard; this gate is the inner one. Fixing the bug here does not
    // open /grc on its own — the env-only kill-switch still has to be flipped
    // to "true" before the route accepts traffic.
    const { data, error } = await db
      .from('switchboard_flags')
      .select('enabled')
      .eq('flag_key', 'ENABLE_GRC_INTEGRATIONS')
      .single() as { data: { enabled: boolean } | null; error: unknown };

    if (error || !data) {
      const envValue = process.env.ENABLE_GRC_INTEGRATIONS === 'true';
      flagCache = { value: envValue, expiresAt: now + FLAG_CACHE_TTL_MS };
      return envValue;
    }

    const enabled = data.enabled === true;
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
