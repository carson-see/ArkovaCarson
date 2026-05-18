/**
 * MOH Singapore Healthcare Provider Fetcher
 *
 * Fetches healthcare facility and provider data from the Ministry of
 * Health (MOH) Singapore via the data.gov.sg CKAN Datastore API.
 *
 * API: https://data.gov.sg/api/action/datastore_search
 * Resource: d_64ee6a62af10a4761adb3b4a64e74c4e (licensed healthcare institutions)
 * Auth: None required (public dataset)
 * Rate limit: Respectful usage (~3 req/sec)
 *
 * Why anchor this: Healthcare provider verification — proves a
 * facility was licensed by MOH Singapore at a point in time.
 * Critical for healthcare credential verification in Singapore.
 */

import { logger } from '../utils/logger.js';
import { computeContentHash, delay, isIngestionEnabled } from '../utils/pipeline.js';
import type { SupabaseClient } from '@supabase/supabase-js';

/** CKAN Datastore API for MOH register */
const MOH_DATASTORE_URL = 'https://data.gov.sg/api/action/datastore_search';

/** MOH licensed healthcare institutions resource ID on data.gov.sg */
const MOH_RESOURCE_ID = 'd_64ee6a62af10a4761adb3b4a64e74c4e';

const RATE_LIMIT_MS = 300;
const PAGE_SIZE = 100;
const MAX_PAGES_PER_RUN = 50; // 5,000 records per run

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbAny = (db: SupabaseClient) => db as any;

interface MohRecord {
  _id: number;
  licence_no?: string;
  hci_name?: string;
  hci_code?: string;
  premises_address?: string;
  postal_code?: string;
  licence_type?: string;
  licence_status?: string;
  licensee_name?: string;
  effective_date?: string;
  expiry_date?: string;
  [key: string]: unknown;
}

interface CkanDatastoreResponse {
  success: boolean;
  result: {
    records: MohRecord[];
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

async function insertProvider(
  supabase: SupabaseClient,
  record: MohRecord,
): Promise<'inserted' | 'skipped' | 'error'> {
  const licenceNo = (record.licence_no ?? record.hci_code ?? '').trim();
  if (!licenceNo) return 'skipped';

  const sourceId = `moh-sg-${licenceNo}`;

  // Check for duplicates
  const { data: existing } = await dbAny(supabase)
    .from('public_records')
    .select('id')
    .eq('source', 'moh_sg')
    .eq('source_id', sourceId)
    .limit(1);

  if (existing && existing.length > 0) {
    return 'skipped';
  }

  const name = record.hci_name ?? record.licensee_name ?? 'Unknown Provider';

  const contentForHash = JSON.stringify({
    licence_no: licenceNo,
    name,
    licence_type: record.licence_type,
    licence_status: record.licence_status,
    effective_date: record.effective_date,
    expiry_date: record.expiry_date,
  });

  const { error: insertError } = await dbAny(supabase)
    .from('public_records')
    .insert({
      source: 'moh_sg',
      source_id: sourceId,
      source_url: 'https://www.moh.gov.sg/licensing-and-regulation/healthcare-institutions',
      record_type: 'healthcare_provider',
      title: `${name} — Licence ${licenceNo}`,
      content_hash: computeContentHash(contentForHash),
      metadata: {
        licence_no: licenceNo,
        hci_name: record.hci_name ?? null,
        hci_code: record.hci_code ?? null,
        premises_address: record.premises_address ?? null,
        postal_code: record.postal_code ?? null,
        licence_type: record.licence_type ?? null,
        licence_status: record.licence_status ?? null,
        licensee_name: record.licensee_name ?? null,
        effective_date: record.effective_date ?? null,
        expiry_date: record.expiry_date ?? null,
        pipeline_source: 'moh_sg',
        registry: 'Ministry of Health Singapore',
        jurisdiction: 'SG',
      },
    });

  if (insertError) {
    if (insertError.code === '23505') {
      return 'skipped';
    }
    logger.error({ sourceId, error: insertError }, 'MOH SG insert failed');
    return 'error';
  }
  return 'inserted';
}

/**
 * Bulk fetch MOH Singapore licensed healthcare institutions.
 * Uses pagination with resumable batching (same pattern as ACNC).
 */
export async function fetchMohSgProviders(supabase: SupabaseClient): Promise<FetchResult> {
  if (!(await isIngestionEnabled(supabase))) {
    logger.info('ENABLE_PUBLIC_RECORDS_INGESTION disabled — skipping MOH SG fetch');
    return { inserted: 0, skipped: 0, errors: 0 };
  }

  let totalInserted = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  // Resume from where we left off
  const { count: existingCount } = await dbAny(supabase)
    .from('public_records')
    .select('id', { count: 'exact', head: true })
    .eq('source', 'moh_sg');

  const startOffset = existingCount ?? 0;

  // First request to get total count
  const firstUrl = `${MOH_DATASTORE_URL}?resource_id=${MOH_RESOURCE_ID}&limit=${PAGE_SIZE}&offset=${startOffset}`;
  let firstResp: Response;
  try {
    firstResp = await fetch(firstUrl, {
      headers: {
        'User-Agent': 'Arkova/1.0 (contact@arkova.ai)',
        Accept: 'application/json',
      },
    });
  } catch (err) {
    logger.error({ error: err }, 'MOH SG initial fetch failed (network)');
    return { inserted: 0, skipped: 0, errors: 1 };
  }

  if (!firstResp.ok) {
    logger.error({ status: firstResp.status }, 'MOH SG initial fetch failed');
    return { inserted: 0, skipped: 0, errors: 1 };
  }

  const firstData = (await firstResp.json()) as CkanDatastoreResponse;
  if (!firstData.success) {
    logger.error('MOH SG API returned success=false');
    return { inserted: 0, skipped: 0, errors: 1 };
  }

  const totalRecords = firstData.result?.total ?? 0;
  const endOffset = Math.min(startOffset + MAX_PAGES_PER_RUN * PAGE_SIZE, totalRecords);
  const isComplete = endOffset >= totalRecords;

  logger.info(
    { totalRecords, startOffset, endOffset, existingCount, isComplete },
    'MOH SG fetch starting (resumable batch)',
  );

  // Process first page
  for (const record of firstData.result?.records ?? []) {
    const result = await insertProvider(supabase, record);
    if (result === 'inserted') totalInserted++;
    else if (result === 'skipped') totalSkipped++;
    else totalErrors++;
  }

  // Process remaining pages in this batch
  for (let offset = startOffset + PAGE_SIZE; offset < endOffset; offset += PAGE_SIZE) {
    await delay(RATE_LIMIT_MS);
    try {
      const url = `${MOH_DATASTORE_URL}?resource_id=${MOH_RESOURCE_ID}&limit=${PAGE_SIZE}&offset=${offset}`;
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Arkova/1.0 (contact@arkova.ai)',
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        logger.warn({ offset, status: response.status }, 'MOH SG page request failed');
        totalErrors++;
        continue;
      }

      const data = (await response.json()) as CkanDatastoreResponse;
      for (const record of data.result?.records ?? []) {
        const result = await insertProvider(supabase, record);
        if (result === 'inserted') totalInserted++;
        else if (result === 'skipped') totalSkipped++;
        else totalErrors++;
      }

      const page = Math.floor((offset - startOffset) / PAGE_SIZE) + 1;
      if (page % 10 === 0) {
        logger.info(
          { offset, endOffset, totalRecords, inserted: totalInserted, skipped: totalSkipped, errors: totalErrors },
          'MOH SG fetch progress',
        );
      }
    } catch (err) {
      logger.error({ offset, error: err }, 'MOH SG page fetch failed');
      totalErrors++;
    }
  }

  logger.info(
    { totalInserted, totalSkipped, totalErrors, totalRecords, startOffset, endOffset, isComplete },
    isComplete ? 'MOH SG fetch complete (all records processed)' : 'MOH SG fetch batch complete (more records remaining)',
  );
  return { inserted: totalInserted, skipped: totalSkipped, errors: totalErrors };
}
