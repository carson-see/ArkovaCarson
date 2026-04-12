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

import { jwtVerify, type JWTPayload } from 'jose';
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
    // Local verification failed — fall back to Supabase API (secret may be stale/wrong)
    logger.warn('Local JWT verification failed — falling back to Supabase API');
  }

  // Fallback: network call to Supabase auth API
  return verifyJwtViaSupabase(token, config, logger);
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
 */
async function verifyJwtViaSupabase(
  token: string,
  config: AuthConfig,
  logger: Pick<Logger, 'warn' | 'error'>,
): Promise<string | null> {
  try {
    const { createClient } = await import('@supabase/supabase-js');
    const supabaseClient = createClient(config.supabaseUrl!, config.supabaseServiceKey!);
    const { data: { user }, error } = await supabaseClient.auth.getUser(token);

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
