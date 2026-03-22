/**
 * EDGAR Fetcher Job
 *
 * Fetches SEC EDGAR filings (10-K, 10-Q, 8-K) for Nessie training data pipeline.
 * Gated by ENABLE_PUBLIC_RECORDS_INGESTION switchboard flag.
 *
 * SEC fair access policy: 10 req/sec max, User-Agent required.
 */

import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { SupabaseClient } from '@supabase/supabase-js';

/** SEC rate limit: 10 requests per second → 100ms between requests */
const SEC_RATE_LIMIT_MS = 100;

/** Filing types to fetch */
const FILING_FORMS = '10-K,10-Q,8-K';

/** EDGAR full-text search API base */
const EDGAR_SEARCH_URL = 'https://efts.sec.gov/LATEST/search-index';

interface EdgarSearchHit {
  _id: string;
  _source: {
    file_date: string;
    display_date_filed: string;
    entity_name: string;
    file_num: string;
    form_type: string;
    file_description?: string;
  };
}

interface EdgarSearchResponse {
  hits: {
    hits: EdgarSearchHit[];
    total: { value: number };
  };
}

/**
 * Compute SHA-256 hex digest of a string.
 */
export function computeContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

/**
 * Simple delay for rate limiting.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch SEC EDGAR filings and insert into public_records.
 * Resumable: picks up from the most recent record's created_at.
 */
export async function fetchEdgarFilings(supabase: SupabaseClient): Promise<void> {
  // Check switchboard flag
  const { data: enabled } = await supabase.rpc('get_flag', {
    p_flag_id: 'ENABLE_PUBLIC_RECORDS_INGESTION',
  });
  if (!enabled) {
    logger.info('ENABLE_PUBLIC_RECORDS_INGESTION is disabled — skipping EDGAR fetch');
    return;
  }

  const userAgent = config.edgarUserAgent ?? 'Arkova contact@arkova.io';

  // Determine resume point: last record's created_at
  const { data: lastRecord } = await supabase
    .from('public_records')
    .select('created_at')
    .eq('source', 'sec_edgar')
    .order('created_at', { ascending: false })
    .limit(1);

  const now = new Date();
  const startDate = lastRecord?.[0]
    ? new Date(lastRecord[0].created_at).toISOString().slice(0, 10)
    : new Date(now.getFullYear(), now.getMonth() - 1, now.getDate())
        .toISOString()
        .slice(0, 10);
  const endDate = now.toISOString().slice(0, 10);

  logger.info({ startDate, endDate }, 'Fetching EDGAR filings');

  const url = `${EDGAR_SEARCH_URL}?q=*&dateRange=custom&startdt=${startDate}&enddt=${endDate}&forms=${FILING_FORMS}`;

  const response = await fetch(url, {
    headers: { 'User-Agent': userAgent },
  });

  if (!response.ok) {
    logger.error({ status: response.status }, 'EDGAR search API request failed');
    return;
  }

  const result = (await response.json()) as EdgarSearchResponse;
  const hits = result.hits?.hits ?? [];

  logger.info({ totalHits: hits.length }, 'EDGAR search results received');

  for (const hit of hits) {
    const sourceId = hit._id;
    const source = hit._source;

    // Check for duplicates
    const { data: existing } = await supabase
      .from('public_records')
      .select('id')
      .eq('source', 'sec_edgar')
      .eq('source_id', sourceId)
      .limit(1);

    if (existing && existing.length > 0) {
      continue;
    }

    // Build filing URL
    const filingUrl = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&filenum=${source.file_num}&type=${source.form_type}&dateb=&owner=include&count=10`;

    // Compute content hash from the filing metadata (full text fetch would require additional request)
    const contentForHash = JSON.stringify({
      source_id: sourceId,
      entity_name: source.entity_name,
      form_type: source.form_type,
      file_date: source.file_date,
    });
    const contentHash = computeContentHash(contentForHash);

    const { error: insertError } = await supabase.from('public_records').insert({
      source: 'sec_edgar',
      source_id: sourceId,
      source_url: filingUrl,
      record_type: source.form_type,
      title: source.file_description ?? `${source.entity_name} ${source.form_type}`,
      content_hash: contentHash,
      metadata: {
        entity_name: source.entity_name,
        file_num: source.file_num,
        file_date: source.file_date,
      },
    });

    if (insertError) {
      logger.error({ sourceId, error: insertError }, 'Failed to insert EDGAR record');
    }

    // SEC rate limit compliance
    await delay(SEC_RATE_LIMIT_MS);
  }

  logger.info({ processedCount: hits.length }, 'EDGAR fetch complete');
}
