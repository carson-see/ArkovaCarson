/**
 * useTreasuryBalance — Treasury data from server-side cache (SCRUM-546)
 *
 * Reads from the treasury_cache Supabase table, which is refreshed
 * every 10 minutes by the worker cron job. This eliminates direct
 * mempool.space calls from the browser (which get rate-limited or
 * blocked by browser extensions).
 *
 * Falls back to direct mempool.space fetch if cache is unavailable
 * (e.g., migration not applied yet).
 *
 * Auto-refreshes every 60 seconds.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import { TREASURY_ADDRESS, MEMPOOL_BASE_URL } from '@/lib/platform';
import { workerFetch } from '@/lib/workerClient';

const MEMPOOL_API = `${MEMPOOL_BASE_URL}/api`;
const POLL_INTERVAL_MS = 60_000;

export interface TreasuryBalance {
  confirmed: number;
  unconfirmed: number;
  total: number;
  btcPrice: number | null;
  totalUsd: number | null;
}

export interface MempoolReceipt {
  txid: string;
  fee: number;
  size: number;
  weight: number;
  confirmed: boolean;
  blockHeight: number | null;
  blockTime: number | null;
  value: number;
  opReturn: string | null;
}

export interface MempoolFeeRates {
  fastest: number;
  halfHour: number;
  hour: number;
  economy: number;
  minimum: number;
}

interface TreasuryCacheRow {
  balance_confirmed_sats: number;
  balance_unconfirmed_sats: number;
  utxo_count: number;
  btc_price_usd: number | null;
  fee_fastest: number | null;
  fee_half_hour: number | null;
  fee_hour: number | null;
  fee_economy: number | null;
  fee_minimum: number | null;
  total_secured: number;
  total_pending: number;
  last_24h_count: number;
  updated_at: string;
  error: string | null;
}

export function useTreasuryBalance() {
  const [balance, setBalance] = useState<TreasuryBalance | null>(null);
  const [receipts, setReceipts] = useState<MempoolReceipt[]>([]);
  const [feeRates, setFeeRates] = useState<MempoolFeeRates | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isMountedRef = useRef(true);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastCacheTimestampRef = useRef<string | null>(null);

  const fetchFromCache = useCallback(async (): Promise<boolean> => {
    try {
      // Cast: treasury_cache table added in migration 0185, types not yet regenerated
      const { data, error: queryError } = await (supabase.from as CallableFunction)(
        'treasury_cache',
      ).select('*').eq('id', 1).single();

      if (queryError || !data) return false;

      const row = data as unknown as TreasuryCacheRow;

      if (!isMountedRef.current) return true;

      // Skip state updates if cache hasn't changed since last poll
      if (row.updated_at === lastCacheTimestampRef.current) return true;
      lastCacheTimestampRef.current = row.updated_at;

      const confirmed = row.balance_confirmed_sats;
      const unconfirmed = row.balance_unconfirmed_sats;
      const total = confirmed + unconfirmed;
      const totalBtc = total / 1e8;
      const btcPrice = row.btc_price_usd;
      const totalUsd = btcPrice ? totalBtc * btcPrice : null;

      setBalance({ confirmed, unconfirmed, total, btcPrice, totalUsd });

      if (row.fee_fastest != null) {
        setFeeRates({
          fastest: row.fee_fastest,
          halfHour: row.fee_half_hour ?? row.fee_fastest,
          hour: row.fee_hour ?? row.fee_fastest,
          economy: row.fee_economy ?? row.fee_fastest,
          minimum: row.fee_minimum ?? row.fee_fastest,
        });
      }

      setError(null);
      return true;
    } catch {
      return false;
    }
  }, []);

  const fetchDirectFromMempool = useCallback(async () => {
    try {
      const fetchWithTimeout = (url: string) =>
        fetch(url, { signal: AbortSignal.timeout(10_000) });

      const [addressResult, txResult, priceResult, feeResult] = await Promise.allSettled([
        fetchWithTimeout(`${MEMPOOL_API}/address/${TREASURY_ADDRESS}`),
        fetchWithTimeout(`${MEMPOOL_API}/address/${TREASURY_ADDRESS}/txs`),
        fetchWithTimeout(`${MEMPOOL_API}/v1/prices`),
        fetchWithTimeout(`${MEMPOOL_API}/v1/fees/recommended`),
      ]);

      const addressRes = addressResult.status === 'fulfilled' ? addressResult.value : null;
      const txRes = txResult.status === 'fulfilled' ? txResult.value : null;
      const priceRes = priceResult.status === 'fulfilled' ? priceResult.value : null;
      const feeRes = feeResult.status === 'fulfilled' ? feeResult.value : null;

      if (!isMountedRef.current) return;

      if (addressRes?.ok) {
        const data = await addressRes.json() as {
          chain_stats: { funded_txo_sum: number; spent_txo_sum: number };
          mempool_stats: { funded_txo_sum: number; spent_txo_sum: number };
        };
        const confirmed = data.chain_stats.funded_txo_sum - data.chain_stats.spent_txo_sum;
        const unconfirmed = data.mempool_stats.funded_txo_sum - data.mempool_stats.spent_txo_sum;

        let btcPrice: number | null = null;
        if (priceRes?.ok) {
          const priceData = await priceRes.json() as { USD: number };
          btcPrice = priceData.USD;
        }

        const total = confirmed + unconfirmed;
        const totalBtc = total / 1e8;
        const totalUsd = btcPrice ? totalBtc * btcPrice : null;

        if (isMountedRef.current) {
          setBalance({ confirmed, unconfirmed, total, btcPrice, totalUsd });
        }
      }

      if (txRes?.ok) {
        const txData = await txRes.json() as Array<{
          txid: string;
          fee: number;
          size: number;
          weight: number;
          status: { confirmed: boolean; block_height?: number; block_time?: number };
          vout: Array<{ scriptpubkey_type: string; scriptpubkey_asm: string; value: number }>;
        }>;

        const parsed: MempoolReceipt[] = txData.slice(0, 20).map((tx) => {
          const opReturnOut = tx.vout.find((v) => v.scriptpubkey_type === 'op_return');
          return {
            txid: tx.txid,
            fee: tx.fee,
            size: tx.size,
            weight: tx.weight,
            confirmed: tx.status.confirmed,
            blockHeight: tx.status.block_height ?? null,
            blockTime: tx.status.block_time ?? null,
            value: tx.vout.reduce((sum, v) => sum + v.value, 0),
            opReturn: opReturnOut?.scriptpubkey_asm ?? null,
          };
        });

        if (isMountedRef.current) {
          setReceipts(parsed);
        }
      }

      if (feeRes?.ok) {
        const fees = await feeRes.json() as {
          fastestFee: number;
          halfHourFee: number;
          hourFee: number;
          economyFee: number;
          minimumFee: number;
        };
        if (isMountedRef.current) {
          setFeeRates({
            fastest: fees.fastestFee,
            halfHour: fees.halfHourFee,
            hour: fees.hourFee,
            economy: fees.economyFee,
            minimum: fees.minimumFee,
          });
        }
      }

      // If balance fetch from mempool failed, fall back to worker API
      const balanceFailed = !addressRes?.ok;
      if (balanceFailed && isMountedRef.current) {
        try {
          const response = await workerFetch('/api/treasury/status', { method: 'GET' });
          if (response.ok && isMountedRef.current) {
            const data = await response.json() as {
              wallet?: { balanceSats: number; utxoCount?: number };
              fees?: { currentRateSatPerVbyte: number };
            };
            if (data.wallet) {
              setBalance({
                confirmed: data.wallet.balanceSats,
                unconfirmed: 0,
                total: data.wallet.balanceSats,
                btcPrice: null,
                totalUsd: null,
              });
            }
            if (data.fees && !feeRes?.ok) {
              const rate = data.fees.currentRateSatPerVbyte;
              setFeeRates({ fastest: rate, halfHour: rate, hour: rate, economy: rate, minimum: rate });
            }
            if (isMountedRef.current) setError(null);
          } else if (isMountedRef.current) {
            setError(`Treasury API returned ${response.status}. Check worker logs.`);
          }
        } catch (workerErr) {
          if (isMountedRef.current) {
            setError(workerErr instanceof Error ? workerErr.message : 'Failed to fetch treasury data');
          }
        }
      } else if (isMountedRef.current) {
        setError(null);
      }
    } catch (err) {
      if (isMountedRef.current) {
        setError(err instanceof Error ? err.message : 'Failed to fetch treasury data');
      }
    }
  }, []);

  const fetchAll = useCallback(async () => {
    try {
      // Try server-side cache first (fast, no rate limits)
      const cacheHit = await fetchFromCache();

      if (!cacheHit) {
        // Fallback: direct mempool.space fetch (for pre-migration compatibility)
        await fetchDirectFromMempool();
      }
    } finally {
      if (isMountedRef.current) {
        setLoading(false);
      }
    }
  }, [fetchFromCache, fetchDirectFromMempool]);

  useEffect(() => {
    isMountedRef.current = true;
    void fetchAll();

    pollRef.current = setInterval(() => {
      void fetchAll();
    }, POLL_INTERVAL_MS);

    return () => {
      isMountedRef.current = false;
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [fetchAll]);

  return { balance, receipts, feeRates, loading, error, refresh: fetchAll };
}
