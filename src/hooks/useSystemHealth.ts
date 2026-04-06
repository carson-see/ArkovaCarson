/**
 * System Health Hook
 *
 * Fetches system health status from the admin API.
 * Only accessible to platform admins.
 */

import { useState, useCallback } from 'react';
import { workerFetch } from '@/lib/workerClient';

export interface SystemHealth {
  status: 'healthy' | 'degraded' | 'down';
  uptime: number;
  version: string;
  checks: {
    supabase: { status: 'ok' | 'error'; latencyMs?: number; message?: string };
    bitcoin: { connected: boolean; network: string };
  };
  config: {
    stripe: boolean;
    sentry: boolean;
    ai: { configured: boolean; provider: string };
    email: boolean;
  };
  memory: {
    heapUsedMB: number;
    heapTotalMB: number;
    rssMB: number;
  };
}

export function useSystemHealth() {
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchHealth = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await workerFetch('/api/admin/system-health', { method: 'GET' });

      if (!response.ok) {
        const body = await response.json().catch(() => ({ error: 'Request failed' }));
        setError(body.error ?? `HTTP ${response.status}`);
        setLoading(false);
        return;
      }

      const data = await response.json();
      setHealth(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch system health');
    } finally {
      setLoading(false);
    }
  }, []);

  return { health, loading, error, fetchHealth };
}

export interface SmokeTestResult {
  name: string;
  status: 'pass' | 'fail';
  durationMs: number;
  detail?: string;
  error?: string;
}

export interface SmokeTestRun {
  timestamp: string;
  passed: number;
  failed: number;
  total: number;
  results: SmokeTestResult[];
}

export function useSmokeTestHistory() {
  const [history, setHistory] = useState<SmokeTestRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchHistory = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await workerFetch('/cron/smoke-test/history', { method: 'GET' });

      if (!response.ok) {
        setError(`HTTP ${response.status}`);
        setLoading(false);
        return;
      }

      const data = await response.json();
      setHistory(data.history ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch smoke test history');
    } finally {
      setLoading(false);
    }
  }, []);

  const runSmokeTest = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await workerFetch('/cron/smoke-test', { method: 'POST' });
      const data = await response.json();

      if (data.results) {
        // Prepend to history
        setHistory((prev) => [
          { timestamp: data.timestamp, passed: data.passed, failed: data.failed, total: data.total, results: data.results },
          ...prev,
        ]);
      }

      return data;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to run smoke test');
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  return { history, loading, error, fetchHistory, runSmokeTest };
}
