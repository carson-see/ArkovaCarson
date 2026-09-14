/**
 * SCRUM-5139 durable manual/API instant-secure consumer.
 *
 * The job owns only intent dispatch. Bitcoin preparation, txid journaling,
 * broadcast ambiguity and recovery remain in the canonical batch processor.
 */
import { z } from 'zod';
import { config } from '../config.js';
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { processNextJob } from '../utils/jobQueue.js';
import { processBatchAnchors } from './batch-anchor.js';

export const INSTANT_SECURE_JOB_TYPE = 'anchor.instant_secure';
const PayloadSchema = z.object({
  intent_id: z.string().uuid(),
  generation: z.number().int().nonnegative().optional().default(0),
}).strict();

interface IntentRow {
  id: string;
  anchor_id: string;
  attempt: number;
  rearm_generation: number;
  status: 'QUEUED' | 'PROCESSING' | 'NEEDS_CREDIT' | 'RETRYABLE' | 'HELD' | 'SUBMITTED' | 'FAILED';
}

async function settle(intentId: string, attempt: number, outcome: 'SUBMITTED' | 'HELD' | 'FAILED_SAFE', errorCode?: string): Promise<void> {
  // Worker generated types acquire this additive RPC after schema promotion.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db.rpc as any)('settle_anchor_instant_intent', {
    p_intent_id: intentId,
    p_outcome: outcome,
    p_expected_attempt: attempt,
    p_error_code: errorCode ?? null,
  });
  if (error || !(data as { success?: boolean } | null)?.success) {
    throw new Error(`instant_intent_settlement_failed:${outcome}`);
  }
}

export async function processInstantSecureIntent(payload: unknown): Promise<void> {
  const { intent_id: intentId, generation } = PayloadSchema.parse(payload);
  if (!config.enableInstantSecure) throw new Error('instant_secure_disabled');

  // Worker generated types acquire this additive table after schema promotion.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: before, error: beforeError } = await (db as any)
    .from('anchor_instant_intents')
    .select('id, anchor_id, status, attempt, rearm_generation')
    .eq('id', intentId)
    .maybeSingle();
  if (beforeError || !before) throw new Error('instant_intent_unavailable');
  const intent = before as IntentRow;
  if ((intent.rearm_generation ?? 0) !== generation) return;
  if (intent.status === 'SUBMITTED' || intent.status === 'NEEDS_CREDIT' || intent.status === 'FAILED') return;

  await processBatchAnchors({ force: true, instantIntentId: intentId });

  const [{ data: after, error: afterError }, { data: anchor, error: anchorError }] = await Promise.all([
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).from('anchor_instant_intents').select('id, anchor_id, status, attempt, rearm_generation').eq('id', intentId).single(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).from('anchors').select('id, status, chain_tx_id').eq('id', intent.anchor_id).single(),
  ]);
  if (afterError || anchorError || !after || !anchor) throw new Error('instant_intent_state_unavailable');
  if ((after.rearm_generation ?? 0) !== generation) return;

  if (after.status === 'NEEDS_CREDIT') return;
  if (anchor.status === 'SUBMITTED' || anchor.status === 'SECURED') {
    await settle(intentId, after.attempt, 'SUBMITTED');
    return;
  }
  if (anchor.status === 'BROADCASTING' || anchor.chain_tx_id) {
    await settle(intentId, after.attempt, 'HELD', 'broadcast_outcome_ambiguous');
    return;
  }
  if (anchor.status === 'PENDING' && after.status === 'PROCESSING') {
    await settle(intentId, after.attempt, 'FAILED_SAFE', 'prebroadcast_failure');
    return;
  }
  // No claim was acquired (for example, global treasury lease contention).
  // Let job_queue retry; no debit exists to settle.
  throw new Error('instant_intent_not_claimed');
}

export interface InstantSecureRunResult {
  claimed: number;
  completed: number;
  failed: number;
  dead: number;
  updateFailed: number;
}

export async function runInstantSecureJobs(limit = 10): Promise<InstantSecureRunResult> {
  const result: InstantSecureRunResult = { claimed: 0, completed: 0, failed: 0, dead: 0, updateFailed: 0 };
  for (let index = 0; index < Math.max(1, Math.min(limit, 100)); index += 1) {
    const processed = await processNextJob(INSTANT_SECURE_JOB_TYPE, (job) => processInstantSecureIntent(job.payload));
    if (!processed.claimed) break;
    result.claimed += 1;
    if (processed.status === 'completed') result.completed += 1;
    else if (processed.status === 'failed') result.failed += 1;
    else if (processed.status === 'dead') result.dead += 1;
    else if (processed.status === 'update_failed') result.updateFailed += 1;
  }
  if (result.dead || result.updateFailed) logger.error({ ...result }, 'Instant-secure job drain requires attention');
  return result;
}
