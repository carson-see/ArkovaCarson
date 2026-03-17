/**
 * useTreasuryStatus — Arkova internal-only treasury dashboard data
 *
 * Calls the worker API to fetch live wallet balance, UTXO count,
 * fee estimates, and network info. Only accessible to platform admins.
 *
 * @see feedback_treasury_access — treasury is NEVER customer-facing
 */

import { useState, useCallback } from 'react';
import { workerFetch } from '@/lib/workerClient';

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

export function useTreasuryStatus() {
  const [status, setStatus] = useState<TreasuryStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await workerFetch('/api/treasury/status', { method: 'GET' });

      if (response.status === 403) {
        setError('Access denied — platform admin required');
        return;
      }

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error((body as Record<string, string>).error ?? `Request failed (${response.status})`);
      }

      const data = (await response.json()) as TreasuryStatus;
      setStatus(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch treasury status');
    } finally {
      setLoading(false);
    }
  }, []);

  return { status, loading, error, fetchStatus };
}
