/**
 * Treasury Cache Refresh Job (SCRUM-546)
 *
 * Fetches treasury balance, fee rates, and anchor stats,
 * then writes them to the treasury_cache singleton table.
 *
 * Called by Cloud Scheduler every 10 minutes.
 * Frontend reads from Supabase instead of calling mempool.space directly.
 */

import { config } from '../config.js';
import { addressFromWif } from '../chain/wallet.js';
import { createUtxoProvider } from '../chain/utxo-provider.js';
import { createFeeEstimator } from '../chain/fee-estimator.js';
import { logger } from '../utils/logger.js';
import { db } from '../utils/db.js';

export interface TreasuryCacheData {
  balance_confirmed_sats: number;
  balance_unconfirmed_sats: number;
  utxo_count: number;
  btc_price_usd: number | null;
  fee_fastest: number | null;
  fee_half_hour: number | null;
  fee_hour: number | null;
  fee_economy: number | null;
  fee_minimum: number | null;
  block_height: number | null;
  network_name: string | null;
  last_secured_at: string | null;
  total_secured: number;
  total_pending: number;
  last_24h_count: number;
  updated_at: string;
  error: string | null;
}

const MEMPOOL_API = 'https://mempool.space/api';

export async function refreshTreasuryCache(): Promise<TreasuryCacheData> {
  const data: TreasuryCacheData = {
    balance_confirmed_sats: 0,
    balance_unconfirmed_sats: 0,
    utxo_count: 0,
    btc_price_usd: null,
    fee_fastest: null,
    fee_half_hour: null,
    fee_hour: null,
    fee_economy: null,
    fee_minimum: null,
    block_height: null,
    network_name: null,
    last_secured_at: null,
    total_secured: 0,
    total_pending: 0,
    last_24h_count: 0,
    updated_at: new Date().toISOString(),
    error: null,
  };

  // 1. Fetch wallet balance from mempool.space
  let address: string | null = null;
  if (config.bitcoinTreasuryWif) {
    try {
      address = addressFromWif(config.bitcoinTreasuryWif);
      const res = await fetch(`${MEMPOOL_API}/address/${address}`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        const body = await res.json() as {
          chain_stats: { funded_txo_sum: number; spent_txo_sum: number };
          mempool_stats: { funded_txo_sum: number; spent_txo_sum: number };
        };
        data.balance_confirmed_sats = body.chain_stats.funded_txo_sum - body.chain_stats.spent_txo_sum;
        data.balance_unconfirmed_sats = body.mempool_stats.funded_txo_sum - body.mempool_stats.spent_txo_sum;
      }
    } catch (err) {
      logger.warn({ error: err }, 'Treasury cache: failed to fetch balance from mempool');
    }

    // UTXO count
    try {
      const utxoProvider = createUtxoProvider({
        type: 'mempool',
        mempoolApiUrl: config.mempoolApiUrl,
        network: config.bitcoinNetwork,
      });
      const utxos = await utxoProvider.listUnspent(address!);
      data.utxo_count = utxos.length;
    } catch (err) {
      logger.warn({ error: err }, 'Treasury cache: failed to fetch UTXOs');
    }
  }

  // 2. BTC price
  try {
    const res = await fetch(`${MEMPOOL_API}/v1/prices`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const body = await res.json() as { USD: number };
      data.btc_price_usd = body.USD;
    }
  } catch (err) {
    logger.warn({ error: err }, 'Treasury cache: failed to fetch BTC price');
  }

  // 3. Fee rates
  try {
    const res = await fetch(`${MEMPOOL_API}/v1/fees/recommended`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const fees = await res.json() as {
        fastestFee: number;
        halfHourFee: number;
        hourFee: number;
        economyFee: number;
        minimumFee: number;
      };
      data.fee_fastest = fees.fastestFee;
      data.fee_half_hour = fees.halfHourFee;
      data.fee_hour = fees.hourFee;
      data.fee_economy = fees.economyFee;
      data.fee_minimum = fees.minimumFee;
    }
  } catch (err) {
    logger.warn({ error: err }, 'Treasury cache: failed to fetch fee rates');
  }

  // 4. Network info
  try {
    const utxoProvider = createUtxoProvider({
      type: 'mempool',
      mempoolApiUrl: config.mempoolApiUrl,
      network: config.bitcoinNetwork,
    });
    const info = await utxoProvider.getBlockchainInfo();
    data.block_height = info.blocks;
    data.network_name = info.chain;
  } catch (err) {
    logger.warn({ error: err }, 'Treasury cache: failed to fetch network info');
  }

  // 5. Anchor stats from Supabase
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
    data.total_secured = securedCount ?? 0;
    data.total_pending = pendingCount ?? 0;
    data.last_secured_at = lastSecured?.[0]?.chain_timestamp ?? null;
    data.last_24h_count = last24hCount ?? 0;
  } catch (err) {
    logger.warn({ error: err }, 'Treasury cache: failed to fetch anchor stats');
  }

  // 6. Upsert into treasury_cache (singleton, id=1)
  const { error: upsertError } = await db
    .from('treasury_cache')
    .upsert({
      id: 1,
      ...data,
    });

  if (upsertError) {
    logger.error({ error: upsertError }, 'Treasury cache: failed to write cache');
    data.error = upsertError.message;
  } else {
    logger.info({
      balance: data.balance_confirmed_sats,
      pending: data.total_pending,
      secured: data.total_secured,
    }, 'Treasury cache refreshed');
  }

  return data;
}
