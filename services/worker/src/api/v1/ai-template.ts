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

/**
 * AI-03 lock-in (SCRUM-2383): this endpoint accepts ONLY already-extracted,
 * PII-stripped metadata fields + confidence. It must never accept document
 * bytes — structurally (no bytes/base64/document keys in the shape, asserted
 * by ai-template.contract.test.ts) or smuggled inside `fields` (guarded below).
 */
const BANNED_FIELD_KEY = /bytes|base64|blob|dataurl|data_uri|datauri|rawdocument|raw_document|filedata|file_data|filecontent|file_content|documentcontent|document_content/i;
const MAX_FIELD_VALUE_LENGTH = 20_000;

/** Reject fields records that look like document-byte smuggling. */
function assertNoDocumentPayload(
  fields: Record<string, unknown>,
  ctx: z.RefinementCtx,
): void {
  for (const [key, value] of Object.entries(fields)) {
    if (BANNED_FIELD_KEY.test(key)) {
      // Report the offending KEY only — never echo the value.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fields', key],
        message: 'Document-byte-shaped field keys are not accepted on this endpoint.',
      });
      continue;
    }
    if (typeof value === 'string') {
      if (value.length > MAX_FIELD_VALUE_LENGTH) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['fields', key],
          message: `Field value exceeds ${MAX_FIELD_VALUE_LENGTH} characters.`,
        });
      } else if (value.startsWith('data:')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['fields', key],
          message: 'data: URIs are not accepted on this endpoint.',
        });
      }
    }
  }
}

export const TemplateRequestSchema = z
  .object({
    fields: z.record(z.string(), z.unknown()),
    confidence: z.number().min(0).max(1),
  })
  .superRefine((value, ctx) => assertNoDocumentPayload(value.fields, ctx));

export const TagsRequestSchema = z
  .object({
    fields: z.record(z.string(), z.unknown()),
  })
  .superRefine((value, ctx) => assertNoDocumentPayload(value.fields, ctx));

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
    // AI-03 value-omission lock-in: never log the error object or message —
    // a provider error can echo request field values. Bounded error NAME only.
    logger.error(
      { event: 'ai.template.failed', errorName: err instanceof Error ? err.name : 'UnknownError', userId },
      'AI template reconstruction failed',
    );

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
    // AI-03 value-omission lock-in: bounded error NAME only (see /template).
    logger.error(
      { event: 'ai.tags.failed', errorName: err instanceof Error ? err.name : 'UnknownError', userId },
      'AI tagging failed',
    );

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
