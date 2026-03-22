/**
 * USPTO Patent Fetcher Job
 *
 * Fetches patent grants from the PatentsView API for Nessie training data pipeline.
 * Gated by ENABLE_PUBLIC_RECORDS_INGESTION switchboard flag.
 *
 * PatentsView API: 45 requests/minute, no API key required.
 * Bulk CSV downloads available for historical backfill (weekly Tuesday updates).
 */

import { createHash } from 'node:crypto';
import { logger } from '../utils/logger.js';
import type { SupabaseClient } from '@supabase/supabase-js';

/** PatentsView rate limit: 45 requests/minute → ~1333ms between requests */
const USPTO_RATE_LIMIT_MS = 1400;

/** PatentsView API base URL (transitioning to data.uspto.gov as of March 2026) */
const PATENTSVIEW_API_URL = 'https://api.patentsview.org/patents/query';

/** Batch size for API queries */
const QUERY_BATCH_SIZE = 100;

interface PatentResult {
  patent_number: string;
  patent_title: string;
  patent_abstract: string;
  patent_date: string;
  patent_type: string;
}

interface PatentsViewResponse {
  patents: PatentResult[];
  count: number;
  total_patent_count: number;
}

/**
 * Compute SHA-256 hex digest of a string.
 */
function computeContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

/**
 * Simple delay for rate limiting.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch USPTO patent grants and insert into public_records.
 * Resumable: picks up from the most recent patent date in the database.
 */
export async function fetchUsptoPAtents(supabase: SupabaseClient): Promise<void> {
  // Check switchboard flag
  const { data: enabled } = await supabase.rpc('get_flag', {
    p_flag_key: 'ENABLE_PUBLIC_RECORDS_INGESTION',
  });
  if (!enabled) {
    logger.info('ENABLE_PUBLIC_RECORDS_INGESTION is disabled — skipping USPTO fetch');
    return;
  }

  // Determine resume point: last patent date in DB
  const { data: lastRecord } = await supabase
    .from('public_records')
    .select('metadata')
    .eq('source', 'uspto')
    .order('created_at', { ascending: false })
    .limit(1);

  const now = new Date();
  const startDate = lastRecord?.[0]?.metadata?.patent_date
    ? (lastRecord[0].metadata as Record<string, string>).patent_date
    : new Date(now.getFullYear() - 1, 0, 1).toISOString().slice(0, 10);

  logger.info({ startDate }, 'Fetching USPTO patents');

  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const queryBody = {
      q: {
        _gte: { patent_date: startDate },
      },
      f: ['patent_number', 'patent_title', 'patent_abstract', 'patent_date', 'patent_type'],
      o: {
        page,
        per_page: QUERY_BATCH_SIZE,
      },
      s: [{ patent_date: 'asc' }],
    };

    let response: Response;
    try {
      response = await fetch(PATENTSVIEW_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(queryBody),
      });
    } catch (err) {
      logger.error({ error: err, page }, 'USPTO API request failed');
      break;
    }

    if (!response.ok) {
      logger.error({ status: response.status, page }, 'USPTO API returned error');
      break;
    }

    const result = (await response.json()) as PatentsViewResponse;
    const patents = result.patents ?? [];

    if (patents.length === 0) {
      hasMore = false;
      break;
    }

    logger.info({ page, count: patents.length, total: result.total_patent_count }, 'USPTO batch received');

    for (const patent of patents) {
      // Check for duplicates
      const { data: existing } = await supabase
        .from('public_records')
        .select('id')
        .eq('source', 'uspto')
        .eq('source_id', patent.patent_number)
        .limit(1);

      if (existing && existing.length > 0) {
        continue;
      }

      const contentForHash = JSON.stringify({
        patent_number: patent.patent_number,
        title: patent.patent_title,
        abstract: patent.patent_abstract,
        date: patent.patent_date,
      });

      const { error: insertError } = await supabase.from('public_records').insert({
        source: 'uspto',
        source_id: patent.patent_number,
        source_url: `https://patents.google.com/patent/US${patent.patent_number}`,
        record_type: 'patent_grant',
        title: patent.patent_title,
        content_hash: computeContentHash(contentForHash),
        metadata: {
          patent_number: patent.patent_number,
          patent_type: patent.patent_type,
          patent_date: patent.patent_date,
          abstract: patent.patent_abstract,
        },
      });

      if (insertError) {
        logger.error({ patentNumber: patent.patent_number, error: insertError }, 'Failed to insert USPTO record');
      }
    }

    // Check if there are more pages
    if (patents.length < QUERY_BATCH_SIZE) {
      hasMore = false;
    } else {
      page++;
    }

    // Rate limit compliance
    await delay(USPTO_RATE_LIMIT_MS);
  }

  logger.info({ pagesProcessed: page }, 'USPTO fetch complete');
}
