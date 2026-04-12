/**
 * Job Queue Abstraction (PERF-13)
 *
 * Lightweight job queue using a Supabase `job_queue` table with
 * pg_notify for real-time job dispatch. Supports:
 * - Job submission with priority and scheduling
 * - Dead letter queue for failed jobs (max retries)
 * - Job status tracking (pending → processing → completed/failed/dead)
 * - Configurable retry with exponential backoff
 *
 * This is a stepping stone — can be replaced with Cloudflare Queues
 * or BullMQ when horizontal scaling requires it.
 */

import { db } from './db.js';
import { logger } from './logger.js';

export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'dead';

export interface Job<T = unknown> {
  id: string;
  type: string;
  payload: T;
  status: JobStatus;
  priority: number;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  scheduled_for: string | null;
}

export interface JobSubmission<T = unknown> {
  type: string;
  payload: T;
  priority?: number;
  max_attempts?: number;
  /** ISO timestamp — job won't be picked up before this time */
  scheduled_for?: string;
}

const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Submit a job to the queue.
 */
export async function submitJob<T>(submission: JobSubmission<T>): Promise<string | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from('job_queue')
    .insert({
      type: submission.type,
      payload: submission.payload,
      priority: submission.priority ?? 0,
      max_attempts: submission.max_attempts ?? DEFAULT_MAX_ATTEMPTS,
      scheduled_for: submission.scheduled_for ?? null,
      status: 'pending',
      attempts: 0,
    })
    .select('id')
    .single();

  if (error) {
    logger.error({ error, type: submission.type }, 'Failed to submit job');
    return null;
  }

  return data?.id ?? null;
}

/**
 * Claim the next available job of a given type.
 * Uses UPDATE ... RETURNING with a lock to prevent double-processing.
 */
export async function claimJob<T>(type: string): Promise<Job<T> | null> {
  const now = new Date().toISOString();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any).rpc('claim_next_job', {
    p_type: type,
    p_now: now,
  });

  if (error) {
    logger.error({ error, type }, 'Failed to claim job');
    return null;
  }

  if (!data || (Array.isArray(data) && data.length === 0)) return null;

  const row = Array.isArray(data) ? data[0] : data;
  return row as Job<T>;
}

/**
 * Mark a job as completed.
 */
export async function completeJob(jobId: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db as any)
    .from('job_queue')
    .update({ status: 'completed', updated_at: new Date().toISOString() })
    .eq('id', jobId);
}

/**
 * Mark a job as failed. If max attempts exceeded, move to dead letter.
 */
export async function failJob(jobId: string, errorMessage: string, attempts: number, maxAttempts: number): Promise<void> {
  const status: JobStatus = attempts >= maxAttempts ? 'dead' : 'failed';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db as any)
    .from('job_queue')
    .update({
      status,
      last_error: errorMessage.substring(0, 1000),
      updated_at: new Date().toISOString(),
      // Exponential backoff for retry: 2^attempts * 30 seconds
      ...(status === 'failed' ? {
        scheduled_for: new Date(Date.now() + Math.pow(2, attempts) * 30_000).toISOString(),
      } : {}),
    })
    .eq('id', jobId);

  if (status === 'dead') {
    logger.warn({ jobId, attempts, error: errorMessage }, 'Job moved to dead letter queue');
  }
}

/**
 * Get queue depth (pending + failed jobs) for monitoring.
 */
export async function getQueueDepth(type?: string): Promise<{ pending: number; failed: number; dead: number }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dbAny = db as any;

  let pendingQuery = dbAny.from('job_queue').select('id', { count: 'exact', head: true }).eq('status', 'pending');
  let failedQuery = dbAny.from('job_queue').select('id', { count: 'exact', head: true }).eq('status', 'failed');
  let deadQuery = dbAny.from('job_queue').select('id', { count: 'exact', head: true }).eq('status', 'dead');

  if (type) {
    pendingQuery = pendingQuery.eq('type', type);
    failedQuery = failedQuery.eq('type', type);
    deadQuery = deadQuery.eq('type', type);
  }

  const [p, f, d] = await Promise.all([pendingQuery, failedQuery, deadQuery]);

  return {
    pending: p.count ?? 0,
    failed: f.count ?? 0,
    dead: d.count ?? 0,
  };
}
