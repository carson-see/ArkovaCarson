/**
 * Auth Utilities — JWT verification for the Arkova Worker.
 *
 * Supports two verification strategies:
 * 1. Local verification (preferred) — uses SUPABASE_JWT_SECRET with `jose` library
 *    No network call, no single point of failure, lower latency.
 * 2. Supabase API fallback — calls auth.getUser() when JWT secret is not configured.
 *
 * Constitution 1.4: Never log tokens, secrets, or user identifiers.
 */

import {
  jwtVerify,
  decodeJwt,
  decodeProtectedHeader,
  createRemoteJWKSet,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';
import type { Logger } from './utils/logger.js';

export interface AuthConfig {
  supabaseJwtSecret?: string;
  supabaseUrl?: string;
  supabaseServiceKey?: string;
}

const NON_SUPABASE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

/**
 * Asymmetric algorithms accepted on the JWKS path.
 *
 * Pinned deliberately. Never widen this to include HMAC algorithms: `jwtVerify`
 * would then accept a token whose `alg` is HS256 and treat the JWKS *public*
 * key as an HMAC secret — the classic algorithm-confusion forgery. The
 * symmetric path below is a separate function with its own HS256-only pin for
 * exactly this reason.
 */
const ASYMMETRIC_ALGS = ['ES256', 'RS256'];

/**
 * Detect non-Supabase JWTs (e.g. Google OIDC tokens from Cloud Scheduler)
 * by inspecting the `iss` claim without full verification.
 */
function isNonSupabaseJwt(token: string): boolean {
  try {
    const { iss } = decodeJwt(token);
    return typeof iss === 'string' && NON_SUPABASE_ISSUERS.includes(iss);
  } catch {
    return false;
  }
}

/**
 * Read the unverified `alg` header to choose a verification strategy.
 *
 * This value is attacker-controlled and is used ONLY to route to the correct
 * verifier — never to decide whether a signature is acceptable. Both verifiers
 * re-pin their own algorithm allow-list, so a forged `alg` can at worst send a
 * token to a verifier that rejects it.
 */
function isAsymmetricJwt(token: string): boolean {
  try {
    const { alg } = decodeProtectedHeader(token);
    return typeof alg === 'string' && ASYMMETRIC_ALGS.includes(alg);
  } catch {
    return false;
  }
}

/** Cached JWKS resolver. `createRemoteJWKSet` handles fetch caching + cooldown. */
let jwksResolver: JWTVerifyGetKey | undefined;
let jwksResolverUrl: string | undefined;

function getSupabaseJwks(supabaseUrl: string): JWTVerifyGetKey {
  const url = `${supabaseUrl.replace(/\/+$/, '')}/auth/v1/.well-known/jwks.json`;
  if (!jwksResolver || jwksResolverUrl !== url) {
    jwksResolver = createRemoteJWKSet(new URL(url));
    jwksResolverUrl = url;
  }
  return jwksResolver;
}

/**
 * Extract authenticated user ID from a Bearer token.
 *
 * @param token - Raw JWT token (without "Bearer " prefix)
 * @param config - Auth configuration
 * @param logger - Logger instance
 * @returns User ID (UUID) or null if verification fails
 */
export async function verifyAuthToken(
  token: string,
  config: AuthConfig,
  logger: Pick<Logger, 'warn' | 'error'>,
): Promise<string | null> {
  if (!token) return null;

  // A non-Supabase issuer (e.g. Google OIDC from Cloud Scheduler) can never be
  // verified with Supabase credentials, so short-circuit BEFORE attempting any
  // of them. This must stay ahead of the local check: running an RS256 Google
  // token through the HS256 verifier logged
  // "JWT local verification failed / ERR_JOSE_ALG_NOT_ALLOWED" on every cron
  // request — a warning on a request that then succeeds via its own OIDC path
  // (cron.ts Method 3). During the 2026-08-11 outage that noise was
  // indistinguishable from a real auth failure and cost ~30 minutes of
  // diagnostic time. It also skips the auth.getUser() fallback, which produced
  // a spurious 403 that Sentry captured as "Failed HTTP Operation".
  if (isNonSupabaseJwt(token)) return null;

  // Symmetric path: legacy projects still signing with SUPABASE_JWT_SECRET.
  if (config.supabaseJwtSecret && !isAsymmetricJwt(token)) {
    const localResult = await verifyJwtLocally(token, config.supabaseJwtSecret, logger);
    if (localResult) return localResult;
  }

  // Asymmetric path: projects migrated to Supabase's asymmetric signing keys
  // publish an ES256 key at /auth/v1/.well-known/jwks.json. Without this, every
  // ES256 user token fails local verification and silently degrades to a
  // per-request network call to the Supabase auth API.
  if (config.supabaseUrl && isAsymmetricJwt(token)) {
    const jwksResult = await verifyJwtViaJwks(token, config.supabaseUrl, logger);
    if (jwksResult) return jwksResult;
  }

  if (config.supabaseJwtSecret) {
    logger.warn('Local JWT verification failed — falling back to Supabase API');
  }

  // Fallback: network call to Supabase auth API
  return verifyJwtViaSupabase(token, logger);
}

/**
 * Verify JWT locally using the Supabase JWT secret (HMAC-SHA256).
 * Eliminates network latency and dependency on Supabase auth API availability.
 */
async function verifyJwtLocally(
  token: string,
  jwtSecret: string,
  logger: Pick<Logger, 'warn'>,
): Promise<string | null> {
  try {
    const secret = new TextEncoder().encode(jwtSecret);
    const { payload } = await jwtVerify(token, secret, {
      algorithms: ['HS256'],
    });

    const userId = (payload as JWTPayload & { sub?: string }).sub;
    if (!userId) {
      logger.warn('JWT verified but missing sub claim');
      return null;
    }

    return userId;
  } catch (error) {
    logger.warn({ error }, 'JWT local verification failed');
    return null;
  }
}

/**
 * Verify a Supabase-issued JWT against the project's published JWKS.
 *
 * Security properties, all load-bearing:
 *  - `issuer` is pinned to this project's auth endpoint, so a correctly signed
 *    token from a DIFFERENT Supabase project is rejected.
 *  - `algorithms` is pinned to asymmetric algorithms only (see ASYMMETRIC_ALGS)
 *    to foreclose algorithm confusion against the public key.
 *  - The JWKS URL derives from server-side config, never from the token.
 */
async function verifyJwtViaJwks(
  token: string,
  supabaseUrl: string,
  logger: Pick<Logger, 'warn'>,
): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, getSupabaseJwks(supabaseUrl), {
      issuer: `${supabaseUrl.replace(/\/+$/, '')}/auth/v1`,
      algorithms: ASYMMETRIC_ALGS,
    });

    const userId = (payload as JWTPayload & { sub?: string }).sub;
    if (!userId) {
      logger.warn('JWKS-verified JWT missing sub claim');
      return null;
    }

    return userId;
  } catch (error) {
    logger.warn({ error }, 'JWKS JWT verification failed');
    return null;
  }
}

/**
 * Fallback: verify JWT by calling Supabase auth.getUser().
 * Used when SUPABASE_JWT_SECRET is not configured.
 * Reuses the shared singleton DB client (getDb) instead of creating
 * a throwaway client on every invocation.
 *
 * Dynamic import of db.ts defers config validation to call time,
 * keeping auth.ts importable in test environments without all worker
 * env vars present.
 */
async function verifyJwtViaSupabase(
  token: string,
  logger: Pick<Logger, 'warn' | 'error'>,
): Promise<string | null> {
  try {
    const { getDb } = await import('./utils/db.js');
    const { data: { user }, error } = await getDb().auth.getUser(token);

    if (error || !user) {
      logger.warn({ error }, 'Invalid or expired auth token');
      return null;
    }

    return user.id;
  } catch (error) {
    logger.error({ error }, 'Failed to verify auth token');
    return null;
  }
}
