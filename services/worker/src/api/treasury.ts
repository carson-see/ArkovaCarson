/**
 * Treasury Status API — Arkova Internal Only
 *
 * GET /api/treasury/status
 *
 * Returns treasury wallet balance, UTXO count, fee estimates, and network info.
 * Gated behind platform admin email whitelist — never accessible to third-party
 * org admins or external users.
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

/** Platform admin emails — must match TreasuryAdminPage.tsx whitelist */
const PLATFORM_ADMIN_EMAILS = [
  'carson@arkova.ai',
  'sarah@arkova.ai',
];

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

/**
 * Verify the requesting user is a platform admin (Arkova internal).
 * Checks email against the hardcoded whitelist.
 */
async function isPlatformAdmin(userId: string): Promise<boolean> {
  const { data: profile } = await db
    .from('profiles')
    .select('email')
    .eq('id', userId)
    .single();

  if (!profile?.email) return false;
  return PLATFORM_ADMIN_EMAILS.includes(profile.email);
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
        type: config.bitcoinUtxoProvider as 'rpc' | 'mempool',
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

  // 3. Anchor stats from Supabase (always available)
  try {
    const [
      { count: securedCount },
      { count: pendingCount },
      { data: lastSecured },
      { count: last24hCount },
    ] = await Promise.all([
      db.from('anchors').select('*', { count: 'exact', head: true })
        .eq('status', 'SECURED').is('deleted_at', null),
      db.from('anchors').select('*', { count: 'exact', head: true })
        .eq('status', 'PENDING').is('deleted_at', null),
      db.from('anchors').select('chain_timestamp')
        .eq('status', 'SECURED').is('deleted_at', null)
        .order('chain_timestamp', { ascending: false })
        .limit(1),
      db.from('anchors').select('*', { count: 'exact', head: true })
        .is('deleted_at', null)
        .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()),
    ]);

    result.recentAnchors = {
      totalSecured: securedCount ?? 0,
      totalPending: pendingCount ?? 0,
      lastSecuredAt: lastSecured?.[0]?.chain_timestamp ?? null,
      last24hCount: last24hCount ?? 0,
    };
  } catch (err) {
    logger.warn({ error: err }, 'Failed to fetch anchor stats for treasury status');
  }

  res.json(result);
}
