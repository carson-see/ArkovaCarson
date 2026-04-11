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

function mempoolApiUrl(): string {
  return config.mempoolApiUrl || 'https://mempool.space/api';
}

/**
 * Handle a PromiseSettledResult by running `onSuccess` on a fulfilled non-nullish
 * value, and logging a warning on rejection. Collapses the 5 nearly-identical
 * `if (status === 'fulfilled') ... else if (rejected)` branches in
 * refreshTreasuryCache into single-line calls, which keeps the top-level function
 * below SonarCloud's S3776 cognitive-complexity threshold.
 */
function handleSettled<T>(
  result: PromiseSettledResult<T | null | undefined>,
  onSuccess: (value: T) => void,
  errorLabel: string,
): void {
  if (result.status === 'fulfilled') {
    if (result.value != null) {
      onSuccess(result.value as T);
    }
    return;
  }
  logger.warn({ error: result.reason }, `Treasury cache: ${errorLabel}`);
}

async function fetchAnchorStats(): Promise<Pick<TreasuryCacheData, 'total_secured' | 'total_pending' | 'last_secured_at' | 'last_24h_count'>> {
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
    return {
      total_secured: securedCount ?? 0,
      total_pending: pendingCount ?? 0,
      last_secured_at: lastSecured?.[0]?.chain_timestamp ?? null,
      last_24h_count: last24hCount ?? 0,
    };
  } catch (err) {
    logger.warn({ error: err }, 'Treasury cache: failed to fetch anchor stats');
    return { total_secured: 0, total_pending: 0, last_secured_at: null, last_24h_count: 0 };
  }
}

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

  const apiBase = mempoolApiUrl();
  let address: string | null = null;

  if (config.bitcoinTreasuryWif) {
    try {
      address = addressFromWif(config.bitcoinTreasuryWif);
    } catch (err) {
      logger.warn({ error: err }, 'Treasury cache: failed to derive address from WIF');
    }
  }

  // Create UTXO provider once for reuse
  const utxoProvider = createUtxoProvider({
    type: 'mempool',
    mempoolApiUrl: config.mempoolApiUrl,
    network: config.bitcoinNetwork,
  });

  // Fetch balance, price, fees, UTXOs, and network info in parallel
  const [balanceResult, priceResult, feeResult, utxoResult, networkResult] = await Promise.allSettled([
    // 1. Balance from mempool.space
    address
      ? fetch(`${apiBase}/address/${address}`, { signal: AbortSignal.timeout(15_000) })
          .then(res => res.ok ? res.json() as Promise<{
            chain_stats: { funded_txo_sum: number; spent_txo_sum: number };
            mempool_stats: { funded_txo_sum: number; spent_txo_sum: number };
          }> : null)
      : Promise.resolve(null),
    // 2. BTC price
    fetch(`${apiBase}/v1/prices`, { signal: AbortSignal.timeout(10_000) })
      .then(res => res.ok ? res.json() as Promise<{ USD: number }> : null),
    // 3. Fee rates
    fetch(`${apiBase}/v1/fees/recommended`, { signal: AbortSignal.timeout(10_000) })
      .then(res => res.ok ? res.json() as Promise<{
        fastestFee: number; halfHourFee: number; hourFee: number;
        economyFee: number; minimumFee: number;
      }> : null),
    // 4. UTXO count
    address
      ? utxoProvider.listUnspent(address).then(utxos => utxos.length)
      : Promise.resolve(0),
    // 5. Network info
    utxoProvider.getBlockchainInfo(),
  ]);

  // Process results. Each handleSettled() call keeps branching off the main
  // function's complexity budget (S3776).
  handleSettled(balanceResult, (body) => {
    data.balance_confirmed_sats = body.chain_stats.funded_txo_sum - body.chain_stats.spent_txo_sum;
    data.balance_unconfirmed_sats = body.mempool_stats.funded_txo_sum - body.mempool_stats.spent_txo_sum;
  }, 'failed to fetch balance');

  handleSettled(priceResult, (priceData) => {
    data.btc_price_usd = priceData.USD;
  }, 'failed to fetch BTC price');

  handleSettled(feeResult, (fees) => {
    data.fee_fastest = fees.fastestFee;
    data.fee_half_hour = fees.halfHourFee;
    data.fee_hour = fees.hourFee;
    data.fee_economy = fees.economyFee;
    data.fee_minimum = fees.minimumFee;
  }, 'failed to fetch fee rates');

  handleSettled(utxoResult, (utxoCount) => {
    data.utxo_count = utxoCount;
  }, 'failed to fetch UTXOs');

  handleSettled(networkResult, (info) => {
    data.block_height = info.blocks;
    data.network_name = info.chain;
  }, 'failed to fetch network info');

  // Anchor stats from Supabase (extracted for complexity budget)
  Object.assign(data, await fetchAnchorStats());

  // Upsert into treasury_cache (singleton, id=1)
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
