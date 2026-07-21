/**
 * Partner Provisioning Feature Gate (SCRUM-2990).
 *
 * Gates the ENTIRE partner-provisioning surface (/api/partner-provisioning/*)
 * behind the ENABLE_PARTNER_PROVISIONING switchboard flag. Mirrors the
 * ENABLE_VERIFICATION_API gate mechanism (featureGate.ts / CLAUDE.md §1.9):
 * get_flag() RPC so production/local switchboard column differences stay behind
 * the database RPC, 60s TTL cache to avoid per-request DB queries, and FAIL
 * CLOSED — flag absent, false, non-boolean, or a read error all leave the
 * surface dark. The env var is deliberately NOT a runtime fallback.
 *
 * Dark = HTTP 404 (vs the verification gate's 503): /api/v1 is a published API
 * that can be "temporarily unavailable"; partner provisioning is UNRELEASED, so
 * the gate must not disclose the surface's existence before launch.
 *
 * Seeding: this PR does NOT ship a switchboard_flags migration (DBA-owned this
 * slice). An unseeded flag row means get_flag yields no boolean → the surface
 * stays dark, which is the intended safe default until release-ops seeds
 * ENABLE_PARTNER_PROVISIONING.
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
 * Read the ENABLE_PARTNER_PROVISIONING flag with TTL caching.
 * Fail closed if the switchboard can't be read (negative result is cached so a
 * failing switchboard is not hammered on every request).
 */
export async function isPartnerProvisioningEnabled(): Promise<boolean> {
  const now = Date.now();

  if (flagCache && flagCache.expiresAt > now) {
    return flagCache.value;
  }

  const { data, error } = await callRpc<boolean>(db, 'get_flag', {
    p_flag_key: 'ENABLE_PARTNER_PROVISIONING',
  });

  if (error || typeof data !== 'boolean') {
    logger.warn(
      { error, flagKey: 'ENABLE_PARTNER_PROVISIONING' },
      'Failed to read ENABLE_PARTNER_PROVISIONING flag from DB, failing closed',
    );
    flagCache = { value: false, expiresAt: now + FLAG_CACHE_TTL_MS };
    return false;
  }

  flagCache = { value: data, expiresAt: now + FLAG_CACHE_TTL_MS };
  return data;
}

/**
 * Express middleware that blacks out the partner-provisioning surface when the
 * flag is off/unseeded/unreadable. 404 — the surface does not exist until the
 * switchboard says so.
 */
export function partnerProvisioningGate() {
  return async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    const enabled = await isPartnerProvisioningEnabled();

    if (!enabled) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    next();
  };
}

/** Reset cache — for testing only */
export function _resetPartnerProvisioningFlagCache(): void {
  flagCache = null;
}
