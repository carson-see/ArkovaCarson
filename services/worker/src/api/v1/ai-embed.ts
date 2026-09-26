/**
 * AI Embedding Endpoint (P8-S11)
 *
 * POST /api/v1/ai/embed — Generate embedding for a credential.
 * POST /api/v1/ai/embed/batch — Re-embed multiple credentials.
 *
 * Constitution 4A: Only PII-stripped metadata is processed.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { createEmbeddingProvider } from '../../ai/factory.js';
import {
  generateAndStoreEmbedding,
  batchReEmbed,
  type BatchReEmbedResult,
  type EmbeddingFailureCode,
} from '../../ai/embeddings.js';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

const router = Router();

/**
 * B1 (SCRUM-4939 follow-up) — the HTTP status of a credit failure.
 *
 * This route used to pick the status by asking whether the failure MESSAGE
 * contained the substring "credit":
 *
 *     const status = result.error?.includes('credit') ? 402 : 500;
 *     error: result.error?.includes('credit') ? 'insufficient_credits' : …
 *
 * Every credit failure in `ai/embeddings.ts` says "credit", so the 55P03 lock
 * timeout `deduct_ai_credits` raises under contention (migration 0483) and a
 * flat RPC outage both answered `402 insufficient_credits` — telling a customer
 * who HAS credits to go buy more, for a failure that is ours and retryable.
 *
 * The reasoning is the one already written into `ai-extract.ts`: "503, not 402:
 * `insufficient_credits` would tell the caller to buy more when
 * `checkAICredits` just reported that they have some. The failure is ours and
 * it is retryable." The result now carries a typed `code`; the substring test
 * is gone, and only genuine exhaustion can reach a 402.
 */
const CREDIT_INFRASTRUCTURE_CODES: ReadonlySet<EmbeddingFailureCode> = new Set([
  'credit_check_unavailable',
  'credit_debit_unavailable',
]);

/**
 * Matches `refund_ai_credits` / `deduct_ai_credits`'s own 5 s `lock_timeout`:
 * the contended holder is gone by then, so retrying sooner just re-queues
 * behind the same lock.
 */
const CREDIT_RETRY_AFTER_SECONDS = 5;

/** 503 + `Retry-After` for a credit failure that is ours, never the caller's. */
function respondCreditSystemUnavailable(res: Response, what: string): void {
  res.setHeader('Retry-After', String(CREDIT_RETRY_AFTER_SECONDS));
  res.status(503).json({
    error: 'credit_system_unavailable',
    message: `Credit accounting could not be confirmed. ${what} Please try again later.`,
  });
}

/**
 * The code shared by EVERY failed row of a wholly-failed batch, or null when
 * the batch partly succeeded or the rows disagree. A partial failure stays a
 * 200 with per-row detail: there is no single status that describes it.
 */
function wholeBatchFailureCode(result: BatchReEmbedResult): EmbeddingFailureCode | null {
  if (result.total === 0 || result.failed !== result.total || result.errors.length === 0) {
    return null;
  }
  const first = result.errors[0].code;
  return result.errors.every((e) => e.code === first) ? first : null;
}

const EmbedRequestSchema = z.object({
  anchorId: z.string().uuid('Invalid anchor ID'),
  metadata: z
    .object({
      credentialType: z.string().optional(),
      issuerName: z.string().optional(),
      fieldOfStudy: z.string().optional(),
      degreeLevel: z.string().optional(),
      issuedDate: z.string().optional(),
      expiryDate: z.string().optional(),
      jurisdiction: z.string().optional(),
    }),
});

const BatchEmbedRequestSchema = z.object({
  anchorIds: z.array(z.string().uuid()).min(1).max(100),
});

/** POST /api/v1/ai/embed — Generate embedding for a single credential */
router.post('/', async (req: Request, res: Response) => {
  const userId = req.authUserId;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const parsed = EmbedRequestSchema.safeParse(req.body);
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

  try {
    // Get org_id from profile
    const { data: profile } = await db
      .from('profiles')
      .select('org_id')
      .eq('id', userId)
      .single();

    const orgId = profile?.org_id;
    if (!orgId) {
      res.status(403).json({ error: 'Organization membership required' });
      return;
    }

    const provider = createEmbeddingProvider();
    const result = await generateAndStoreEmbedding(provider, {
      anchorId: parsed.data.anchorId,
      orgId,
      metadata: parsed.data.metadata as Record<string, string | undefined>,
      userId,
    });

    if (!result.success) {
      if (CREDIT_INFRASTRUCTURE_CODES.has(result.code)) {
        logger.error(
          { userId, orgId, anchorId: parsed.data.anchorId, code: result.code },
          'AI credit system unavailable during embedding — no embedding kept, nothing charged',
        );
        respondCreditSystemUnavailable(res, 'No embedding was kept.');
        return;
      }
      if (result.code === 'insufficient_credits') {
        res.status(402).json({ error: 'insufficient_credits', message: result.error });
        return;
      }
      res.status(500).json({ error: 'embedding_failed', message: result.error });
      return;
    }

    res.json({ success: true, model: result.model });
  } catch (err) {
    logger.error({ error: err, userId }, 'Embedding endpoint failed');
    res.status(500).json({ error: 'embedding_failed', message: 'Internal error' });
  }
});

/** POST /api/v1/ai/embed/batch — Re-embed multiple credentials */
router.post('/batch', async (req: Request, res: Response) => {
  const userId = req.authUserId;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const parsed = BatchEmbedRequestSchema.safeParse(req.body);
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

  try {
    const { data: profile } = await db
      .from('profiles')
      .select('org_id')
      .eq('id', userId)
      .single();

    const orgId = profile?.org_id;
    if (!orgId) {
      res.status(403).json({ error: 'Organization membership required' });
      return;
    }

    // Fetch anchor metadata for each ID
    const { data: anchors, error: fetchError } = await db
      .from('anchors')
      .select('id, metadata, credential_type')
      .in('id', parsed.data.anchorIds)
      .eq('org_id', orgId);

    if (fetchError || !anchors) {
      res.status(500).json({ error: 'Failed to fetch anchors' });
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items = (anchors as any[]).map((a) => ({
      anchorId: a.id as string,
      metadata: {
        credentialType: (a.credential_type as string) ?? undefined,
        ...(a.metadata as Record<string, string> | undefined),
      },
    }));

    const provider = createEmbeddingProvider();
    const result = await batchReEmbed(provider, orgId, items, userId);

    // Same classification as the single route. A batch that failed ENTIRELY
    // for one credit reason has a single honest status; a partial failure does
    // not, and stays a 200 carrying the per-row codes.
    const batchCode = wholeBatchFailureCode(result);
    if (batchCode && CREDIT_INFRASTRUCTURE_CODES.has(batchCode)) {
      logger.error(
        { userId, orgId, count: items.length, code: batchCode },
        'AI credit system unavailable during batch embedding — no embeddings kept, nothing charged',
      );
      respondCreditSystemUnavailable(res, 'No embeddings were kept.');
      return;
    }
    if (batchCode === 'insufficient_credits') {
      res.status(402).json({
        error: 'insufficient_credits',
        message: result.errors[0].error,
        ...result,
      });
      return;
    }

    res.json(result);
  } catch (err) {
    logger.error({ error: err, userId }, 'Batch embed endpoint failed');
    res.status(500).json({ error: 'batch_embed_failed', message: 'Internal error' });
  }
});

export { router as aiEmbedRouter };
