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

import { jwtVerify, decodeJwt, type JWTPayload } from 'jose';
import type { Logger } from './utils/logger.js';

export interface AuthConfig {
  supabaseJwtSecret?: string;
  supabaseUrl?: string;
  supabaseServiceKey?: string;
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

  // Prefer local JWT verification when secret is configured
  if (config.supabaseJwtSecret) {
    const localResult = await verifyJwtLocally(token, config.supabaseJwtSecret, logger);
    if (localResult) return localResult;

    // If the token is a non-Supabase JWT (e.g. Google OIDC from Cloud Scheduler),
    // skip the Supabase auth.getUser() fallback — it produces a spurious 403 that
    // Sentry traces capture as "Failed HTTP Operation".
    if (isNonSupabaseJwt(token)) return null;

    logger.warn('Local JWT verification failed — falling back to Supabase API');
  }

  // Fallback: network call to Supabase auth API
  return verifyJwtViaSupabase(token, logger);
}

const NON_SUPABASE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

function isNonSupabaseJwt(token: string): boolean {
  try {
    const { iss } = decodeJwt(token);
    return typeof iss === 'string' && NON_SUPABASE_ISSUERS.includes(iss);
  } catch {
    return false;
  }
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
