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

// All known flags and their sources. Env-backed flags are process-level
// controls; DB-backed flags are switchboard rollout controls.
const ENV_FLAG_GETTERS = {
  USE_MOCKS: () => config.useMocks,
  ENABLE_PROD_NETWORK_ANCHORING: () => config.enableProdNetworkAnchoring,
  ENABLE_ORG_CREDIT_ENFORCEMENT: () => config.enableOrgCreditEnforcement,
  ENABLE_AI_FALLBACK: () => config.enableAiFallback,
  ENABLE_VERTEX_AI: () => config.enableVertexAi,
  ENABLE_RULES_ENGINE: () => config.enableRulesEngine,
  ENABLE_QUEUE_REMINDERS: () => config.enableQueueReminders,
  ENABLE_TREASURY_ALERTS: () => config.enableTreasuryAlerts,
  ENABLE_WEBHOOK_HMAC: () => config.enableWebhookHmac,
  ENABLE_RULE_ACTION_DISPATCHER: () => config.enableRuleActionDispatcher,
  ENABLE_ALLOCATION_ROLLOVER: () => config.enableAllocationRollover,
  ENABLE_VISUAL_FRAUD_DETECTION: () => config.enableVisualFraudDetection,
  ENABLE_GRC_INTEGRATIONS: () => config.enableGrcIntegrations,
  ENABLE_DEMO_INJECTOR: () => config.enableDemoInjector,
  ENABLE_SYNTHETIC_DATA: () => config.enableSyntheticData,
  ENABLE_NESSIE_RAG_RECOMMENDATIONS: () => config.enableNessieRagRecommendations,
  ENABLE_MULTIMODAL_EMBEDDINGS: () => config.enableMultimodalEmbeddings,
  ENABLE_CLOUD_LOGGING_SINK: () => config.enableCloudLoggingSink,
  ENABLE_WORKSPACE_RENEWAL: () => config.enableWorkspaceRenewal,
  ENABLE_DRIVE_OAUTH: () => config.enableDriveOauth,
  ENABLE_DRIVE_WEBHOOK: () => config.enableDriveWebhook,
  ENABLE_DOCUSIGN_OAUTH: () => config.enableDocusignOauth,
  ENABLE_DOCUSIGN_WEBHOOK: () => config.enableDocusignWebhook,
  ENABLE_ATS_WEBHOOK: () => config.enableAtsWebhook,
  ENABLE_VEREMARK_WEBHOOK: () => config.enableVeremarkWebhook,
} as const;

type EnvFlagName = keyof typeof ENV_FLAG_GETTERS;

const ENV_FLAGS = Object.keys(ENV_FLAG_GETTERS) as EnvFlagName[];

const DB_FLAGS = [
  'ENABLE_VERIFICATION_API',
  'ENABLE_AI_EXTRACTION',
  'ENABLE_SEMANTIC_SEARCH',
  'ENABLE_AI_FRAUD',
  'ENABLE_AI_REPORTS',
  'ENABLE_ADES_SIGNATURES',
  'ENABLE_EXPIRY_ALERTS',
  'ENABLE_COMPLIANCE_ENGINE',
  'ENABLE_X402_PAYMENTS',
  'ENABLE_PUBLIC_RECORDS_INGESTION',
  'ENABLE_PUBLIC_RECORD_ANCHORING',
  'ENABLE_PUBLIC_RECORD_EMBEDDINGS',
  'ENABLE_ATTESTATION_ANCHORING',
  'ENABLE_BATCH_ANCHORING',
  'ENABLE_OUTBOUND_WEBHOOKS',
  'ENABLE_NEW_CHECKOUTS',
  'ENABLE_REPORTS',
  'MAINTENANCE_MODE',
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
    for (const key of ENV_FLAGS) {
      this.flags.set(key, {
        value: Boolean(ENV_FLAG_GETTERS[key]()),
        source: 'env',
        lastChecked: Date.now(),
      });
    }

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
