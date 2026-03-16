/**
 * BatchAIDashboard Component (P8-S14)
 *
 * Shows batch AI processing job status, progress, and results.
 * Nordic Vault aesthetic with shimmer loading, glass cards, staggered reveals.
 *
 * Gated behind ENABLE_AI_EXTRACTION flag. Displays job list from
 * batch_verification_jobs table with auto-refresh while jobs are processing.
 */

import { useState, useEffect, useCallback } from 'react';
import { Cpu, CheckCircle, XCircle, Clock, RefreshCw, AlertCircle } from 'lucide-react';
import { supabase } from '../../lib/supabase';

interface BatchJob {
  id: string;
  status: 'queued' | 'processing' | 'complete' | 'partial_failure' | 'failed';
  totalItems: number;
  processedItems: number;
  failedItems: number;
  createdAt: string;
  updatedAt: string;
}

function StatusBadge({ status }: { status: BatchJob['status'] }) {
  const config = {
    queued: { color: 'bg-blue-500/10 text-blue-400 border-blue-500/20', icon: Clock },
    processing: {
      color: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
      icon: RefreshCw,
    },
    complete: {
      color: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
      icon: CheckCircle,
    },
    partial_failure: {
      color: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
      icon: AlertCircle,
    },
    failed: { color: 'bg-red-500/10 text-red-400 border-red-500/20', icon: XCircle },
  };

  const { color, icon: Icon } = config[status] || config.queued;

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${color}`}
    >
      <Icon className={`h-3 w-3 ${status === 'processing' ? 'animate-spin' : ''}`} />
      {status.replace('_', ' ')}
    </span>
  );
}

function ProgressBar({
  processed,
  total,
  failed,
}: {
  processed: number;
  total: number;
  failed: number;
}) {
  const successPct = total > 0 ? ((processed - failed) / total) * 100 : 0;
  const failedPct = total > 0 ? (failed / total) * 100 : 0;

  return (
    <div className="w-full">
      <div className="flex justify-between text-xs text-muted-foreground mb-1">
        <span>
          {processed}/{total} processed
        </span>
        {failed > 0 && <span className="text-red-400">{failed} failed</span>}
      </div>
      <div className="h-1.5 w-full rounded-full bg-white/5 overflow-hidden">
        <div className="flex h-full">
          <div
            className="bg-emerald-500 transition-all duration-500"
            style={{ width: `${successPct}%` }}
          />
          {failed > 0 && (
            <div
              className="bg-red-500 transition-all duration-500"
              style={{ width: `${failedPct}%` }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function JobCard({ job }: { job: BatchJob }) {
  return (
    <div className="glass-card rounded-xl border border-white/10 p-4 shadow-card-rest">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-primary/15 to-primary/5">
            <Cpu className="h-5 w-5 text-primary" />
          </div>
          <div>
            <p className="font-mono text-xs text-muted-foreground">
              {job.id.slice(0, 8)}...
            </p>
            <p className="text-sm font-medium text-foreground mt-0.5">
              {job.totalItems} credential{job.totalItems !== 1 ? 's' : ''}
            </p>
          </div>
        </div>
        <StatusBadge status={job.status} />
      </div>

      <div className="mt-3">
        <ProgressBar
          processed={job.processedItems}
          total={job.totalItems}
          failed={job.failedItems}
        />
      </div>

      <div className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
        <Clock className="h-3 w-3" />
        {new Date(job.createdAt).toLocaleString()}
      </div>
    </div>
  );
}

export function BatchAIDashboard() {
  const [jobs, setJobs] = useState<BatchJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchJobs = useCallback(async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error: fetchError } = await (supabase as any)
        .from('batch_verification_jobs')
        .select('id, status, total_items, processed_items, failed_items, created_at, updated_at')
        .order('created_at', { ascending: false })
        .limit(20);

      if (fetchError) {
        setError('Failed to load batch jobs');
        return;
      }

      setJobs(
        (data ?? []).map(
          (row: {
            id: string;
            status: string;
            total_items: number;
            processed_items: number;
            failed_items: number;
            created_at: string;
            updated_at: string;
          }) => ({
            id: row.id,
            status: row.status as BatchJob['status'],
            totalItems: row.total_items,
            processedItems: row.processed_items,
            failedItems: row.failed_items ?? 0,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          }),
        ),
      );
      setError(null);
    } catch {
      setError('Failed to load batch jobs');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchJobs();

    // Auto-refresh every 5s while jobs may be processing
    const hasActiveJobs = jobs.some(
      (j) => j.status === 'queued' || j.status === 'processing',
    );
    if (hasActiveJobs) {
      const interval = setInterval(fetchJobs, 5000);
      return () => clearInterval(interval);
    }
  }, [fetchJobs, jobs]);

  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="shimmer h-24 rounded-xl" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-sm text-red-400">
        <AlertCircle className="h-4 w-4 shrink-0" />
        {error}
      </div>
    );
  }

  if (jobs.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground text-sm">
        <Cpu className="h-8 w-8 mx-auto mb-2 opacity-50" />
        <p>No batch AI jobs yet</p>
        <p className="text-xs mt-1">
          Upload credentials via CSV to start batch AI processing
        </p>
      </div>
    );
  }

  // Summary stats
  const completed = jobs.filter((j) => j.status === 'complete').length;
  const processing = jobs.filter(
    (j) => j.status === 'queued' || j.status === 'processing',
  ).length;
  const failed = jobs.filter(
    (j) => j.status === 'failed' || j.status === 'partial_failure',
  ).length;

  return (
    <div className="space-y-4 animate-in-view">
      {/* Summary */}
      <div className="grid grid-cols-3 gap-3">
        <div className="glass-card rounded-xl border border-white/10 p-3 text-center">
          <p className="text-2xl font-semibold text-emerald-400">{completed}</p>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Completed
          </p>
        </div>
        <div className="glass-card rounded-xl border border-white/10 p-3 text-center">
          <p className="text-2xl font-semibold text-amber-400">{processing}</p>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Processing
          </p>
        </div>
        <div className="glass-card rounded-xl border border-white/10 p-3 text-center">
          <p className="text-2xl font-semibold text-red-400">{failed}</p>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Failed
          </p>
        </div>
      </div>

      {/* Job list */}
      <div className="space-y-2">
        {jobs.map((job, i) => (
          <div key={job.id} className={`stagger-${Math.min(i + 1, 8)}`}>
            <JobCard job={job} />
          </div>
        ))}
      </div>

      {/* Refresh button */}
      <button
        onClick={fetchJobs}
        className="flex items-center gap-1.5 mx-auto text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <RefreshCw className="h-3 w-3" />
        Refresh
      </button>
    </div>
  );
}
