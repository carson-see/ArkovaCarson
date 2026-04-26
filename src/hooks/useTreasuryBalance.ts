/**
 * useTreasuryBalance — Treasury data with tiered fetch strategy
 *
 * 1. Server-side cache (treasury_cache Supabase table, refreshed every 10min
 *    by worker cron) — fastest path, no rate limits
 * 2. Worker API fallback (paid Bitcoin node via /api/treasury/status)
 * 3. Direct mempool.space (display-only supplementary data)
 *
 * Cache hit returns balance + feeRates immediately (no receipts).
 * Cache miss falls through to the worker-first, mempool-fallback path.
 *
 * Auto-refreshes every 60 seconds.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import { TREASURY_ADDRESS, MEMPOOL_BASE_URL } from '@/lib/platform';
import { workerFetch } from '@/lib/workerClient';
import { TREASURY_LABELS } from '@/lib/copy';

const MEMPOOL_API = `${MEMPOOL_BASE_URL}/api`;
const POLL_INTERVAL_MS = 60_000;
const FETCH_TIMEOUT_MS = 15_000;

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

export function useTreasuryBalance() {
  const [balance, setBalance] = useState<TreasuryBalance | null>(null);
  const [receipts, setReceipts] = useState<MempoolReceipt[]>([]);
  const [feeRates, setFeeRates] = useState<MempoolFeeRates | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isMountedRef = useRef(true);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastBalanceRef = useRef<TreasuryBalance | null>(null);
  const lastCacheTimestampRef = useRef<string | null>(null);

  const fetchFromCache = useCallback(async (): Promise<boolean> => {
    try {
      const { data, error: queryError } = await supabase
        .from('treasury_cache')
        .select('*')
        .eq('id', 1)
        .single();

      if (queryError || !data) return false;

      const row = data;

      if (!isMountedRef.current) return true;

      // Fall through to direct fetch if cache is older than 30 minutes
      const cacheAge = Date.now() - new Date(row.updated_at).getTime();
      if (cacheAge > 30 * 60 * 1000) return false;

      // Skip state updates if cache hasn't changed since last poll
      if (row.updated_at === lastCacheTimestampRef.current) return true;
      lastCacheTimestampRef.current = row.updated_at;

      const confirmed = row.balance_confirmed_sats;
      const unconfirmed = row.balance_unconfirmed_sats;
      const total = confirmed + unconfirmed;
      const totalBtc = total / 1e8;
      const btcPrice = row.btc_price_usd;
      const totalUsd = btcPrice ? totalBtc * btcPrice : null;

      const bal: TreasuryBalance = { confirmed, unconfirmed, total, btcPrice, totalUsd };
      setBalance(bal);
      lastBalanceRef.current = bal;

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

  const fetchAll = useCallback(async () => {
    try {
      // 0. Try server-side cache first (fastest, no rate limits).
      //    Cache provides balance + feeRates; receipts still require mempool.space.
      const cacheHit = await fetchFromCache();
      if (cacheHit) {
        if (isMountedRef.current) setLoading(false);
        return;
      }

      const fetchWithTimeout = (url: string) =>
        fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

      // 1. Balance: try worker API first (uses paid Bitcoin node), mempool.space as fallback
      let balanceResolved = false;
      try {
        const response = await workerFetch('/api/treasury/status', { method: 'GET' });
        if (response.ok && isMountedRef.current) {
          const data = await response.json() as {
            wallet?: { balanceSats: number; utxoCount?: number };
            fees?: { currentRateSatPerVbyte: number };
          };
          if (data.wallet) {
            const bal: TreasuryBalance = {
              confirmed: data.wallet.balanceSats,
              unconfirmed: 0,
              total: data.wallet.balanceSats,
              btcPrice: null,
              totalUsd: null,
            };
            setBalance(bal);
            lastBalanceRef.current = bal;
            balanceResolved = true;
          }
          if (data.fees) {
            const rate = data.fees.currentRateSatPerVbyte;
            setFeeRates({ fastest: rate, halfHour: rate, hour: rate, economy: rate, minimum: rate });
          }
        }
      } catch {
        // Worker unavailable — will try mempool.space below
      }

      // SCRUM-1260 (R1-6): when the worker is unavailable, do NOT fall back
      // to direct mempool.space balance polling. Forensic 1 / SCRUM-1245
      // documented this as a privacy/sovereignty leak (every poll exposes
      // our treasury address polling pattern to a third party). Instead,
      // keep the last cached balance + show a "stale" badge via setError.
      // Receipts / price / fees are still fetched from mempool.space because
      // (a) the address is already public via on-chain receipts and (b)
      // these are display-only enrichment with no security-state impact.
      const mempoolFetches = [
        fetchWithTimeout(`${MEMPOOL_API}/address/${TREASURY_ADDRESS}/txs`),
        fetchWithTimeout(`${MEMPOOL_API}/v1/prices`),
        fetchWithTimeout(`${MEMPOOL_API}/v1/fees/recommended`),
      ];
      const settled = await Promise.allSettled(mempoolFetches);

      if (!isMountedRef.current) return;

      const val = (i: number) => settled[i]?.status === 'fulfilled' ? (settled[i] as PromiseFulfilledResult<Response>).value : null;
      const txRes = val(0);
      const priceRes = val(1);
      const feeRes = val(2);

      // Parse receipts
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

      // Enrich balance with BTC price if available
      if (priceRes?.ok && lastBalanceRef.current) {
        const priceData = await priceRes.json() as { USD: number };
        const btcPrice = priceData.USD;
        const totalBtc = lastBalanceRef.current.total / 1e8;
        const enriched = { ...lastBalanceRef.current, btcPrice, totalUsd: totalBtc * btcPrice };
        setBalance(enriched);
        lastBalanceRef.current = enriched;
      }

      // Parse fee rates from mempool (more granular than worker)
      if (feeRes?.ok) {
        const fees = await feeRes.json() as {
          fastestFee: number; halfHourFee: number; hourFee: number; economyFee: number; minimumFee: number;
        };
        if (isMountedRef.current) {
          setFeeRates({
            fastest: fees.fastestFee, halfHour: fees.halfHourFee,
            hour: fees.hourFee, economy: fees.economyFee, minimum: fees.minimumFee,
          });
        }
      }

      // Final error state
      if (!balanceResolved && isMountedRef.current) {
        if (lastBalanceRef.current) {
          setBalance(lastBalanceRef.current);
          setError(TREASURY_LABELS.BALANCE_STALE);
        } else {
          setError(TREASURY_LABELS.BALANCE_UNAVAILABLE);
        }
      } else if (isMountedRef.current) {
        setError(null);
      }
    } catch (err) {
      if (isMountedRef.current) {
        setError(err instanceof Error ? err.message : 'Failed to fetch treasury data');
      }
    } finally {
      if (isMountedRef.current) {
        setLoading(false);
      }
    }
  }, [fetchFromCache]);

  useEffect(() => {
    isMountedRef.current = true;
    async function run() { await fetchAll(); }
    void run();

    pollRef.current = setInterval(() => {
      async function poll() { await fetchAll(); }
      void poll();
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
