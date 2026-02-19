/**
 * Anchor Processing with Safe Job Claim
 *
 * Uses atomic job claim mechanism for idempotent processing.
 */

import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { chainClient } from '../chain/client.js';
import { getNetworkDisplayName, config } from '../config.js';

const WORKER_ID = `worker-${process.pid}-${Date.now()}`;

/**
 * Claim and process a single job
 */
export async function claimAndProcessJob(): Promise<boolean> {
  // Atomically claim a job
  const { data: jobId, error: claimError } = await db.rpc('claim_anchoring_job', {
    p_worker_id: WORKER_ID,
    p_lock_duration_seconds: 300,
  });

  if (claimError) {
    logger.error({ error: claimError }, 'Failed to claim job');
    return false;
  }

  if (!jobId) {
    // No jobs available
    return false;
  }

  logger.info({ jobId, workerId: WORKER_ID }, 'Claimed job');

  try {
    // Fetch the job with anchor details
    const { data: job, error: fetchError } = await db
      .from('anchoring_jobs')
      .select('*, anchors(*)')
      .eq('id', jobId)
      .single();

    if (fetchError || !job) {
      logger.error({ jobId, error: fetchError }, 'Failed to fetch job');
      await db.rpc('complete_anchoring_job', {
        p_job_id: jobId,
        p_success: false,
        p_error: 'Failed to fetch job details',
      });
      return false;
    }

    const anchor = job.anchors;

    // Submit to chain
    const receipt = await chainClient.submitFingerprint({
      fingerprint: anchor.fingerprint,
      timestamp: new Date().toISOString(),
    });

    // Update anchor with chain data (only worker can set SECURED)
    const { error: updateError } = await db
      .from('anchors')
      .update({
        status: 'SECURED',
        chain_tx_id: receipt.receiptId,
        chain_block_height: receipt.blockHeight,
        chain_timestamp: receipt.blockTimestamp,
      })
      .eq('id', anchor.id);

    if (updateError) {
      throw updateError;
    }

    // Store proof
    await db.from('anchor_proofs').insert({
      anchor_id: anchor.id,
      receipt_id: receipt.receiptId,
      block_height: receipt.blockHeight,
      block_timestamp: receipt.blockTimestamp,
      merkle_root: receipt.merkleRoot || null,
      raw_response: receipt,
    });

    // Log audit event
    await db.from('audit_events').insert({
      event_type: 'anchor.secured',
      event_category: 'ANCHOR',
      actor_id: anchor.user_id,
      target_type: 'anchor',
      target_id: anchor.id,
      org_id: anchor.org_id,
      details: `Secured on ${getNetworkDisplayName(config.chainNetwork)}: ${receipt.receiptId}`,
    });

    // Complete job
    await db.rpc('complete_anchoring_job', {
      p_job_id: jobId,
      p_success: true,
    });

    logger.info({ jobId, anchorId: anchor.id, receiptId: receipt.receiptId }, 'Job completed successfully');
    return true;
  } catch (error) {
    logger.error({ jobId, error }, 'Job processing failed');

    await db.rpc('complete_anchoring_job', {
      p_job_id: jobId,
      p_success: false,
      p_error: error instanceof Error ? error.message : 'Unknown error',
    });

    return false;
  }
}

/**
 * Process all available jobs
 */
export async function processAllJobs(): Promise<{ processed: number; failed: number }> {
  let processed = 0;
  let failed = 0;
  let hasMore = true;

  while (hasMore) {
    const success = await claimAndProcessJob();
    if (success) {
      processed++;
    } else {
      // Check if it was a failure or just no jobs
      const { data: pendingCount } = await db
        .from('anchoring_jobs')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending');

      if (!pendingCount || pendingCount === 0) {
        hasMore = false;
      } else {
        failed++;
        // Continue trying other jobs
      }
    }

    // Safety limit
    if (processed + failed >= 100) {
      hasMore = false;
    }
  }

  return { processed, failed };
}
