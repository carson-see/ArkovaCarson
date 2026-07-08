/**
 * Enhanced Health Endpoint (P7-TS-06)
 *
 * Structured subsystem health checks for production smoke testing.
 * Returns database, anchoring, KMS, and fee rate status.
 *
 * Constitution refs:
 *   - 1.4: No PII, secrets, or API keys in responses
 *   - 1.9: /api/health always available without auth
 *
 * The actual Express route is mounted in index.ts — this module
 * exports pure functions for testability.
 */

import { getBuildSha } from '../utils/buildInfo.js';
import { evaluateBatchDrainHealth, type BatchDrainReason } from './batch-drain-deadman.js';

/**
 * Dependency injection interface for health checks.
 * Allows full mocking in tests without touching real Supabase/chain.
 */
export interface HealthCheckDeps {
  isDbHealthy: () => boolean;
  dbQuery: () => Promise<{ data: unknown; error: { message: string } | null }>;
  recordDbSuccess: () => void;
  recordDbFailure: (err: unknown) => void;
  getDbCircuitState: () => { healthy: boolean; consecutiveFailures: number; lastError: string | null };
  getConnectionInfo: () => { mode: 'pooler' | 'direct'; url: string };
  config: {
    bitcoinNetwork: 'signet' | 'testnet' | 'testnet4' | 'mainnet';
    stripeSecretKey: string;
    sentryDsn?: string;
    geminiApiKey?: string;
    aiProvider?: string;
    kmsProvider: 'aws' | 'gcp';
    bitcoinKmsKeyId?: string;
    gcpKmsKeyResourceName?: string;
    bitcoinTreasuryWif?: string;
    enableProdNetworkAnchoring: boolean;
  };
  getLastSecuredAnchor: () => Promise<{ data: Array<{ created_at: string }> | null; error: { message: string } | null }>;
  getLastBatchAnchor: () => Promise<{ data: Array<{ updated_at?: string; completed_at?: string }> | null; error: { message: string } | null }>;
  getPendingAnchorCount: () => Promise<{ count: number | null; error: { message: string } | null }>;
  /**
   * Oldest PENDING anchor timestamp — powers the batch-drain dead-man's-switch.
   * Optional so existing callers/mocks stay valid; when absent, a non-empty
   * backlog is reported with unknown age (fails loud, never silent).
   */
  getOldestPendingAnchor?: () => Promise<{ data: Array<{ created_at: string }> | null; error: { message: string } | null }>;
  getCurrentFeeRate: () => Promise<number | null>;
}

interface HealthResponse {
  statusCode: number;
  body: {
    status: 'healthy' | 'degraded';
    version: string;
    // SCRUM-1247 (R0-1): git SHA of the deployed image. Populated from BUILD_SHA
    // env baked at Docker build via `--build-arg BUILD_SHA=$github.sha`.
    // Returns "unknown" if env is unset (image built without the build-arg).
    // Operators compare against `git rev-parse origin/main` to detect deploy drift.
    git_sha: string;
    uptime: number;
    network: string;
    checks: Record<string, unknown>;
    info?: Record<string, unknown>;
    connection?: { mode: string; url?: string };
  };
}

/**
 * Build the health response — pure function, no side effects on Express.
 * Called by the /health route handler in index.ts.
 */
export async function buildHealthResponse(
  deps: HealthCheckDeps,
  detailed: boolean,
): Promise<HealthResponse> {
  // ─── Database check ───
  type DbCheck = { status: 'ok' | 'error'; latencyMs?: number; message?: string };
  let dbCheck: DbCheck;

  if (!deps.isDbHealthy()) {
    const circuitState = deps.getDbCircuitState();
    dbCheck = {
      status: 'error',
      message: `Circuit breaker open (${circuitState.consecutiveFailures} consecutive failures): ${circuitState.lastError}`,
    };
  } else {
    const dbStart = Date.now();
    try {
      const { error } = await deps.dbQuery();
      if (error) {
        deps.recordDbFailure(error);
        dbCheck = { status: 'error', latencyMs: Date.now() - dbStart, message: error.message };
      } else {
        deps.recordDbSuccess();
        dbCheck = { status: 'ok', latencyMs: Date.now() - dbStart };
      }
    } catch (err) {
      deps.recordDbFailure(err);
      dbCheck = {
        status: 'error',
        latencyMs: Date.now() - dbStart,
        message: err instanceof Error ? err.message : 'Connection failed',
      };
    }
  }

  // ─── Anchoring checks (informational, non-critical) ───
  type AnchoringCheck = {
    status: 'ok' | 'warning';
    lastSecuredAt: string | null;
    lastBatchAt: string | null;
    pendingCount: number | null;
    feeRateSatVb: number | null;
    // Batch-drain dead-man's-switch (Lane-1 S3.5 / BTC-real). Present in
    // detailed mode; true/reason surface a stalled nightly drain that would
    // otherwise be indistinguishable from a healthy empty-queue flush.
    drainStalled?: boolean;
    drainReason?: BatchDrainReason;
  };

  let lastSecuredAt: string | null = null;
  let lastBatchAt: string | null = null;
  let pendingCount: number | null = null;
  let feeRateSatVb: number | null = null;
  let oldestPendingAt: string | null = null;

  // Only fetch enrichment data in detailed mode — basic /health probes
  // from load balancers should be cheap (DB ping only)
  if (detailed) {
    try {
      const securedResult = await deps.getLastSecuredAnchor();
      if (!securedResult.error && securedResult.data && securedResult.data.length > 0) {
        lastSecuredAt = securedResult.data[0].created_at;
      }
    } catch {
      // Non-critical — continue
    }

    try {
      const batchResult = await deps.getLastBatchAnchor();
      if (!batchResult.error && batchResult.data && batchResult.data.length > 0) {
        lastBatchAt = batchResult.data[0].updated_at ?? batchResult.data[0].completed_at ?? null;
      }
    } catch {
      // Non-critical — continue
    }

    try {
      const countResult = await deps.getPendingAnchorCount();
      if (!countResult.error && countResult.count !== null) {
        pendingCount = countResult.count;
      }
    } catch {
      // Non-critical — continue
    }

    try {
      feeRateSatVb = await deps.getCurrentFeeRate();
    } catch {
      // Non-critical — continue
    }

    if (deps.getOldestPendingAnchor) {
      try {
        const oldestResult = await deps.getOldestPendingAnchor();
        if (!oldestResult.error && oldestResult.data && oldestResult.data.length > 0) {
          oldestPendingAt = oldestResult.data[0].created_at ?? null;
        }
      } catch {
        // Non-critical — leave null; the switch treats a proven backlog with
        // unknown age as loud (never silent).
      }
    }
  }

  // ─── Batch-drain dead-man's-switch (Lane-1 S3.5 / BTC-real) ───
  // Only meaningful in detailed mode, where pending/batch enrichment ran.
  // Flips anchoring.status to 'warning' when a real PENDING backlog is aging
  // without being drained — the loud signal the diagnosis found missing.
  const drainVerdict = detailed
    ? evaluateBatchDrainHealth({
        pendingCount,
        oldestPendingAt,
        lastBatchAt,
        nowMs: Date.now(),
      })
    : null;

  const anchoringCheck: AnchoringCheck = {
    status: drainVerdict?.status ?? 'ok',
    lastSecuredAt,
    lastBatchAt,
    pendingCount,
    feeRateSatVb,
    ...(drainVerdict
      ? { drainStalled: drainVerdict.stalled, drainReason: drainVerdict.reason }
      : {}),
  };

  // ─── KMS / signing check ───
  type KmsCheck = { status: 'ok' | 'warning'; provider: string; message?: string };
  let kmsCheck: KmsCheck;

  const cfg = deps.config;
  if (cfg.kmsProvider === 'gcp' && cfg.gcpKmsKeyResourceName) {
    kmsCheck = { status: 'ok', provider: 'gcp' };
  } else if (cfg.kmsProvider === 'aws' && cfg.bitcoinKmsKeyId) {
    kmsCheck = { status: 'ok', provider: 'aws' };
  } else if (cfg.bitcoinTreasuryWif) {
    kmsCheck = { status: 'ok', provider: 'wif' };
  } else {
    kmsCheck = {
      status: 'warning',
      provider: 'none',
      message: 'No signing key configured (KMS key or treasury WIF required)',
    };
  }

  // ─── Overall status ───
  const allHealthy = dbCheck.status === 'ok';

  // ─── Build response ───
  const compactChecks: Record<string, unknown> = {
    database: dbCheck.status,
    anchoring: anchoringCheck.status,
    kms: kmsCheck.status,
  };

  const detailedChecks: Record<string, unknown> = {
    database: dbCheck,
    anchoring: anchoringCheck,
    kms: kmsCheck,
  };

  const info: Record<string, unknown> = {
    stripe: { configured: Boolean(cfg.stripeSecretKey) },
    sentry: {
      configured: Boolean(cfg.sentryDsn),
      ...(!cfg.sentryDsn ? { message: 'SENTRY_DSN not configured' } : {}),
    },
    ai: {
      configured: Boolean(cfg.geminiApiKey) || cfg.aiProvider === 'mock',
    },
    prodAnchoring: { enabled: cfg.enableProdNetworkAnchoring },
  };

  return {
    statusCode: allHealthy ? 200 : 503,
    body: {
      status: allHealthy ? 'healthy' : 'degraded',
      version: process.env.npm_package_version ?? '0.1.0',
      git_sha: getBuildSha(),
      uptime: Math.floor(process.uptime()),
      network: cfg.bitcoinNetwork,
      checks: detailed ? detailedChecks : compactChecks,
      ...(detailed ? { info, connection: deps.getConnectionInfo() } : {}),
    },
  };
}
