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

/** Filing types to ingest (standard cron) */
const FILING_TYPES = ['10-K', '10-Q', '8-K', '20-F', '6-K', 'S-1', 'DEF 14A'];

/** Expanded form types for bulk ingestion — covers virtually all SEC filing categories */
const BULK_FILING_TYPES = [
  // Annual & Quarterly
  '10-K', '10-Q', '10-K/A', '10-Q/A',
  // Current Reports
  '8-K', '8-K/A',
  // Foreign Private Issuers
  '20-F', '20-F/A', '6-K', '6-K/A',
  // Registration Statements
  'S-1', 'S-1/A', 'S-3', 'S-3/A', 'S-4', 'S-4/A', 'S-8', 'S-11',
  // Proxy Statements
  'DEF 14A', 'DEFA14A', 'DEFC14A', 'PRE 14A',
  // Insider Trading
  '4', '3', '5',
  // Ownership & Tender
  'SC 13D', 'SC 13D/A', 'SC 13G', 'SC 13G/A', 'SC TO-T', 'SC 14D9',
  // Fund Filings
  'N-CSR', 'N-CSRS', 'N-Q', '485BPOS', '497',
  // Shelf Registrations & Prospectuses
  '424B2', '424B3', '424B4', '424B5', 'FWP',
  // Exempt Offerings
  'D', 'D/A',
  // Annual Reports (foreign)
  '40-F', '40-F/A',
  // Special Purpose
  'CB', 'F-1', 'F-3', 'F-4',
];

interface _EdgarFiling {
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
 * S&P 500 CIKs for historical backfill — 150 companies.
 * Expanded from original 30 to target 100K+ records.
 * Each company has ~50-400 filings → ~15K-60K records per full backfill.
 * With 5-year lookback across 7 filing types, expect 100K+ total.
 */
const TOP_COMPANY_CIKS: string[] = [
  // ── FAANG / Mega-cap Tech ──
  '0000320193', // Apple
  '0000789019', // Microsoft
  '0001652044', // Alphabet (Google)
  '0001018724', // Amazon
  '0001326801', // Meta (Facebook)
  '0001045810', // NVIDIA
  '0001318605', // Tesla
  '0001559720', // Uber
  '0001364742', // Palantir
  '0001783879', // CrowdStrike
  '0001341439', // Oracle
  '0000051143', // IBM
  '0001652130', // Snap Inc
  '0001585521', // Snowflake
  '0001467373', // Workday
  '0001403161', // Visa (class A)
  '0001564590', // ServiceNow
  '0001720635', // Datadog
  '0001571996', // HubSpot
  '0001823945', // Confluent
  '0001816233', // ZoomInfo
  // ── Semiconductors ──
  '0000050863', // Intel
  '0000002488', // AMD
  '0001413447', // Broadcom
  '0000097476', // Texas Instruments
  '0001000228', // Qualcomm
  '0000898293', // TSMC (ADR)
  '0001666175', // Arm Holdings
  '0001385187', // Marvell
  // ── Finance ──
  '0000019617', // JPMorgan Chase
  '0000070858', // Bank of America
  '0000072971', // Wells Fargo
  '0000886982', // Goldman Sachs
  '0000831001', // Citigroup
  '0000895421', // Morgan Stanley
  '0001067983', // Berkshire Hathaway
  '0000718877', // Visa
  '0001141391', // Mastercard
  '0000060667', // Charles Schwab
  '0001393612', // PayPal
  '0001547903', // Block (Square)
  '0001637459', // SoFi
  '0000840715', // S&P Global
  // ── Healthcare / Pharma ──
  '0000200406', // Johnson & Johnson
  '0000078003', // Pfizer
  '0000310158', // Merck
  '0000014693', // Abbott Labs
  '0000004962', // AbbVie
  '0000092380', // Thermo Fisher
  '0001551152', // Moderna
  '0000018230', // Bristol-Myers Squibb
  '0000829224', // Regeneron
  '0000816284', // Amgen
  '0000858655', // UnitedHealth
  '0001178879', // Danaher
  // ── Energy ──
  '0000034088', // Exxon Mobil
  '0000093410', // Chevron
  '0000858470', // ConocoPhillips
  '0000076334', // Pioneer Natural Resources
  '0000004447', // Hess
  '0001163165', // Devon Energy
  '0000047217', // EOG Resources
  // ── Consumer ──
  '0000021344', // Coca-Cola
  '0000077476', // PepsiCo
  '0000080424', // Procter & Gamble
  '0000050863', // Intel
  '0000354950', // Home Depot
  '0000060714', // Lockheed Martin
  '0000886158', // Lowes
  '0000027419', // Costco
  '0001018840', // Dollar General
  '0000764478', // Starbucks
  '0001012100', // Nike
  '0001065280', // Netflix
  '0001324424', // Disney
  '0000040545', // General Electric
  // ── Industrials ──
  '0000310764', // Caterpillar
  '0000049826', // Honeywell
  '0000034903', // 3M
  '0000030554', // Deere & Co
  '0000091142', // Union Pacific
  '0000813672', // FedEx
  '0001090727', // UPS
  // ── Telecom / Media ──
  '0000732717', // AT&T
  '0000068505', // Verizon
  '0001166691', // Comcast
  '0001288776', // T-Mobile
  '0001265107', // Charter Communications
  // ── Real Estate ──
  '0000783280', // Simon Property Group
  '0001070750', // American Tower
  '0001051470', // Crown Castle
  '0000726728', // Prologis
  '0001474098', // Digital Realty
  // ── Utilities ──
  '0000072741', // NextEra Energy
  '0000812074', // Southern Company
  '0000024545', // Duke Energy
  '0000027904', // Dominion Energy
  // ── Misc Large-Cap ──
  '0000004281', // Adobe
  '0000796343', // Salesforce
  '0001403568', // Fortinet
  '0001442145', // Okta
  '0001689923', // Zscaler
  '0001555280', // ZoomVideo
  '0001535527', // Twilio
  '0001477333', // CrowdStrike (duplicate removed — already above)
  '0000816761', // Accenture
  '0000109198', // Walmart
  '0000804328', // Target
  '0000320187', // General Motors
  '0000037996', // Ford
  '0001800227', // Rivian
  '0001628280', // Airbnb
  '0001121788', // DoorDash
  '0001647639', // Lyft
  '0001543151', // Pinterest
  '0001564708', // Chewy
  // ── Biotech / Life Sciences ──
  '0000885590', // Gilead Sciences
  '0000815094', // Biogen
  '0001543018', // Sarepta Therapeutics
  '0001399529', // Vertex Pharmaceuticals
  '0001630983', // BioNTech
  '0000717423', // Illumina
  '0000818686', // Edwards Lifesciences
  '0000895456', // Boston Scientific
  // ── Cybersecurity / Enterprise Software ──
  '0001160791', // Palo Alto Networks
  '0000912057', // Check Point
  '0001688568', // SentinelOne
  '0001410384', // Elastic
  '0001313167', // Splunk
  '0001529628', // Atlassian
  '0000877890', // Intuit
  '0001571123', // Veeva Systems
  '0000899629', // Akamai
  '0001366868', // Cloudflare
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
 * Historical backfill: Fetch filings from TOP_COMPANY_CIKS via the submissions API.
 * Unlike the main fetcher, this always starts from 5 years ago for broader coverage.
 * Processes in batches to stay within Cloud Run timeout limits.
 *
 * @param batchIndex — which batch of companies to process (0-based). Each batch = 30 companies.
 *   Allows multiple cron invocations to cover all 150+ companies without timeout.
 */
export async function fetchEdgarHistoricalBackfill(
  supabase: SupabaseClient,
  batchIndex = 0,
): Promise<{
  inserted: number;
  skipped: number;
  errors: number;
  batchIndex: number;
  totalBatches: number;
  companiesProcessed: number;
}> {
  // Check switchboard flag
  const { data: enabled } = await supabase.rpc('get_flag', {
    p_flag_key: 'ENABLE_PUBLIC_RECORDS_INGESTION',
  });
  if (!enabled) {
    logger.info('ENABLE_PUBLIC_RECORDS_INGESTION is disabled — skipping EDGAR backfill');
    return { inserted: 0, skipped: 0, errors: 0, batchIndex, totalBatches: 0, companiesProcessed: 0 };
  }

  const BATCH_COMPANY_SIZE = 30; // Process 30 companies per invocation (~4 min)
  const totalBatches = Math.ceil(TOP_COMPANY_CIKS.length / BATCH_COMPANY_SIZE);
  const startIdx = batchIndex * BATCH_COMPANY_SIZE;
  const endIdx = Math.min(startIdx + BATCH_COMPANY_SIZE, TOP_COMPANY_CIKS.length);
  const batchCIKs = TOP_COMPANY_CIKS.slice(startIdx, endIdx);

  if (batchCIKs.length === 0) {
    logger.info({ batchIndex, totalBatches }, 'EDGAR backfill: batch index out of range');
    return { inserted: 0, skipped: 0, errors: 0, batchIndex, totalBatches, companiesProcessed: 0 };
  }

  const fiveYearsAgo = new Date();
  fiveYearsAgo.setFullYear(fiveYearsAgo.getFullYear() - 5);
  const startDate = fiveYearsAgo.toISOString().slice(0, 10);

  logger.info({
    startDate,
    batchIndex,
    totalBatches,
    companiesInBatch: batchCIKs.length,
    startCompany: batchCIKs[0],
    endCompany: batchCIKs[batchCIKs.length - 1],
  }, 'Starting EDGAR historical backfill batch');

  // Temporarily override the CIK list for this batch
  const originalCIKs = [...TOP_COMPANY_CIKS];
  TOP_COMPANY_CIKS.length = 0;
  TOP_COMPANY_CIKS.push(...batchCIKs);

  const result = await fetchEdgarViaSubmissionsApi(supabase, 'ALL', startDate);

  // Restore full list
  TOP_COMPANY_CIKS.length = 0;
  TOP_COMPANY_CIKS.push(...originalCIKs);

  logger.info({
    ...result,
    batchIndex,
    totalBatches,
    companiesProcessed: batchCIKs.length,
  }, 'EDGAR historical backfill batch complete');

  return {
    ...result,
    batchIndex,
    totalBatches,
    companiesProcessed: batchCIKs.length,
  };
}

// ─── BULK EDGAR INGESTION ────────────────────────────────────────────────────
// Year-sharded EFTS queries with batch upserts for 2M+ target.
// Bypasses the 10K EFTS result cap by querying each form type per year (or month
// for high-volume types like 8-K, 4, D).

/** Form types that exceed 10K filings/year — need monthly sharding */
const HIGH_VOLUME_FORMS = new Set(['8-K', '8-K/A', '4', '3', '5', 'D', 'D/A']);

/** Max records per batch insert (Supabase/PostgREST limit) */
const BULK_INSERT_BATCH = 500;

interface BulkIngestionResult {
  inserted: number;
  skipped: number;
  errors: number;
  queriesRun: number;
  formType: string;
  yearRange: string;
}

/**
 * Bulk EDGAR ingestion via EFTS with year-sharding.
 *
 * For each form type × year (or month), queries EFTS up to 10K results,
 * then batch-upserts into public_records with ON CONFLICT DO NOTHING.
 *
 * @param formTypes — which form types to ingest (defaults to BULK_FILING_TYPES)
 * @param startYear — earliest year (defaults to 1993, EDGAR inception)
 * @param endYear — latest year (defaults to current year)
 * @param maxQueriesPerInvocation — throttle to stay within Cloud Run timeout (~8 min)
 */
export async function fetchEdgarBulk(
  supabase: SupabaseClient,
  options: {
    formTypes?: string[];
    startYear?: number;
    endYear?: number;
    maxQueriesPerInvocation?: number;
  } = {},
): Promise<{
  inserted: number;
  skipped: number;
  errors: number;
  queriesRun: number;
  formTypesProcessed: string[];
}> {
  // Check switchboard flag
  const { data: enabled } = await supabase.rpc('get_flag', {
    p_flag_key: 'ENABLE_PUBLIC_RECORDS_INGESTION',
  });
  if (!enabled) {
    logger.info('ENABLE_PUBLIC_RECORDS_INGESTION is disabled — skipping bulk EDGAR');
    return { inserted: 0, skipped: 0, errors: 0, queriesRun: 0, formTypesProcessed: [] };
  }

  const formTypes = options.formTypes ?? BULK_FILING_TYPES;
  const currentYear = new Date().getFullYear();
  const startYear = options.startYear ?? 1993;
  const endYear = options.endYear ?? currentYear;
  const maxQueries = options.maxQueriesPerInvocation ?? 200; // ~200 queries × 150ms ≈ 30s of API time

  let totalInserted = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  let queriesRun = 0;
  const processedTypes: Set<string> = new Set();

  // Auto-resume: find years already fully ingested per form type to skip them
  // Query: count filings per form_type per year for the edgar source
  const { data: existingCounts } = await supabase.rpc('get_edgar_shard_counts');
  const shardCounts = new Map<string, number>();
  if (existingCounts && Array.isArray(existingCounts)) {
    for (const row of existingCounts as Array<{ form_type: string; filing_year: number; cnt: number }>) {
      shardCounts.set(`${row.form_type}:${row.filing_year}`, row.cnt);
    }
  }

  // Minimum records to consider a shard "done" — skip if already has this many
  const SHARD_SKIP_THRESHOLD = 50;

  logger.info({
    formTypes: formTypes.length,
    startYear,
    endYear,
    maxQueries,
    existingShards: shardCounts.size,
  }, 'Starting bulk EDGAR ingestion (with shard-skip resume)');

  for (const formType of formTypes) {
    if (queriesRun >= maxQueries) {
      logger.info({ queriesRun, maxQueries }, 'Bulk EDGAR: hit query limit, stopping');
      break;
    }

    const isHighVolume = HIGH_VOLUME_FORMS.has(formType);

    for (let year = endYear; year >= startYear; year--) {
      if (queriesRun >= maxQueries) break;

      // Skip shards that already have enough records (auto-resume)
      const existingCount = shardCounts.get(`${formType}:${year}`) ?? 0;
      if (existingCount >= SHARD_SKIP_THRESHOLD) {
        continue; // Already ingested this shard
      }

      if (isHighVolume) {
        // Monthly shards for high-volume forms
        for (let month = 12; month >= 1; month--) {
          if (queriesRun >= maxQueries) break;
          const startdt = `${year}-${String(month).padStart(2, '0')}-01`;
          const enddt = month === 12
            ? `${year + 1}-01-01`
            : `${year}-${String(month + 1).padStart(2, '0')}-01`;

          const result = await fetchEftsShard(supabase, formType, startdt, enddt);
          totalInserted += result.inserted;
          totalSkipped += result.skipped;
          totalErrors += result.errors;
          queriesRun += result.queriesRun;
          processedTypes.add(formType);
        }
      } else {
        // Yearly shard for normal-volume forms
        const startdt = `${year}-01-01`;
        const enddt = `${year + 1}-01-01`;

        const result = await fetchEftsShard(supabase, formType, startdt, enddt);
        totalInserted += result.inserted;
        totalSkipped += result.skipped;
        totalErrors += result.errors;
        queriesRun += result.queriesRun;
        processedTypes.add(formType);
      }
    }
  }

  logger.info({
    totalInserted,
    totalSkipped,
    totalErrors,
    queriesRun,
    formTypesProcessed: [...processedTypes],
  }, 'Bulk EDGAR ingestion complete');

  return {
    inserted: totalInserted,
    skipped: totalSkipped,
    errors: totalErrors,
    queriesRun,
    formTypesProcessed: [...processedTypes],
  };
}

/**
 * Fetch a single EFTS shard (one form type × one date range).
 * Paginates through up to 10K results and batch-upserts.
 */
async function fetchEftsShard(
  supabase: SupabaseClient,
  formType: string,
  startdt: string,
  enddt: string,
): Promise<BulkIngestionResult> {
  let inserted = 0;
  let skipped = 0;
  let errors = 0;
  let queriesRun = 0;
  let from = 0;
  let hasMore = true;

  while (hasMore) {
    const params = new URLSearchParams({
      forms: formType,
      dateRange: 'custom',
      startdt,
      enddt,
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
      queriesRun++;
    } catch (err) {
      logger.error({ error: err, formType, startdt, enddt, from }, 'Bulk EDGAR EFTS request failed');
      errors++;
      break;
    }

    if (response.status === 429) {
      logger.warn({ formType, startdt }, 'Bulk EDGAR rate limited — backing off 10s');
      await delay(10_000);
      continue; // Retry same request
    }

    if (!response.ok) {
      logger.warn({ status: response.status, formType, startdt, enddt }, 'Bulk EDGAR EFTS error — skipping shard');
      errors++;
      break;
    }

    let result: EdgarSearchResult;
    try {
      result = (await response.json()) as EdgarSearchResult;
    } catch {
      logger.error({ formType, startdt, from }, 'Failed to parse bulk EDGAR response');
      errors++;
      break;
    }

    const hits = result.hits?.hits ?? [];
    if (hits.length === 0) {
      hasMore = false;
      break;
    }

    const totalHits = result.hits?.total?.value ?? 0;

    // Build batch of records
    const records: Array<{
      source: string;
      source_id: string;
      source_url: string;
      record_type: string;
      title: string;
      content_hash: string;
      metadata: Record<string, unknown>;
    }> = [];

    for (const hit of hits) {
      const src = hit._source;
      const entityName = src.entity_name
        || (src.display_names?.[0]?.split(/\s{2,}/)?.[0]?.trim())
        || 'Unknown Entity';
      const formTypeValue = src.form_type || formType;
      const fileDate = src.file_date || '';
      const cik = src.ciks?.[0] ?? '';

      const contentForHash = JSON.stringify({
        accession: hit._id,
        form_type: formTypeValue,
        entity_name: entityName,
        file_date: fileDate,
      });

      const accessionClean = hit._id.replace(/-/g, '');

      records.push({
        source: 'edgar',
        source_id: hit._id,
        source_url: `https://www.sec.gov/Archives/edgar/data/${cik.replace(/^0+/, '')}/${accessionClean}/${hit._id}-index.htm`,
        record_type: 'sec_filing',
        title: `${entityName} — ${formTypeValue} (${fileDate})`,
        content_hash: computeContentHash(contentForHash),
        metadata: {
          form_type: formTypeValue,
          entity_name: entityName,
          filing_date: fileDate,
          period_of_report: src.period_of_report ?? null,
          tickers: src.tickers ?? [],
          ciks: src.ciks ?? [],
          display_names: src.display_names ?? [],
          file_description: src.file_description ?? null,
        },
      });
    }

    // Batch upsert — ON CONFLICT (source, source_id) DO NOTHING
    for (let i = 0; i < records.length; i += BULK_INSERT_BATCH) {
      const batch = records.slice(i, i + BULK_INSERT_BATCH);
      const { error: insertError, count } = await supabase
        .from('public_records')
        .upsert(batch, { onConflict: 'source,source_id', ignoreDuplicates: true, count: 'exact' });

      if (insertError) {
        logger.error({ error: insertError, formType, startdt, batchSize: batch.length }, 'Bulk EDGAR batch insert failed');
        errors += batch.length;
      } else {
        const insertedCount = count ?? batch.length;
        inserted += insertedCount;
        skipped += batch.length - insertedCount;
      }
    }

    if (from === 0 && totalHits > 0) {
      logger.info({ formType, startdt, enddt, totalHits, batchInserted: records.length }, 'Bulk EDGAR shard started');
    }

    from += hits.length;
    if (from >= totalHits || from >= 9800 || hits.length < BATCH_SIZE) {
      hasMore = false;
    }

    // Rate limit compliance
    await delay(EDGAR_RATE_LIMIT_MS);
  }

  return { inserted, skipped, errors, queriesRun, formType, yearRange: `${startdt}→${enddt}` };
}
