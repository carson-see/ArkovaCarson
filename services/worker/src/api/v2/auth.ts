import { Request, Response, NextFunction } from 'express';
import { hashApiKey } from '../../middleware/apiKeyAuth.js';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { ProblemError } from './problem.js';

function extractApiKey(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ak_')) {
    return authHeader.slice(7);
  }

  const apiKeyHeader = req.headers['x-api-key'];
  if (typeof apiKeyHeader === 'string' && apiKeyHeader.startsWith('ak_')) {
    return apiKeyHeader;
  }

  return null;
}

/**
 * v2 API-key auth keeps the legacy v1 middleware untouched while making every
 * v2 authentication failure flow through the RFC 7807 problem handler.
 */
export function apiKeyAuthV2(hmacSecret: string) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const rawKey = extractApiKey(req);

    if (!rawKey) {
      next();
      return;
    }

    if (!hmacSecret) {
      logger.warn('API key presented but API_KEY_HMAC_SECRET is not configured');
      next(ProblemError.internalError('API key authentication is not available.'));
      return;
    }

    try {
      const keyHash = hashApiKey(rawKey, hmacSecret);
      const { data: apiKey, error } = await db.from('api_keys')
        .select('id, org_id, created_by, scopes, rate_limit_tier, key_prefix, is_active, expires_at')
        .eq('key_hash', keyHash)
        .single();

      if (error || !apiKey) {
        logger.warn('Invalid API key presented');
        next(ProblemError.invalidApiKey());
        return;
      }

      if (!apiKey.is_active) {
        next(ProblemError.apiKeyRevoked());
        return;
      }

      if (apiKey.expires_at && new Date(apiKey.expires_at) < new Date()) {
        next(ProblemError.apiKeyExpired());
        return;
      }

      req.apiKey = {
        keyId: apiKey.id,
        orgId: apiKey.org_id,
        userId: apiKey.created_by,
        scopes: apiKey.scopes,
        rateLimitTier: apiKey.rate_limit_tier,
        keyPrefix: apiKey.key_prefix,
      };

      void db.from('api_keys')
        .update({ last_used_at: new Date().toISOString() })
        .eq('id', apiKey.id);

      next();
    } catch (err) {
      logger.error({ error: err }, 'v2 API key lookup failed');
      next(ProblemError.internalError('Failed to validate API key.'));
    }
  };
}
