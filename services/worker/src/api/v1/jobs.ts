/**
 * GET /api/v1/jobs/:jobId (P4.5-TS-06)
 *
 * Poll batch verification job status. Only the API key that
 * created the job can retrieve its results.
 */

import { Router } from 'express';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

const router = Router();

export interface JobStatusResponse {
  job_id: string;
  status: 'submitted' | 'processing' | 'complete' | 'failed';
  total: number;
  results?: Array<Record<string, unknown>>;
  error_message?: string;
  created_at: string;
  completed_at?: string | null;
}

/**
 * GET /api/v1/jobs/:jobId
 */
router.get('/:jobId', async (req, res) => {
  if (!req.apiKey) {
    res.status(401).json({
      error: 'authentication_required',
      message: 'API key required to check job status',
    });
    return;
  }

  const { jobId } = req.params;

  if (!jobId) {
    res.status(400).json({ error: 'invalid_request', message: 'jobId is required' });
    return;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (db as any)
      .from('batch_verification_jobs')
      .select('id, api_key_id, status, total, results, error_message, created_at, completed_at')
      .eq('id', jobId)
      .single();

    if (error || !data) {
      res.status(404).json({ error: 'not_found', message: 'Job not found' });
      return;
    }

    // Ownership check — only the key that created the job can read it
    if (data.api_key_id !== req.apiKey.keyId) {
      res.status(403).json({ error: 'forbidden', message: 'You do not have access to this job' });
      return;
    }

    const response: JobStatusResponse = {
      job_id: data.id,
      status: data.status,
      total: data.total ?? 0,
      created_at: data.created_at,
      completed_at: data.completed_at,
    };

    if (data.status === 'complete' && data.results) {
      response.results = data.results;
    }

    if (data.status === 'failed' && data.error_message) {
      response.error_message = data.error_message;
    }

    res.json(response);
  } catch (err) {
    logger.error({ error: err, jobId }, 'Job status lookup failed');
    res.status(500).json({ error: 'internal_error', message: 'Failed to retrieve job status' });
  }
});

/**
 * Clean up expired jobs (> 24h old). Called from worker cron.
 */
export async function cleanupExpiredJobs(): Promise<number> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (db as any)
      .from('batch_verification_jobs')
      .delete()
      .lt('created_at', cutoff)
      .select('id');

    if (error) {
      logger.error({ error }, 'Failed to clean up expired jobs');
      return 0;
    }

    const count = data?.length ?? 0;
    if (count > 0) {
      logger.info({ count }, 'Cleaned up expired batch jobs');
    }
    return count;
  } catch (err) {
    logger.error({ error: err }, 'Job cleanup failed');
    return 0;
  }
}

export { router as jobsRouter };
