/**
 * Feature Flag Registry (ARCH-5)
 *
 * Centralized registry for all feature flags across the worker.
 * Combines env-based flags (config.ts) and DB-backed flags (switchboard_flags table).
 * Logs all active flags at startup for operational visibility.
 *
 * Usage:
 *   await flagRegistry.init();          // Call once at startup
 *   flagRegistry.getFlag('ENABLE_AI_EXTRACTION')  // Returns boolean
 *   flagRegistry.getAllFlags()           // Returns snapshot of all flags
 */

import { config } from '../config.js';
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';

interface FlagState {
  value: boolean;
  source: 'env' | 'db';
  lastChecked: number;
}

const _FLAG_CACHE_TTL_MS = 60_000; // 60 seconds

// All known flags and their sources
const ENV_FLAGS = [
  'USE_MOCKS',
  'ENABLE_PROD_NETWORK_ANCHORING',
  'ENABLE_AI_FALLBACK',
] as const;

const DB_FLAGS = [
  'ENABLE_VERIFICATION_API',
  'ENABLE_AI_EXTRACTION',
  'ENABLE_SEMANTIC_SEARCH',
  'ENABLE_AI_FRAUD',
  'ENABLE_AI_REPORTS',
] as const;

type FlagName = typeof ENV_FLAGS[number] | typeof DB_FLAGS[number];

class FeatureFlagRegistry {
  private flags = new Map<string, FlagState>();

  /**
   * Initialize the registry — reads all env and DB flags, logs them.
   * Call once at server startup.
   */
  async init(): Promise<void> {
    // Load env-based flags from config
    this.flags.set('USE_MOCKS', {
      value: config.useMocks,
      source: 'env',
      lastChecked: Date.now(),
    });
    this.flags.set('ENABLE_PROD_NETWORK_ANCHORING', {
      value: config.enableProdNetworkAnchoring,
      source: 'env',
      lastChecked: Date.now(),
    });

    // Load DB-backed flags (with env var fallback for stability)
    try {
      const { data, error } = await db
        .from('switchboard_flags')
        .select('id, value')
        .in('id', [...DB_FLAGS]);

      if (error) {
        logger.warn({ error }, 'Failed to load switchboard flags — falling back to env vars');
        for (const key of DB_FLAGS) {
          const envFallback = process.env[key] === 'true';
          this.flags.set(key, { value: envFallback, source: 'env', lastChecked: Date.now() });
        }
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dbFlagMap = new Map((data ?? []).map((r: any) => [r.id, r.value === true]));
        for (const key of DB_FLAGS) {
          // If flag not in DB, fall back to env var
          const envFallback = process.env[key] === 'true';
          this.flags.set(key, {
            value: dbFlagMap.has(key) ? (dbFlagMap.get(key) ?? false) : envFallback,
            source: dbFlagMap.has(key) ? 'db' : 'env',
            lastChecked: Date.now(),
          });
        }
      }
    } catch (err) {
      logger.error({ error: err }, 'Error loading switchboard flags — falling back to env vars');
      for (const key of DB_FLAGS) {
        const envFallback = process.env[key] === 'true';
        this.flags.set(key, { value: envFallback, source: 'env', lastChecked: Date.now() });
      }
    }

    // Log all flags at startup for visibility
    const snapshot: Record<string, { value: boolean; source: string }> = {};
    for (const [key, state] of this.flags) {
      snapshot[key] = { value: state.value, source: state.source };
    }
    logger.info({ flags: snapshot }, 'Feature flag registry initialized');
  }

  /**
   * Get the current value of a feature flag.
   * Returns false for unknown flags (fail-closed).
   */
  getFlag(name: FlagName): boolean {
    const state = this.flags.get(name);
    if (!state) return false;
    return state.value;
  }

  /**
   * Refresh a DB-backed flag from the database.
   * Used by the existing featureGate/aiFeatureGate middleware
   * which have their own TTL caching.
   */
  async refreshDbFlag(name: string): Promise<boolean> {
    try {
      const { data, error } = await db
        .from('switchboard_flags')
        .select('value')
        .eq('id', name)
        .single() as { data: { value: boolean } | null; error: unknown };

      const value = (!error && data) ? data.value === true : false;
      this.flags.set(name, { value, source: 'db', lastChecked: Date.now() });
      return value;
    } catch {
      return this.getFlag(name as FlagName);
    }
  }

  /**
   * Get a snapshot of all flags — for diagnostics/health endpoints.
   */
  getAllFlags(): Record<string, { value: boolean; source: string }> {
    const result: Record<string, { value: boolean; source: string }> = {};
    for (const [key, state] of this.flags) {
      result[key] = { value: state.value, source: state.source };
    }
    return result;
  }

  /** Reset for testing */
  _reset(): void {
    this.flags.clear();
  }
}

export const flagRegistry = new FeatureFlagRegistry();
