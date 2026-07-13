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
/**
 * Cumulative budget across EVERY string in the payload — blocks documents
 * chunked across many individually-small keys.
 */
const MAX_TOTAL_STRING_LENGTH = 50_000;
/** Extracted metadata is shallow; anything deeper is smuggling or abuse. */
const MAX_FIELD_DEPTH = 8;
/** Extracted-metadata key names are short identifiers, never content. */
const MAX_FIELD_KEY_LENGTH = 256;
/**
 * A long run of pure base64/base64url alphabet with no whitespace is a
 * document chunk, not extracted metadata (real field values contain spaces
 * and punctuation long before this length).
 */
const BASE64_SHAPED_VALUE = /^[A-Za-z0-9+/_-]{512,}={0,2}$/;

interface PayloadWalkState {
  totalStringLength: number;
}

/** Never echo VALUES — issues carry key paths and bounded messages only. */
function addPayloadIssue(ctx: z.RefinementCtx, path: Array<string | number>, message: string): void {
  ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
}

function checkStringValue(
  value: string,
  path: Array<string | number>,
  state: PayloadWalkState,
  ctx: z.RefinementCtx,
): void {
  state.totalStringLength += value.length;
  if (value.length > MAX_FIELD_VALUE_LENGTH) {
    addPayloadIssue(ctx, path, `Field value exceeds ${MAX_FIELD_VALUE_LENGTH} characters.`);
  } else if (value.startsWith('data:')) {
    addPayloadIssue(ctx, path, 'data: URIs are not accepted on this endpoint.');
  } else if (BASE64_SHAPED_VALUE.test(value)) {
    addPayloadIssue(ctx, path, 'Base64-shaped values are not accepted on this endpoint.');
  }
}

function walkPayload(
  value: unknown,
  path: Array<string | number>,
  depth: number,
  state: PayloadWalkState,
  ctx: z.RefinementCtx,
): void {
  if (depth > MAX_FIELD_DEPTH) {
    addPayloadIssue(ctx, path, `Fields are nested deeper than ${MAX_FIELD_DEPTH} levels.`);
    return;
  }
  if (typeof value === 'string') {
    checkStringValue(value, path, state, ctx);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkPayload(item, [...path, index], depth + 1, state, ctx));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      // Key NAMES are strings too — count them against the cumulative budget
      // and bound them so a document cannot be smuggled inside the keys.
      state.totalStringLength += key.length;
      if (key.length > MAX_FIELD_KEY_LENGTH) {
        addPayloadIssue(ctx, path, `Field keys are limited to ${MAX_FIELD_KEY_LENGTH} characters.`);
        continue;
      }
      if (BANNED_FIELD_KEY.test(key)) {
        // Report the offending KEY only — never echo (or descend into) the value.
        addPayloadIssue(ctx, [...path, key], 'Document-byte-shaped field keys are not accepted on this endpoint.');
        continue;
      }
      walkPayload(child, [...path, key], depth + 1, state, ctx);
    }
  }
}

/**
 * Reject fields records that look like document-byte smuggling — RECURSIVELY
 * (Carson P1, round-1 review): banned keys, data: URIs, base64-shaped and
 * oversized strings at ANY depth, plus a cumulative string budget so a
 * document cannot be chunked across many small keys.
 */
function assertNoDocumentPayload(
  fields: Record<string, unknown>,
  ctx: z.RefinementCtx,
): void {
  const state: PayloadWalkState = { totalStringLength: 0 };
  walkPayload(fields, ['fields'], 0, state, ctx);
  if (state.totalStringLength > MAX_TOTAL_STRING_LENGTH) {
    addPayloadIssue(
      ctx,
      ['fields'],
      `Combined field text exceeds ${MAX_TOTAL_STRING_LENGTH} characters.`,
    );
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

// ─── Shared route plumbing (auth → validate → invoke → log → respond) ───

interface AiRouteSpec<TRequest, TResult> {
  schema: z.ZodType<TRequest>;
  invoke: (provider: GeminiProvider, data: TRequest) => Promise<TResult>;
  /** Bounded, value-free telemetry payload (AI-03 value-omission lock-in). */
  successLog: (result: TResult, durationMs: number) => { event: string; message: string; fields: Record<string, unknown> };
  failureEvent: string;
  failureMessage: string;
  failureCode: string;
  failureBody: string;
}

function aiRouteHandler<TRequest, TResult>(spec: AiRouteSpec<TRequest, TResult>) {
  return async (req: Request, res: Response): Promise<void> => {
    const userId = req.authUserId;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const parsed = spec.schema.safeParse(req.body);
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
      const result = await spec.invoke(provider, parsed.data);
      const durationMs = Date.now() - startMs;

      const { event, message, fields } = spec.successLog(result, durationMs);
      logger.info({ event, durationMs, ...fields, userId }, message);

      res.json(result);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      // AI-03 value-omission lock-in: never log the error object or message —
      // a provider error can echo request field values. Bounded error NAME only.
      logger.error(
        { event: spec.failureEvent, errorName: err instanceof Error ? err.name : 'UnknownError', userId },
        spec.failureMessage,
      );

      if (errorMessage.includes('circuit breaker')) {
        res.status(503).json({
          error: 'service_unavailable',
          message: 'AI service temporarily unavailable.',
        });
        return;
      }

      res.status(500).json({ error: spec.failureCode, message: spec.failureBody });
    }
  };
}

// ─── POST /template — Full template reconstruction ───

router.post('/template', aiRouteHandler({
  schema: TemplateRequestSchema,
  invoke: (provider, data) => provider.reconstructTemplate(data.fields, data.confidence),
  successLog: (result, durationMs) => ({
    event: 'ai.template.complete',
    message: `AI template reconstruction: ${durationMs}ms type=${result.templateType}`,
    fields: {
      templateType: result.templateType,
      tagCount: result.tags.length,
      sectionCount: result.sections.length,
      tokensUsed: result.tokensUsed ?? 0,
    },
  }),
  failureEvent: 'ai.template.failed',
  failureMessage: 'AI template reconstruction failed',
  failureCode: 'template_failed',
  failureBody: 'Failed to reconstruct credential template',
}));

// ─── POST /tags — Lightweight tagging ───

router.post('/tags', aiRouteHandler({
  schema: TagsRequestSchema,
  invoke: (provider, data) => provider.generateTags(data.fields),
  successLog: (result, durationMs) => ({
    event: 'ai.tags.complete',
    message: `AI tagging: ${durationMs}ms tags=${result.tags.length}`,
    fields: {
      tagCount: result.tags.length,
      category: result.category,
    },
  }),
  failureEvent: 'ai.tags.failed',
  failureMessage: 'AI tagging failed',
  failureCode: 'tagging_failed',
  failureBody: 'Failed to generate credential tags',
}));

export { router as aiTemplateRouter };
