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
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { createAIProvider } from '../../ai/factory.js';
import { checkAICredits, deductAICredits, logAIUsageEvent } from '../../ai/cost-tracker.js';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

const MAX_BATCH_SIZE = 50;

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

  try {
    // Get org_id from profile
    const { data: profile } = await db
      .from('profiles')
      .select('org_id')
      .eq('id', userId)
      .single();

    const orgId = profile?.org_id ?? undefined;

    // Check AI credits — need enough for all rows
    const credits = await checkAICredits(orgId, userId);
    if (!credits) {
      res.status(503).json({
        error: 'credits_unavailable',
        message: 'Unable to verify credit balance. Please try again.',
      });
      return;
    }
    if (credits.remaining < rowCount) {
      res.status(402).json({
        error: 'insufficient_credits',
        message: `Need ${rowCount} credits but only ${credits.remaining} remaining.`,
        credits: {
          monthlyAllocation: credits.monthlyAllocation,
          usedThisMonth: credits.usedThisMonth,
          remaining: credits.remaining,
          needed: rowCount,
        },
      });
      return;
    }

    // Deduct credits upfront for the whole batch
    const deducted = await deductAICredits(orgId, userId, rowCount);
    if (!deducted) {
      res.status(402).json({
        error: 'insufficient_credits',
        message: 'Credit deduction failed. Please try again.',
      });
      return;
    }

    // Process rows sequentially (to avoid flooding AI provider)
    const provider = createAIProvider();
    const results: BatchResult[] = [];
    let successCount = 0;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
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

        results.push({
          index: i,
          success: true,
          fields: result.fields as Record<string, string>,
          confidence: result.confidence,
          provider: result.provider,
        });

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
        }).catch(() => {});
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Unknown error';
        logger.warn({ error: err, rowIndex: i }, 'Batch extraction failed for row');

        results.push({
          index: i,
          success: false,
          error: errorMessage,
        });

        // Log failed usage event (non-blocking)
        logAIUsageEvent({
          orgId,
          userId,
          eventType: 'extraction',
          provider: 'unknown',
          success: false,
          errorMessage,
        }).catch(() => {});
      }
    }

    // Refund credits for failed extractions (best-effort)
    const failedCount = rowCount - successCount;
    if (failedCount > 0) {
      await deductAICredits(orgId, userId, -failedCount).catch((refundErr) => {
        logger.warn({ error: refundErr, failedCount }, 'Failed to refund credits for failed batch extractions');
      });
    }

    const creditsRemaining = Math.max(0, credits.remaining - successCount);

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
