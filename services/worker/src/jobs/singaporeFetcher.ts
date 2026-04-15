/**
 * ACRA Singapore Companies Fetcher
 *
 * Fetches registered business entities from the Accounting and
 * Corporate Regulatory Authority (ACRA) of Singapore via the
 * data.gov.sg CKAN Datastore API.
 *
 * API: https://data.gov.sg/api/action/datastore_search
 * Resource: d_3f960c10fed6145404ca7b821f263b87
 * Auth: None required (public dataset)
 * Rate limit: Respectful usage (~3 req/sec)
 * Records: Business registrations in Singapore
 *
 * Why anchor this: Business registration verification — proves a
 * company was registered with ACRA at a point in time. Critical for
 * Singapore regulatory compliance and KYB due diligence.
 */

import { logger } from '../utils/logger.js';
import { computeContentHash, delay, isIngestionEnabled } from '../utils/pipeline.js';
import type { SupabaseClient } from '@supabase/supabase-js';

/** CKAN Datastore API for ACRA register */
const ACRA_DATASTORE_URL = 'https://data.gov.sg/api/action/datastore_search';

/** ACRA company register resource ID on data.gov.sg */
const ACRA_RESOURCE_ID = 'd_3f960c10fed6145404ca7b821f263b87';

const RATE_LIMIT_MS = 300;
const PAGE_SIZE = 100;
const MAX_PAGES_PER_RUN = 50; // 5,000 records per run — fits Cloud Run timeout

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbAny = (db: SupabaseClient) => db as any;

interface AcraRecord {
  _id: number;
  uen: string;
  entity_name: string;
  entity_type_description?: string;
  registration_incorporation_date?: string;
  uen_status?: string;
  primary_ssic_description?: string;
  primary_ssic_code?: string;
  secondary_ssic_description?: string;
  secondary_ssic_code?: string;
  company_type?: string;
  [key: string]: unknown;
}

interface CkanDatastoreResponse {
  success: boolean;
  result: {
    records: AcraRecord[];
    total: number;
    _links?: {
      next?: string;
    };
  };
}

interface FetchResult {
  inserted: number;
  skipped: number;
  errors: number;
}

async function insertCompany(
  supabase: SupabaseClient,
  record: AcraRecord,
): Promise<'inserted' | 'skipped' | 'error'> {
  const uen = (record.uen ?? '').trim();
  if (!uen) return 'skipped';

  const sourceId = `acra-sg-${uen}`;

  // Check for duplicates
  const { data: existing } = await dbAny(supabase)
    .from('public_records')
    .select('id')
    .eq('source', 'acra_sg')
    .eq('source_id', sourceId)
    .limit(1);

  if (existing && existing.length > 0) {
    return 'skipped';
  }

  const contentForHash = JSON.stringify({
    uen,
    name: record.entity_name,
    type: record.entity_type_description,
    status: record.uen_status,
    registration_date: record.registration_incorporation_date,
  });

  const { error: insertError } = await dbAny(supabase)
    .from('public_records')
    .insert({
      source: 'acra_sg',
      source_id: sourceId,
      source_url: `https://www.acra.gov.sg/`,
      record_type: 'business_registration',
      title: `${record.entity_name} — UEN ${uen}`,
      content_hash: computeContentHash(contentForHash),
      metadata: {
        uen,
        entity_name: record.entity_name,
        entity_type: record.entity_type_description ?? null,
        registration_date: record.registration_incorporation_date ?? null,
        uen_status: record.uen_status ?? null,
        primary_ssic_code: record.primary_ssic_code ?? null,
        primary_ssic_description: record.primary_ssic_description ?? null,
        secondary_ssic_code: record.secondary_ssic_code ?? null,
        secondary_ssic_description: record.secondary_ssic_description ?? null,
        company_type: record.company_type ?? null,
        pipeline_source: 'acra_sg',
        registry: 'Accounting and Corporate Regulatory Authority (ACRA)',
        jurisdiction: 'SG',
      },
    });

  if (insertError) {
    if (insertError.code === '23505') {
      return 'skipped';
    }
    logger.error({ sourceId, error: insertError }, 'ACRA SG insert failed');
    return 'error';
  }
  return 'inserted';
}

/**
 * Bulk fetch ACRA Singapore registered companies.
 * Uses pagination with resumable batching (same pattern as ACNC).
 */
export async function fetchAcraSgCompanies(supabase: SupabaseClient): Promise<FetchResult> {
  if (!(await isIngestionEnabled(supabase))) {
    logger.info('ENABLE_PUBLIC_RECORDS_INGESTION disabled — skipping ACRA SG fetch');
    return { inserted: 0, skipped: 0, errors: 0 };
  }

  let totalInserted = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  // Resume from where we left off
  const { count: existingCount } = await dbAny(supabase)
    .from('public_records')
    .select('id', { count: 'exact', head: true })
    .eq('source', 'acra_sg');

  const startOffset = existingCount ?? 0;

  // First request to get total count
  const firstUrl = `${ACRA_DATASTORE_URL}?resource_id=${ACRA_RESOURCE_ID}&limit=${PAGE_SIZE}&offset=${startOffset}`;
  let firstResp: Response;
  try {
    firstResp = await fetch(firstUrl, {
      headers: {
        'User-Agent': 'Arkova/1.0 (contact@arkova.ai)',
        Accept: 'application/json',
      },
    });
  } catch (err) {
    logger.error({ error: err }, 'ACRA SG initial fetch failed (network)');
    return { inserted: 0, skipped: 0, errors: 1 };
  }

  if (!firstResp.ok) {
    logger.error({ status: firstResp.status }, 'ACRA SG initial fetch failed');
    return { inserted: 0, skipped: 0, errors: 1 };
  }

  const firstData = (await firstResp.json()) as CkanDatastoreResponse;
  if (!firstData.success) {
    logger.error('ACRA SG API returned success=false');
    return { inserted: 0, skipped: 0, errors: 1 };
  }

  const totalRecords = firstData.result?.total ?? 0;
  const endOffset = Math.min(startOffset + MAX_PAGES_PER_RUN * PAGE_SIZE, totalRecords);
  const isComplete = endOffset >= totalRecords;

  logger.info(
    { totalRecords, startOffset, endOffset, existingCount, isComplete },
    'ACRA SG fetch starting (resumable batch)',
  );

  // Process first page
  for (const record of firstData.result?.records ?? []) {
    const result = await insertCompany(supabase, record);
    if (result === 'inserted') totalInserted++;
    else if (result === 'skipped') totalSkipped++;
    else totalErrors++;
  }

  // Process remaining pages in this batch
  for (let offset = startOffset + PAGE_SIZE; offset < endOffset; offset += PAGE_SIZE) {
    await delay(RATE_LIMIT_MS);
    try {
      const url = `${ACRA_DATASTORE_URL}?resource_id=${ACRA_RESOURCE_ID}&limit=${PAGE_SIZE}&offset=${offset}`;
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Arkova/1.0 (contact@arkova.ai)',
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        logger.warn({ offset, status: response.status }, 'ACRA SG page request failed');
        totalErrors++;
        continue;
      }

      const data = (await response.json()) as CkanDatastoreResponse;
      for (const record of data.result?.records ?? []) {
        const result = await insertCompany(supabase, record);
        if (result === 'inserted') totalInserted++;
        else if (result === 'skipped') totalSkipped++;
        else totalErrors++;
      }

      const page = Math.floor((offset - startOffset) / PAGE_SIZE) + 1;
      if (page % 10 === 0) {
        logger.info(
          { offset, endOffset, totalRecords, inserted: totalInserted, skipped: totalSkipped, errors: totalErrors },
          'ACRA SG fetch progress',
        );
      }
    } catch (err) {
      logger.error({ offset, error: err }, 'ACRA SG page fetch failed');
      totalErrors++;
    }
  }

  logger.info(
    { totalInserted, totalSkipped, totalErrors, totalRecords, startOffset, endOffset, isComplete },
    isComplete ? 'ACRA SG fetch complete (all records processed)' : 'ACRA SG fetch batch complete (more records remaining)',
  );
  return { inserted: totalInserted, skipped: totalSkipped, errors: totalErrors };
}
