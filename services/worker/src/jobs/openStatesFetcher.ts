/**
 * Open States Legislation Fetcher Job
 *
 * Fetches state-level bills and legislation from the Open States API (v3/GraphQL).
 * Covers all 50 US states + DC + PR. Starting with CA, NY, TX.
 *
 * Open States API:
 *   - Free, open-source project by Civic Eagle / Plural
 *   - Auth: API key (required, free tier generous)
 *   - GraphQL endpoint: https://v3.openstates.org/graphql
 *   - REST alternative: https://v3.openstates.org/bills
 *   - Rate limit: 6 req/sec with key
 *
 * Constitution 4A: Only metadata is stored (no full text).
 */

import { createHash } from 'node:crypto';
import { logger } from '../utils/logger.js';
import type { SupabaseClient } from '@supabase/supabase-js';

/** Open States REST API base */
const OS_API_URL = 'https://v3.openstates.org';

/** Rate limit: ~6 req/sec */
const OS_RATE_LIMIT_MS = 200;

/** Results per page (max 20 for Open States) */
const PER_PAGE = 20;

/** Max pages per state per run */
const MAX_PAGES_PER_STATE = 300;

/** Max records per batch insert */
const BULK_INSERT_BATCH = 500;

interface OSBill {
  id: string;
  identifier: string;
  title: string;
  session: string;
  classification: string[];
  subject: string[];
  from_organization: { name: string; classification: string } | null;
  jurisdiction: { id: string; name: string; classification: string };
  latest_action_date: string | null;
  latest_action_description: string | null;
  created_at: string;
  updated_at: string;
  openstates_url: string;
  abstracts: Array<{ abstract: string; note: string }>;
  sponsorships: Array<{ name: string; classification: string; primary: boolean }>;
}

interface OSBillsResponse {
  results: OSBill[];
  pagination: {
    per_page: number;
    page: number;
    max_page: number;
    total_items: number;
  };
}

function computeContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** State codes and their Open States jurisdiction IDs */
const STATE_JURISDICTIONS: Record<string, { name: string; jurisdictionId: string }> = {
  CA: { name: 'California', jurisdictionId: 'ocd-jurisdiction/country:us/state:ca/government' },
  NY: { name: 'New York', jurisdictionId: 'ocd-jurisdiction/country:us/state:ny/government' },
  TX: { name: 'Texas', jurisdictionId: 'ocd-jurisdiction/country:us/state:tx/government' },
  FL: { name: 'Florida', jurisdictionId: 'ocd-jurisdiction/country:us/state:fl/government' },
  IL: { name: 'Illinois', jurisdictionId: 'ocd-jurisdiction/country:us/state:il/government' },
};

/**
 * Fetch state bills from Open States REST API and insert into public_records.
 */
export async function fetchStateBills(
  supabase: SupabaseClient,
  options: {
    stateCode?: string;
    maxPages?: number;
    session?: string;
    updatedSince?: string;
  } = {},
): Promise<{
  inserted: number;
  skipped: number;
  errors: number;
  pagesProcessed: number;
}> {
  // Check switchboard flag
  const { data: enabled } = await supabase.rpc('get_flag', {
    p_flag_key: 'ENABLE_PUBLIC_RECORDS_INGESTION',
  });
  if (!enabled) {
    logger.info('ENABLE_PUBLIC_RECORDS_INGESTION is disabled — skipping Open States');
    return { inserted: 0, skipped: 0, errors: 0, pagesProcessed: 0 };
  }

  const apiKey = process.env.OPENSTATES_API_KEY;
  if (!apiKey) {
    logger.warn('OPENSTATES_API_KEY not set — skipping Open States fetch');
    return { inserted: 0, skipped: 0, errors: 0, pagesProcessed: 0 };
  }

  const stateCode = (options.stateCode ?? 'CA').toUpperCase();
  const stateConfig = STATE_JURISDICTIONS[stateCode];
  if (!stateConfig) {
    logger.error({ stateCode }, 'Unknown state code for Open States');
    return { inserted: 0, skipped: 0, errors: 0, pagesProcessed: 0 };
  }

  const maxPages = options.maxPages ?? MAX_PAGES_PER_STATE;
  const jurisdictionId = stateConfig.jurisdictionId;

  let totalInserted = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  let pagesProcessed = 0;

  // Auto-resume: calculate offset from existing records
  let startPage = 1;
  const { count: existingCount } = await supabase
    .from('public_records')
    .select('id', { count: 'exact', head: true })
    .eq('source', 'openstates')
    .ilike('source_id', `os-${stateCode.toLowerCase()}-%`);
  if (existingCount && existingCount > 0) {
    startPage = Math.floor(existingCount / PER_PAGE) + 1;
    logger.info({ existingCount, startPage, stateCode }, 'Open States auto-resume');
  }

  logger.info({ stateCode, state: stateConfig.name, maxPages, startPage }, 'Starting Open States fetch');

  for (let page = startPage; page < startPage + maxPages; page++) {
    const params = new URLSearchParams({
      jurisdiction: jurisdictionId,
      sort: 'updated_desc',
      per_page: String(PER_PAGE),
      page: String(page),
      include: 'abstracts,sponsorships',
    });
    if (options.session) params.set('session', options.session);
    if (options.updatedSince) params.set('updated_since', options.updatedSince);

    const url = `${OS_API_URL}/bills?${params.toString()}`;

    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          'X-API-KEY': apiKey,
          Accept: 'application/json',
          'User-Agent': 'Arkova/1.0 (contact@arkova.io)',
        },
      });
    } catch (err) {
      logger.error({ error: err, page, stateCode }, 'Open States API request failed');
      totalErrors++;
      break;
    }

    if (response.status === 429) {
      logger.warn('Open States rate limited — backing off 30s');
      await delay(30_000);
      continue;
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      logger.error({ status: response.status, page, body: body.slice(0, 200), stateCode }, 'Open States API error');
      totalErrors++;
      break;
    }
    pagesProcessed++;

    let result: OSBillsResponse;
    try {
      result = (await response.json()) as OSBillsResponse;
    } catch {
      logger.error({ page, stateCode }, 'Failed to parse Open States response');
      totalErrors++;
      break;
    }

    const bills = result.results ?? [];
    if (bills.length === 0) break;

    if (page % 50 === 0 || page === startPage) {
      logger.info({ page, count: bills.length, total: result.pagination.total_items, stateCode }, 'Open States progress');
    }

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

    for (const bill of bills) {
      const sourceId = `os-${stateCode.toLowerCase()}-${bill.identifier}-${bill.session}`;
      const title = `${bill.identifier}: ${bill.title} (${stateConfig.name} ${bill.session})`;

      const contentForHash = JSON.stringify({
        id: bill.id,
        identifier: bill.identifier,
        session: bill.session,
        state: stateCode,
        title: bill.title,
      });

      const primarySponsors = bill.sponsorships
        ?.filter((s) => s.primary)
        .map((s) => s.name) ?? [];

      records.push({
        source: 'openstates',
        source_id: sourceId,
        source_url: bill.openstates_url || `https://openstates.org/${bill.jurisdiction?.id?.split('/').pop()}/bills/${bill.session}/${bill.identifier}/`,
        record_type: 'legislation',
        title,
        content_hash: computeContentHash(contentForHash),
        metadata: {
          bill_id: bill.id,
          identifier: bill.identifier,
          session: bill.session,
          state: stateCode,
          state_name: stateConfig.name,
          classification: bill.classification,
          subjects: bill.subject,
          primary_sponsors: primarySponsors,
          latest_action_date: bill.latest_action_date,
          latest_action: bill.latest_action_description,
          abstract: bill.abstracts?.[0]?.abstract?.slice(0, 2000) ?? null,
          chamber: bill.from_organization?.name ?? null,
          jurisdiction: `US-${stateCode}`,
        },
      });
    }

    // Batch upsert
    for (let i = 0; i < records.length; i += BULK_INSERT_BATCH) {
      const batch = records.slice(i, i + BULK_INSERT_BATCH);
      const { error: insertError, count } = await supabase
        .from('public_records')
        .upsert(batch, { onConflict: 'source,source_id', ignoreDuplicates: true, count: 'exact' });

      if (insertError) {
        logger.error({ error: insertError, batchSize: batch.length, stateCode }, 'Open States batch insert failed');
        totalErrors += batch.length;
      } else {
        const insertedCount = count ?? batch.length;
        totalInserted += insertedCount;
        totalSkipped += batch.length - insertedCount;
      }
    }

    // Stop if we've reached the last page
    if (page >= result.pagination.max_page) break;

    await delay(OS_RATE_LIMIT_MS);
  }

  logger.info(
    { totalInserted, totalSkipped, totalErrors, pagesProcessed, stateCode },
    `Open States ${stateConfig.name} fetch complete`,
  );

  return { inserted: totalInserted, skipped: totalSkipped, errors: totalErrors, pagesProcessed };
}

/**
 * Fetch bills from multiple states in sequence.
 */
export async function fetchMultipleStateBills(
  supabase: SupabaseClient,
  stateCodes: string[] = ['CA', 'NY', 'TX'],
  options: { maxPagesPerState?: number } = {},
): Promise<{
  totalInserted: number;
  totalSkipped: number;
  totalErrors: number;
  stateResults: Array<{ state: string; inserted: number; skipped: number; errors: number }>;
}> {
  let totalInserted = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  const stateResults: Array<{ state: string; inserted: number; skipped: number; errors: number }> = [];

  for (const stateCode of stateCodes) {
    const result = await fetchStateBills(supabase, {
      stateCode,
      maxPages: options.maxPagesPerState ?? MAX_PAGES_PER_STATE,
    });
    totalInserted += result.inserted;
    totalSkipped += result.skipped;
    totalErrors += result.errors;
    stateResults.push({ state: stateCode, inserted: result.inserted, skipped: result.skipped, errors: result.errors });
  }

  return { totalInserted, totalSkipped, totalErrors, stateResults };
}
