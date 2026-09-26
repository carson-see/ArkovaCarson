/**
 * Producer for the `ai_credits.reconcile_refund` queue.
 *
 * WHY IT IS SHARED (S9). `api/v1/ai-extract-batch.ts` owned this helper
 * privately, so only the BATCH path had a fallback when a refund failed after a
 * successful debit. The single-extraction path in `api/v1/ai-extract.ts` raised
 * a Sentry alert and stopped there — an alert is a notification, not a remedy,
 * so an overcharge on the single path was surfaced to us and never returned to
 * the customer, while the identical failure on the batch path was reconciled
 * automatically. Both paths now enqueue through this one function.
 *
 * The consumer is `jobs/ai-credit-reconcile.ts`, which declares the job type;
 * it is imported rather than re-spelled so producer and consumer cannot drift
 * onto two spellings of the same literal (the `DRIVE_FILE_CHANGED_JOB_TYPE`
 * convention).
 *
 * NEVER THROWS. A failure to enqueue is itself an unrecoverable overcharge, so
 * it is logged at `error` and swallowed: it must not turn a degraded-but-served
 * extraction into a 5xx for the end user.
 */
import { submitJob } from '../utils/jobQueue.js';
import { AI_CREDIT_RECONCILE_JOB_TYPE } from '../jobs/ai-credit-reconcile.js';
import { logger } from '../utils/logger.js';
import type { AICreditDebit } from './cost-tracker.js';

export { AI_CREDIT_RECONCILE_JOB_TYPE };

export interface RefundReconciliationRequest {
  /**
   * The ids and instant captured at DEBIT time. S8/S2: the reconciler must
   * refund from the same row, and the same period, the debit was taken from —
   * see `AICreditDebit`. Passing the debit record rather than loose ids is
   * what makes a divergent retry unrepresentable.
   */
  debit: AICreditDebit;
  amount: number;
  /** Short enum-ish string. Never row text. */
  reason: string;
  /** Which producer enqueued this. Short enum-ish string. */
  source: string;
  /**
   * Carried for operator correlation only. The consumer's Zod schema is
   * deliberately non-`.strict()` so this passes through UNREAD — it must never
   * reach a log line or a Sentry event (CLAUDE.md §1.1).
   */
  fingerprint?: string;
}

/**
 * Enqueue a reconciliation job when a refund failed after a successful debit.
 * This prevents a silent overcharge: the credit is reconciled out-of-band
 * instead of being lost in a swallowed `.catch`.
 */
export async function enqueueRefundReconciliation(
  params: RefundReconciliationRequest,
): Promise<void> {
  const { debit, amount, reason, source, fingerprint } = params;
  const context = { orgId: debit.orgId, userId: debit.userId, amount, reason, source };

  try {
    const jobId = await submitJob({
      type: AI_CREDIT_RECONCILE_JOB_TYPE,
      payload: {
        orgId: debit.orgId ?? null,
        userId: debit.userId ?? null,
        // S2: without this the retry — which runs minutes to days later, on
        // exponential backoff — refunds against whatever period is current
        // WHEN IT RUNS, not the one the debit was taken from.
        debitedAt: debit.debitedAt ?? null,
        amount,
        reason,
        fingerprint: fingerprint ?? null,
        source,
      },
      priority: 5,
    });
    if (!jobId) {
      logger.error(context, 'Failed to enqueue AI credit reconciliation job — refund not applied');
    }
  } catch (err) {
    // Last-resort: surface loudly. Do NOT swallow — a lost refund is an overcharge.
    logger.error(
      { error: err, ...context },
      'Exception enqueuing AI credit reconciliation job — refund not applied',
    );
  }
}
