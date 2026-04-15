/**
 * Shared pipeline utilities for public record fetchers.
 *
 * Extracted from duplicate implementations across 20+ fetcher files.
 * New fetchers should import from here instead of re-declaring.
 */

import { createHash } from 'node:crypto';
import { logger } from './logger.js';
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase as any)
    .from('public_records')
    .upsert(records, { onConflict: 'source,source_id', ignoreDuplicates: true });
  if (error) {
    logger.error({ error, count: records.length }, 'Pipeline batch upsert failed');
    return { inserted: 0, errors: records.length };
  }
  return { inserted: records.length, errors: 0 };
}

/** Check which source_ids already exist (batch dedup). Returns a Set of existing IDs. */
export async function getExistingSourceIds(
  supabase: SupabaseClient,
  source: string,
  sourceIds: string[],
): Promise<Set<string>> {
  if (sourceIds.length === 0) return new Set();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (supabase as any)
    .from('public_records')
    .select('source_id')
    .eq('source', source)
    .in('source_id', sourceIds);
  return new Set((data ?? []).map((r: { source_id: string }) => r.source_id));
}
