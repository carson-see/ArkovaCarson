/**
 * Public Record Batch Embedder Job (PH1-INT-01)
 *
 * Generates vector embeddings for public records that don't yet have them.
 * Uses the existing AI provider abstraction (Gemini text-embedding-004).
 *
 * Gated by ENABLE_PUBLIC_RECORD_EMBEDDINGS switchboard flag.
 * Processes in batches of 500 records per run.
 *
 * Constitution 4A: Only metadata is embedded — no raw document content.
 */

import { createAIProvider } from '../ai/factory.js';
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import type { SupabaseClient } from '@supabase/supabase-js';

/** Batch size for embedding generation — increased from 100 to clear 12K+ backlog faster */
const EMBED_BATCH_SIZE = 500;

/** Number of concurrent embedding API calls */
const EMBED_CONCURRENCY = 10;

export interface BatchEmbedResult {
  total: number;
  succeeded: number;
  failed: number;
  errors: Array<{ recordId: string; error: string }>;
}

/**
 * Build embedding text from a public record's metadata.
 * Extracts title, abstract/content, source info for semantic search.
 */
function buildPublicRecordEmbeddingText(record: {
  title: string | null;
  source: string;
  record_type: string;
  metadata: Record<string, unknown>;
}): string {
  const parts: string[] = [];

  if (record.title) parts.push(record.title);
  parts.push(`Source: ${record.source}`);
  parts.push(`Type: ${record.record_type}`);

  const meta = record.metadata ?? {};
  if (meta.abstract) parts.push(`Abstract: ${String(meta.abstract)}`);
  if (meta.patent_type) parts.push(`Patent type: ${String(meta.patent_type)}`);
  if (meta.agencies) {
    const agencies = Array.isArray(meta.agencies) ? meta.agencies.join(', ') : String(meta.agencies);
    parts.push(`Agencies: ${agencies}`);
  }
  if (meta.citation) parts.push(`Citation: ${String(meta.citation)}`);
  if (meta.type) parts.push(`Document type: ${String(meta.type)}`);

  return parts.join(' | ');
}

/**
 * Generate and store embeddings for unembedded public records.
 * Resumable: only processes records without existing embeddings.
 */
export async function embedPublicRecords(
  supabase?: SupabaseClient,
): Promise<BatchEmbedResult> {
  const client = supabase ?? db;

  // Check switchboard flag
  const { data: enabled } = await client.rpc('get_flag', {
    p_flag_key: 'ENABLE_PUBLIC_RECORD_EMBEDDINGS',
  });
  if (!enabled) {
    logger.info('ENABLE_PUBLIC_RECORD_EMBEDDINGS is disabled — skipping embedding');
    return { total: 0, succeeded: 0, failed: 0, errors: [] };
  }

  // Use RPC with proper SQL anti-join (LEFT JOIN … WHERE NULL) — the old approach
  // of fetching all embedded IDs client-side broke at scale (PostgREST URL limits).
  const { data: records, error: fetchError } = await client.rpc(
    'get_unembedded_public_records',
    { p_limit: EMBED_BATCH_SIZE },
  );

  if (fetchError) {
    logger.error({ error: fetchError }, 'Failed to fetch unembedded public records');
    return { total: 0, succeeded: 0, failed: 0, errors: [] };
  }

  if (!records || records.length === 0) {
    logger.info('No unembedded public records found');
    return { total: 0, succeeded: 0, failed: 0, errors: [] };
  }

  const aiProvider = createAIProvider();
  const result: BatchEmbedResult = {
    total: records.length,
    succeeded: 0,
    failed: 0,
    errors: [],
  };

  // Process records with bounded concurrency for throughput
  const processRecord = async (record: { id: string; title: string | null; source: string; record_type: string; metadata: Record<string, unknown> }) => {
    try {
      const text = buildPublicRecordEmbeddingText(record);

      const embeddingResult = await aiProvider.generateEmbedding(text);
      if (!embeddingResult.embedding || embeddingResult.embedding.length === 0) {
        result.failed++;
        result.errors.push({ recordId: record.id, error: 'Empty embedding returned' });
        return;
      }

      const { error: insertError } = await client
        .from('public_record_embeddings')
        .insert({
          public_record_id: record.id,
          embedding: embeddingResult.embedding,
          model_version: process.env.GEMINI_EMBEDDING_MODEL ?? 'text-embedding-004',
        });

      if (insertError) {
        result.failed++;
        result.errors.push({ recordId: record.id, error: insertError.message });
      } else {
        result.succeeded++;
      }
    } catch (error) {
      result.failed++;
      result.errors.push({
        recordId: record.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };

  // Process in chunks of EMBED_CONCURRENCY for bounded parallelism
  for (let i = 0; i < records.length; i += EMBED_CONCURRENCY) {
    const chunk = records.slice(i, i + EMBED_CONCURRENCY);
    await Promise.all(chunk.map((r: { id: string; title: string | null; source: string; record_type: string; metadata: Record<string, unknown> }) => processRecord(r)));
  }

  logger.info(
    { total: result.total, succeeded: result.succeeded, failed: result.failed },
    'Public record embedding batch complete',
  );

  return result;
}
