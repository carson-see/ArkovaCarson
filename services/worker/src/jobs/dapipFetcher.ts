/**
 * DAPIP Accredited Institutions Fetcher
 *
 * Fetches accredited postsecondary institutions from the U.S. Department
 * of Education DAPIP (Database of Accredited Postsecondary Institutions
 * and Programs) API.
 *
 * Free, public, no auth required.
 * ~43,000 institutions/sites in the database.
 * Data includes: institution name, type, address, active status.
 *
 * API base: https://surveys.ope.ed.gov/dapip/api/
 * Search endpoint: POST /search/advanced
 *
 * Why anchor this: Credential verification requires knowing whether
 * the issuing institution is legitimately accredited. This is the
 * foundation for diploma/degree verification.
 */

import { createHash } from 'node:crypto';
import { logger } from '../utils/logger.js';
import type { SupabaseClient } from '@supabase/supabase-js';

const DAPIP_SEARCH_URL = 'https://surveys.ope.ed.gov/dapip/api/search/advanced';
const RATE_LIMIT_MS = 300;
const PAGE_SIZE = 100;
const MAX_PAGES = 500; // Safety cap: 500 * 100 = 50K max
const MAX_PAGES_PER_RUN = 60; // ~6K records per run, fits within Cloud Run 5-min timeout

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbAny = (db: SupabaseClient) => db as any;

interface DapipSearchResult {
  unitid: number;
  opeID: string | null;
  institutionType: string;
  institutionName: string;
  address: string;
  city: string;
  state: string;
  hasHistory: boolean;
  activeStatus: string;
  additionalLocations: Array<{
    unitid: number;
    parentid: number;
    institutionName: string;
    address: string;
    city: string;
    state: string;
    activeStatus: string;
  }> | null;
}

interface DapipSearchResponse {
  results: DapipSearchResult[];
  AllUnitIds: number[];
  Criteria: Record<string, unknown>;
}

function computeContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function insertInstitution(
  supabase: SupabaseClient,
  inst: DapipSearchResult,
): Promise<'inserted' | 'skipped' | 'error'> {
  const sourceId = `dapip-${inst.unitid}`;

  // Check for duplicates
  const { data: existing } = await dbAny(supabase)
    .from('public_records')
    .select('id')
    .eq('source', 'dapip')
    .eq('source_id', sourceId)
    .limit(1);

  if (existing && existing.length > 0) {
    return 'skipped';
  }

  const contentForHash = JSON.stringify({
    id: inst.unitid,
    name: inst.institutionName,
    state: inst.state,
    type: inst.institutionType,
    status: inst.activeStatus,
  });

  const fullAddress = [inst.address, inst.city, inst.state]
    .filter(Boolean)
    .join(', ');

  const { error: insertError } = await dbAny(supabase)
    .from('public_records')
    .insert({
      source: 'dapip',
      source_id: sourceId,
      source_url: `https://ope.ed.gov/dapip/#/institution-profile/${inst.unitid}`,
      record_type: 'accreditation',
      title: `${inst.institutionName} — ${inst.activeStatus}`,
      content_hash: computeContentHash(contentForHash),
      metadata: {
        institution_name: inst.institutionName,
        institution_type: inst.institutionType,
        address: fullAddress || null,
        state: inst.state ?? null,
        ope_id: inst.opeID ?? null,
        active_status: inst.activeStatus,
        dapip_id: inst.unitid,
        pipeline_source: 'dapip',
      },
    });

  if (insertError) {
    if (insertError.code === '23505') {
      return 'skipped';
    }
    logger.error({ sourceId, error: insertError }, 'DAPIP insert failed');
    return 'error';
  }
  return 'inserted';
}

/**
 * Fetch accredited institutions from DAPIP.
 * Uses the advanced search endpoint with pagination.
 */
export async function fetchDapipInstitutions(supabase: SupabaseClient): Promise<{
  inserted: number;
  skipped: number;
  errors: number;
}> {
  // Check switchboard flag
  const { data: enabled } = await supabase.rpc('get_flag', {
    p_flag_key: 'ENABLE_PUBLIC_RECORDS_INGESTION',
  });
  if (!enabled) {
    logger.info('ENABLE_PUBLIC_RECORDS_INGESTION disabled — skipping DAPIP fetch');
    return { inserted: 0, skipped: 0, errors: 0 };
  }

  let totalInserted = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  // Resume from where we left off: count existing DAPIP records to calculate start page
  const { count: existingCount } = await dbAny(supabase)
    .from('public_records')
    .select('id', { count: 'exact', head: true })
    .eq('source', 'dapip');
  const startPage = Math.floor((existingCount ?? 0) / PAGE_SIZE) + 1;

  // First request to get total count
  const firstResp = await fetch(DAPIP_SEARCH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ PageSize: PAGE_SIZE, PageNumber: startPage }),
  });

  if (!firstResp.ok) {
    logger.error({ status: firstResp.status }, 'DAPIP initial search failed');
    return { inserted: 0, skipped: 0, errors: 1 };
  }

  const firstData = await firstResp.json() as DapipSearchResponse;
  const totalInstitutions = firstData.AllUnitIds?.length ?? 0;
  const totalPages = Math.min(Math.ceil(totalInstitutions / PAGE_SIZE), MAX_PAGES);
  const endPage = Math.min(startPage + MAX_PAGES_PER_RUN - 1, totalPages);
  const isComplete = endPage >= totalPages;

  logger.info(
    { totalInstitutions, totalPages, startPage, endPage, existingCount, isComplete },
    'DAPIP fetch starting (resumable batch)',
  );

  // Process first page of this batch
  for (const inst of firstData.results ?? []) {
    const result = await insertInstitution(supabase, inst);
    if (result === 'inserted') totalInserted++;
    else if (result === 'skipped') totalSkipped++;
    else totalErrors++;
  }

  // Process remaining pages in this batch
  for (let page = startPage + 1; page <= endPage; page++) {
    await delay(RATE_LIMIT_MS);
    try {
      const response = await fetch(DAPIP_SEARCH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ PageSize: PAGE_SIZE, PageNumber: page }),
      });

      if (!response.ok) {
        logger.warn({ page, status: response.status }, 'DAPIP page request failed');
        totalErrors++;
        continue;
      }

      const data = await response.json() as DapipSearchResponse;
      for (const inst of data.results ?? []) {
        const result = await insertInstitution(supabase, inst);
        if (result === 'inserted') totalInserted++;
        else if (result === 'skipped') totalSkipped++;
        else totalErrors++;
      }

      if (page % 10 === 0) {
        logger.info(
          { page, endPage, totalPages, inserted: totalInserted, skipped: totalSkipped, errors: totalErrors },
          'DAPIP fetch progress',
        );
      }
    } catch (err) {
      logger.error({ page, error: err }, 'DAPIP page fetch failed');
      totalErrors++;
    }
  }

  logger.info(
    { totalInserted, totalSkipped, totalErrors, totalInstitutions, startPage, endPage, isComplete },
    isComplete ? 'DAPIP fetch complete (all pages processed)' : 'DAPIP fetch batch complete (more pages remaining)',
  );
  return { inserted: totalInserted, skipped: totalSkipped, errors: totalErrors };
}
