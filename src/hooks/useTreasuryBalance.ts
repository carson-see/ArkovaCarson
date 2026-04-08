/**
 * useTreasuryBalance — Live BTC balance from mempool.space API
 *
 * Fetches balance + recent receipts for the treasury address
 * directly from mempool.space (display only — all broadcasting
 * goes through our GetBlock RPC node).
 *
 * Auto-refreshes every 60 seconds.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
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

export function useTreasuryBalance() {
  const [balance, setBalance] = useState<TreasuryBalance | null>(null);
  const [receipts, setTransactions] = useState<MempoolReceipt[]>([]);
  const [feeRates, setFeeRates] = useState<MempoolFeeRates | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isMountedRef = useRef(true);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchAll = useCallback(async () => {
    try {
      // Fetch balance, receipts, BTC price, and fee rates in parallel
      // 10s timeout to prevent hanging if mempool.space is blocked by browser extensions
      const fetchWithTimeout = (url: string) =>
        fetch(url, { signal: AbortSignal.timeout(10_000) });

      // Use allSettled so one failing call doesn't break all cards
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

      // Parse address balance
      if (addressRes?.ok) {
        const data = await addressRes.json() as {
          chain_stats: { funded_txo_sum: number; spent_txo_sum: number };
          mempool_stats: { funded_txo_sum: number; spent_txo_sum: number };
        };
        const confirmed = data.chain_stats.funded_txo_sum - data.chain_stats.spent_txo_sum;
        const unconfirmed = data.mempool_stats.funded_txo_sum - data.mempool_stats.spent_txo_sum;

        // Parse BTC price
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
          setTransactions(parsed);
        }
      }

      // Parse fee rates
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
            // Clear error since worker fallback succeeded
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
    } finally {
      if (isMountedRef.current) {
        setLoading(false);
      }
    }
  }, []);

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
