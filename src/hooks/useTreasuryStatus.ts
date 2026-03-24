/**
 * useTreasuryStatus — Arkova internal-only treasury dashboard data
 *
 * Calls the worker API to fetch live wallet balance, UTXO count,
 * fee estimates, and network info. Only accessible to platform admins.
 *
 * @see feedback_treasury_access — treasury is NEVER customer-facing
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { workerFetch } from '@/lib/workerClient';

/** Auto-poll interval for treasury balance (30 seconds) */
const POLL_INTERVAL_MS = 30_000;

export interface TreasuryWallet {
  address: string;
  balanceSats: number;
  utxoCount: number;
}

export interface TreasuryNetwork {
  name: string;
  blockHeight: number;
}

export interface TreasuryFees {
  estimatorName: string;
  currentRateSatPerVbyte: number;
}

export interface TreasuryAnchorStats {
  totalSecured: number;
  totalPending: number;
  lastSecuredAt: string | null;
  last24hCount: number;
}

export interface TreasuryStatus {
  wallet: TreasuryWallet | null;
  network: TreasuryNetwork | null;
  fees: TreasuryFees | null;
  recentAnchors: TreasuryAnchorStats;
  error?: string;
}

export function useTreasuryStatus(autoPolling = true) {
  const [status, setStatus] = useState<TreasuryStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastFetchedAt, setLastFetchedAt] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isMountedRef = useRef(true);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await workerFetch('/api/treasury/status', { method: 'GET' });

      if (!isMountedRef.current) return;

      if (response.status === 403) {
        setError('Access denied — platform admin required');
        return;
      }

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error((body as Record<string, string>).error ?? `Request failed (${response.status})`);
      }

      const data = (await response.json()) as TreasuryStatus;
      if (isMountedRef.current) {
        setStatus(data);
        setLastFetchedAt(new Date().toISOString());
      }
    } catch (err) {
      if (isMountedRef.current) {
        setError(err instanceof Error ? err.message : 'Failed to fetch treasury status');
      }
    } finally {
      if (isMountedRef.current) {
        setLoading(false);
      }
    }
  }, []);

  // Auto-poll every 30s when enabled
  useEffect(() => {
    isMountedRef.current = true;

    if (autoPolling) {
      pollRef.current = setInterval(() => {
        void fetchStatus();
      }, POLL_INTERVAL_MS);
    }

    return () => {
      isMountedRef.current = false;
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [autoPolling, fetchStatus]);

  return { status, loading, error, fetchStatus, lastFetchedAt };
}
