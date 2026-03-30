/**
 * AI Template Reconstruction & Tagging Endpoint
 *
 * POST /api/v1/ai/template — Reconstruct a structured template from extracted fields
 * POST /api/v1/ai/tags — Generate tags and classification from extracted fields
 *
 * These endpoints take already-extracted metadata and produce:
 * - Template: structured document reconstruction with sections, summary, verification notes
 * - Tags: categorical tags, document type label, category/subcategory classification
 *
 * Designed to run AFTER extraction — takes extraction output as input.
 * Constitution 4A: Only metadata (no PII, no document bytes).
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { GeminiProvider } from '../../ai/gemini.js';
import { logger } from '../../utils/logger.js';

const router = Router();

// ─── Schemas ───

const TemplateRequestSchema = z.object({
  fields: z.record(z.unknown()),
  confidence: z.number().min(0).max(1),
});

const TagsRequestSchema = z.object({
  fields: z.record(z.unknown()),
});

// ─── POST /template — Full template reconstruction ───

router.post('/template', async (req: Request, res: Response) => {
  const userId = req.authUserId;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const parsed = TemplateRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'validation_error',
      details: parsed.error.issues.map(i => ({
        field: i.path.join('.'),
        message: i.message,
      })),
    });
    return;
  }

  try {
    const provider = new GeminiProvider();
    const startMs = Date.now();

    const result = await provider.reconstructTemplate(
      parsed.data.fields,
      parsed.data.confidence,
    );

    const durationMs = Date.now() - startMs;
    logger.info({
      event: 'ai.template.complete',
      durationMs,
      templateType: result.templateType,
      tagCount: result.tags.length,
      sectionCount: result.sections.length,
      tokensUsed: result.tokensUsed ?? 0,
      userId,
    }, `AI template reconstruction: ${durationMs}ms type=${result.templateType}`);

    res.json(result);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    logger.error({ error: err, userId }, 'AI template reconstruction failed');

    if (errorMessage.includes('circuit breaker')) {
      res.status(503).json({
        error: 'service_unavailable',
        message: 'AI service temporarily unavailable.',
      });
      return;
    }

    res.status(500).json({
      error: 'template_failed',
      message: 'Failed to reconstruct credential template',
    });
  }
});

// ─── POST /tags — Lightweight tagging ───

router.post('/tags', async (req: Request, res: Response) => {
  const userId = req.authUserId;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const parsed = TagsRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'validation_error',
      details: parsed.error.issues.map(i => ({
        field: i.path.join('.'),
        message: i.message,
      })),
    });
    return;
  }

  try {
    const provider = new GeminiProvider();
    const startMs = Date.now();

    const result = await provider.generateTags(parsed.data.fields);

    const durationMs = Date.now() - startMs;
    logger.info({
      event: 'ai.tags.complete',
      durationMs,
      tagCount: result.tags.length,
      category: result.category,
      userId,
    }, `AI tagging: ${durationMs}ms tags=${result.tags.length}`);

    res.json(result);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    logger.error({ error: err, userId }, 'AI tagging failed');

    if (errorMessage.includes('circuit breaker')) {
      res.status(503).json({
        error: 'service_unavailable',
        message: 'AI service temporarily unavailable.',
      });
      return;
    }

    res.status(500).json({
      error: 'tagging_failed',
      message: 'Failed to generate credential tags',
    });
  }
});

export { router as aiTemplateRouter };
