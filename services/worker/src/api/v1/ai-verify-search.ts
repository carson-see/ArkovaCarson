/**
 * Agentic Verification Search Endpoint (P8-S19)
 *
 * GET /api/v1/verify/search?q={query} — Search-based verification for AI agents.
 * Combines semantic search with frozen verification schema results.
 *
 * Designed for ATS systems, background check integrations, and AI agents
 * that need natural language credential lookup rather than exact IDs.
 *
 * Gated behind both ENABLE_SEMANTIC_SEARCH and ENABLE_VERIFICATION_API.
 * API key required (no anonymous access). Credits deducted per search.
 *
 * Constitution 4A: Only public credential data is returned (no org-private data).
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { createAIProvider } from '../../ai/factory.js';
import { checkAICredits, deductAICredits, logAIUsageEvent } from '../../ai/cost-tracker.js';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

const router = Router();

const VerifySearchSchema = z.object({
  q: z.string().min(1, 'Search query is required').max(500),
  threshold: z.coerce.number().min(0).max(1).default(0.75),
  limit: z.coerce.number().int().min(1).max(20).default(5),
});

/** GET /api/v1/verify/search — Semantic verification search */
router.get('/', async (req: Request, res: Response) => {
  // Require API key (not anonymous)
  if (!req.apiKey) {
    res.status(401).json({
      error: 'api_key_required',
      message: 'API key authentication required for verification search',
    });
    return;
  }

  const parsed = VerifySearchSchema.safeParse(req.query);
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
    // Check credits for the API key's org
    const keyOrgId = req.apiKey.orgId;
    const credits = keyOrgId ? await checkAICredits(keyOrgId) : null;
    if (credits && !credits.hasCredits) {
      res.status(402).json({
        error: 'insufficient_credits',
        message: 'No AI credits remaining.',
      });
      return;
    }

    // Generate query embedding
    const startMs = Date.now();
    const provider = createAIProvider();
    const queryEmbedding = await provider.generateEmbedding(q);

    // Search across ALL public embeddings (not org-scoped — this is a public verification search)
    // New RPC not yet in generated types — use any bypass
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: matches, error: searchError } = await (db.rpc as any)(
      'search_public_credential_embeddings',
      {
        p_query_embedding: queryEmbedding.embedding,
        p_match_threshold: threshold,
        p_match_count: limit,
      },
    );

    if (searchError) {
      // Fallback: if RPC doesn't exist yet, return empty results
      if ((searchError as { code?: string }).code === '42883') {
        logger.warn('search_public_credential_embeddings RPC not found, returning empty');
        res.json({ query: q, results: [], count: 0 });
        return;
      }
      logger.error({ error: searchError }, 'Agentic verification search RPC failed');
      res.status(500).json({ error: 'search_failed' });
      return;
    }

    const durationMs = Date.now() - startMs;

    // Deduct credit if org has credits
    if (keyOrgId) {
      await deductAICredits(keyOrgId, undefined, 1);
    }

    // Log usage
    logAIUsageEvent({
      orgId: keyOrgId,
      eventType: 'embedding',
      provider: provider.name,
      creditsConsumed: 1,
      durationMs,
      success: true,
    }).catch(() => {});

    // Map results to frozen verification schema format
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = ((matches ?? []) as any[]).map(
      (m: {
        public_id: string;
        status: string;
        issuer_name: string | null;
        credential_type: string | null;
        issued_date: string | null;
        expiry_date: string | null;
        anchor_timestamp: string;
        similarity: number;
      }) => ({
        verified: m.status === 'SECURED',
        status: m.status,
        issuer_name: m.issuer_name,
        credential_type: m.credential_type,
        issued_date: m.issued_date,
        expiry_date: m.expiry_date,
        anchor_timestamp: m.anchor_timestamp,
        record_uri: `https://app.arkova.io/verify/${m.public_id}`,
        similarity: m.similarity,
      }),
    );

    res.json({
      query: q,
      results,
      count: results.length,
      threshold,
    });
  } catch (err) {
    logger.error({ error: err }, 'Agentic verification search failed');
    res.status(500).json({ error: 'search_failed', message: 'Internal error' });
  }
});

export { router as aiVerifySearchRouter };
