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

    // Beta: credit checks disabled — all users get unlimited AI extraction
    // TODO: Re-enable credit checks post-beta launch
    void checkAICredits(orgId, userId); // Track usage for analytics only
    void deductAICredits(orgId, userId, 1).catch(() => { /* non-blocking in beta */ });

    // Call AI provider
    const startMs = Date.now();
    const provider = createAIProvider();
    let result;
    try {
      result = await provider.extractMetadata({
        strippedText,
        credentialType,
        fingerprint,
        issuerHint,
      });
    } catch (extractionError) {
      // Refund the credit on extraction failure (best-effort)
      await deductAICredits(orgId, userId, -1).catch((refundErr) => {
        logger.warn({ error: refundErr, orgId, userId }, 'Failed to refund AI credit after extraction failure');
      });
      throw extractionError;
    }
    const durationMs = Date.now() - startMs;

    // Structured observability log — AI extraction latency + quality metrics
    logger.info({
      event: 'ai.extraction.complete',
      provider: result.provider,
      credentialType,
      confidence: result.confidence,
      fieldsExtracted: Object.keys(result.fields).length,
      tokensUsed: result.tokensUsed ?? 0,
      durationMs,
      userId,
      orgId,
    }, `AI extraction: ${result.provider} ${durationMs}ms conf=${result.confidence} fields=${Object.keys(result.fields).length}`);

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
      creditsRemaining: null, // Beta: unlimited
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
