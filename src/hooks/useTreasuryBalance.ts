/**
 * useTreasuryBalance — Treasury data from worker-owned sources
 *
 * 1. Worker status API for authoritative fee account balance and anchor stats.
 * 2. Worker health API for treasury cache freshness.
 * 3. Direct mempool.space only for display-only receipts / price / fee enrichment.
 *
 * The hook never reads treasury_cache or treasury RPCs from the browser. Worker
 * or cache failures stay visible to the admin UI instead of being masked by a
 * client-side Supabase fallback.
 *
 * Auto-refreshes every 60 seconds.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
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
const TREASURY_CACHE_STALE_MS = 30 * 60 * 1000;

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

export interface TreasuryAnchorStats {
  byStatus: Record<string, number | null>;
  totalAnchors: number | null;
  distinctTxIds: number | null;
  avgAnchorsPerTx: number | null;
  lastAnchorTime: string | null;
  lastTxTime: string | null;
}

export interface TreasurySourceState {
  cacheUpdatedAt: string | null;
  cacheStale: boolean;
  healthError: string | null;
}

interface WorkerTreasuryStatus {
  wallet?: {
    balanceSats: number;
    confirmedBalanceSats?: number;
    unconfirmedBalanceSats?: number;
    utxoCount?: number;
  } | null;
  fees?: { currentRateSatPerVbyte: number } | null;
  recentAnchors?: {
    totalSecured?: number | null;
    totalPending?: number | null;
    totalBroadcasting?: number | null;
    totalSubmitted?: number | null;
    totalRevoked?: number | null;
    lastSecuredAt: string | null;
    last24hCount: number | null;
    byStatus?: Record<string, number | null>;
    distinctTxIds?: number | null;
    avgAnchorsPerTx?: number | null;
    lastAnchorAt?: string | null;
    lastTxAt?: string | null;
  };
  error?: string;
}

interface WorkerTreasuryHealth {
  last_updated_at: string | null;
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

function isFreshnessStale(updatedAt: string | null): boolean {
  if (!updatedAt) return true;
  const updatedMs = new Date(updatedAt).getTime();
  return !Number.isFinite(updatedMs) || Date.now() - updatedMs > TREASURY_CACHE_STALE_MS;
}

function nonNegativeNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

function toAnchorStats(recentAnchors: WorkerTreasuryStatus['recentAnchors']): TreasuryAnchorStats | null {
  if (!recentAnchors) return null;

  const byStatus: Record<string, number | null> = {};
  const addStatus = (status: string, rawValue: unknown) => {
    if (rawValue !== undefined) {
      byStatus[status] = nonNegativeNumberOrNull(rawValue);
    }
  };

  if (recentAnchors.byStatus && Object.keys(recentAnchors.byStatus).length > 0) {
    for (const [status, count] of Object.entries(recentAnchors.byStatus)) {
      addStatus(status, count);
    }
  } else {
    addStatus('PENDING', recentAnchors.totalPending);
    addStatus('BROADCASTING', recentAnchors.totalBroadcasting);
    addStatus('SUBMITTED', recentAnchors.totalSubmitted);
    addStatus('SECURED', recentAnchors.totalSecured);
    addStatus('REVOKED', recentAnchors.totalRevoked);
  }

  const statusCounts = Object.values(byStatus);
  if (statusCounts.length === 0 || !statusCounts.some((count) => count !== null)) return null;

  const distinctTxIds = nonNegativeNumberOrNull(recentAnchors.distinctTxIds);
  const totalAnchors = statusCounts.some((count) => count === null)
    ? null
    : statusCounts.reduce<number>((sum, count) => sum + (count ?? 0), 0);
  return {
    byStatus,
    totalAnchors,
    distinctTxIds,
    avgAnchorsPerTx: distinctTxIds === null ? null : nonNegativeNumberOrNull(recentAnchors.avgAnchorsPerTx),
    lastAnchorTime: recentAnchors.lastAnchorAt ?? recentAnchors.lastSecuredAt,
    lastTxTime: recentAnchors.lastTxAt ?? recentAnchors.lastAnchorAt ?? recentAnchors.lastSecuredAt,
  };
}

export function useTreasuryBalance() {
  const [balance, setBalance] = useState<TreasuryBalance | null>(null);
  const [receipts, setReceipts] = useState<MempoolReceipt[]>([]);
  const [feeRates, setFeeRates] = useState<MempoolFeeRates | null>(null);
  const [anchorStats, setAnchorStats] = useState<TreasuryAnchorStats | null>(null);
  const [sourceState, setSourceState] = useState<TreasurySourceState>({
    cacheUpdatedAt: null,
    cacheStale: true,
    healthError: null,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isMountedRef = useRef(true);
  const lastBalanceRef = useRef<TreasuryBalance | null>(null);
  const lastFeeRatesRef = useRef<MempoolFeeRates | null>(null);
  const lastReceiptsRef = useRef<MempoolReceipt[]>([]);
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

  const fetchAll = useCallback(async () => {
    // Cancel any prior in-flight cycle. SCRUM-1260 (R1-6): without this,
    // a slow worker fetch + 60s polling cycle could stack 4+ requests for
    // the same data on a backgrounded tab.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;

    try {
      // SCRUM-1260 + P0 truth path: parallelize worker status, worker cache
      // freshness, and display-only mempool enrichment. There is no browser
      // Supabase fallback here; if the worker/cache path is unhealthy the UI
      // keeps the last value and surfaces the stale/error state.
      const fetchWithTimeout = (url: string) =>
        fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]) });

      const workerSignal = AbortSignal.any([signal, AbortSignal.timeout(WORKER_TIMEOUT_MS)]);
      const workerPromise = workerFetch(
        '/api/treasury/status',
        { method: 'GET', signal: workerSignal },
        WORKER_TIMEOUT_MS,
      );
      const healthPromise = workerFetch(
        '/api/treasury/health',
        { method: 'GET', signal: workerSignal },
        WORKER_TIMEOUT_MS,
      );

      // Receipts / price / fees are still fetched from mempool.space because
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

      const [workerSettled, healthSettled, mempoolSettled] = await Promise.all([
        workerPromise.then(
          (r) => ({ ok: true as const, response: r }),
          (err: unknown) => ({ ok: false as const, error: err }),
        ),
        healthPromise.then(
          (r) => ({ ok: true as const, response: r }),
          (err: unknown) => ({ ok: false as const, error: err }),
        ),
        mempoolPromise,
      ]);

      if (signal.aborted || !isMountedRef.current) return;

      // ─── Worker leg: authoritative balance + coarse fees ─────────────
      let balanceResolved = false;
      let workerError: string | null = null;
      if (workerSettled.ok && workerSettled.response.ok) {
        const data = (await workerSettled.response.json()) as WorkerTreasuryStatus;
        if (!isMountedRef.current) return;
        if (data.wallet) {
          const unconfirmed = data.wallet.unconfirmedBalanceSats ?? 0;
          const confirmed = data.wallet.confirmedBalanceSats
            ?? (data.wallet.unconfirmedBalanceSats !== undefined
              ? data.wallet.balanceSats - data.wallet.unconfirmedBalanceSats
              : data.wallet.balanceSats);
          const bal: TreasuryBalance = {
            confirmed,
            unconfirmed,
            total: data.wallet.balanceSats,
            btcPrice: null,
            totalUsd: null,
          };
          setBalanceIfChanged(bal);
          balanceResolved = true;
        }
        const nextAnchorStats = toAnchorStats(data.recentAnchors);
        setAnchorStats(nextAnchorStats);
        if (data.fees) {
          const rate = data.fees.currentRateSatPerVbyte;
          setFeeRatesIfChanged({ fastest: rate, halfHour: rate, hour: rate, economy: rate, minimum: rate });
        }
        workerError = data.error ?? null;
      } else if (workerSettled.ok) {
        workerError = TREASURY_LABELS.WORKER_RETURNED_STATUS(workerSettled.response.status);
      } else {
        workerError = workerSettled.error instanceof Error
          ? workerSettled.error.message
          : TREASURY_LABELS.WORKER_REQUEST_FAILED;
      }

      // ─── Worker cache freshness leg ─────────────────────────────────
      if (healthSettled.ok && healthSettled.response.ok) {
        const health = (await healthSettled.response.json()) as WorkerTreasuryHealth;
        setSourceState({
          cacheUpdatedAt: health.last_updated_at ?? null,
          cacheStale: isFreshnessStale(health.last_updated_at ?? null),
          healthError: null,
        });
      } else if (healthSettled.ok) {
        setSourceState((prev) => ({
          ...prev,
          cacheStale: true,
          healthError: TREASURY_LABELS.WORKER_HEALTH_RETURNED_STATUS(healthSettled.response.status),
        }));
      } else {
        const healthError = healthSettled.error instanceof Error
          ? healthSettled.error.message
          : TREASURY_LABELS.WORKER_HEALTH_REQUEST_FAILED;
        setSourceState((prev) => ({ ...prev, cacheStale: true, healthError }));
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
          setError(workerError ? `${TREASURY_LABELS.BALANCE_STALE} ${workerError}` : TREASURY_LABELS.BALANCE_STALE);
        } else {
          setError(workerError ? `${TREASURY_LABELS.BALANCE_UNAVAILABLE} ${workerError}` : TREASURY_LABELS.BALANCE_UNAVAILABLE);
        }
      } else if (isMountedRef.current) {
        setError(workerError);
      }
    } catch (err) {
      if (signal.aborted || isAbortError(err)) return;
      if (isMountedRef.current) {
        setError(err instanceof Error ? err.message : TREASURY_LABELS.FETCH_FAILED);
      }
    } finally {
      if (isMountedRef.current) {
        setLoading(false);
      }
    }
  }, [setBalanceIfChanged, setFeeRatesIfChanged, setReceiptsIfChanged]);

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

  return { balance, receipts, feeRates, anchorStats, sourceState, loading, error, refresh: fetchAll };
}
