/**
 * AI Feature Gate Middleware (P8-S3)
 *
 * Gates AI endpoints behind switchboard flags:
 *   - ENABLE_AI_EXTRACTION: Controls /api/v1/ai/extract
 *   - ENABLE_SEMANTIC_SEARCH: Controls semantic search endpoints
 *   - ENABLE_AI_FRAUD: Controls AI fraud detection (text-based)
 *   - ENABLE_AI_REPORTS: Controls AI report generation
 *   - ENABLE_VISUAL_FRAUD_DETECTION: Controls legacy /api/v1/ai/fraud/visual.
 *     That route now fails closed with 410 because SCRUM-1955 moves visual
 *     fraud analysis to a client-side worker.
 *
 * Fail-direction (SCRUM-2247 / HARDEN-1-D): the DB switchboard row is the
 * source of truth. When a DB read fails or returns no row, we resolve in this
 * order:
 *   1. Last-known-good DB value, if we have read one this process lifetime
 *      (a transient Supabase blip must not flip a flag).
 *   2. Otherwise the flag's *fail default*:
 *      - Kill-switchable flags (SEMANTIC_SEARCH, AI_FRAUD, AI_REPORTS,
 *        VISUAL_FRAUD_DETECTION) fail CLOSED (false). The env var is NOT a
 *        re-open path: with env=true + DB=false, a blip must keep the feature
 *        OFF, never silently re-enable it. (Pre-fix bug: returned envFallback
 *        on any DB error → fail-OPEN. SEV1.)
 *      - ENABLE_AI_EXTRACTION is launch-required (CLAUDE.md §1.6, default true
 *        in prod). It is not a kill-switch, so its fail default is its launch
 *        default (env value) — a blip keeps the launch path serving rather
 *        than 503-ing it. An explicit DB=false still wins, and once read it
 *        becomes the last-known-good.
 *
 * Uses TTL-based cache (60s) to avoid per-request DB queries. Same caching
 * pattern as featureGate.ts (P4.5-TS-12).
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
  ENABLE_VISUAL_FRAUD_DETECTION: null,
};

type AIFlagKey = keyof typeof aiFlags;

/**
 * Last successfully-read DB value per flag (survives TTL expiry). Used so a
 * transient DB blip after a good read holds the flag steady instead of
 * snapping to a fail default. Cleared by _resetAIFlagCache().
 */
const lastKnownGoodDb: Partial<Record<AIFlagKey, boolean>> = {};

/**
 * Per-flag fail direction when no last-known-good DB value exists and the DB
 * read fails. Kill-switchable flags fail CLOSED regardless of env (the env var
 * is never a re-open path). ENABLE_AI_EXTRACTION is launch-required (§1.6) so
 * it falls back to its launch default (env value).
 */
function failDefault(flagKey: AIFlagKey): boolean {
  if (flagKey === 'ENABLE_AI_EXTRACTION') {
    // Launch-required path: keep the launch default (env-driven, true in prod).
    return process.env[flagKey] === 'true';
  }
  // Kill-switchable: fail CLOSED. Do not consult env — that is the SEV1 bug.
  return false;
}

/**
 * Resolve the value to use when the DB read does not yield a fresh row.
 * Prefers last-known-good DB value, else the per-flag fail default.
 */
function resolveFallback(flagKey: AIFlagKey): boolean {
  const lkg = lastKnownGoodDb[flagKey];
  if (lkg !== undefined) return lkg;
  return failDefault(flagKey);
}

/**
 * Read an AI feature flag with TTL caching.
 * The DB switchboard row is the source of truth. On a failed/empty DB read we
 * resolve via resolveFallback() (last-known-good DB value, else the per-flag
 * fail default) — never via a naive env-var fail-OPEN. See file header and
 * SCRUM-2247 for the fail-direction contract.
 */
async function readAIFlag(flagKey: AIFlagKey): Promise<boolean> {
  const now = Date.now();
  const cached = aiFlags[flagKey];

  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  try {
    // Schema: switchboard_flags(id uuid, flag_key text, enabled boolean, ...).
    // Earlier code queried `select('value').eq('id', flagKey)` — that
    // (a) selected a column that doesn't exist, and (b) compared a uuid
    // column against a string flag name. Every read errored and fell back
    // to env var, making the DB-side flag system effectively dead code.
    // The /admin/controls UI flips would land in the row but the runtime
    // path was never reading them.
    const { data, error } = await db
      .from('switchboard_flags')
      .select('enabled')
      .eq('flag_key', flagKey)
      .single() as { data: { enabled: boolean } | null; error: unknown };

    if (error || !data) {
      // No fresh row. Fail-direction resolution — NOT a blanket env fail-OPEN.
      const fallback = resolveFallback(flagKey);
      logger.warn(
        { error, flagKey, fallback, lastKnownGood: lastKnownGoodDb[flagKey] },
        `Failed to read ${flagKey} flag from DB, using fail-direction fallback`,
      );
      aiFlags[flagKey] = { value: fallback, expiresAt: now + FLAG_CACHE_TTL_MS };
      return fallback;
    }

    const enabled = data.enabled === true;
    lastKnownGoodDb[flagKey] = enabled;
    aiFlags[flagKey] = { value: enabled, expiresAt: now + FLAG_CACHE_TTL_MS };
    return enabled;
  } catch (err) {
    const fallback = resolveFallback(flagKey);
    logger.error(
      { error: err, flagKey, fallback, lastKnownGood: lastKnownGoodDb[flagKey] },
      `Error reading ${flagKey} switchboard flag, using fail-direction fallback`,
    );
    aiFlags[flagKey] = { value: fallback, expiresAt: now + FLAG_CACHE_TTL_MS };
    return fallback;
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
export const isVisualFraudDetectionEnabled = () => readAIFlag('ENABLE_VISUAL_FRAUD_DETECTION');

// Public gate middlewares
export const aiExtractionGate = createAIGate('ENABLE_AI_EXTRACTION', 'AI extraction');
export const aiSemanticSearchGate = createAIGate('ENABLE_SEMANTIC_SEARCH', 'Semantic search');
export const aiFraudGate = createAIGate('ENABLE_AI_FRAUD', 'AI fraud detection');
export const aiReportsGate = createAIGate('ENABLE_AI_REPORTS', 'AI reports');
export const visualFraudDetectionGate = createAIGate(
  'ENABLE_VISUAL_FRAUD_DETECTION',
  'Visual fraud detection',
);

/** Reset all AI flag caches AND last-known-good DB values — for testing only */
export function _resetAIFlagCache(): void {
  for (const key of Object.keys(aiFlags)) {
    aiFlags[key] = null;
  }
  for (const key of Object.keys(lastKnownGoodDb)) {
    delete lastKnownGoodDb[key as AIFlagKey];
  }
}

/**
 * Expire the TTL cache without clearing last-known-good DB values — for
 * testing the "transient blip after a good read" path only.
 */
export function _expireAIFlagCache(): void {
  for (const key of Object.keys(aiFlags)) {
    aiFlags[key] = null;
  }
}
