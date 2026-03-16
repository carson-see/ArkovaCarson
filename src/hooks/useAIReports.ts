/**
 * useAIReports Hook (P8-S16)
 *
 * Create, list, and fetch AI-generated reports.
 */

import { useState, useCallback } from 'react';
import { workerFetch } from '@/lib/workerClient';

export type ReportType = 'integrity_summary' | 'extraction_accuracy' | 'credential_analytics' | 'compliance_overview';
export type ReportStatus = 'QUEUED' | 'GENERATING' | 'COMPLETE' | 'FAILED';

export interface AIReport {
  id: string;
  orgId: string;
  requestedBy: string;
  reportType: ReportType;
  status: ReportStatus;
  title: string;
  parameters: Record<string, unknown>;
  result: Record<string, unknown> | null;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export function useAIReports() {
  const [reports, setReports] = useState<AIReport[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);

  const fetchReports = useCallback(async () => {
    setLoading(true);
    try {
      const res = await workerFetch('/api/v1/ai/reports');
      if (!res.ok) return;

      const data = await res.json() as { reports: AIReport[] };
      setReports(data.reports);
    } finally {
      setLoading(false);
    }
  }, []);

  const createReport = useCallback(async (
    reportType: ReportType,
    title: string,
    parameters?: { dateRange?: number; credentialType?: string },
  ) => {
    setCreating(true);
    try {
      const res = await workerFetch('/api/v1/ai/reports', {
        method: 'POST',
        body: JSON.stringify({ reportType, title, parameters }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as Record<string, string>).error ?? 'Failed to create report');
      }

      const data = await res.json() as { reportId: string; status: string };

      // Refetch list
      await fetchReports();
      return data.reportId;
    } finally {
      setCreating(false);
    }
  }, [fetchReports]);

  const fetchReport = useCallback(async (reportId: string) => {
    const res = await workerFetch(`/api/v1/ai/reports/${reportId}`);
    if (!res.ok) return null;
    return await res.json() as AIReport;
  }, []);

  return { reports, loading, creating, fetchReports, createReport, fetchReport };
}
