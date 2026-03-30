/**
 * AI Semantic Search Endpoint (P8-S12)
 *
 * GET /api/v1/ai/search?q={query} — Search credentials using natural language.
 * Uses pgvector cosine similarity on credential_embeddings table.
 *
 * Gated behind ENABLE_SEMANTIC_SEARCH flag.
 * Credits deducted per search query.
 *
 * Constitution 4A: Only PII-stripped metadata is searched/returned.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { createEmbeddingProvider } from '../../ai/factory.js';
import { checkAICredits, deductAICredits, logAIUsageEvent } from '../../ai/cost-tracker.js';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { callRpc } from '../../utils/rpc.js';
import { monitorQuery } from '../../utils/queryMonitor.js';

const router = Router();

const SearchQuerySchema = z.object({
  q: z.string().min(1, 'Search query is required').max(500),
  threshold: z.coerce.number().min(0).max(1).default(0.7),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

/** GET /api/v1/ai/search — Semantic search across org's credentials */
router.get('/', async (req: Request, res: Response) => {
  const userId = req.authUserId;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const parsed = SearchQuerySchema.safeParse(req.query);
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

  const { q, threshold, limit } = parsed.data;

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

    // Check credits
    const credits = await checkAICredits(orgId, userId);
    if (!credits?.hasCredits) {
      res.status(402).json({
        error: 'insufficient_credits',
        message: 'No AI credits remaining for search.',
      });
      return;
    }

    // Generate embedding for the search query
    const startMs = Date.now();
    const provider = createEmbeddingProvider();
    const queryEmbedding = await provider.generateEmbedding(q, 'RETRIEVAL_QUERY');

    // QA-PERF-6: Monitor semantic search query performance
    const { data: matches, error: searchError } = await monitorQuery(
      'semantic-search',
      () => callRpc<Array<{ anchor_id: string; similarity: number }>>(
        db,
        'search_credential_embeddings',
        {
          p_org_id: orgId,
          p_query_embedding: queryEmbedding.embedding,
          p_match_threshold: threshold,
          p_match_count: limit,
        },
      ),
    );

    if (searchError) {
      logger.error({ error: searchError }, 'Semantic search RPC failed');
      res.status(500).json({ error: 'search_failed', message: 'Search query failed' });
      return;
    }

    const matchArray = (matches ?? []) as Array<{ anchor_id: string; similarity: number }>;
    const anchorIds = matchArray.map((m) => m.anchor_id);
    const similarityMap = new Map(
      matchArray.map((m) => [m.anchor_id, m.similarity]),
    );

    // Fetch anchor details for matched IDs
    let results: Array<Record<string, unknown>> = [];
    if (anchorIds.length > 0) {
      const { data: anchors, error: anchorsError } = await db
        .from('anchors')
        .select(
          'id, public_id, filename, credential_type, metadata, status, created_at',
        )
        .in('id', anchorIds)
        .eq('org_id', orgId);

      if (anchorsError) {
        logger.error({ error: anchorsError }, 'Failed to fetch anchor details for search results');
        res.status(500).json({ error: 'search_failed', message: 'Failed to fetch search results' });
        return;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      results = ((anchors ?? []) as any[]).map((a) => ({
        anchorId: a.id,
        publicId: a.public_id,
        fileName: a.filename,
        credentialType: a.credential_type,
        metadata: a.metadata,
        status: a.status,
        createdAt: a.created_at,
        similarity: similarityMap.get(a.id as string) ?? 0,
      }));

      // Sort by similarity descending
      results.sort(
        (a, b) => (b.similarity as number) - (a.similarity as number),
      );
    }

    const durationMs = Date.now() - startMs;

    // Deduct credit
    const deducted = await deductAICredits(orgId, userId, 1);

    // Log usage (non-blocking)
    logAIUsageEvent({
      orgId,
      userId,
      eventType: 'embedding',
      provider: provider.name,
      creditsConsumed: 1,
      durationMs,
      success: true,
    }).catch(() => {});

    res.json({
      query: q,
      results,
      count: results.length,
      threshold,
      creditsRemaining: deducted ? Math.max(0, (credits.remaining ?? 1) - 1) : credits.remaining ?? 0,
    });
  } catch (err) {
    logger.error({ error: err, userId }, 'Semantic search failed');
    res.status(500).json({ error: 'search_failed', message: 'Internal error' });
  }
});

export { router as aiSearchRouter };
