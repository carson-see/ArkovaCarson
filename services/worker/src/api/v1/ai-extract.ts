/**
 * AI Extraction Endpoint (P8-S4)
 *
 * POST /api/v1/ai/extract — Extract structured credential metadata
 * from PII-stripped text using AI.
 *
 * Constitution 4A: Only PII-stripped metadata arrives at this endpoint.
 * Document bytes and raw OCR text never leave the client.
 *
 * Flow: client OCR → client PII strip → this endpoint → AI provider → response
 */

import { Router, Request, Response } from 'express';
import { ExtractionRequestSchema } from '../../ai/schemas.js';
import { createAIProvider } from '../../ai/factory.js';
import { checkAICredits, deductAICredits, logAIUsageEvent } from '../../ai/cost-tracker.js';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

const router = Router();

router.post('/', async (req: Request, res: Response) => {
  const userId = req.authUserId;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  // Validate request body
  const parsed = ExtractionRequestSchema.safeParse(req.body);
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

  const { strippedText, credentialType, fingerprint, issuerHint } = parsed.data;

  try {
    // Get org_id from profile
    const { data: profile } = await db
      .from('profiles')
      .select('org_id')
      .eq('id', userId)
      .single();

    const orgId = profile?.org_id ?? undefined;

    // Check AI credits — distinguish RPC errors from exhausted balance
    const credits = await checkAICredits(orgId, userId);
    if (!credits) {
      res.status(503).json({
        error: 'credits_unavailable',
        message: 'Unable to verify credit balance. Please try again.',
      });
      return;
    }
    if (!credits.hasCredits) {
      res.status(402).json({
        error: 'insufficient_credits',
        message: 'No AI credits remaining. Upgrade your plan for more credits.',
        credits: { monthlyAllocation: credits.monthlyAllocation, usedThisMonth: credits.usedThisMonth, remaining: 0 },
      });
      return;
    }

    // Call AI provider
    const startMs = Date.now();
    const provider = createAIProvider();
    const result = await provider.extractMetadata({
      strippedText,
      credentialType,
      fingerprint,
      issuerHint,
    });
    const durationMs = Date.now() - startMs;

    // Deduct credit
    const deducted = await deductAICredits(orgId, userId, 1);
    if (!deducted) {
      logger.warn({ orgId, userId }, 'Credit deduction failed after successful extraction');
    }

    // Log usage event (non-blocking)
    logAIUsageEvent({
      orgId,
      userId,
      eventType: 'extraction',
      provider: result.provider,
      tokensUsed: result.tokensUsed,
      creditsConsumed: 1,
      fingerprint,
      confidence: result.confidence,
      durationMs,
      success: true,
    }).catch(() => {
      // Swallow — logging should not fail the request
    });

    res.json({
      fields: result.fields,
      confidence: result.confidence,
      provider: result.provider,
      creditsRemaining: deducted ? Math.max(0, credits.remaining - 1) : credits.remaining,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    logger.error({ error: err, userId }, 'AI extraction failed');

    // Log failed usage event (non-blocking)
    logAIUsageEvent({
      userId,
      eventType: 'extraction',
      provider: 'unknown',
      success: false,
      errorMessage,
    }).catch(() => {});

    if (errorMessage.includes('circuit breaker')) {
      res.status(503).json({
        error: 'service_unavailable',
        message: 'AI service temporarily unavailable. Please try again later.',
      });
      return;
    }

    res.status(500).json({
      error: 'extraction_failed',
      message: 'Failed to extract credential metadata',
    });
  }
});

export { router as aiExtractRouter };
