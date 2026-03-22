/**
 * Public Record Batch Embedder Job (PH1-INT-01)
 *
 * Generates vector embeddings for public records that don't yet have them.
 * Uses the existing AI provider abstraction (Gemini text-embedding-004).
 *
 * Gated by ENABLE_PUBLIC_RECORD_EMBEDDINGS switchboard flag.
 * Processes in batches of 100 records per run.
 *
 * Constitution 4A: Only metadata is embedded — no raw document content.
 */

import { createAIProvider } from '../ai/factory.js';
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import type { SupabaseClient } from '@supabase/supabase-js';

/** Batch size for embedding generation */
const EMBED_BATCH_SIZE = 100;

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

  // Fetch records without embeddings via RPC (PostgREST doesn't support subquery anti-joins)
  // First get IDs that already have embeddings, then exclude them
  const { data: embeddedIds } = await client
    .from('public_record_embeddings')
    .select('public_record_id');

  const excludeIds = (embeddedIds ?? []).map((r: { public_record_id: string }) => r.public_record_id);

  let query = client
    .from('public_records')
    .select('id, title, source, record_type, metadata')
    .order('created_at', { ascending: true })
    .limit(EMBED_BATCH_SIZE);

  // Exclude already-embedded records (if any exist)
  if (excludeIds.length > 0) {
    query = query.not('id', 'in', `(${excludeIds.join(',')})`);
  }

  const { data: records, error: fetchError } = await query;

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

  for (const record of records) {
    try {
      const text = buildPublicRecordEmbeddingText(record as {
        title: string | null;
        source: string;
        record_type: string;
        metadata: Record<string, unknown>;
      });

      const embeddingResult = await aiProvider.generateEmbedding(text);
      if (!embeddingResult.embedding || embeddingResult.embedding.length === 0) {
        result.failed++;
        result.errors.push({ recordId: record.id, error: 'Empty embedding returned' });
        continue;
      }

      const { error: insertError } = await client
        .from('public_record_embeddings')
        .insert({
          public_record_id: record.id,
          embedding: embeddingResult.embedding,
          model_version: 'text-embedding-004',
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
  }

  logger.info(
    { total: result.total, succeeded: result.succeeded, failed: result.failed },
    'Public record embedding batch complete',
  );

  return result;
}
