/**
 * AI Feature Gate Middleware (P8-S3)
 *
 * Gates AI endpoints behind switchboard flags:
 *   - ENABLE_AI_EXTRACTION: Controls /api/v1/ai/extract
 *   - ENABLE_SEMANTIC_SEARCH: Controls semantic search endpoints
 *   - ENABLE_AI_FRAUD: Controls AI fraud detection
 *
 * All flags default to false (fail-closed). Uses TTL-based cache (60s)
 * to avoid per-request DB queries. Same pattern as featureGate.ts (P4.5-TS-12).
 */

import { Request, Response, NextFunction } from 'express';
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';

interface FlagCache {
  value: boolean;
  expiresAt: number;
}

const FLAG_CACHE_TTL_MS = 60_000; // 60 seconds

const aiFlags: Record<string, FlagCache | null> = {
  ENABLE_AI_EXTRACTION: null,
  ENABLE_SEMANTIC_SEARCH: null,
  ENABLE_AI_FRAUD: null,
  ENABLE_AI_REPORTS: null,
};

type AIFlagKey = keyof typeof aiFlags;

/**
 * Read an AI feature flag with TTL caching.
 * Falls back to env var when DB flag can't be read (stabilizes gates
 * against transient DB issues). Env vars are set in Cloud Run deploy.
 */
async function readAIFlag(flagKey: AIFlagKey): Promise<boolean> {
  const now = Date.now();
  const cached = aiFlags[flagKey];

  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  // Env var fallback: if DB query fails, check env (set in Cloud Run deploy)
  const envFallback = process.env[flagKey] === 'true';

  try {
    const { data, error } = await db
      .from('switchboard_flags')
      .select('value')
      .eq('id', flagKey)
      .single() as { data: { value: boolean } | null; error: unknown };

    if (error || !data) {
      logger.warn({ error, flagKey, envFallback }, `Failed to read ${flagKey} flag from DB, falling back to env`);
      aiFlags[flagKey] = { value: envFallback, expiresAt: now + FLAG_CACHE_TTL_MS };
      return envFallback;
    }

    const enabled = data.value === true;
    aiFlags[flagKey] = { value: enabled, expiresAt: now + FLAG_CACHE_TTL_MS };
    return enabled;
  } catch (err) {
    logger.error({ error: err, flagKey, envFallback }, `Error reading ${flagKey} switchboard flag, falling back to env`);
    aiFlags[flagKey] = { value: envFallback, expiresAt: now + FLAG_CACHE_TTL_MS };
    return envFallback;
  }
}

/**
 * Create an Express middleware that gates requests behind a specific AI flag.
 */
function createAIGate(flagKey: AIFlagKey, featureName: string) {
  return () => {
    return async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
      const enabled = await readAIFlag(flagKey);

      if (!enabled) {
        res.status(503).json({
          error: 'service_unavailable',
          message: `${featureName} is not currently enabled`,
        });
        return;
      }

      next();
    };
  };
}

// Public flag checkers
export const isAIExtractionEnabled = () => readAIFlag('ENABLE_AI_EXTRACTION');
export const isSemanticSearchEnabled = () => readAIFlag('ENABLE_SEMANTIC_SEARCH');
export const isAIFraudEnabled = () => readAIFlag('ENABLE_AI_FRAUD');
export const isAIReportsEnabled = () => readAIFlag('ENABLE_AI_REPORTS');

// Public gate middlewares
export const aiExtractionGate = createAIGate('ENABLE_AI_EXTRACTION', 'AI extraction');
export const aiSemanticSearchGate = createAIGate('ENABLE_SEMANTIC_SEARCH', 'Semantic search');
export const aiFraudGate = createAIGate('ENABLE_AI_FRAUD', 'AI fraud detection');
export const aiReportsGate = createAIGate('ENABLE_AI_REPORTS', 'AI reports');

/** Reset all AI flag caches — for testing only */
export function _resetAIFlagCache(): void {
  for (const key of Object.keys(aiFlags)) {
    aiFlags[key] = null;
  }
}
