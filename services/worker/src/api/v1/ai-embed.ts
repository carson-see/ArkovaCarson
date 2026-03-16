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
import { createAIProvider } from '../../ai/factory.js';
import { generateAndStoreEmbedding, batchReEmbed } from '../../ai/embeddings.js';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

const router = Router();

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

    const provider = createAIProvider();
    const result = await generateAndStoreEmbedding(provider, {
      anchorId: parsed.data.anchorId,
      orgId,
      metadata: parsed.data.metadata as Record<string, string | undefined>,
      userId,
    });

    if (!result.success) {
      const status = result.error?.includes('credit') ? 402 : 500;
      res.status(status).json({
        error: result.error?.includes('credit') ? 'insufficient_credits' : 'embedding_failed',
        message: result.error,
      });
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

    const provider = createAIProvider();
    const result = await batchReEmbed(provider, orgId, items, userId);

    res.json(result);
  } catch (err) {
    logger.error({ error: err, userId }, 'Batch embed endpoint failed');
    res.status(500).json({ error: 'batch_embed_failed', message: 'Internal error' });
  }
});

export { router as aiEmbedRouter };
