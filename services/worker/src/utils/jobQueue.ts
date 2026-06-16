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

// ─── SCRUM-2492 (§1.6A): last_error sanitizer ──────────────────────────────
//
// `last_error` is persisted to Postgres (`job_queue.last_error`). For
// connector jobs (DocuSign / Google Drive document fetch), a failure must not
// be able to write raw document bytes into that column. `failJob` is typed to
// take a `string`, but `String(someBuffer)` (or a stringified
// `{ "type":"Buffer","data":[...] }`) would smuggle bytes in. This sanitizer
// detects those shapes and replaces them with a bounded token, then caps the
// length. It is intentionally conservative: it never persists raw byte runs.

export const REDACTED_LAST_ERROR_TOKEN = '[redacted: binary content]';
const LAST_ERROR_MAX_LENGTH = 1000;

// `{ "type": "Buffer", "data": [ ... ] }` — Node's JSON form of a Buffer.
const SERIALIZED_BUFFER_RE = /\{\s*"?type"?\s*:\s*"Buffer"\s*,\s*"?data"?\s*:\s*\[/i;
const CONTROL_RUN_THRESHOLD = 8;
// A run of identical characters this long is not a plausible human/error
// message — it is a low-entropy byte fill coerced to text (e.g. a PDF padding
// region, or `Buffer.alloc(n, b).toString()`).
const REPEAT_RUN_THRESHOLD = 32;

/**
 * Heuristic: does `text` look like raw document bytes coerced to a string?
 * Two signals, both rare in real error messages:
 *   (a) a dense run of non-printable control bytes (binary content / invalid
 *       UTF-8 decoded to U+FFFD), or
 *   (b) a long run of a single repeated character (low-entropy byte fill).
 * Implemented programmatically (no control chars in source).
 */
function looksLikeRawBytes(text: string): boolean {
  let controlRun = 0;
  let repeatRun = 1;
  let prev = -1;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);

    const isNonPrintable =
      (code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
      code === 0x7f ||
      code === 0xfffd; // U+FFFD replacement char from invalid UTF-8
    if (isNonPrintable) {
      controlRun += 1;
      if (controlRun >= CONTROL_RUN_THRESHOLD) return true;
    } else {
      controlRun = 0;
    }

    if (code === prev) {
      repeatRun += 1;
      if (repeatRun >= REPEAT_RUN_THRESHOLD) return true;
    } else {
      repeatRun = 1;
      prev = code;
    }
  }
  return false;
}

/**
 * Strip byte-ish content from a `last_error` string before it is persisted.
 * Returns a bounded, byte-free string.
 */
export function sanitizeLastError(raw: unknown): string {
  // Coerce defensively — `failJob`'s caller may hand us a non-string.
  let text: string;
  if (typeof raw === 'string') {
    text = raw;
  } else if (raw === null || raw === undefined) {
    text = '';
  } else if (typeof Buffer !== 'undefined' && Buffer.isBuffer(raw)) {
    return REDACTED_LAST_ERROR_TOKEN;
  } else if (ArrayBuffer.isView(raw as ArrayBufferView) || raw instanceof ArrayBuffer) {
    return REDACTED_LAST_ERROR_TOKEN;
  } else {
    text = String(raw);
  }

  if (SERIALIZED_BUFFER_RE.test(text) || looksLikeRawBytes(text)) {
    return REDACTED_LAST_ERROR_TOKEN;
  }

  return text.length > LAST_ERROR_MAX_LENGTH ? text.slice(0, LAST_ERROR_MAX_LENGTH) : text;
}

export type JobHandler<T = unknown> = (job: Job<T>) => Promise<void>;

export interface ProcessJobResult {
  claimed: boolean;
  status: 'idle' | 'completed' | 'failed' | 'dead' | 'update_failed';
  jobId?: string;
  attempts?: number;
  error?: string;
}

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
  const { error } = await (db as any)
    .from('job_queue')
    .update({ status: 'completed', updated_at: new Date().toISOString() })
    .eq('id', jobId);
  if (error) {
    throw new Error(`job_complete_update_failed:${jobId}`);
  }
}

/**
 * Mark a job as failed. If max attempts exceeded, move to dead letter.
 */
export async function failJob(jobId: string, errorMessage: string, attempts: number, maxAttempts: number): Promise<void> {
  const status: JobStatus = attempts >= maxAttempts ? 'dead' : 'failed';

  // SCRUM-2492 (§1.6A): never persist raw document bytes into job_queue.last_error.
  // Route through the byte-safe sanitizer (which also caps length) instead of a
  // bare substring.
  const safeLastError = sanitizeLastError(errorMessage);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (db as any)
    .from('job_queue')
    .update({
      status,
      last_error: safeLastError,
      updated_at: new Date().toISOString(),
      // Exponential backoff for retry: 2^attempts * 30 seconds
      ...(status === 'failed' ? {
        scheduled_for: new Date(Date.now() + Math.pow(2, attempts) * 30_000).toISOString(),
      } : {}),
    })
    .eq('id', jobId);
  if (error) {
    throw new Error(`job_fail_update_failed:${jobId}`);
  }

  if (status === 'dead') {
    // Log the sanitized value — the raw errorMessage could be a stringified
    // Buffer that the pino binary guard (which is type-based) would not catch
    // once it is already a string.
    logger.warn({ jobId, attempts, error: safeLastError }, 'Job moved to dead letter queue');
  }
}

/**
 * Claim and process one queued job with the shared retry/dead-letter policy.
 */
export async function processNextJob<T = unknown>(
  type: string,
  handler: JobHandler<T>,
): Promise<ProcessJobResult> {
  const job = await claimJob<T>(type);
  if (!job) return { claimed: false, status: 'idle' };

  try {
    await handler(job);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await failJob(job.id, message, job.attempts, job.max_attempts);
    } catch (updateError) {
      const updateMessage = updateError instanceof Error ? updateError.message : String(updateError);
      return {
        claimed: true,
        status: 'update_failed',
        jobId: job.id,
        attempts: job.attempts,
        error: updateMessage,
      };
    }
    return {
      claimed: true,
      status: job.attempts >= job.max_attempts ? 'dead' : 'failed',
      jobId: job.id,
      attempts: job.attempts,
      error: message,
    };
  }

  try {
    await completeJob(job.id);
  } catch (updateError) {
    const updateMessage = updateError instanceof Error ? updateError.message : String(updateError);
    return {
      claimed: true,
      status: 'update_failed',
      jobId: job.id,
      attempts: job.attempts,
      error: updateMessage,
    };
  }

  return {
    claimed: true,
    status: 'completed',
    jobId: job.id,
    attempts: job.attempts,
  };
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
