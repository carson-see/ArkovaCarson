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
      const [addressRes, txRes, priceRes, feeRes] = await Promise.all([
        fetch(`${MEMPOOL_API}/address/${TREASURY_ADDRESS}`),
        fetch(`${MEMPOOL_API}/address/${TREASURY_ADDRESS}/txs`),
        fetch(`${MEMPOOL_API}/v1/prices`),
        fetch(`${MEMPOOL_API}/v1/fees/recommended`),
      ]);

      if (!isMountedRef.current) return;

      // Parse address balance
      if (addressRes.ok) {
        const data = await addressRes.json() as {
          chain_stats: { funded_txo_sum: number; spent_txo_sum: number };
          mempool_stats: { funded_txo_sum: number; spent_txo_sum: number };
        };
        const confirmed = data.chain_stats.funded_txo_sum - data.chain_stats.spent_txo_sum;
        const unconfirmed = data.mempool_stats.funded_txo_sum - data.mempool_stats.spent_txo_sum;

        // Parse BTC price
        let btcPrice: number | null = null;
        if (priceRes.ok) {
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
      if (txRes.ok) {
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
      if (feeRes.ok) {
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

      if (isMountedRef.current) {
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
