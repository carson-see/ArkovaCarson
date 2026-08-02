/**
 * Shared pipeline utilities for public record fetchers.
 *
 * Extracted from duplicate implementations across 20+ fetcher files.
 * New fetchers should import from here instead of re-declaring.
 */

import { createHash } from 'node:crypto';
import { logger } from './logger.js';
// `jobs/anchor-batching.ts` is an import-free leaf module of shared PostgREST /
// batch constants, so importing it here creates no cycle and no runtime
// coupling to the anchoring jobs themselves.
import { chunkForInFilter } from '../jobs/anchor-batching.js';
import type { SupabaseClient } from '@supabase/supabase-js';

/** SHA-256 content hash for deduplication and fingerprinting. */
export function computeContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

/** Rate-limiting delay between API requests. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Check the ENABLE_PUBLIC_RECORDS_INGESTION switchboard flag. */
export async function isIngestionEnabled(supabase: SupabaseClient): Promise<boolean> {
  const { data: enabled } = await supabase.rpc('get_flag', {
    p_flag_key: 'ENABLE_PUBLIC_RECORDS_INGESTION',
  });
  return Boolean(enabled);
}

/** Batch upsert records into public_records with standard conflict handling. */
export async function batchUpsertRecords(
  supabase: SupabaseClient,
  records: Array<Record<string, unknown>>,
): Promise<{ inserted: number; errors: number }> {
  if (records.length === 0) return { inserted: 0, errors: 0 };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- service-role admin query
  const { error } = await (supabase as any)
    .from('public_records')
    .upsert(records, { onConflict: 'source,source_id', ignoreDuplicates: true });
  if (error) {
    logger.error({ error, count: records.length }, 'Pipeline batch upsert failed');
    return { inserted: 0, errors: records.length };
  }
  return { inserted: records.length, errors: 0 };
}

/**
 * Check which source_ids already exist (batch dedup). Returns a Set of existing IDs.
 *
 * Two defects fixed here, both from the class that cost 70 hours of
 * public-record anchoring (see `chunkForInFilter` in `jobs/anchor-batching.ts`):
 *
 *  1. The `.in('source_id', …)` filter was unchunked. Callers pass every
 *     source id in a fetch page, so the encoded query string grew with the
 *     upstream corpus until PostgREST answered 400 Bad Request. `source_id` is
 *     an arbitrary upstream identifier (URLs, docket numbers), not a UUID,
 *     which is why the helper bounds by encoded BYTES and not by a count.
 *  2. The error was discarded (`const { data } = …`), so a 400 returned an
 *     empty Set — indistinguishable from "nothing is a duplicate". Dedup would
 *     be silently dead while every caller reported success.
 *
 * Mirrors `fetchAnchorRows`: per-chunk failures are logged and skipped, but a
 * run where EVERY chunk failed refuses to report an empty result as success.
 * A partial result is still safe for dedup — `batchUpsertRecords` upserts with
 * `ignoreDuplicates`, so a missed duplicate costs a redundant write, never a
 * wrong row.
 */
export async function getExistingSourceIds(
  supabase: SupabaseClient,
  source: string,
  sourceIds: string[],
): Promise<Set<string>> {
  if (sourceIds.length === 0) return new Set();

  const existing = new Set<string>();
  let attemptedChunks = 0;
  let failedChunks = 0;

  for (const { values, start } of chunkForInFilter(sourceIds)) {
    attemptedChunks += 1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- service-role admin query
    const { data, error } = await (supabase as any)
      .from('public_records')
      .select('source_id')
      .eq('source', source)
      .in('source_id', values);

    if (error) {
      failedChunks += 1;
      logger.error(
        { error, source, chunkStart: start, chunkSize: values.length },
        'Pipeline dedup lookup failed for a source_id chunk',
      );
      continue;
    }

    for (const row of (data ?? []) as Array<{ source_id: string }>) {
      existing.add(row.source_id);
    }
  }

  if (failedChunks === attemptedChunks) {
    throw new Error(
      `getExistingSourceIds: all ${failedChunks} chunk(s) failed for source=${source} (${sourceIds.length} id(s)); refusing to report an empty dedup set as success`,
    );
  }

  return existing;
}
