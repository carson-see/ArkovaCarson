/**
 * Feature Flag Registry (ARCH-5)
 *
 * Centralized registry for all feature flags across the worker.
 * Combines env-based flags (config.ts) and DB-backed flags (switchboard_flags table).
 * Logs all active flags at startup for operational visibility.
 *
 * Usage:
 *   await flagRegistry.init();                          // Call once at startup
 *   await flagRegistry.getFlagLive('ENABLE_BATCH_ANCHORING')  // GATE a code path
 *   flagRegistry.getFlag('ENABLE_AI_EXTRACTION')        // Boot snapshot (diagnostics)
 *   flagRegistry.getAllFlags()                          // Snapshot of all flags
 *
 * DI-736 / SCRUM-3475 — `getFlag()` is a BOOT-TIME SNAPSHOT and nothing more.
 * `init()` reads the switchboard once; the value it caches never changes for
 * the life of the process. That is fine for the startup log and for /health
 * diagnostics, and it is WRONG for a kill switch: flipping
 * `switchboard_flags.ENABLE_BATCH_ANCHORING` (the nightly 3am drain — the money
 * path) or `ENABLE_EXPIRY_ALERTS` used to have no effect until the worker was
 * restarted, so the switch did not switch.
 *
 * `getFlagLive()` is the resolver a gate must use. It refreshes DB-backed flags
 * from `switchboard_flags` on a 60s TTL — the same cadence as the two sibling
 * resolvers that already do this correctly (`featureGate.ts`,
 * `aiFeatureGate.ts`) — and writes the refreshed value back into the snapshot
 * so diagnostics stop reporting a stale boot value.
 *
 * FAIL DIRECTION on a failed refresh (SCRUM-2247's contract, applied here):
 *   1. Last-known-good DB value read this process lifetime — a transient
 *      Supabase blip must never flip a kill switch in either direction. In
 *      particular the env var is NOT a re-open path for a row that was read
 *      as false.
 *   2. Else the boot snapshot (whatever `init()` resolved — DB row or env).
 *   3. Else — `init()` never ran — false. Fail closed.
 * A refresh failure is cached for the same TTL so an outage does not turn every
 * gate check into a DB round trip.
 *
 * Note the deliberate asymmetry with `init()`: `init()` falls back to the env
 * var when a row is ABSENT, whereas a live refresh that stops finding a row
 * holds the last-known-good DB value instead. A deleted/unreadable row must not
 * silently hand control back to an env var that may say "on".
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
  ENABLE_CONFIRMATION_PROOF_BACKFILL: () => config.enableConfirmationProofBackfill,
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
  // BUG-008/027: env-backed on purpose — a capability disabled by founder
  // directive must not be re-enablable by a switchboard_flags DB write.
  ENABLE_NESSIE_QUERY: () => config.enableNessieQuery,
  ENABLE_MULTIMODAL_EMBEDDINGS: () => config.enableMultimodalEmbeddings,
  ENABLE_CLOUD_LOGGING_SINK: () => config.enableCloudLoggingSink,
  ENABLE_WORKSPACE_RENEWAL: () => config.enableWorkspaceRenewal,
  ENABLE_DRIVE_OAUTH: () => config.enableDriveOauth,
  ENABLE_DRIVE_WEBHOOK: () => config.enableDriveWebhook,
  ENABLE_DOCUSIGN_OAUTH: () => config.enableDocusignOauth,
  ENABLE_DOCUSIGN_WEBHOOK: () => config.enableDocusignWebhook,
  ENABLE_ATS_WEBHOOK: () => config.enableAtsWebhook,
  ENABLE_VEREMARK_WEBHOOK: () => config.enableVeremarkWebhook,
  ENABLE_MICROSOFT_GRAPH_WEBHOOK: () => config.enableMicrosoftGraphWebhook,
} as const;

type EnvFlagName = keyof typeof ENV_FLAG_GETTERS;

const ENV_FLAGS = Object.keys(ENV_FLAG_GETTERS) as EnvFlagName[];

const DB_FLAGS = [
  'ENABLE_VERIFICATION_API',
  'ENABLE_AI_EXTRACTION',
  'ENABLE_SEMANTIC_SEARCH',
  'ENABLE_AI_FRAUD',
  'ENABLE_FRAUD_DETECTION',
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
  'ENABLE_PARTNER_PROVISIONING',
  'MAINTENANCE_MODE',
] as const;

type DbFlagName = typeof DB_FLAGS[number];

type FlagName = typeof ENV_FLAGS[number] | DbFlagName;

/** Membership test for the DB-backed half of the registry. */
const DB_FLAG_SET: ReadonlySet<string> = new Set<string>(DB_FLAGS);

function isDbFlag(name: string): name is DbFlagName {
  return DB_FLAG_SET.has(name);
}

/**
 * How long a DB-backed flag may be served from cache before `getFlagLive()`
 * re-reads the switchboard. Matches featureGate.ts / aiFeatureGate.ts.
 */
const FLAG_REFRESH_TTL_MS = 60_000; // 60 seconds

class FeatureFlagRegistry {
  private flags = new Map<string, FlagState>();

  /**
   * Last successfully-read DB value per flag (survives TTL expiry). A blip
   * after a good read holds the flag steady rather than snapping to a default
   * or back to the env var. Cleared by `_reset()`.
   */
  private lastKnownGoodDb = new Map<string, boolean>();

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

    // Load DB-backed flags (with env var fallback for stability).
    // Schema: switchboard_flags(id uuid, flag_key text, enabled boolean, ...).
    // See SCRUM-1622. Pre-fix code queried `select('id, value').in('id', DB_FLAGS)`
    // which selected a non-existent column and compared the uuid PK against
    // text flag names. The `as` cast hid the type mismatch. Every startup
    // load errored and the registry was env-driven only.
    try {
      const { data, error } = await db
        .from('switchboard_flags')
        .select('flag_key, enabled')
        .in('flag_key', [...DB_FLAGS]);

      if (error) {
        logger.warn({ error }, 'Failed to load switchboard flags — falling back to env vars');
        for (const key of DB_FLAGS) {
          const envFallback = process.env[key] === 'true';
          this.flags.set(key, { value: envFallback, source: 'env', lastChecked: Date.now() });
        }
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dbFlagMap = new Map((data ?? []).map((r: any) => [r.flag_key, r.enabled === true]));
        for (const key of DB_FLAGS) {
          // If flag not in DB, fall back to env var
          const envFallback = process.env[key] === 'true';
          const fromDb = dbFlagMap.has(key);
          // A row we genuinely read is a last-known-good value from boot on,
          // so a refresh failure minutes later has something true to hold.
          if (fromDb) this.lastKnownGoodDb.set(key, dbFlagMap.get(key) ?? false);
          this.flags.set(key, {
            value: fromDb ? (dbFlagMap.get(key) ?? false) : envFallback,
            source: fromDb ? 'db' : 'env',
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
   * Boot-snapshot read — the value as of `init()` or the last refresh.
   * Returns false for unknown flags (fail-closed).
   *
   * DI-736: this is a SNAPSHOT, not a resolver. Do NOT gate a code path on it —
   * a switchboard flip is invisible here until the worker restarts. Use
   * `getFlagLive()` for anything that decides whether work runs; `getFlag()` is
   * for startup logging, /health and other diagnostics that must not do I/O.
   */
  getFlag(name: FlagName): boolean {
    const state = this.flags.get(name);
    if (!state) return false;
    return state.value;
  }

  /**
   * Resolve a feature flag against the live switchboard (DI-736 / SCRUM-3475).
   *
   * DB-backed flags are re-read from `switchboard_flags` once the snapshot is
   * older than FLAG_REFRESH_TTL_MS, so an operator flipping a row takes effect
   * within one TTL instead of never. Env-backed flags are process-level —
   * `config.ts` parses them once at boot and a running Cloud Run revision
   * cannot change them — so their snapshot IS the live value and no DB read is
   * issued. Unknown flags fail closed.
   */
  async getFlagLive(name: FlagName): Promise<boolean> {
    if (!isDbFlag(name)) return this.getFlag(name);

    const state = this.flags.get(name);
    if (state && Date.now() - state.lastChecked < FLAG_REFRESH_TTL_MS) {
      return state.value;
    }
    return this.refreshDbFlag(name);
  }

  /**
   * Re-read one DB-backed flag from `switchboard_flags` and update the
   * snapshot. Called by `getFlagLive()` when the cached value goes stale; also
   * usable directly to force an immediate refresh.
   *
   * On a failed/empty read this resolves through `resolveRefreshFallback()`
   * rather than defaulting to false — see the fail-direction contract in the
   * file header. The failure is still stamped with `lastChecked` so an outage
   * cannot turn every gate check into a DB round trip.
   */
  async refreshDbFlag(name: DbFlagName): Promise<boolean> {
    const now = Date.now();
    try {
      // Schema: see SCRUM-1622 — select `enabled` keyed by `flag_key`.
      const { data, error } = await db
        .from('switchboard_flags')
        .select('enabled')
        .eq('flag_key', name)
        .single() as { data: { enabled: boolean } | null; error: unknown };

      if (error || !data) {
        const fallback = this.resolveRefreshFallback(name);
        logger.warn(
          {
            error,
            flagKey: name,
            fallback: fallback.value,
            lastKnownGood: this.lastKnownGoodDb.get(name),
          },
          `Failed to refresh ${name} from switchboard_flags — using fail-direction fallback`,
        );
        this.flags.set(name, { ...fallback, lastChecked: now });
        return fallback.value;
      }

      const value = data.enabled === true;
      this.lastKnownGoodDb.set(name, value);
      this.flags.set(name, { value, source: 'db', lastChecked: now });
      return value;
    } catch (err) {
      const fallback = this.resolveRefreshFallback(name);
      logger.error(
        {
          error: err,
          flagKey: name,
          fallback: fallback.value,
          lastKnownGood: this.lastKnownGoodDb.get(name),
        },
        `Error refreshing ${name} from switchboard_flags — using fail-direction fallback`,
      );
      this.flags.set(name, { ...fallback, lastChecked: now });
      return fallback.value;
    }
  }

  /**
   * Value to serve when a refresh could not read a fresh row.
   * Last-known-good DB value → boot snapshot → fail closed. Deliberately never
   * re-consults `process.env`: a row that was read as false must not be
   * re-opened by an env var that says true (SCRUM-2247 fail-direction).
   */
  private resolveRefreshFallback(name: DbFlagName): FlagState {
    const lastGood = this.lastKnownGoodDb.get(name);
    if (lastGood !== undefined) {
      return { value: lastGood, source: 'db', lastChecked: 0 };
    }
    const state = this.flags.get(name);
    if (state) return { ...state };
    // init() never ran (or the registry was reset): nothing to trust.
    return { value: false, source: 'env', lastChecked: 0 };
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

  /** Reset for testing — clears the snapshot AND the last-known-good values. */
  _reset(): void {
    this.flags.clear();
    this.lastKnownGoodDb.clear();
  }

  /**
   * Expire the refresh TTL without clearing values — for testing the refresh
   * path (mirrors `_expireAIFlagCache()` in aiFeatureGate.ts). Keeps
   * last-known-good intact so fail-direction can be exercised.
   */
  _expireLiveCache(): void {
    for (const [key, state] of this.flags) {
      this.flags.set(key, { ...state, lastChecked: 0 });
    }
  }
}

export const flagRegistry = new FeatureFlagRegistry();
