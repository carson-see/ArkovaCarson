/**
 * AdES Signature Feature Gate Middleware (PH3-ESIG-01)
 *
 * Gates /api/v1/sign and /api/v1/signatures/* behind ENABLE_ADES_SIGNATURES flag.
 * Returns HTTP 503 when disabled.
 *
 * The gate also path-guards itself so it's safe to mount at `router.use('/', ...)`
 * — historically (router.ts:333/336) the gate was chained under root because the
 * `signatureCompliance` and `key-inventory` sub-routers define their own
 * `/signatures/*` internal routes. Without the path guard, that root mount
 * catches *every* `/api/v1/*` request and 503s unrelated endpoints like
 * `/api/v1/compliance/audit` when AdES is disabled (found in prod UAT
 * 2026-04-18: `/api/v1/compliance/audit` → 503 `ADES_SIGNATURES_DISABLED`).
 */

import { Request, Response, NextFunction } from 'express';
import { db } from '../utils/db.js';

// Paths the gate should actually guard. Everything else falls through.
const ADES_PATH_PREFIXES = ['/sign', '/signatures', '/verify-signature'];

function isAdesPath(reqPath: string): boolean {
  return ADES_PATH_PREFIXES.some(
    (p) => reqPath === p || reqPath.startsWith(`${p}/`) || reqPath.startsWith(`${p}?`),
  );
}

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
    // Bypass the gate for any path outside the AdES feature surface. This
    // keeps the gate safe when mounted at `router.use('/', …)` alongside
    // routers whose internal routes expose `/signatures/*` paths.
    if (!isAdesPath(req.path)) {
      next();
      return;
    }
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

// Exported for unit testing.
export const _isAdesPath = isAdesPath;
export function _resetAdesFlagCacheForTesting(): void {
  flagCache = null;
}
