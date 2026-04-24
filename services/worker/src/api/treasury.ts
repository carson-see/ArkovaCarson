/**
 * Treasury APIs — Arkova Platform Admin Only
 *
 * GET /api/treasury/status — wallet + UTXOs + fees + anchor stats
 * GET /api/treasury/health — USD aggregate + below-threshold flag
 *
 * Both endpoints are gated behind the platform admin whitelist — never
 * accessible to org admins or external users. No exceptions. The
 * handleTreasuryHealth endpoint returns a narrower shape (USD only, no
 * wallet address) but the access policy is identical.
 *
 * Constitution refs:
 *   - 1.4: Treasury keys server-side only, never logged
 *   - feedback_treasury_access: Arkova-internal ONLY
 */

import type { Request, Response } from 'express';
import { config } from '../config.js';
import { addressFromWif } from '../chain/wallet.js';
import { createUtxoProvider } from '../chain/utxo-provider.js';
import { createFeeEstimator } from '../chain/fee-estimator.js';
import { logger } from '../utils/logger.js';
import { db } from '../utils/db.js';
import { isPlatformAdmin } from '../utils/platformAdmin.js';
import { fetchAnchorStats } from '../utils/anchor-stats.js';

export interface TreasuryStatusResponse {
  wallet: {
    address: string;
    balanceSats: number;
    utxoCount: number;
  } | null;
  network: {
    name: string;
    blockHeight: number;
  } | null;
  fees: {
    estimatorName: string;
    currentRateSatPerVbyte: number;
  } | null;
  recentAnchors: {
    totalSecured: number;
    totalPending: number;
    lastSecuredAt: string | null;
    last24hCount: number;
  };
  error?: string;
}

export async function handleTreasuryStatus(
  userId: string,
  _req: Request,
  res: Response,
): Promise<void> {
  // Gate: platform admin only
  const isAdmin = await isPlatformAdmin(userId);
  if (!isAdmin) {
    res.status(403).json({ error: 'Forbidden — platform admin access required' });
    return;
  }

  const result: TreasuryStatusResponse = {
    wallet: null,
    network: null,
    fees: null,
    recentAnchors: {
      totalSecured: 0,
      totalPending: 0,
      lastSecuredAt: null,
      last24hCount: 0,
    },
  };

  // 1. Wallet balance + UTXOs (requires BITCOIN_TREASURY_WIF)
  if (config.bitcoinTreasuryWif) {
    try {
      const address = addressFromWif(config.bitcoinTreasuryWif);
      const utxoProvider = createUtxoProvider({
        type: config.bitcoinUtxoProvider as 'rpc' | 'mempool' | 'getblock',
        rpcUrl: config.bitcoinRpcUrl,
        rpcAuth: config.bitcoinRpcAuth,
        mempoolApiUrl: config.mempoolApiUrl,
        network: config.bitcoinNetwork,
      });

      const utxos = await utxoProvider.listUnspent(address);
      const balanceSats = utxos.reduce((sum, u) => sum + u.valueSats, 0);

      result.wallet = {
        address,
        balanceSats,
        utxoCount: utxos.length,
      };

      // Network info
      try {
        const blockchainInfo = await utxoProvider.getBlockchainInfo();
        result.network = {
          name: blockchainInfo.chain,
          blockHeight: blockchainInfo.blocks,
        };
      } catch (err) {
        logger.warn({ error: err }, 'Failed to fetch blockchain info for treasury status');
      }
    } catch (err) {
      logger.warn({ error: err }, 'Failed to fetch wallet data for treasury status');
      result.error = 'Wallet data temporarily unavailable';
    }
  } else {
    result.error = 'Treasury wallet not configured (BITCOIN_TREASURY_WIF not set)';
  }

  // 2. Fee estimates
  try {
    const useMempoolFees = config.bitcoinUtxoProvider === 'mempool' || !config.bitcoinRpcUrl;
    const feeEstimator = createFeeEstimator({
      strategy: useMempoolFees ? 'mempool' : 'static',
      mempoolApiUrl: config.mempoolApiUrl,
      staticRate: 1,
    });
    const rate = await feeEstimator.estimateFee();
    result.fees = {
      estimatorName: feeEstimator.name,
      currentRateSatPerVbyte: rate,
    };
  } catch (err) {
    logger.warn({ error: err }, 'Failed to estimate fees for treasury status');
  }

  // 3. Anchor stats from Supabase (shared helper — same query as
  //    treasury-cache cron, extracted to utils/anchor-stats.ts so SonarCloud
  //    doesn't flag duplicate-lines density).
  const stats = await fetchAnchorStats();
  result.recentAnchors = {
    totalSecured: stats.total_secured,
    totalPending: stats.total_pending,
    lastSecuredAt: stats.last_secured_at,
    last24hCount: stats.last_24h_count,
  };

  res.json(result);
}

// =============================================================================
// ARK-103 (SCRUM-1013): Treasury Health — safe for any authed user
// =============================================================================
//
// Unlike `/api/treasury/status` (platform-admin-only, leaks wallet address +
// UTXOs), this endpoint returns ONLY aggregate USD numbers + the current
// alert flag. Org admins surface this on their dashboard so they know when
// fast-track anchoring is paused.

export interface TreasuryHealthResponse {
  balance_usd: number | null;
  below_threshold: boolean;
  threshold_usd: number;
  /** Null when price oracle is stale or not configured. */
  price_unknown: boolean;
  last_alert_at: string | null;
  last_updated_at: string | null;
}

const DEFAULT_TREASURY_THRESHOLD_USD = 50;
const SATS_PER_BTC = 100_000_000;

export async function handleTreasuryHealth(
  userId: string,
  _req: import('express').Request,
  res: import('express').Response,
): Promise<void> {
  // Same platform-admin gate as handleTreasuryStatus — USD aggregates are
  // still treasury state and only Arkova operators should see them.
  const isAdmin = await isPlatformAdmin(userId);
  if (!isAdmin) {
    res.status(403).json({ error: 'Forbidden — platform admin access required' });
    return;
  }
  try {
    // Parallel reads: cache + alert state. Matches the pattern in
    // services/worker/src/jobs/treasury-alert.ts.
    const [cacheResult, alertResult] = await Promise.all([
      db
        .from('treasury_cache')
        .select('balance_confirmed_sats, btc_price_usd, updated_at')
        .limit(1)
        .maybeSingle(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (db as any)
        .from('treasury_alert_state')
        .select('below_threshold, updated_at')
        .eq('key', 'low_balance')
        .maybeSingle(),
    ]);

    // CIBA-HARDEN-03: DB errors must not be treated as "everything's fine."
    // Previously this code read .data and ignored .error, which meant a
    // transient Supabase outage returned balance_usd: null + below_threshold:
    // false — indistinguishable from a genuinely-healthy treasury. Return
    // 500 so the health check fails loudly instead.
    if (cacheResult.error) {
      logger.error({ error: cacheResult.error }, 'Treasury health: cache read failed');
      res.status(500).json({ error: 'Internal server error', source: 'treasury_cache' });
      return;
    }
    if (alertResult.error) {
      logger.error({ error: alertResult.error }, 'Treasury health: alert state read failed');
      res.status(500).json({ error: 'Internal server error', source: 'treasury_alert_state' });
      return;
    }

    const cache = cacheResult.data as
      | { balance_confirmed_sats: number | null; btc_price_usd: number | null; updated_at: string | null }
      | null;
    const alert = alertResult.data as
      | { below_threshold: boolean; updated_at: string | null }
      | null;

    // CIBA-HARDEN-03: parse TREASURY_LOW_BALANCE_USD defensively. An empty
    // env var, a typo ("fifty"), or a negative value all used to silently
    // become NaN → every balance was "below threshold" by accident, firing
    // alerts on a healthy treasury. Fall back to DEFAULT on any non-finite
    // or non-positive parse.
    const thresholdUsd = parseThresholdUsd(process.env.TREASURY_LOW_BALANCE_USD);
    const priceUnknown = cache?.btc_price_usd == null || cache?.balance_confirmed_sats == null;
    const balanceUsd = priceUnknown
      ? null
      : (cache!.balance_confirmed_sats! / SATS_PER_BTC) * (cache!.btc_price_usd as number);

    const response: TreasuryHealthResponse = {
      balance_usd: balanceUsd,
      below_threshold: alert?.below_threshold ?? (balanceUsd != null && balanceUsd < thresholdUsd),
      threshold_usd: thresholdUsd,
      price_unknown: priceUnknown,
      last_alert_at: alert?.updated_at ?? null,
      last_updated_at: cache?.updated_at ?? null,
    };

    res.json(response);
  } catch (err) {
    logger.error({ error: err }, 'handleTreasuryHealth failed');
    res.status(500).json({ error: { code: 'internal', message: 'Internal server error' } });
  }
}

/**
 * Defensive parse of the TREASURY_LOW_BALANCE_USD env var.
 *
 * Rejects: undefined, empty string, NaN, non-finite, negative, zero.
 * Any rejection falls back to DEFAULT_TREASURY_THRESHOLD_USD (50). Exported
 * so treasury-alert.ts can share the same semantics (follow-up).
 */
export function parseThresholdUsd(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_TREASURY_THRESHOLD_USD;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TREASURY_THRESHOLD_USD;
  return parsed;
}
