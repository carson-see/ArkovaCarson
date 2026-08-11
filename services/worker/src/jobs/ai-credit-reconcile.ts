/**
 * `ai_credits.reconcile_refund` consumer — the lost-refund surface.
 *
 * WHY THIS EXISTS
 *
 * `api/v1/ai-extract-batch.ts` debits 1 AI credit per row BEFORE the provider
 * call and refunds that row's credit when the row fails or times out. If the
 * refund itself fails after a successful debit, the org is overcharged. Rather
 * than swallow that in a `.catch(() => {})`, the route enqueues an
 * `ai_credits.reconcile_refund` job — and its own contract
 * (`api/v1/agents.md`) states: "A lost refund is an overcharge — it is
 * surfaced, not dropped."
 *
 * It was not surfaced. The worker has no central job dispatcher: a `job_queue`
 * type is handled if and only if some file calls `claimJob` / `processNextJob`
 * with that literal string, and nothing did. Every enqueued row sat `pending`
 * forever — never claimed, never retried, never dead-lettered, absent from
 * every error path and dashboard. The producer was writing to a queue with no
 * other end, so the "surfacing" mechanism silently guaranteed the opposite of
 * its stated purpose.
 *
 * WHAT THIS DOES
 *
 *   1. Re-applies the lost refund (`deductAICredits(org, user, -amount)`),
 *      which is the actual remedy — the customer gets the credit back.
 *   2. On a refund that still fails, throws so `processNextJob` applies the
 *      shared exponential-backoff retry and, on the final attempt, the dead
 *      letter policy.
 *   3. On that final attempt, emits a Sentry event BEFORE throwing, so a
 *      permanently unreconciled overcharge produces an operator-visible
 *      signal rather than one more silent `dead` row.
 *
 * SAFETY: this job MINTS credits. Its payload is therefore validated with Zod
 * (bounded positive integer amount, at least one of org/user) before any
 * balance moves — a malformed or hostile payload must fail loudly, not issue
 * an unattributable or unbounded credit. Document fingerprints are carried in
 * the payload by the producer but are NEVER written to logs or Sentry
 * (CLAUDE.md §1.1: no Sentry events containing document fingerprints).
 */
import { z } from 'zod';

import { deductAICredits } from '../ai/cost-tracker.js';
import { logger } from '../utils/logger.js';
import { processNextJob, type Job } from '../utils/jobQueue.js';
import { Sentry } from '../utils/sentry.js';

/**
 * job_queue `type` for the AI-credit refund reconciliation queue. Single
 * source of truth — the producer (`api/v1/ai-extract-batch.ts`) re-exports
 * this rather than re-declaring the literal, mirroring the
 * `DRIVE_FILE_CHANGED_JOB_TYPE` convention in `drive-artifact-producer.ts`.
 */
export const AI_CREDIT_RECONCILE_JOB_TYPE = 'ai_credits.reconcile_refund';

/** Default jobs drained per pass. */
const DEFAULT_LIMIT = 25;

/**
 * Upper bound on a single reconciliation. The producer only ever enqueues 1
 * (one row's credit), so anything near this ceiling is already a bug; the
 * bound exists so a corrupted payload cannot mint an arbitrary balance.
 */
export const MAX_RECONCILABLE_AMOUNT = 1000;

const ReconcileRefundPayloadSchema = z
  .object({
    orgId: z.string().uuid().nullish(),
    userId: z.string().uuid().nullish(),
    amount: z.number().int().positive().max(MAX_RECONCILABLE_AMOUNT),
    reason: z.string().max(200).nullish(),
    source: z.string().max(100).nullish(),
  })
  // Deliberately NOT `.strict()`: the payload also carries `fingerprint`,
  // which this consumer must never read into a log or a Sentry event.
  .refine(
    (payload) => payload.orgId != null || payload.userId != null,
    { message: 'reconciliation payload has neither orgId nor userId — credit would be unattributable' },
  );

export interface AiCreditReconcileRunResult {
  claimed: number;
  reconciled: number;
  failed: number;
}

export interface AiCreditReconcileOptions {
  /** Max jobs to drain in one pass. */
  limit?: number;
}

/**
 * True when this claim is the job's LAST attempt, i.e. a failure now moves it
 * to the dead letter queue. Mirrors `failJob`'s own `attempts >= maxAttempts`
 * condition so the Sentry signal cannot drift from the actual DLQ boundary.
 */
function isFinalAttempt(job: Job<unknown>): boolean {
  return job.attempts >= job.max_attempts;
}

async function reconcileOne(job: Job<unknown>): Promise<void> {
  // Bounded, fingerprint-free log/Sentry context. `reason`/`source` are our
  // own short enum-ish strings; row text and fingerprints never appear here.
  const parsed = ReconcileRefundPayloadSchema.safeParse(job.payload);

  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({
      code: issue.code,
      path: issue.path.map(String),
    }));
    logger.error(
      { jobId: job.id, attempts: job.attempts, issues },
      'AI credit reconciliation payload failed validation — refusing to move credits',
    );
    if (isFinalAttempt(job)) {
      Sentry.captureException(
        new Error('ai_credits.reconcile_refund: payload invalid on final attempt — refund NOT reconciled'),
        { extra: { jobId: job.id, issues } },
      );
    }
    throw new Error('ai_credit_reconcile_invalid_payload');
  }

  const { orgId, userId, amount, reason, source } = parsed.data;
  const context = {
    jobId: job.id,
    attempts: job.attempts,
    orgId: orgId ?? null,
    userId: userId ?? null,
    amount,
    reason: reason ?? null,
    source: source ?? null,
  };

  // A NEGATIVE deduction is the refund. Same helper (and therefore the same
  // `deduct_ai_credits` RPC) the inline refund used, so this is a retry of the
  // exact operation that failed, not a second, divergent code path.
  const refunded = await deductAICredits(orgId ?? undefined, userId ?? undefined, -amount);

  if (!refunded) {
    logger.error(context, 'AI credit refund reconciliation failed — org remains overcharged');
    if (isFinalAttempt(job)) {
      Sentry.captureException(
        new Error('ai_credits.reconcile_refund exhausted retries — customer remains overcharged'),
        { extra: context },
      );
    }
    throw new Error('ai_credit_refund_reconciliation_failed');
  }

  logger.info(context, 'AI credit refund reconciled');
}

/**
 * Drain the `ai_credits.reconcile_refund` queue. Stops as soon as the queue is
 * idle so a large `limit` costs nothing on an empty queue.
 */
export async function runAiCreditReconcileJobs(
  opts: AiCreditReconcileOptions = {},
): Promise<AiCreditReconcileRunResult> {
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), 100);
  const result: AiCreditReconcileRunResult = { claimed: 0, reconciled: 0, failed: 0 };

  for (let i = 0; i < limit; i++) {
    const processed = await processNextJob(AI_CREDIT_RECONCILE_JOB_TYPE, reconcileOne);
    if (!processed.claimed) break;

    result.claimed += 1;
    if (processed.status === 'completed') {
      result.reconciled += 1;
    } else {
      result.failed += 1;
    }
  }

  return result;
}
