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
  getCurrentFeeRate: () => Promise<number | null>;
}

interface HealthResponse {
  statusCode: number;
  body: {
    status: 'healthy' | 'degraded';
    version: string;
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
  };

  let lastSecuredAt: string | null = null;
  let lastBatchAt: string | null = null;
  let pendingCount: number | null = null;
  let feeRateSatVb: number | null = null;

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
  }

  const anchoringCheck: AnchoringCheck = {
    status: 'ok',
    lastSecuredAt,
    lastBatchAt,
    pendingCount,
    feeRateSatVb,
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
      uptime: Math.floor(process.uptime()),
      network: cfg.bitcoinNetwork,
      checks: detailed ? detailedChecks : compactChecks,
      ...(detailed ? { info, connection: deps.getConnectionInfo() } : {}),
    },
  };
}
