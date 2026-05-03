/**
 * SCRUM-948 — Latest compliance_audits row for the caller's org.
 *
 * Replaces the legacy `useComplianceScore` flow on the dashboard widget.
 * After NCA-03 (migration 0217) audits write to `compliance_audits`, so
 * the dashboard's "Compliance Score" tile must read from there too —
 * otherwise it stays stuck on the empty state even after a successful
 * audit shows on `/compliance/scorecard`.
 */
import { useCallback, useEffect, useState } from 'react';
import { workerFetch } from '@/lib/workerClient';

export interface LatestComplianceAudit {
  id: string;
  overall_score: number;
  overall_grade: string;
  status: string;
  started_at: string;
  completed_at: string | null;
}

interface AuditsResponse {
  audits?: LatestComplianceAudit[];
}

export function useLatestComplianceAudit() {
  const [audit, setAudit] = useState<LatestComplianceAudit | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchLatest = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await workerFetch('/api/v1/compliance/audit?limit=1');
      if (res.status === 404) {
        setAudit(null);
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const msg = (body as { error?: string }).error ?? `HTTP ${res.status}`;
        setError(msg);
        return;
      }
      const body = (await res.json()) as AuditsResponse;
      setAudit(body.audits?.[0] ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(fetchLatest);
  }, [fetchLatest]);

  return { audit, loading, error, refetch: fetchLatest };
}
