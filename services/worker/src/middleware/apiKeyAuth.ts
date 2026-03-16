/**
 * API Key Authentication Middleware (P4.5-TS-03)
 *
 * Extracts API keys from Authorization or X-API-Key headers,
 * verifies them via HMAC-SHA256 hash comparison, and attaches
 * key metadata to the request.
 *
 * Constitution 1.4: Raw API keys are NEVER stored. Only HMAC-SHA256
 * hashes are persisted. Comparison is done by hashing the incoming
 * key and matching against the stored hash.
 */

import { Request, Response, NextFunction } from 'express';
import { createHmac, randomBytes } from 'crypto';
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';


/** API key metadata attached to req after authentication */
export interface ApiKeyMeta {
  keyId: string;
  orgId: string;
  scopes: string[];
  rateLimitTier: 'free' | 'paid' | 'custom';
  keyPrefix: string;
}

// Extend Express Request
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      apiKey?: ApiKeyMeta;
    }
  }
}

/**
 * Hash a raw API key with HMAC-SHA256.
 */
export function hashApiKey(rawKey: string, hmacSecret: string): string {
  return createHmac('sha256', hmacSecret).update(rawKey).digest('hex');
}

/**
 * Generate a new API key with crypto-random bytes.
 * Returns { raw, hash, prefix }.
 */
export function generateApiKey(hmacSecret: string, isTest = false): {
  raw: string;
  hash: string;
  prefix: string;
} {
  const keyPrefix = isTest ? 'ak_test_' : 'ak_live_';
  const randomPart = randomBytes(32).toString('hex');
  const raw = `${keyPrefix}${randomPart}`;
  const hash = hashApiKey(raw, hmacSecret);
  // Prefix for display: first 12 chars (includes ak_live_ + 4 random)
  const prefix = raw.substring(0, 12);

  return { raw, hash, prefix };
}

/**
 * Extract API key from request headers.
 * Checks Authorization: Bearer ak_... and X-API-Key: ak_... headers.
 */
function extractApiKey(req: Request): string | null {
  // Check Authorization header
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ak_')) {
    return authHeader.slice(7);
  }

  // Check X-API-Key header
  const apiKeyHeader = req.headers['x-api-key'];
  if (typeof apiKeyHeader === 'string' && apiKeyHeader.startsWith('ak_')) {
    return apiKeyHeader;
  }

  return null;
}

/**
 * API key authentication middleware.
 *
 * If a valid API key is present, attaches metadata to req.apiKey.
 * If no key is present, the request continues as anonymous.
 * If an invalid key is present, returns 401.
 *
 * @param hmacSecret - The HMAC-SHA256 secret for key verification
 * @param options.required - If true, reject requests without a key (401)
 */
export function apiKeyAuth(hmacSecret: string, options: { required?: boolean } = {}) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const rawKey = extractApiKey(req);

    // No key provided
    if (!rawKey) {
      if (options.required) {
        res.status(401).json({
          error: 'authentication_required',
          message: 'API key required. Pass via Authorization: Bearer ak_... or X-API-Key header.',
        });
        return;
      }
      // Anonymous access allowed
      next();
      return;
    }

    // Hash the incoming key
    const keyHash = hashApiKey(rawKey, hmacSecret);

    // Look up in database
    try {
      const { data: apiKey, error } = await db.from('api_keys')
        .select('id, org_id, scopes, rate_limit_tier, key_prefix, is_active, expires_at')
        .eq('key_hash', keyHash)
        .single();

      if (error || !apiKey) {
        logger.warn('Invalid API key presented');
        res.status(401).json({
          error: 'invalid_api_key',
          message: 'The provided API key is invalid or does not exist.',
        });
        return;
      }

      if (!apiKey.is_active) {
        res.status(401).json({
          error: 'api_key_revoked',
          message: 'This API key has been revoked.',
        });
        return;
      }

      // Check expiry
      if (apiKey.expires_at && new Date(apiKey.expires_at) < new Date()) {
        res.status(401).json({
          error: 'api_key_expired',
          message: 'This API key has expired.',
        });
        return;
      }

      // Attach metadata to request
      req.apiKey = {
        keyId: apiKey.id,
        orgId: apiKey.org_id,
        scopes: apiKey.scopes,
        rateLimitTier: apiKey.rate_limit_tier,
        keyPrefix: apiKey.key_prefix,
      };

      // Update last_used_at (fire-and-forget, non-blocking)
      void db.from('api_keys')
        .update({ last_used_at: new Date().toISOString() })
        .eq('id', apiKey.id);

      next();
    } catch (err) {
      logger.error({ error: err }, 'API key lookup failed');
      res.status(500).json({
        error: 'internal_error',
        message: 'Failed to validate API key.',
      });
    }
  };
}
