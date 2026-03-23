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
const BATCH_SIZE = 200;

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

        // Extract entity name — EFTS _source may use entity_name directly
        // or only provide display_names array like "APPLE INC (AAPL) (CIK 0000320193)"
        const entityName = src.entity_name
          || (src.display_names?.[0]?.split(/\s{2,}/)?.[0]?.trim())
          || 'Unknown Entity';

        // Form type — may be in form_type or inferred from search query
        const formTypeValue = src.form_type || formType;

        // Filing date
        const fileDate = src.file_date || '';

        const contentForHash = JSON.stringify({
          accession: hit._id,
          form_type: formTypeValue,
          entity_name: entityName,
          file_date: fileDate,
        });

        const cik = src.ciks?.[0] ?? '';

        const { error: insertError } = await supabase.from('public_records').insert({
          source: 'edgar',
          source_id: hit._id,
          source_url: `https://www.sec.gov/Archives/edgar/data/${cik}/${accession.replace(/-/g, '')}/${accession}-index.htm`,
          record_type: 'sec_filing',
          title: `${entityName} — ${formTypeValue} (${fileDate})`,
          content_hash: computeContentHash(contentForHash),
          metadata: {
            form_type: formTypeValue,
            entity_name: entityName,
            filing_date: fileDate,
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
 * Top S&P 500 CIKs for historical backfill.
 * These cover the most-searched companies and provide broad market coverage.
 */
const TOP_COMPANY_CIKS = [
  '0000320193', // Apple
  '0000789019', // Microsoft
  '0001652044', // Alphabet (Google)
  '0001018724', // Amazon
  '0001326801', // Meta (Facebook)
  '0001045810', // NVIDIA
  '0000034088', // Exxon Mobil
  '0000078003', // Pfizer
  '0000050863', // Intel
  '0000051143', // IBM
  '0000200406', // Johnson & Johnson
  '0000060714', // Lockheed Martin
  '0001341439', // Oracle
  '0000092380', // Thermo Fisher
  '0000732717', // AT&T
  '0000354950', // Home Depot
  '0001067983', // Berkshire Hathaway
  '0000021344', // Coca-Cola
  '0000093410', // Chevron
  '0000886982', // Goldman Sachs
  '0000072971', // Wells Fargo
  '0000070858', // Bank of America
  '0000019617', // JPMorgan Chase
  '0000718877', // Visa
  '0001141391', // Mastercard
  '0001652130', // Snap Inc
  '0001318605', // Tesla
  '0001559720', // Uber
  '0001364742', // Palantir
  '0001783879', // CrowdStrike
];

interface SubmissionsResponse {
  cik: string;
  entityType: string;
  name: string;
  tickers: string[];
  exchanges: string[];
  filings: {
    recent: {
      accessionNumber: string[];
      filingDate: string[];
      reportDate: string[];
      form: string[];
      primaryDocument: string[];
      primaryDocDescription: string[];
    };
    files: Array<{ name: string; filingCount: number; filingFrom: string; filingTo: string }>;
  };
}

/**
 * Fallback: Fetch filings from EDGAR submissions API.
 * Uses company CIK-based lookups (more stable endpoint).
 * Also serves as historical backfill — iterates through TOP_COMPANY_CIKS.
 */
async function fetchEdgarViaSubmissionsApi(
  supabase: SupabaseClient,
  formType: string,
  startDate: string,
): Promise<{ inserted: number; skipped: number; errors: number }> {
  let totalInserted = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  for (const cik of TOP_COMPANY_CIKS) {
    try {
      const url = `${EDGAR_SUBMISSIONS_URL}/CIK${cik}.json`;
      const response = await fetch(url, {
        headers: {
          'User-Agent': getEdgarUserAgent(),
          Accept: 'application/json',
        },
      });

      if (response.status === 429) {
        logger.warn({ cik }, 'EDGAR submissions rate limited — backing off');
        await delay(10_000);
        continue;
      }

      if (!response.ok) {
        logger.warn({ cik, status: response.status }, 'EDGAR submissions request failed');
        totalErrors++;
        continue;
      }

      const data = (await response.json()) as SubmissionsResponse;
      const recent = data.filings?.recent;
      if (!recent?.accessionNumber) continue;

      const entityName = data.name || 'Unknown Entity';
      const tickers = data.tickers ?? [];

      for (let i = 0; i < recent.accessionNumber.length; i++) {
        const form = recent.form[i];
        // Filter to target form types
        if (!FILING_TYPES.includes(form)) continue;

        const filingDate = recent.filingDate[i];
        if (filingDate < startDate) continue;

        const accession = recent.accessionNumber[i];
        const sourceId = accession.replace(/-/g, '');

        // Check for duplicates
        const { data: existing } = await supabase
          .from('public_records')
          .select('id')
          .eq('source', 'edgar')
          .eq('source_id', accession)
          .limit(1);

        if (existing && existing.length > 0) {
          totalSkipped++;
          continue;
        }

        const contentForHash = JSON.stringify({
          accession,
          form_type: form,
          entity_name: entityName,
          file_date: filingDate,
        });

        const { error: insertError } = await supabase.from('public_records').insert({
          source: 'edgar',
          source_id: accession,
          source_url: `https://www.sec.gov/Archives/edgar/data/${cik.replace(/^0+/, '')}/${sourceId}/${accession}-index.htm`,
          record_type: 'sec_filing',
          title: `${entityName} — ${form} (${filingDate})`,
          content_hash: computeContentHash(contentForHash),
          metadata: {
            form_type: form,
            entity_name: entityName,
            filing_date: filingDate,
            period_of_report: recent.reportDate[i] || null,
            tickers,
            ciks: [cik],
            primary_document: recent.primaryDocument[i] || null,
            primary_doc_description: recent.primaryDocDescription[i] || null,
          },
        });

        if (insertError) {
          if (insertError.code !== '23505') {
            logger.error({ accession, error: insertError }, 'Failed to insert EDGAR submission record');
            totalErrors++;
          } else {
            totalSkipped++;
          }
        } else {
          totalInserted++;
        }
      }

      // Rate limit compliance
      await delay(EDGAR_RATE_LIMIT_MS);
    } catch (err) {
      logger.error({ cik, error: err }, 'EDGAR submissions fetch failed for CIK');
      totalErrors++;
    }
  }

  logger.info(
    { totalInserted, totalSkipped, totalErrors, formType },
    'EDGAR submissions API fallback complete',
  );

  return { inserted: totalInserted, skipped: totalSkipped, errors: totalErrors };
}

/**
 * Historical backfill: Fetch filings from all TOP_COMPANY_CIKS via the submissions API.
 * Unlike the main fetcher, this always starts from 5 years ago for broader coverage.
 * Exported so it can be triggered via a dedicated cron endpoint.
 */
export async function fetchEdgarHistoricalBackfill(supabase: SupabaseClient): Promise<{
  inserted: number;
  skipped: number;
  errors: number;
}> {
  // Check switchboard flag
  const { data: enabled } = await supabase.rpc('get_flag', {
    p_flag_key: 'ENABLE_PUBLIC_RECORDS_INGESTION',
  });
  if (!enabled) {
    logger.info('ENABLE_PUBLIC_RECORDS_INGESTION is disabled — skipping EDGAR backfill');
    return { inserted: 0, skipped: 0, errors: 0 };
  }

  const fiveYearsAgo = new Date();
  fiveYearsAgo.setFullYear(fiveYearsAgo.getFullYear() - 5);
  const startDate = fiveYearsAgo.toISOString().slice(0, 10);

  logger.info({ startDate, companyCIKs: TOP_COMPANY_CIKS.length }, 'Starting EDGAR historical backfill');

  const result = await fetchEdgarViaSubmissionsApi(supabase, 'ALL', startDate);

  logger.info(result, 'EDGAR historical backfill complete');
  return result;
}
