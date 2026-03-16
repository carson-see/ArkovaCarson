/**
 * POST /api/v1/verify/batch (P4.5-TS-02)
 *
 * Batch verification of multiple credentials by publicId.
 * Synchronous for ≤20 items, async (job) for >20.
 * Requires API key authentication.
 */

import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { buildVerificationResult, type PublicIdLookup, type AnchorByPublicId } from './verify.js';
import { incrementUsage } from '../../middleware/usageTracking.js';
import type { VerificationResult } from './verify.js';

const router = Router();

const MAX_BATCH_SIZE = 100;
const SYNC_THRESHOLD = 20;
const PER_ITEM_TIMEOUT_MS = 5000;

/** Zod schema for batch request */
export const batchRequestSchema = z.object({
  public_ids: z.array(z.string().min(3)).min(1).max(MAX_BATCH_SIZE),
});

export interface BatchResultItem extends VerificationResult {
  public_id: string;
}

export interface BatchResponse {
  results?: BatchResultItem[];
  job_id?: string;
  total: number;
}

/** Default DB-backed lookup (same as verify.ts) */
const defaultLookup: PublicIdLookup = {
  async lookupByPublicId(publicId: string) {
    const { data, error } = await db
      .from('anchors')
      .select(`
        public_id,
        fingerprint,
        status,
        chain_tx_id,
        chain_block_height,
        chain_timestamp,
        created_at,
        credential_type,
        issued_at,
        expires_at,
        org_id
      `)
      .eq('public_id', publicId)
      .is('deleted_at', null)
      .single();

    if (error || !data) return null;

    let orgName: string | null = null;
    if (data.org_id) {
      const { data: org } = await db
        .from('organizations')
        .select('display_name')
        .eq('id', data.org_id)
        .single();
      orgName = org?.display_name ?? null;
    }

    return {
      public_id: data.public_id ?? '',
      fingerprint: data.fingerprint,
      status: data.status,
      chain_tx_id: data.chain_tx_id,
      chain_block_height: data.chain_block_height,
      chain_timestamp: data.chain_timestamp,
      created_at: data.created_at,
      credential_type: data.credential_type,
      org_name: orgName,
      recipient_hash: null,
      issued_at: data.issued_at,
      expires_at: data.expires_at,
      jurisdiction: null,
      merkle_root: null,
    } as AnchorByPublicId;
  },
};

/**
 * Verify a single item with timeout.
 */
async function verifyWithTimeout(
  publicId: string,
  lookup: PublicIdLookup,
  timeoutMs: number,
): Promise<BatchResultItem> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const anchor = await Promise.race([
      lookup.lookupByPublicId(publicId),
      new Promise<null>((_, reject) => {
        controller.signal.addEventListener('abort', () =>
          reject(new Error('timeout')),
        );
      }),
    ]);

    clearTimeout(timer);

    if (!anchor) {
      return { public_id: publicId, verified: false, error: 'Record not found' };
    }

    const result = buildVerificationResult(anchor);
    return { public_id: publicId, ...result };
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.message === 'timeout') {
      return { public_id: publicId, verified: false, error: 'timeout' };
    }
    return { public_id: publicId, verified: false, error: 'Verification failed' };
  }
}

/**
 * Process a batch synchronously (≤ SYNC_THRESHOLD items).
 */
export async function processBatchSync(
  publicIds: string[],
  lookup: PublicIdLookup = defaultLookup,
): Promise<BatchResultItem[]> {
  const results = await Promise.allSettled(
    publicIds.map((id) => verifyWithTimeout(id, lookup, PER_ITEM_TIMEOUT_MS)),
  );

  return results.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    return { public_id: publicIds[i], verified: false, error: 'Verification failed' };
  });
}

/**
 * Create an async batch job (> SYNC_THRESHOLD items).
 */
async function createBatchJob(
  publicIds: string[],
  apiKeyId: string,
): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from('batch_verification_jobs')
    .insert({
      api_key_id: apiKeyId,
      status: 'submitted',
      public_ids: publicIds,
      total: publicIds.length,
    })
    .select('id')
    .single();

  if (error || !data) {
    throw new Error('Failed to create batch job');
  }

  // Fire-and-forget: process in background
  void processAsyncJob(data.id, publicIds);

  return data.id;
}

/**
 * Process async batch job in background.
 */
async function processAsyncJob(jobId: string, publicIds: string[]): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (db as any)
      .from('batch_verification_jobs')
      .update({ status: 'processing' })
      .eq('id', jobId);

    const results = await processBatchSync(publicIds);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (db as any)
      .from('batch_verification_jobs')
      .update({
        status: 'complete',
        results,
        completed_at: new Date().toISOString(),
      })
      .eq('id', jobId);
  } catch (err) {
    logger.error({ error: err, jobId }, 'Async batch job failed');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (db as any)
      .from('batch_verification_jobs')
      .update({
        status: 'failed',
        error_message: err instanceof Error ? err.message : 'Unknown error',
        completed_at: new Date().toISOString(),
      })
      .eq('id', jobId)
      .catch(() => {}); // best-effort
  }
}

/**
 * POST /api/v1/verify/batch
 */
router.post('/', async (req, res) => {
  // Require API key
  if (!req.apiKey) {
    res.status(401).json({
      error: 'authentication_required',
      message: 'API key required for batch verification',
    });
    return;
  }

  // Validate request body
  const parsed = batchRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'invalid_request',
      message: parsed.error.issues[0]?.message ?? 'Invalid request body',
      details: parsed.error.issues,
    });
    return;
  }

  const { public_ids } = parsed.data;

  try {
    const lookup = (req as unknown as { _testLookup?: PublicIdLookup })._testLookup ?? defaultLookup;

    if (public_ids.length <= SYNC_THRESHOLD) {
      // Synchronous path
      const results = await processBatchSync(public_ids, lookup);

      // Increment usage by number of items
      void incrementUsage(req.apiKey.keyId, req.apiKey.orgId, public_ids.length);

      const response: BatchResponse = {
        results,
        total: public_ids.length,
      };
      res.json(response);
    } else {
      // Async path — create job
      const jobId = await createBatchJob(public_ids, req.apiKey.keyId);

      // Increment usage by number of items
      void incrementUsage(req.apiKey.keyId, req.apiKey.orgId, public_ids.length);

      const response: BatchResponse = {
        job_id: jobId,
        total: public_ids.length,
      };
      res.status(202).json(response);
    }
  } catch (err) {
    logger.error({ error: err }, 'Batch verification failed');
    res.status(500).json({
      error: 'internal_error',
      message: 'Batch verification failed',
    });
  }
});

export { router as batchRouter };
