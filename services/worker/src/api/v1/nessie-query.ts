/**
 * Nessie RAG Query Endpoint (PH1-INT-02)
 *
 * GET /api/v1/nessie/query?q={query} — Natural language query over anchored public records.
 * Returns results with Bitcoin anchor proofs (Merkle proof + tx ID).
 *
 * Gated by ENABLE_PUBLIC_RECORD_EMBEDDINGS switchboard flag.
 *
 * Constitution 4A: Only PII-stripped metadata searched/returned.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { createAIProvider } from '../../ai/factory.js';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

// Type helpers for tables not yet in generated types (migration 0080 pending)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbAny = db as any;

const router = Router();

const NessieQuerySchema = z.object({
  q: z.string().min(1, 'Query is required').max(1000),
  threshold: z.coerce.number().min(0).max(1).default(0.65),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

/** Single result with anchor proof */
export interface NessieResult {
  record_id: string;
  source: string;
  source_url: string;
  record_type: string;
  title: string | null;
  relevance_score: number;
  anchor_proof: {
    chain_tx_id: string | null;
    merkle_root: string | null;
    merkle_proof: unknown[];
    content_hash: string;
    anchored_at: string | null;
  } | null;
  metadata: Record<string, unknown>;
}

/** GET /api/v1/nessie/query — RAG query over anchored public records */
router.get('/', async (req: Request, res: Response) => {
  const parsed = NessieQuerySchema.safeParse(req.query);
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
    // Check switchboard flag
    const { data: enabled } = await db.rpc('get_flag', {
      p_flag_key: 'ENABLE_PUBLIC_RECORD_EMBEDDINGS',
    });
    if (!enabled) {
      res.status(503).json({ error: 'Nessie query endpoint is not enabled' });
      return;
    }

    // Generate query embedding
    const aiProvider = createAIProvider();
    const embeddingResult = await aiProvider.generateEmbedding(q);
    if (!embeddingResult.embedding || embeddingResult.embedding.length === 0) {
      res.status(500).json({ error: 'Failed to generate query embedding' });
      return;
    }

    // Search public_record_embeddings via RPC (table from migration 0080 — not yet in generated types)
    const { data: matches, error: searchError } = await dbAny.rpc(
      'search_public_record_embeddings',
      {
        p_query_embedding: embeddingResult.embedding,
        p_match_threshold: threshold,
        p_match_count: limit,
      },
    ) as { data: Array<{ public_record_id: string; similarity: number }> | null; error: unknown };

    if (searchError) {
      logger.error({ error: searchError }, 'Nessie search RPC failed');
      res.status(500).json({ error: 'Search failed' });
      return;
    }

    if (!matches || matches.length === 0) {
      res.json({ results: [], count: 0, query: q });
      return;
    }

    // Fetch full records with anchor proofs (public_records from migration 0077)
    const recordIds = matches.map((m) => m.public_record_id);
    const { data: records, error: fetchError } = await dbAny
      .from('public_records')
      .select('id, source, source_url, record_type, title, content_hash, metadata, anchor_id')
      .in('id', recordIds) as { data: Array<{
        id: string; source: string; source_url: string; record_type: string;
        title: string | null; content_hash: string; metadata: Record<string, unknown>;
        anchor_id: string | null;
      }> | null; error: unknown };

    if (fetchError) {
      logger.error({ error: fetchError }, 'Failed to fetch public records');
      res.status(500).json({ error: 'Failed to retrieve results' });
      return;
    }

    // Build results with anchor proofs
    const results: NessieResult[] = (records ?? []).map((record) => {
      const match = matches.find((m: { public_record_id: string }) => m.public_record_id === record.id);
      const meta = (record.metadata as Record<string, unknown>) ?? {};

      return {
        record_id: record.id,
        source: record.source,
        source_url: record.source_url,
        record_type: record.record_type,
        title: record.title,
        relevance_score: match?.similarity ?? 0,
        anchor_proof: record.anchor_id
          ? {
              chain_tx_id: (meta.chain_tx_id as string) ?? null,
              merkle_root: (meta.merkle_root as string) ?? null,
              merkle_proof: (meta.merkle_proof as unknown[]) ?? [],
              content_hash: record.content_hash,
              anchored_at: (meta.anchored_at as string) ?? null,
            }
          : null,
        metadata: {
          ...meta,
          // Strip internal fields
          merkle_proof: undefined,
          merkle_root: undefined,
          chain_tx_id: undefined,
          batch_id: undefined,
        },
      };
    });

    // Sort by relevance
    results.sort((a, b) => b.relevance_score - a.relevance_score);

    res.json({
      results,
      count: results.length,
      query: q,
    });
  } catch (error) {
    logger.error({ error }, 'Nessie query failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as nessieQueryRouter };
