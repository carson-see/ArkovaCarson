/**
 * Verification API Redis Cache (PERF-12)
 *
 * Caches verification results in Upstash Redis to reduce database load
 * for frequently-queried anchors. TTL-based expiration with cache
 * invalidation on anchor status changes.
 *
 * Falls back to direct DB query if Redis is unavailable.
 */

import { logger } from './logger.js';

const CACHE_TTL_SECONDS = 300; // 5 minutes
// Bumped v1 → v2 when API-RICH-01 landed 8 additive response fields (2026-04-16).
// Bumped v2 → v3 for SCRUM-2227: the verify response now carries
// `compliance_controls_note` and strips the retired EU-US DPF control IDs from
// stored values on read. A v2 hit is served verbatim without re-running
// buildVerificationResult, so without this bump every anchor cached before the
// deploy would keep serving the retired identifiers with no note for the whole
// TTL — the exact claim this change exists to stop making.
// Bumped v3 → v5 for BUG-2026-06-24-007: compliance controls are now WITHHELD for
// credentials that are no longer current. Without the bump, any revoked anchor
// cached before the deploy keeps serving the full SOC2/HIPAA/eIDAS set next to
// `status: REVOKED` for the whole TTL — the exact claim this change removes.
// `invalidateVerificationCache` does not help: nothing re-fires for an ALREADY
// revoked/expired anchor.
//
// v4 is skipped deliberately. PR #1816 (SCRUM-2575) takes v2 → v4 for its own
// response-shape change on a branch based on main; going to v5 here keeps the two
// namespaces distinct in EVERY merge order, so neither can serve the other's shape.
//
// Bump again on any response-shape change so post-deploy cache hits don't serve stale
// thin responses. Old keys age out naturally via TTL.
const KEY_PREFIX = 'verify:v5:';

/** Module-level config cache — avoids process.env reads on every request */
let _redisConfig: { url: string; token: string } | null | undefined;

function getRedisConfig(): { url: string; token: string } | null {
  if (_redisConfig !== undefined) return _redisConfig;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  _redisConfig = (url && token) ? { url, token } : null;
  return _redisConfig;
}

async function redisGet(key: string): Promise<string | null> {
  const config = getRedisConfig();
  if (!config) return null;

  try {
    const res = await fetch(`${config.url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${config.token}` },
    });
    if (!res.ok) return null;
    const data = await res.json() as { result?: string | null };
    return data.result ?? null;
  } catch (err) {
    logger.debug({ err, key }, 'Redis GET failed — falling back to DB');
    return null;
  }
}

async function redisSet(key: string, value: string, ttlSeconds: number): Promise<void> {
  const config = getRedisConfig();
  if (!config) return;

  try {
    await fetch(`${config.url}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}/ex/${ttlSeconds}`, {
      headers: { Authorization: `Bearer ${config.token}` },
    });
  } catch (err) {
    logger.debug({ err, key }, 'Redis SET failed — non-critical');
  }
}

async function redisDel(key: string): Promise<void> {
  const config = getRedisConfig();
  if (!config) return;

  try {
    await fetch(`${config.url}/del/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${config.token}` },
    });
  } catch (err) {
    logger.debug({ err, key }, 'Redis DEL failed — non-critical');
  }
}

/**
 * Get cached verification result for a publicId.
 * Returns null on cache miss or Redis unavailable.
 */
export async function getCachedVerification<T>(publicId: string): Promise<T | null> {
  const raw = await redisGet(`${KEY_PREFIX}${publicId}`);
  if (!raw) return null;

  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Cache a verification result for a publicId.
 */
export async function setCachedVerification<T>(publicId: string, result: T, ttl = CACHE_TTL_SECONDS): Promise<void> {
  await redisSet(`${KEY_PREFIX}${publicId}`, JSON.stringify(result), ttl);
}

/**
 * Invalidate cached verification for a publicId.
 * Call this when anchor status changes (e.g., SECURED, REVOKED).
 */
export async function invalidateVerificationCache(publicId: string): Promise<void> {
  await redisDel(`${KEY_PREFIX}${publicId}`);
}
