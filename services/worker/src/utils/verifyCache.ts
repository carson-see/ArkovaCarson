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
//
// Bumped to v4 for SCRUM-2575: the verify response now carries
// `proof_availability` + `proof_availability_note`. A hit is served verbatim
// without re-running buildVerificationResult, so without a bump every anchor
// cached before the deploy would keep answering the proof-availability question
// with silence for the whole TTL.
//
// Bumped v2 → v4 for SCRUM-2575 (#1816): the verify response now carries
// `proof_availability` + `proof_availability_note`. v3 was skipped deliberately
// so concurrent response-shape changes could not silently reuse each other's
// namespace; #1800 (SCRUM-2227) landed on top of v4 and inherited it.
// v5 is claimed by #1843 (BUG-2026-06-24-007, controls withheld for
// non-current credentials), in flight on its own branch.
//
// Bumped v4 → v6 for this PR's outbound PII gate on
// `buildVerificationResult` (academic-record free-text suppression + value
// gate on description/issuer_name/jurisdiction/sub_type/file_mime). This bump
// is a SECURITY requirement, not hygiene: the gate runs before
// `setCachedVerification`, so new writes are safe either way, but entries
// written by the PRE-gate build (v4 — live on main since #1816) carry a raw
// `description` and would keep serving it to anonymous callers for the rest
// of the TTL after deploy. A new prefix orphans them instantly. The PR's
// original v4 claim predated #1816 taking v4 on main; staying at v4 would
// have left every pre-gate v4 entry validly servable — the exact exposure
// this bump exists to close.
//
// A hit is served verbatim without re-running buildVerificationResult — bump
// again on any response-shape change so post-deploy cache hits don't serve
// stale thin responses. Old keys age out naturally via TTL.
const KEY_PREFIX = 'verify:v6:';
//
// Bump again on any response-shape change so post-deploy cache hits don't serve stale
// thin responses. Old keys age out naturally via TTL.
const KEY_PREFIX = 'verify:v4:';

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
