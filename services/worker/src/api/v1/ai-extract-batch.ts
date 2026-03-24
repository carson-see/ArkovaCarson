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
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { createAIProvider } from '../../ai/factory.js';
import { checkAICredits, deductAICredits, logAIUsageEvent } from '../../ai/cost-tracker.js';
import { getExtractionPromptVersion } from '../../ai/prompts/extraction.js';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

const MAX_BATCH_SIZE = 50;
// EFF-4: Configurable concurrency — Gemini Flash handles 5-10 concurrent requests well.
const CONCURRENCY_LIMIT = Math.min(
  Math.max(1, parseInt(process.env.AI_BATCH_CONCURRENCY ?? '3', 10) || 3),
  20, // hard cap
);

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

    // RISK-6: Synchronous credit check and deduction for batch operations.
    const creditBalance = await checkAICredits(orgId, userId);
    if (creditBalance && !creditBalance.hasCredits) {
      res.status(402).json({
        error: 'insufficient_credits',
        message: `AI extraction credits exhausted (${creditBalance.usedThisMonth}/${creditBalance.monthlyAllocation} used). Upgrade your plan.`,
        used: creditBalance.usedThisMonth,
        limit: creditBalance.monthlyAllocation,
      });
      return;
    }

    const deducted = await deductAICredits(orgId, userId, rowCount);
    if (!deducted && creditBalance) {
      logger.error({ orgId, userId, rowCount }, 'Batch AI credit deduction failed — proceeding');
    }

    // Process rows with concurrency limit (3 parallel to avoid flooding Gemini)
    const provider = createAIProvider();
    let successCount = 0;

    const results = await parallelMap<typeof rows[0], BatchResult>(
      rows,
      CONCURRENCY_LIMIT,
      async (row, i) => {
        const startMs = Date.now();

        try {
          const result = await provider.extractMetadata({
            strippedText: row.text.length > 10_000
              ? row.text.slice(0, 10_000) + '\n[TRUNCATED]'
              : row.text,
            credentialType: row.credentialType,
            fingerprint: row.fingerprint ?? '',
            issuerHint: row.issuerHint,
          });

          const durationMs = Date.now() - startMs;
          successCount++;

          // Log usage event (non-blocking)
          logAIUsageEvent({
            orgId,
            userId,
            eventType: 'extraction',
            provider: result.provider,
            tokensUsed: result.tokensUsed,
            creditsConsumed: 1,
            fingerprint: row.fingerprint,
            confidence: result.confidence,
            durationMs,
            success: true,
            promptVersion: getExtractionPromptVersion(),
          }).catch(() => {});

          return {
            index: i,
            success: true,
            fields: result.fields as Record<string, string>,
            confidence: result.confidence,
            provider: result.provider,
          };
        } catch (err) {
          const internalMessage = err instanceof Error ? err.message : 'Unknown error';
          // CRIT-2: Log full error server-side, return generic message to client
          logger.warn({ error: err, rowIndex: i }, 'Batch extraction failed for row');

          // Log failed usage event (non-blocking)
          logAIUsageEvent({
            orgId,
            userId,
            eventType: 'extraction',
            provider: 'unknown',
            success: false,
            errorMessage: internalMessage,
          }).catch(() => {});

          return {
            index: i,
            success: false,
            error: 'Extraction failed for this row',
          };
        }
      },
    );

    // Refund credits for failed extractions (best-effort)
    const failedCount = rowCount - successCount;
    if (failedCount > 0) {
      await deductAICredits(orgId, userId, -failedCount).catch((refundErr) => {
        logger.warn({ error: refundErr, failedCount }, 'Failed to refund credits for failed batch extractions');
      });
    }

    const batchDurationMs = Date.now() - batchStartMs;
    const creditsRemaining = null; // Beta: unlimited

    // Structured observability log — batch extraction summary
    logger.info({
      event: 'ai.batch_extraction.complete',
      batchSize: rowCount,
      succeeded: successCount,
      failed: failedCount,
      concurrency: CONCURRENCY_LIMIT,
      durationMs: batchDurationMs,
      avgDurationPerRow: Math.round(batchDurationMs / rowCount),
      creditsRemaining,
      userId,
      orgId,
    }, `Batch extraction: ${successCount}/${rowCount} rows in ${batchDurationMs}ms (${CONCURRENCY_LIMIT} parallel)`);

    res.json({
      results,
      summary: {
        total: rowCount,
        succeeded: successCount,
        failed: failedCount,
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
