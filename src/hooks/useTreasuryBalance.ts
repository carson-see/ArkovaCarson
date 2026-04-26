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
import { useVisibilityPolling } from './useVisibilityPolling';

const MEMPOOL_API = `${MEMPOOL_BASE_URL}/api`;
const POLL_INTERVAL_MS = 60_000;
// SCRUM-1260 (R1-6): tighter mempool timeout. The 15s previous + 60s worker
// default summed to 75s "skeleton" before users saw an error — exactly the
// outage UX the forensic flagged. Mempool calls are the public/enrichment
// path, so 8s is plenty.
const FETCH_TIMEOUT_MS = 8_000;
// Worker timeout for treasury fetch — overrides workerFetch default 60s.
// On timeout we keep the last cached balance (if any) and flag stale.
const WORKER_TIMEOUT_MS = 8_000;

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

// SCRUM-1260 (R1-6) /simplify pass: equality guards. Without these, every poll
// (even when fetched values were identical) re-rendered every consumer of
// useTreasuryBalance — TreasuryAdminPage, BalanceCard, ReceiptTable. These
// helpers compare the new payload against the prior one and short-circuit the
// setState when nothing meaningful changed.

function balanceEqual(a: TreasuryBalance | null, b: TreasuryBalance | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.confirmed === b.confirmed &&
    a.unconfirmed === b.unconfirmed &&
    a.total === b.total &&
    a.btcPrice === b.btcPrice &&
    a.totalUsd === b.totalUsd
  );
}

function feeRatesEqual(a: MempoolFeeRates | null, b: MempoolFeeRates | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.fastest === b.fastest &&
    a.halfHour === b.halfHour &&
    a.hour === b.hour &&
    a.economy === b.economy &&
    a.minimum === b.minimum
  );
}

function receiptsEqual(a: MempoolReceipt[], b: MempoolReceipt[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ra = a[i];
    const rb = b[i];
    if (
      ra.txid !== rb.txid ||
      ra.confirmed !== rb.confirmed ||
      ra.blockHeight !== rb.blockHeight ||
      ra.blockTime !== rb.blockTime ||
      ra.value !== rb.value ||
      ra.opReturn !== rb.opReturn
    ) {
      return false;
    }
  }
  return true;
}

export function useTreasuryBalance() {
  const [balance, setBalance] = useState<TreasuryBalance | null>(null);
  const [receipts, setReceipts] = useState<MempoolReceipt[]>([]);
  const [feeRates, setFeeRates] = useState<MempoolFeeRates | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isMountedRef = useRef(true);
  const lastBalanceRef = useRef<TreasuryBalance | null>(null);
  const lastFeeRatesRef = useRef<MempoolFeeRates | null>(null);
  const lastReceiptsRef = useRef<MempoolReceipt[]>([]);
  const lastCacheTimestampRef = useRef<string | null>(null);
  // SCRUM-1260 (R1-6): one in-flight controller. Each new fetch cycle aborts
  // the prior one so a 60s tab-backgrounded fetch doesn't pile up behind the
  // 30s poll. Also abort on unmount.
  const abortRef = useRef<AbortController | null>(null);

  const setBalanceIfChanged = useCallback((next: TreasuryBalance) => {
    if (!balanceEqual(lastBalanceRef.current, next)) {
      setBalance(next);
    }
    lastBalanceRef.current = next;
  }, []);

  const setFeeRatesIfChanged = useCallback((next: MempoolFeeRates) => {
    if (!feeRatesEqual(lastFeeRatesRef.current, next)) {
      setFeeRates(next);
    }
    lastFeeRatesRef.current = next;
  }, []);

  const setReceiptsIfChanged = useCallback((next: MempoolReceipt[]) => {
    if (!receiptsEqual(lastReceiptsRef.current, next)) {
      setReceipts(next);
    }
    lastReceiptsRef.current = next;
  }, []);

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
      setBalanceIfChanged(bal);

      if (row.fee_fastest != null) {
        setFeeRatesIfChanged({
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
  }, [setBalanceIfChanged, setFeeRatesIfChanged]);

  const fetchAll = useCallback(async () => {
    // Cancel any prior in-flight cycle. SCRUM-1260 (R1-6): without this,
    // a slow worker fetch + 60s polling cycle could stack 4+ requests for
    // the same data on a backgrounded tab.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;

    try {
      // 0. Try server-side cache first (fastest, no rate limits).
      //    Cache provides balance + feeRates; receipts still require mempool.space.
      const cacheHit = await fetchFromCache();
      if (signal.aborted) return;
      if (cacheHit) {
        if (isMountedRef.current) setLoading(false);
        return;
      }

      // SCRUM-1260 (R1-6) /simplify: parallelize worker + mempool fetches.
      // They are independent (worker provides authoritative balance + coarse
      // fees; mempool.space provides receipts, BTC/USD price, and granular
      // fee rates). The previous sequential code paid 8s + 8s = 16s worst
      // case before surfacing an error; running them concurrently caps the
      // worst case at ~8s (max single-leg timeout).
      //
      // SCRUM-1260 (R1-6): combined timeout + cycle-cancel signal. Mempool
      // calls bail out at min(8s, cycle-aborted).
      const fetchWithTimeout = (url: string) =>
        fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]) });

      // 1. Balance: try worker API first (uses paid Bitcoin node).
      // Worker timeout cut from 60s default → 8s so users see error within ~8s instead of ~75s.
      // workerFetch uses `options.signal ?? internal-timeout-controller`, so passing only the
      // cycle signal would bypass its timeout. Combine cycle-cancel AND timeout signals.
      const workerSignal = AbortSignal.any([signal, AbortSignal.timeout(WORKER_TIMEOUT_MS)]);
      const workerPromise = workerFetch(
        '/api/treasury/status',
        { method: 'GET', signal: workerSignal },
        WORKER_TIMEOUT_MS,
      );

      // 2. Receipts / price / fees are still fetched from mempool.space because
      // (a) the address is already public via on-chain receipts and (b)
      // these are display-only enrichment with no security-state impact.
      // SCRUM-1260 (R1-6): when the worker is unavailable, do NOT fall back
      // to direct mempool.space balance polling. Forensic 1 / SCRUM-1245
      // documented this as a privacy/sovereignty leak.
      const mempoolPromise = Promise.allSettled([
        fetchWithTimeout(`${MEMPOOL_API}/address/${TREASURY_ADDRESS}/txs`),
        fetchWithTimeout(`${MEMPOOL_API}/v1/prices`),
        fetchWithTimeout(`${MEMPOOL_API}/v1/fees/recommended`),
      ]);

      const [workerSettled, mempoolSettled] = await Promise.all([
        workerPromise.then(
          (r) => ({ ok: true as const, response: r }),
          (err: unknown) => ({ ok: false as const, error: err }),
        ),
        mempoolPromise,
      ]);

      if (signal.aborted || !isMountedRef.current) return;

      // ─── Worker leg: authoritative balance + coarse fees ─────────────
      let balanceResolved = false;
      if (workerSettled.ok && workerSettled.response.ok) {
        const data = (await workerSettled.response.json()) as {
          wallet?: { balanceSats: number; utxoCount?: number };
          fees?: { currentRateSatPerVbyte: number };
        };
        if (!isMountedRef.current) return;
        if (data.wallet) {
          const bal: TreasuryBalance = {
            confirmed: data.wallet.balanceSats,
            unconfirmed: 0,
            total: data.wallet.balanceSats,
            btcPrice: null,
            totalUsd: null,
          };
          setBalanceIfChanged(bal);
          balanceResolved = true;
        }
        if (data.fees) {
          const rate = data.fees.currentRateSatPerVbyte;
          setFeeRatesIfChanged({ fastest: rate, halfHour: rate, hour: rate, economy: rate, minimum: rate });
        }
      }

      // ─── Mempool leg: receipts + price enrichment + granular fees ────
      const val = (i: number) => mempoolSettled[i]?.status === 'fulfilled'
        ? (mempoolSettled[i] as PromiseFulfilledResult<Response>).value
        : null;
      const txRes = val(0);
      const priceRes = val(1);
      const feeRes = val(2);

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
          setReceiptsIfChanged(parsed);
        }
      }

      if (priceRes?.ok && lastBalanceRef.current) {
        const priceData = await priceRes.json() as { USD?: number };
        const btcPrice = priceData?.USD;
        // Only enrich when the price is a real number — without this guard,
        // mempool.space serving an empty body produces NaN totalUsd values
        // that break the equality guard (NaN !== NaN) and re-render every poll.
        if (typeof btcPrice === 'number' && Number.isFinite(btcPrice)) {
          const totalBtc = lastBalanceRef.current.total / 1e8;
          const enriched = { ...lastBalanceRef.current, btcPrice, totalUsd: totalBtc * btcPrice };
          setBalanceIfChanged(enriched);
        }
      }

      if (feeRes?.ok) {
        const fees = await feeRes.json() as {
          fastestFee: number; halfHourFee: number; hourFee: number; economyFee: number; minimumFee: number;
        };
        if (isMountedRef.current) {
          setFeeRatesIfChanged({
            fastest: fees.fastestFee, halfHour: fees.halfHourFee,
            hour: fees.hourFee, economy: fees.economyFee, minimum: fees.minimumFee,
          });
        }
      }

      // Final error state
      if (!balanceResolved && isMountedRef.current) {
        if (lastBalanceRef.current) {
          setBalanceIfChanged(lastBalanceRef.current);
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
  }, [fetchFromCache, setBalanceIfChanged, setFeeRatesIfChanged, setReceiptsIfChanged]);

  // SCRUM-1260 (R1-6): poll only when tab is visible. Backgrounded admin
  // tabs were hammering the worker on a 60s clock with stacking requests.
  // Centralised in useVisibilityPolling — see the hook for the contract.
  useVisibilityPolling(fetchAll, POLL_INTERVAL_MS);

  // Mount/unmount lifecycle: track mounted-state for in-flight setState guards
  // and abort any pending fetch cycle on unmount so a 60s backgrounded fetch
  // doesn't write to a torn-down React tree.
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  return { balance, receipts, feeRates, loading, error, refresh: fetchAll };
}
