/**
 * Visual Fraud Detection API Endpoint (Phase 5)
 *
 * POST /api/v1/ai/fraud/visual
 *
 * Accepts a PII-stripped document image and returns visual fraud analysis.
 * Uses Gemini 2.0 Flash vision to detect tampering indicators.
 *
 * Constitution 4A: Only PII-stripped images should be sent.
 * The client is responsible for stripping PII before upload.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { analyzeDocumentImage } from '../../ai/visualFraudDetector.js';
import { logger } from '../../utils/logger.js';

const router = Router();

const VisualFraudRequestSchema = z.object({
  /** Base64-encoded document image (PII-stripped) */
  imageBase64: z.string().min(100).max(10_000_000), // ~7.5MB max
  /** Image MIME type */
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  /** Credential type for context-aware analysis */
  credentialType: z.string().min(1).max(50),
});

/**
 * POST /api/v1/ai/fraud/visual
 *
 * Analyze a document image for visual fraud indicators.
 *
 * Request body:
 * - imageBase64: Base64-encoded image (max ~7.5MB)
 * - mimeType: image/png, image/jpeg, image/webp, image/gif
 * - credentialType: Type of credential (DEGREE, LICENSE, etc.)
 *
 * Response:
 * - riskLevel: LOW | MEDIUM | HIGH | CRITICAL
 * - riskScore: 0-100
 * - signals: Array of detected fraud signals
 * - summary: Human-readable summary
 * - recommendations: Array of action items
 */
router.post('/', async (req: Request, res: Response) => {
  const parsed = VisualFraudRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'Invalid request',
      details: parsed.error.issues.map((i) => i.message),
    });
    return;
  }

  const { imageBase64, mimeType, credentialType } = parsed.data;

  try {
    const result = await analyzeDocumentImage(
      imageBase64,
      mimeType,
      credentialType,
    );

    res.json({
      riskLevel: result.riskLevel,
      riskScore: result.riskScore,
      signals: result.signals,
      summary: result.summary,
      recommendations: result.recommendations,
      model: result.model,
      processingTimeMs: result.processingTimeMs,
    });
  } catch (err) {
    logger.error({ error: err, credentialType }, 'Visual fraud analysis endpoint failed');
    res.status(500).json({
      error: 'Visual fraud analysis failed',
      message: err instanceof Error ? err.message : 'Internal error',
    });
  }
});

export { router as aiFraudVisualRouter };
