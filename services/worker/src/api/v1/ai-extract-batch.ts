/**
 * Batch AI Extraction Endpoint (BETA-06)
 *
 * POST /api/v1/ai/extract-batch
 * Accepts an array of row text + credential type hints,
 * returns an array of extraction results (with partial failure support).
 *
 * Constitution 4A: Only PII-stripped metadata arrives at this endpoint.
 * Credit cost: 1 credit per row extracted.
 * Max batch size: 50 rows.
 * Concurrency: 3 parallel extractions (rate-limit Gemini, avoid timeouts).
 *
 * BUG-2026-06-24-013 (credit-ledger integrity, launch-critical):
 * Credits are now debited and refunded PER ITEM inside parallelMap (parity with
 * the single-extraction path in `ai-extract.ts`). This makes batch-level
 * double-accounting structurally impossible:
 *   1. A per-item debit that fails (transient DB error) ABORTS that row with a
 *      402-style result — never a free extraction. The old up-front batch debit
 *      that "logged and proceeded" on failure (free batch) is gone.
 *   2. Only the rows that actually succeed stay charged. Failed rows are
 *      refunded their own single credit — there is no blanket batch refund that
 *      could credit work the org never paid for.
 *   3. A refund that fails AFTER a successful debit is NOT swallowed; it enqueues
 *      an `ai_credits.reconcile_refund` job so the credit is reconciled later
 *      instead of being silently lost (silent overcharge).
 *   4. A per-row fingerprint cache (EFF-1 parity) short-circuits before any
 *      debit or provider call, so retries of a transient-failing batch do not
 *      re-charge or re-bill rows that already extracted successfully.
 *   5. A per-row latency budget (parity with the single path) bounds each
 *      extraction; a timeout is treated as a failed+refunded row, not a charge.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { createExtractionProvider } from '../../ai/factory.js';
import { checkAICredits, deductAICredits, logAIUsageEvent } from '../../ai/cost-tracker.js';
import { getExtractionPromptVersion } from '../../ai/prompts/extraction.js';
import { calibrateConfidenceByProvider } from '../../ai/eval/calibration.js';
import { submitJob } from '../../utils/jobQueue.js';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { config } from '../../config.js';

const MAX_BATCH_SIZE = 50;
// EFF-4: Configurable concurrency — Gemini Flash handles 5-10 concurrent requests well.
const CONCURRENCY_LIMIT = Math.min(
  Math.max(1, parseInt(process.env.AI_BATCH_CONCURRENCY ?? '3', 10) || 3),
  20, // hard cap
);

// Per-row latency budget (parity with the single path's AI_EXTRACTION_LATENCY_BUDGET_MS).
// Batch rows can be longer, so the budget is slightly higher than the single path.
// Sourced via the typed config (SCRUM-1258): AI_BATCH_ROW_LATENCY_BUDGET_MS is
// validated + clamped to [1000, 30000] in config.ts, not read ad-hoc here.
export const BATCH_ROW_LATENCY_BUDGET_MS = config.aiBatchRowLatencyBudgetMs;

/** Job type for the credit-reconciliation queue (refund failed after a successful debit). */
export const AI_CREDIT_RECONCILE_JOB_TYPE = 'ai_credits.reconcile_refund';

const BatchRowSchema = z.object({
  text: z.string().min(1, 'Row text is required'),
  credentialType: z.string().min(1, 'Credential type hint is required'),
  fingerprint: z.string().length(64).optional(),
  issuerHint: z.string().max(200).optional(),
});

const BatchRequestSchema = z.object({
  rows: z.array(BatchRowSchema).min(1, 'At least one row is required').max(MAX_BATCH_SIZE, `Maximum ${MAX_BATCH_SIZE} rows per batch`),
});

interface BatchResult {
  index: number;
  success: boolean;
  fields?: Record<string, string>;
  confidence?: number;
  provider?: string;
  error?: string;
  /** True when this row was served from the fingerprint cache (no debit, no provider call). */
  cached?: boolean;
}

class BatchRowLatencyError extends Error {
  constructor() {
    super(`AI batch row latency budget exceeded (${BATCH_ROW_LATENCY_BUDGET_MS}ms)`);
    this.name = 'BatchRowLatencyError';
  }
}

/** Bound a single provider call by the per-row latency budget. */
function withRowLatencyBudget<T>(operation: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new BatchRowLatencyError()), BATCH_ROW_LATENCY_BUDGET_MS);
  });

  return Promise.race([operation, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

/**
 * Process items with a concurrency limit.
 * Processes up to `limit` items in parallel at a time.
 */
async function parallelMap<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await fn(items[idx], idx);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Look up a cached extraction for a fingerprint (EFF-1 parity with the single path).
 * Returns the cached fields + confidence, or null on miss / no fingerprint.
 */
async function lookupCachedExtraction(
  fingerprint: string | undefined,
): Promise<{ fields: Record<string, string>; confidence: number } | null> {
  if (!fingerprint) return null;

  try {
    const { data, error } = await db
      .from('ai_usage_events')
      .select('result_json, confidence')
      .eq('fingerprint', fingerprint)
      .eq('event_type', 'extraction')
      .eq('success', true)
      .not('result_json', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1);

    if (error || !data || data.length === 0 || !data[0].result_json) return null;

    return {
      fields: data[0].result_json as Record<string, string>,
      confidence: (data[0].confidence as number | null) ?? 0.5,
    };
  } catch (err) {
    // Cache is best-effort — a lookup failure must never block extraction.
    logger.warn({ error: err, fingerprint }, 'Batch extraction cache lookup failed');
    return null;
  }
}

/**
 * Enqueue a reconciliation job when a refund failed after a successful debit.
 * This prevents a silent overcharge: the credit is reconciled out-of-band
 * instead of being lost in a swallowed `.catch`.
 */
async function enqueueRefundReconciliation(params: {
  orgId?: string;
  userId?: string;
  amount: number;
  reason: string;
  fingerprint?: string;
}): Promise<void> {
  try {
    const jobId = await submitJob({
      type: AI_CREDIT_RECONCILE_JOB_TYPE,
      payload: {
        orgId: params.orgId ?? null,
        userId: params.userId ?? null,
        amount: params.amount,
        reason: params.reason,
        fingerprint: params.fingerprint ?? null,
        source: 'ai-extract-batch',
      },
      priority: 5,
    });
    if (!jobId) {
      logger.error(
        { orgId: params.orgId, userId: params.userId, amount: params.amount },
        'Failed to enqueue AI credit reconciliation job — refund not applied',
      );
    }
  } catch (err) {
    // Last-resort: surface loudly. Do NOT swallow — a lost refund is an overcharge.
    logger.error(
      { error: err, orgId: params.orgId, userId: params.userId, amount: params.amount },
      'Exception enqueuing AI credit reconciliation job — refund not applied',
    );
  }
}

const router = Router();

router.post('/', async (req: Request, res: Response) => {
  const userId = req.authUserId;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  // Validate request body
  const parsed = BatchRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'validation_error',
      details: parsed.error.issues.map((i) => ({
        field: i.path.join('.'),
        message: i.message,
      })),
    });
    return;
  }

  const { rows } = parsed.data;
  const rowCount = rows.length;
  const batchStartMs = Date.now();

  try {
    // Get org_id from profile
    const { data: profile } = await db
      .from('profiles')
      .select('org_id')
      .eq('id', userId)
      .single();

    const orgId = profile?.org_id ?? undefined;

    // RISK-6: Up-front credit check. If the org is provably out of credits,
    // reject the whole batch with 402 (no work, no debit). This is the cheap
    // guard; the authoritative per-row debit below is what actually prevents a
    // free extraction when a row-level debit fails mid-batch.
    const creditBalance = await checkAICredits(orgId, userId);
    const hasFiniteCredits = creditBalance !== null;
    if (creditBalance && !creditBalance.hasCredits) {
      res.status(402).json({
        error: 'insufficient_credits',
        message: `AI extraction credits exhausted (${creditBalance.usedThisMonth}/${creditBalance.monthlyAllocation} used). Upgrade your plan.`,
        used: creditBalance.usedThisMonth,
        limit: creditBalance.monthlyAllocation,
      });
      return;
    }

    // Batch extract is typically pipeline/institutional data → route to Nessie
    const provider = createExtractionProvider('pipeline');
    let successCount = 0;
    let cachedCount = 0;
    let chargedCount = 0; // rows that ended the request with a net debit (success, not refunded)

    const results = await parallelMap<typeof rows[0], BatchResult>(
      rows,
      CONCURRENCY_LIMIT,
      async (row, i) => {
        const startMs = Date.now();

        // EFF-1: serve from the fingerprint cache before any debit / provider call.
        // A cache hit is free (already paid for on the original extraction) and
        // makes batch retries idempotent — they don't re-charge cached rows.
        const cached = await lookupCachedExtraction(row.fingerprint);
        if (cached) {
          successCount++;
          cachedCount++;
          logger.info(
            { fingerprint: row.fingerprint, userId, orgId, rowIndex: i },
            'Batch extraction cache hit — returning cached result',
          );
          return {
            index: i,
            success: true,
            fields: cached.fields,
            confidence: cached.confidence,
            provider: 'cache',
            cached: true,
          };
        }

        // RISK-6: per-item debit. Debit BEFORE the provider call so a failed
        // debit cannot grant a free extraction. When the org has a finite
        // credit balance and the debit returns falsy (transient DB error or
        // insufficient balance), abort this row — do NOT extract.
        const debited = await deductAICredits(orgId, userId, 1);
        if (!debited && hasFiniteCredits) {
          logger.warn(
            { orgId, userId, rowIndex: i },
            'Batch AI per-item credit debit failed — skipping row (no free extraction)',
          );
          logAIUsageEvent({
            orgId,
            userId,
            eventType: 'extraction',
            provider: 'unknown',
            success: false,
            errorMessage: 'credit_debit_failed',
            fingerprint: row.fingerprint,
          }).catch(() => {});
          return {
            index: i,
            success: false,
            error: 'insufficient_credits',
          };
        }
        // When credits are unmetered (beta: checkAICredits returned null), a
        // falsy debit is non-fatal — proceed without charging.
        const didDebit = debited === true;

        try {
          const result = await withRowLatencyBudget(
            provider.extractMetadata({
              strippedText: row.text.length > 10_000
                ? row.text.slice(0, 10_000) + '\n[TRUNCATED]'
                : row.text,
              credentialType: row.credentialType,
              fingerprint: row.fingerprint ?? '',
              issuerHint: row.issuerHint,
            }),
          );

          const durationMs = Date.now() - startMs;
          successCount++;
          if (didDebit) chargedCount++;

          // AI-EVAL-02 / NMT-03: provider-routed calibration (parity with single extraction).
          // Gemini maps UP, Nessie maps DOWN — routing by provider prevents double-calibration
          // of Nessie results (which already return in the calibrated range).
          const calibrated = calibrateConfidenceByProvider(result.provider, result.confidence);

          // Log usage event (non-blocking) — store calibrated confidence + result
          // for the fingerprint cache (EFF-1).
          logAIUsageEvent({
            orgId,
            userId,
            eventType: 'extraction',
            provider: result.provider,
            tokensUsed: result.tokensUsed,
            creditsConsumed: didDebit ? 1 : 0,
            fingerprint: row.fingerprint,
            confidence: calibrated,
            durationMs,
            success: true,
            promptVersion: getExtractionPromptVersion(),
            resultJson: result.fields as Record<string, unknown>,
          }).catch(() => {});

          return {
            index: i,
            success: true,
            fields: result.fields as Record<string, string>,
            confidence: calibrated,
            provider: result.provider,
          };
        } catch (err) {
          const internalMessage = err instanceof Error ? err.message : 'Unknown error';
          // CRIT-2: Log full error server-side, return generic message to client
          logger.warn({ error: err, rowIndex: i }, 'Batch extraction failed for row');

          // RISK-6: refund THIS row's credit (only if we actually debited it).
          // If the refund itself fails, do NOT swallow it — enqueue a
          // reconciliation job so the credit is recovered out-of-band.
          if (didDebit) {
            const refunded = await deductAICredits(orgId, userId, -1).catch((refundErr) => {
              logger.warn(
                { error: refundErr, orgId, userId, rowIndex: i },
                'Exception refunding credit for failed batch row',
              );
              return false;
            });
            if (!refunded) {
              await enqueueRefundReconciliation({
                orgId,
                userId,
                amount: 1,
                reason: 'batch_extraction_failed_refund_failed',
                fingerprint: row.fingerprint,
              });
            }
          }

          // Log failed usage event (non-blocking)
          logAIUsageEvent({
            orgId,
            userId,
            eventType: 'extraction',
            provider: 'unknown',
            success: false,
            errorMessage: internalMessage,
            fingerprint: row.fingerprint,
          }).catch(() => {});

          return {
            index: i,
            success: false,
            error: 'Extraction failed for this row',
          };
        }
      },
    );

    const failedCount = rowCount - successCount;
    const batchDurationMs = Date.now() - batchStartMs;
    const creditsRemaining: number | null = null; // Beta: unlimited

    // Structured observability log — batch extraction summary
    logger.info({
      event: 'ai.batch_extraction.complete',
      batchSize: rowCount,
      succeeded: successCount,
      failed: failedCount,
      cached: cachedCount,
      charged: chargedCount,
      concurrency: CONCURRENCY_LIMIT,
      durationMs: batchDurationMs,
      avgDurationPerRow: Math.round(batchDurationMs / rowCount),
      creditsRemaining,
      userId,
      orgId,
    }, `Batch extraction: ${successCount}/${rowCount} rows in ${batchDurationMs}ms (${cachedCount} cached, ${chargedCount} charged, ${CONCURRENCY_LIMIT} parallel)`);

    res.json({
      results,
      summary: {
        total: rowCount,
        succeeded: successCount,
        failed: failedCount,
        cached: cachedCount,
      },
      creditsRemaining,
    });
  } catch (err) {
    logger.error({ error: err, userId }, 'Batch AI extraction failed');
    res.status(500).json({
      error: 'batch_extraction_failed',
      message: 'Failed to process batch extraction',
    });
  }
});

export { router as aiBatchExtractRouter };
