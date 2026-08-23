/**
 * Shared pipeline utilities for public record fetchers.
 *
 * Extracted from duplicate implementations across 20+ fetcher files.
 * New fetchers should import from here instead of re-declaring.
 */

import { createHash } from 'node:crypto';
import { logger } from './logger.js';
import { assertNotAllChunksFailed, chunkForInFilter } from './postgrest-filter.js';
import type { SupabaseClient } from '@supabase/supabase-js';

/** SHA-256 content hash for deduplication and fingerprinting. */
export function computeContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

/** Rate-limiting delay between API requests. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Result `status` literals that mean "this run failed", even when the fetcher
 * left its `errors` counter at zero (BUG-020).
 *
 * `/fetch-uspto` is the reference case: a hard 403 from the PatentsView bucket
 * surfaced as `{"status":"download_failed","inserted":0,"errors":0}` and the
 * route returned HTTP 200. Any fetcher that gives up before reaching upstream —
 * missing credential, dead endpoint, unusable source — must set one of these so
 * `routes/ingestionResponse.ts` can refuse to call the run a success.
 */
export const INGESTION_FAILURE_STATUSES: ReadonlySet<string> = new Set([
  'download_failed',
  'fetch_failed',
  'source_unavailable',
  'unconfigured_source',
  'failed',
  'error',
]);

/** True when a fetcher result's `status` declares the run a failure. */
export function isIngestionFailureStatus(status: unknown): boolean {
  return typeof status === 'string' && INGESTION_FAILURE_STATUSES.has(status);
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
 * A partial result is safe and is returned as-is: `batchUpsertRecords` upserts
 * with `ignoreDuplicates`, so a missed duplicate costs a redundant write, never
 * a wrong row. A run where EVERY chunk failed is not — an empty Set reads as
 * "nothing is a duplicate", so it throws rather than reporting dedup success.
 *
 * BEHAVIOUR CHANGE: that throw propagates out of `ingestStatutes`, which
 * `fetchJurisdictionCompliance` runs BEFORE `fetchCaseLaw` — so a total dedup
 * failure now also skips case-law ingestion for that jurisdiction, where
 * previously it degraded to re-upserting everything. Intended: a cron 500 that
 * Cloud Scheduler retries beats a silent no-op, and an all-chunks-failed result
 * means PostgREST is unavailable for this table anyway.
 *
 * (Of the two defects fixed here the unchunked filter was LATENT and the
 * discarded error was LIVE — see `utils/agents.md` for which and why.)
 */
export async function getExistingSourceIds(
  supabase: SupabaseClient,
  source: string,
  sourceIds: string[],
): Promise<Set<string>> {
  if (sourceIds.length === 0) return new Set();

  const existing = new Set<string>();
  const chunks = chunkForInFilter(sourceIds);
  let failedChunks = 0;

  for (const { values, start } of chunks) {
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

  assertNotAllChunksFailed(
    'getExistingSourceIds',
    chunks.length,
    failedChunks,
    `source=${source} (${sourceIds.length} id(s))`,
  );

  return existing;
}
