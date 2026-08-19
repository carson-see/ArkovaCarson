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
import { fetchAnchorStats } from '../utils/anchor-stats.js';
import {
  MEMPOOL_API_BASES,
  mempoolApiBaseForNetwork,
  resolveMempoolApiBase,
} from '../utils/mempool-url.js';
import { normalizeBtcPrice } from '../utils/btc-price.js';
import { readJsonBounded } from '../utils/body-read-timeout.js';

/**
 * F-D0-5 (fullsoak 2026-08-12): body-read deadlines for the three direct
 * fetches below. Each `AbortSignal.timeout(...)` bounds only its REQUEST; the
 * chained `.json()` had no deadline, so a provider stalling after headers
 * would park a `Promise.allSettled` leg forever — and `allSettled` waits for
 * every leg, so ONE stalled read hangs the whole refresh. Matched to each
 * call's own request budget.
 */
const BALANCE_BODY_READ_TIMEOUT_MS = 15_000;
const QUOTE_BODY_READ_TIMEOUT_MS = 10_000;

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

/**
 * Base for the NETWORK-SCOPED lookups (`/address/…`, `/v1/fees/recommended`).
 *
 * SCRUM-3016: this job builds requests as `${apiBase}/address/${address}` —
 * it never appends /api itself, so the base must already carry it.
 * resolveMempoolApiBase normalizes a MEMPOOL_API_URL set WITHOUT a
 * trailing /api (the OTHER convention some sibling consumers expect — see
 * mempool-url.ts) up to the form this job needs.
 *
 * BUG-2026-08-11: the fallback used to be the mainnet base verbatim, so every
 * non-mainnet deployment asked the mainnet explorer about its own address and
 * silently recorded a zero balance. It now selects per-network exactly as
 * `createUtxoProvider` does — the provider built below already did, which is
 * why utxo_count and block_height were right while the balance was 0.
 */
function mempoolApiUrl(): string {
  return resolveMempoolApiBase(
    config.mempoolApiUrl,
    mempoolApiBaseForNetwork(config.bitcoinNetwork),
  );
}

/**
 * Base for the GLOBAL BTC/USD quote (`/v1/prices`).
 *
 * Deliberately NOT per-network: signet/testnet explorers serve this endpoint
 * with HTTP 200 and a `-1` sentinel for every currency, so selecting it by
 * network would replace the zero-balance bug with a negative-price one (see
 * mempoolApiBaseForNetwork's docstring). An operator-set MEMPOOL_API_URL
 * still wins — pointing at a private mempool instance is an explicit choice,
 * and `normalizeBtcPrice` validates whatever comes back either way.
 */
function priceApiUrl(): string {
  return resolveMempoolApiBase(config.mempoolApiUrl, MEMPOOL_API_BASES.mainnet);
}

// `normalizeBtcPrice` lives in utils/btc-price.ts (SCRUM-3128 de-dup) — the same
// predicate guards the READ side, which middleware/x402PaymentGate.ts uses to
// price anchor requests. One definition, because a second copy of a
// money-validation predicate is exactly the thing that drifts. Its docstring
// explains the `-1` sentinel this guard exists for.

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

// `fetchAnchorStats` lives in utils/anchor-stats.ts — shared with the
// treasury status API (CIBA-HARDEN-03 de-dup).

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
          .then(res => res.ok ? readJsonBounded(
            res,
            `${apiBase}/address/${address}`,
            BALANCE_BODY_READ_TIMEOUT_MS,
          ) as Promise<{
            chain_stats: { funded_txo_sum: number; spent_txo_sum: number };
            mempool_stats: { funded_txo_sum: number; spent_txo_sum: number };
          }> : null)
      : Promise.resolve(null),
    // 2. BTC price — global quote, pinned base (see priceApiUrl)
    fetch(`${priceApiUrl()}/v1/prices`, { signal: AbortSignal.timeout(10_000) })
      .then(res => res.ok ? readJsonBounded(
        res,
        `${priceApiUrl()}/v1/prices`,
        QUOTE_BODY_READ_TIMEOUT_MS,
      ) as Promise<{ USD: number }> : null),
    // 3. Fee rates
    fetch(`${apiBase}/v1/fees/recommended`, { signal: AbortSignal.timeout(10_000) })
      .then(res => res.ok ? readJsonBounded(
        res,
        `${apiBase}/v1/fees/recommended`,
        QUOTE_BODY_READ_TIMEOUT_MS,
      ) as Promise<{
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
    const price = normalizeBtcPrice(priceData.USD);
    if (price == null) {
      logger.warn(
        { reported: priceData.USD, base: priceApiUrl() },
        'Treasury cache: BTC price oracle returned a non-price value — recording null',
      );
    }
    data.btc_price_usd = price;
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

  // Anchor stats from Supabase (extracted for complexity budget). Keep the
  // treasury_cache write shape limited to actual treasury_cache columns.
  const anchorStats = await fetchAnchorStats();
  data.total_secured = anchorStats.total_secured;
  data.total_pending = anchorStats.total_pending;
  data.last_secured_at = anchorStats.last_secured_at;
  data.last_24h_count = anchorStats.last_24h_count;

  // SCRUM-1786: sentinel guard — never overwrite good cached values with -1.
  const sentinelFields = ['total_secured', 'total_pending', 'last_24h_count'] as const;
  if (sentinelFields.some(f => data[f] === -1)) {
    const { data: existing } = await db
      .from('treasury_cache')
      .select('total_secured, total_pending, last_24h_count')
      .eq('id', 1)
      .single();

    if (existing) {
      for (const f of sentinelFields) {
        const prev = (existing as Record<string, unknown>)[f];
        if (data[f] === -1 && typeof prev === 'number' && prev !== -1) {
          (data as unknown as Record<string, number>)[f] = prev;
        }
      }
    }
  }

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
