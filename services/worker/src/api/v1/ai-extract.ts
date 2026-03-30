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
import { createExtractionProvider } from '../../ai/factory.js';
import { checkAICredits, deductAICredits, logAIUsageEvent } from '../../ai/cost-tracker.js';
import { getExtractionPromptVersion } from '../../ai/prompts/extraction.js';
import { calibrateConfidence } from '../../ai/eval/calibration.js';
import { buildExtractionManifest } from '../../ai/extraction-manifest.js';
import { GeminiProvider } from '../../ai/gemini.js';
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

    // EFF-1: Check for cached extraction result by fingerprint before calling AI.
    // Saves ~30% of extraction costs from re-uploads, shared documents, error retries.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: cachedResult } = await (db as any)
      .from('ai_usage_events')
      .select('result_json, confidence')
      .eq('fingerprint', fingerprint)
      .eq('event_type', 'extraction')
      .eq('success', true)
      .not('result_json', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1);

    if (cachedResult && cachedResult.length > 0 && cachedResult[0].result_json) {
      logger.info(
        { fingerprint, userId, orgId },
        'AI extraction cache hit — returning cached result',
      );
      res.json({
        fields: cachedResult[0].result_json,
        confidence: cachedResult[0].confidence ?? 0.5,
        provider: 'cache',
        cached: true,
        creditsRemaining: null,
      });
      return;
    }

    // RISK-6: Synchronous credit check and deduction.
    // Deduction is blocking — if it fails, return 402 Payment Required.
    // Beta mode: check_ai_credits returns unlimited via migration 0084 override.
    const creditBalance = await checkAICredits(orgId, userId);
    if (creditBalance && !creditBalance.hasCredits) {
      res.status(402).json({
        error: 'insufficient_credits',
        message: 'AI extraction credits exhausted. Upgrade your plan for more credits.',
        used: creditBalance.usedThisMonth,
        limit: creditBalance.monthlyAllocation,
      });
      return;
    }

    const deducted = await deductAICredits(orgId, userId, 1);
    if (!deducted && creditBalance) {
      // Deduction failed but credits existed — DB error, not insufficient balance
      logger.error({ orgId, userId }, 'AI credit deduction failed — proceeding with extraction');
    }

    // Call AI provider
    const startMs = Date.now();
    const provider = createExtractionProvider('user_upload');
    let result;
    try {
      result = await provider.extractMetadata({
        strippedText,
        credentialType,
        fingerprint,
        issuerHint,
      });
    } catch (extractionError) {
      // RISK-6: Synchronous refund on extraction failure
      const refunded = await deductAICredits(orgId, userId, -1);
      if (!refunded) {
        logger.warn({ orgId, userId }, 'Failed to refund AI credit after extraction failure');
      }
      throw extractionError;
    }
    const durationMs = Date.now() - startMs;

    // Apply confidence calibration (AI-EVAL-02): maps raw model confidence
    // to calibrated confidence that better reflects actual extraction accuracy.
    const rawConfidence = result.confidence;
    const calibrated = calibrateConfidence(rawConfidence);

    // Structured observability log — AI extraction latency + quality metrics
    logger.info({
      event: 'ai.extraction.complete',
      provider: result.provider,
      credentialType,
      rawConfidence,
      calibratedConfidence: calibrated,
      fieldsExtracted: Object.keys(result.fields).length,
      tokensUsed: result.tokensUsed ?? 0,
      durationMs,
      userId,
      orgId,
    }, `AI extraction: ${result.provider} ${durationMs}ms conf=${rawConfidence.toFixed(2)}→${calibrated.toFixed(2)} fields=${Object.keys(result.fields).length}`);

    // Log usage event with result cache (EFF-1: enables cache-by-fingerprint)
    // Store calibrated confidence in the cache for consistency
    const promptVersion = getExtractionPromptVersion();
    logAIUsageEvent({
      orgId,
      userId,
      eventType: 'extraction',
      provider: result.provider,
      tokensUsed: result.tokensUsed,
      creditsConsumed: 1,
      fingerprint,
      confidence: calibrated,
      durationMs,
      success: true,
      promptVersion,
      resultJson: result.fields as Record<string, unknown>,
    }).catch(() => {
      // Swallow — logging should not fail the request
    });

    // VAI-01: Build and store extraction manifest — cryptographic binding
    const manifest = buildExtractionManifest({
      fingerprint,
      modelId: result.provider,
      modelVersion: result.modelVersion ?? result.provider,
      extractedFields: result.fields,
      confidenceScores: {
        overall: calibrated,
      },
      promptVersion,
    });

    // Non-blocking DB insert — manifest is audit trail, should not fail extraction
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).from('extraction_manifests').insert({
      fingerprint: manifest.fingerprint,
      model_id: manifest.modelId,
      model_version: manifest.modelVersion,
      extracted_fields: manifest.extractedFields,
      confidence_scores: manifest.confidenceScores,
      manifest_hash: manifest.manifestHash,
      org_id: orgId ?? null,
      user_id: userId,
      extraction_timestamp: manifest.extractionTimestamp,
      prompt_version: manifest.promptVersion ?? null,
    }).then(({ error }: { error: unknown }) => {
      if (error) {
        logger.warn({ error, fingerprint }, 'Failed to store extraction manifest');
      }
    }).catch((err: unknown) => {
      logger.warn({ error: err, fingerprint }, 'Failed to store extraction manifest');
    });

    // Auto-generate tags in parallel (non-blocking — best-effort enrichment)
    let tags: string[] | undefined;
    let documentType: string | undefined;
    let category: string | undefined;
    try {
      const gemini = new GeminiProvider();
      const tagsResult = await gemini.generateTags(result.fields as Record<string, unknown>);
      tags = tagsResult.tags;
      documentType = tagsResult.documentType;
      category = tagsResult.category;
    } catch (tagErr) {
      // Tagging is best-effort — don't fail extraction
      logger.warn({ error: tagErr }, 'Auto-tagging failed (non-fatal)');
    }

    res.json({
      fields: result.fields,
      confidence: calibrated,
      provider: result.provider,
      creditsRemaining: creditBalance ? creditBalance.remaining - 1 : null,
      tags,
      documentType,
      category,
      manifestHash: manifest.manifestHash,
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
