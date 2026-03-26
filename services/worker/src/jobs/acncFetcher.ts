/**
 * ACNC Registered Charities Fetcher
 *
 * Fetches registered charities from the Australian Charities and
 * Not-for-profits Commission (ACNC) via the data.gov.au CKAN
 * Datastore API.
 *
 * API: https://data.gov.au/data/api/3/action/datastore_search
 * Resource: 8fb32972-24e9-4c95-885e-7140be51be8a (ACNC main register)
 * Auth: None required (public dataset)
 * Rate limit: Respectful usage (~2 req/sec)
 * Records: ~60,000+ registered charities
 *
 * Why anchor this: Charity verification — proves an entity was
 * registered with ACNC at a point in time. Critical for Australian
 * regulatory compliance and donor due diligence.
 */

import { createHash } from 'node:crypto';
import { logger } from '../utils/logger.js';
import type { SupabaseClient } from '@supabase/supabase-js';

/** CKAN Datastore API for ACNC register */
const ACNC_DATASTORE_URL = 'https://data.gov.au/data/api/3/action/datastore_search';

/** ACNC main register resource ID on data.gov.au */
const ACNC_RESOURCE_ID = '8fb32972-24e9-4c95-885e-7140be51be8a';

const RATE_LIMIT_MS = 500;
const PAGE_SIZE = 100;
const MAX_PAGES_PER_RUN = 50; // 5,000 records per run — fits Cloud Run timeout

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbAny = (db: SupabaseClient) => db as any;

interface AcncRecord {
  _id: number;
  ABN: string;
  Charity_Legal_Name: string;
  Other_Organisation_Names: string | null;
  Address_Type: string | null;
  Address_Line_1: string | null;
  Town_City: string | null;
  State: string | null;
  Postcode: string | null;
  Country: string | null;
  Charity_Website: string | null;
  Registration_Date: string | null;
  Date_Organisation_Established: string | null;
  Charity_Size: string | null;
  Number_of_Responsible_Persons: string | null;
  PBI: string | null;
  Advancing_Education: string | null;
  Advancing_Health: string | null;
  Advancing_Religion: string | null;
  Advancing_social_or_public_welfare: string | null;
  Advancing_Culture: string | null;
  Operating_Countries: string | null;
  [key: string]: unknown;
}

interface CkanDatastoreResponse {
  success: boolean;
  result: {
    records: AcncRecord[];
    total: number;
    _links?: {
      next?: string;
    };
  };
}

function computeContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Build purposes list from ACNC boolean flags */
function buildPurposes(record: AcncRecord): string[] {
  const purposes: string[] = [];
  if (record.Advancing_Education === 'Y') purposes.push('Advancing Education');
  if (record.Advancing_Health === 'Y') purposes.push('Advancing Health');
  if (record.Advancing_Religion === 'Y') purposes.push('Advancing Religion');
  if (record.Advancing_social_or_public_welfare === 'Y') purposes.push('Advancing Social/Public Welfare');
  if (record.Advancing_Culture === 'Y') purposes.push('Advancing Culture');
  if (record.PBI === 'Y') purposes.push('Public Benevolent Institution');
  return purposes;
}

async function insertCharity(
  supabase: SupabaseClient,
  charity: AcncRecord,
): Promise<'inserted' | 'skipped' | 'error'> {
  const abn = (charity.ABN ?? '').replace(/\s/g, '');
  if (!abn) return 'skipped';

  const sourceId = `acnc-${abn}`;

  // Check for duplicates
  const { data: existing } = await dbAny(supabase)
    .from('public_records')
    .select('id')
    .eq('source', 'acnc')
    .eq('source_id', sourceId)
    .limit(1);

  if (existing && existing.length > 0) {
    return 'skipped';
  }

  const contentForHash = JSON.stringify({
    abn,
    name: charity.Charity_Legal_Name,
    state: charity.State,
    size: charity.Charity_Size,
    registration_date: charity.Registration_Date,
  });

  const address = [charity.Address_Line_1, charity.Town_City, charity.State, charity.Postcode]
    .filter(Boolean)
    .join(', ');

  const purposes = buildPurposes(charity);

  const { error: insertError } = await dbAny(supabase)
    .from('public_records')
    .insert({
      source: 'acnc',
      source_id: sourceId,
      source_url: `https://www.acnc.gov.au/charity/charities?search=${abn}`,
      record_type: 'charity_registration',
      title: `${charity.Charity_Legal_Name} — ABN ${abn}`,
      content_hash: computeContentHash(contentForHash),
      metadata: {
        abn,
        charity_legal_name: charity.Charity_Legal_Name,
        other_names: charity.Other_Organisation_Names ?? null,
        address: address || null,
        state: charity.State ?? null,
        postcode: charity.Postcode ?? null,
        country: charity.Country ?? 'Australia',
        website: charity.Charity_Website ?? null,
        registration_date: charity.Registration_Date ?? null,
        date_established: charity.Date_Organisation_Established ?? null,
        charity_size: charity.Charity_Size ?? null,
        responsible_persons: charity.Number_of_Responsible_Persons ?? null,
        pbi: charity.PBI === 'Y',
        purposes,
        operating_countries: charity.Operating_Countries ?? null,
        pipeline_source: 'acnc',
        registry: 'Australian Charities and Not-for-profits Commission',
        jurisdiction: 'AU',
      },
    });

  if (insertError) {
    if (insertError.code === '23505') {
      return 'skipped';
    }
    logger.error({ sourceId, error: insertError }, 'ACNC insert failed');
    return 'error';
  }
  return 'inserted';
}

/**
 * Fetch a specific charity by ABN from ACNC register.
 * Used for targeted lookups (e.g., investor demos).
 */
export async function fetchAcncByAbn(
  supabase: SupabaseClient,
  abn: string,
): Promise<{ inserted: number; skipped: number; errors: number }> {
  const cleanAbn = abn.replace(/\s/g, '');
  logger.info({ abn: cleanAbn }, 'Fetching specific ACNC charity by ABN');

  const url = `${ACNC_DATASTORE_URL}?resource_id=${ACNC_RESOURCE_ID}&q=${cleanAbn}&limit=10`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        'User-Agent': 'Arkova/1.0 (contact@arkova.ai)',
        'Accept': 'application/json',
      },
    });
  } catch (err) {
    logger.error({ error: err, abn: cleanAbn }, 'ACNC API request failed');
    return { inserted: 0, skipped: 0, errors: 1 };
  }

  if (!response.ok) {
    logger.error({ status: response.status, abn: cleanAbn }, 'ACNC API returned error');
    return { inserted: 0, skipped: 0, errors: 1 };
  }

  const data = (await response.json()) as CkanDatastoreResponse;
  if (!data.success || !data.result?.records?.length) {
    logger.warn({ abn: cleanAbn }, 'No ACNC records found for ABN');
    return { inserted: 0, skipped: 0, errors: 0 };
  }

  let inserted = 0;
  let skipped = 0;
  let errors = 0;

  for (const record of data.result.records) {
    const result = await insertCharity(supabase, record);
    if (result === 'inserted') inserted++;
    else if (result === 'skipped') skipped++;
    else errors++;
  }

  logger.info({ abn: cleanAbn, inserted, skipped, errors }, 'ACNC ABN fetch complete');
  return { inserted, skipped, errors };
}

/**
 * Bulk fetch ACNC registered charities.
 * Uses pagination with resumable batching (same pattern as DAPIP).
 */
export async function fetchAcncCharities(supabase: SupabaseClient): Promise<{
  inserted: number;
  skipped: number;
  errors: number;
}> {
  // Check switchboard flag
  const { data: enabled } = await supabase.rpc('get_flag', {
    p_flag_key: 'ENABLE_PUBLIC_RECORDS_INGESTION',
  });
  if (!enabled) {
    logger.info('ENABLE_PUBLIC_RECORDS_INGESTION disabled — skipping ACNC fetch');
    return { inserted: 0, skipped: 0, errors: 0 };
  }

  let totalInserted = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  // Resume from where we left off
  const { count: existingCount } = await dbAny(supabase)
    .from('public_records')
    .select('id', { count: 'exact', head: true })
    .eq('source', 'acnc');

  const startOffset = existingCount ?? 0;

  // First request to get total count
  const firstUrl = `${ACNC_DATASTORE_URL}?resource_id=${ACNC_RESOURCE_ID}&limit=${PAGE_SIZE}&offset=${startOffset}`;
  const firstResp = await fetch(firstUrl, {
    headers: {
      'User-Agent': 'Arkova/1.0 (contact@arkova.ai)',
      'Accept': 'application/json',
    },
  });

  if (!firstResp.ok) {
    logger.error({ status: firstResp.status }, 'ACNC initial fetch failed');
    return { inserted: 0, skipped: 0, errors: 1 };
  }

  const firstData = (await firstResp.json()) as CkanDatastoreResponse;
  const totalRecords = firstData.result?.total ?? 0;
  const endOffset = Math.min(startOffset + MAX_PAGES_PER_RUN * PAGE_SIZE, totalRecords);
  const isComplete = endOffset >= totalRecords;

  logger.info(
    { totalRecords, startOffset, endOffset, existingCount, isComplete },
    'ACNC fetch starting (resumable batch)',
  );

  // Process first page
  for (const charity of firstData.result?.records ?? []) {
    const result = await insertCharity(supabase, charity);
    if (result === 'inserted') totalInserted++;
    else if (result === 'skipped') totalSkipped++;
    else totalErrors++;
  }

  // Process remaining pages in this batch
  for (let offset = startOffset + PAGE_SIZE; offset < endOffset; offset += PAGE_SIZE) {
    await delay(RATE_LIMIT_MS);
    try {
      const url = `${ACNC_DATASTORE_URL}?resource_id=${ACNC_RESOURCE_ID}&limit=${PAGE_SIZE}&offset=${offset}`;
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Arkova/1.0 (contact@arkova.ai)',
          'Accept': 'application/json',
        },
      });

      if (!response.ok) {
        logger.warn({ offset, status: response.status }, 'ACNC page request failed');
        totalErrors++;
        continue;
      }

      const data = (await response.json()) as CkanDatastoreResponse;
      for (const charity of data.result?.records ?? []) {
        const result = await insertCharity(supabase, charity);
        if (result === 'inserted') totalInserted++;
        else if (result === 'skipped') totalSkipped++;
        else totalErrors++;
      }

      const page = Math.floor((offset - startOffset) / PAGE_SIZE) + 1;
      if (page % 10 === 0) {
        logger.info(
          { offset, endOffset, totalRecords, inserted: totalInserted, skipped: totalSkipped, errors: totalErrors },
          'ACNC fetch progress',
        );
      }
    } catch (err) {
      logger.error({ offset, error: err }, 'ACNC page fetch failed');
      totalErrors++;
    }
  }

  logger.info(
    { totalInserted, totalSkipped, totalErrors, totalRecords, startOffset, endOffset, isComplete },
    isComplete ? 'ACNC fetch complete (all records processed)' : 'ACNC fetch batch complete (more records remaining)',
  );
  return { inserted: totalInserted, skipped: totalSkipped, errors: totalErrors };
}
