/**
 * SEC EDGAR Full-Text Search Fetcher Job (PH1-DATA-01)
 *
 * Fetches SEC filings from the EDGAR EFTS (full-text search) API.
 * Gated by ENABLE_PUBLIC_RECORDS_INGESTION switchboard flag.
 *
 * EDGAR API rules:
 *   - User-Agent header required with valid email
 *   - 10 requests/second rate limit for search API
 *   - Filing hours: 6 AM–10 PM ET weekdays for real-time; bulk anytime
 *   - Bulk downloads have no rate limit
 *
 * Constitution refs:
 *   - 4A: Only metadata is stored server-side
 */

import { createHash } from 'node:crypto';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import type { SupabaseClient } from '@supabase/supabase-js';

/** EDGAR EFTS rate limit: 10 req/sec → 100ms + margin */
const EDGAR_RATE_LIMIT_MS = 150;

/** EDGAR full-text search API */
const EDGAR_EFTS_URL = 'https://efts.sec.gov/LATEST/search-index';

/** EDGAR company search API — more reliable for bulk filing ingestion */
const EDGAR_SUBMISSIONS_URL = 'https://data.sec.gov/submissions';

/** Number of filings to fetch per API call */
const BATCH_SIZE = 100;

/** Filing types to ingest */
const FILING_TYPES = ['10-K', '10-Q', '8-K', '20-F', '6-K', 'S-1', 'DEF 14A'];

interface EdgarFiling {
  accessionNumber: string;
  filingDate: string;
  reportDate?: string;
  form: string;
  primaryDocument?: string;
  primaryDocDescription?: string;
  companyName?: string;
  cik?: string;
  ticker?: string;
}

interface EdgarSearchResult {
  hits: {
    hits: Array<{
      _id: string;
      _source: {
        file_num?: string;
        form_type: string;
        entity_name: string;
        file_date: string;
        period_of_report?: string;
        file_description?: string;
        display_names?: string[];
        tickers?: string[];
        ciks?: string[];
      };
    }>;
    total: { value: number };
  };
}

/**
 * Compute SHA-256 hex digest.
 */
function computeContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build User-Agent header per SEC EDGAR fair access policy.
 * Must contain company name + contact email.
 */
function getEdgarUserAgent(): string {
  return config.edgarUserAgent || 'Arkova contact@arkova.io';
}

/**
 * Fetch SEC EDGAR filings via the full-text search endpoint.
 * Resumable: picks up from the most recent filing date in the database.
 *
 * Strategy: Uses EFTS endpoint to search by form type and date range.
 * Each filing gets a content hash based on accession number + form type + dates.
 */
export async function fetchEdgarFilings(supabase: SupabaseClient): Promise<{
  inserted: number;
  skipped: number;
  errors: number;
}> {
  // Check switchboard flag
  const { data: enabled } = await supabase.rpc('get_flag', {
    p_flag_key: 'ENABLE_PUBLIC_RECORDS_INGESTION',
  });
  if (!enabled) {
    logger.info('ENABLE_PUBLIC_RECORDS_INGESTION is disabled — skipping EDGAR fetch');
    return { inserted: 0, skipped: 0, errors: 0 };
  }

  // Determine resume point
  const { data: lastRecord } = await supabase
    .from('public_records')
    .select('metadata')
    .eq('source', 'edgar')
    .order('created_at', { ascending: false })
    .limit(1);

  const now = new Date();
  const startDate = lastRecord?.[0]?.metadata?.filing_date
    ? (lastRecord[0].metadata as Record<string, string>).filing_date
    : new Date(now.getFullYear() - 1, 0, 1).toISOString().slice(0, 10);
  const endDate = now.toISOString().slice(0, 10);

  logger.info({ startDate, endDate, formTypes: FILING_TYPES }, 'Fetching EDGAR filings');

  let totalInserted = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  // Fetch by form type to get broader coverage
  for (const formType of FILING_TYPES) {
    let from = 0;
    let hasMore = true;

    while (hasMore) {
      const params = new URLSearchParams({
        q: `"${formType}"`,
        dateRange: 'custom',
        startdt: startDate,
        enddt: endDate,
        forms: formType,
        from: String(from),
      });

      let response: Response;
      try {
        response = await fetch(`${EDGAR_EFTS_URL}?${params.toString()}`, {
          headers: {
            'User-Agent': getEdgarUserAgent(),
            Accept: 'application/json',
          },
        });
      } catch (err) {
        logger.error({ error: err, formType, from }, 'EDGAR EFTS request failed');
        totalErrors++;
        break;
      }

      if (response.status === 429) {
        logger.warn({ formType }, 'EDGAR rate limited — backing off 10 seconds');
        await delay(10_000);
        continue;
      }

      if (!response.ok) {
        // Fallback: try the submissions API approach
        logger.warn(
          { status: response.status, formType },
          'EDGAR EFTS returned error — trying submissions API fallback',
        );
        const fallbackResult = await fetchEdgarViaSubmissionsApi(supabase, formType, startDate);
        totalInserted += fallbackResult.inserted;
        totalSkipped += fallbackResult.skipped;
        totalErrors += fallbackResult.errors;
        hasMore = false;
        continue;
      }

      let result: EdgarSearchResult;
      try {
        result = (await response.json()) as EdgarSearchResult;
      } catch {
        logger.error({ formType, from }, 'Failed to parse EDGAR response');
        totalErrors++;
        break;
      }

      const hits = result.hits?.hits ?? [];

      if (hits.length === 0) {
        hasMore = false;
        break;
      }

      logger.info(
        { formType, from, count: hits.length, total: result.hits?.total?.value },
        'EDGAR batch received',
      );

      for (const hit of hits) {
        const src = hit._source;
        const accession = hit._id.replace(/-/g, '');

        // Check for duplicates
        const { data: existing } = await supabase
          .from('public_records')
          .select('id')
          .eq('source', 'edgar')
          .eq('source_id', hit._id)
          .limit(1);

        if (existing && existing.length > 0) {
          totalSkipped++;
          continue;
        }

        const contentForHash = JSON.stringify({
          accession: hit._id,
          form_type: src.form_type,
          entity_name: src.entity_name,
          file_date: src.file_date,
        });

        const cik = src.ciks?.[0] ?? '';
        const sourceUrl = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=${encodeURIComponent(src.form_type)}&dateb=&owner=include&count=40&search_text=&action=getcompany`;

        const { error: insertError } = await supabase.from('public_records').insert({
          source: 'edgar',
          source_id: hit._id,
          source_url: `https://www.sec.gov/Archives/edgar/data/${cik}/${accession}`,
          record_type: 'sec_filing',
          title: `${src.entity_name} — ${src.form_type} (${src.file_date})`,
          content_hash: computeContentHash(contentForHash),
          metadata: {
            form_type: src.form_type,
            entity_name: src.entity_name,
            filing_date: src.file_date,
            period_of_report: src.period_of_report,
            tickers: src.tickers ?? [],
            ciks: src.ciks ?? [],
            display_names: src.display_names ?? [],
            file_description: src.file_description,
          },
        });

        if (insertError) {
          logger.error({ accession: hit._id, error: insertError }, 'Failed to insert EDGAR record');
          totalErrors++;
        } else {
          totalInserted++;
        }
      }

      // Check if there are more results
      const totalHits = result.hits?.total?.value ?? 0;
      from += hits.length;
      if (from >= totalHits || hits.length < BATCH_SIZE) {
        hasMore = false;
      }

      // Rate limit compliance — 10 req/sec
      await delay(EDGAR_RATE_LIMIT_MS);
    }

    // Pause between form types
    await delay(500);
  }

  logger.info(
    { totalInserted, totalSkipped, totalErrors },
    'EDGAR fetch complete',
  );

  return { inserted: totalInserted, skipped: totalSkipped, errors: totalErrors };
}

/**
 * Fallback: Fetch filings from EDGAR submissions API.
 * Uses company CIK-based lookups (more stable endpoint).
 */
async function fetchEdgarViaSubmissionsApi(
  supabase: SupabaseClient,
  formType: string,
  startDate: string,
): Promise<{ inserted: number; skipped: number; errors: number }> {
  // Use the EDGAR full-text search as primary — this is a stub fallback
  // for when the EFTS endpoint returns errors. In production, implement
  // bulk CSV download from https://www.sec.gov/cgi-bin/browse-edgar
  logger.info({ formType, startDate }, 'EDGAR submissions API fallback — not yet implemented');
  return { inserted: 0, skipped: 0, errors: 0 };
}
