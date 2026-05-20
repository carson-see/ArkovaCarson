/**
 * Visual Fraud Detection API Endpoint (Phase 5)
 *
 * POST /api/v1/ai/fraud/visual
 *
 * Deprecated server-side visual fraud endpoint.
 *
 * Constitution 4A: document/image bytes must never be sent server-side for
 * fraud detection. SCRUM-1955 replaces this with a client-side Web Worker
 * that returns only structured findings.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';

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
 * This route intentionally fails closed. Keeping validation first preserves
 * existing client error behavior for malformed requests, but valid image
 * payloads are never forwarded to Gemini or any other server-side model.
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

  res.status(410).json({
    error: 'server_side_visual_fraud_disabled',
    message: 'Visual fraud detection must run in the client-side worker. Server-side image analysis is disabled by Constitution 4A.',
    requiredArchitecture: 'client_side_worker_v2',
  });
});

export { router as aiFraudVisualRouter };
