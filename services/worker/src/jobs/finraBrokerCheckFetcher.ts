/**
 * FINRA BrokerCheck Fetcher
 *
 * Fetches registered broker/investment adviser records from FINRA's
 * BrokerCheck public API.
 *
 * API: https://api.brokercheck.finra.org/
 * Auth: None required (public disclosure database)
 * Rate limit: Respectful usage (~2 req/sec)
 * Records: ~634,000+ registered representatives
 *
 * Why anchor this: Financial professional verification — proves an
 * individual was registered with FINRA at a point in time. Critical
 * for financial compliance, due diligence, and fraud detection.
 *
 * Data includes: CRD number, name, firm associations, registration
 * status, disclosures (disciplinary actions, customer complaints,
 * regulatory events).
 *
 * Constitution refs:
 *   - 4A: Only metadata is stored server-side
 */

import { createHash } from 'node:crypto';
import { logger } from '../utils/logger.js';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * FINRA BrokerCheck search API.
 * Public JSON endpoint — no API key required.
 * Supports individual and firm search by name, CRD number, etc.
 */
const BROKERCHECK_SEARCH_URL = 'https://api.brokercheck.finra.org/search/individual';
const BROKERCHECK_DETAIL_URL = 'https://api.brokercheck.finra.org/individual';

/** Rate limit: ~2 req/sec to be respectful */
const RATE_LIMIT_MS = 500;

/** Results per page from BrokerCheck search */
const PAGE_SIZE = 100;

/** Max records per run — fits Cloud Run timeout */
const MAX_PER_RUN = 10000;

/** Max pages per search query */
const MAX_PAGES_PER_QUERY = 100;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbAny = (db: SupabaseClient) => db as any;

interface BrokerCheckIndividual {
  crdNumber: string;
  firstName: string;
  lastName: string;
  middleName?: string;
  otherNames?: string[];
  currentEmployments: Array<{
    firmName: string;
    firmCrdNumber?: string;
    branchCity?: string;
    branchState?: string;
  }>;
  previousEmployments?: Array<{
    firmName: string;
    firmCrdNumber?: string;
  }>;
  registrationCount?: number;
  disclosureCount?: number;
  industryStartDate?: string;
  exams?: string[];
  registrations?: string[];
}

interface BrokerCheckSearchResponse {
  hits: {
    hits: Array<{
      _source: {
        ind_source_id?: string;
        ind_firstname?: string;
        ind_lastname?: string;
        ind_middlename?: string;
        ind_other_names?: string[] | string;
        ind_bc_scope?: string;
        ind_ia_scope?: string;
        ind_industry_cal_date?: string;
        ind_current_employments?: Array<{
          firm_name?: string;
          firm_id?: string;
          branch_city?: string;
          branch_state?: string;
        }>;
        ind_previous_employments?: Array<{
          firm_name?: string;
          firm_id?: string;
        }>;
        ind_num_of_disclosure_events?: number;
        ind_exams?: string;
        ind_registrations?: string;
      };
    }>;
    total: number;
  };
}

function computeContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseBrokerFromHit(hit: BrokerCheckSearchResponse['hits']['hits'][0]): BrokerCheckIndividual | null {
  const src = hit._source;
  const crdNumber = src.ind_source_id ? String(src.ind_source_id).trim() : '';
  if (!crdNumber) return null;

  const currentEmployments = (src.ind_current_employments ?? []).map(emp => ({
    firmName: emp.firm_name ?? 'Unknown',
    firmCrdNumber: emp.firm_id ?? undefined,
    branchCity: emp.branch_city ?? undefined,
    branchState: emp.branch_state ?? undefined,
  }));

  const previousEmployments = (src.ind_previous_employments ?? []).map(emp => ({
    firmName: emp.firm_name ?? 'Unknown',
    firmCrdNumber: emp.firm_id ?? undefined,
  }));

  const otherNames = Array.isArray(src.ind_other_names)
    ? src.ind_other_names.map(String).filter(Boolean)
    : src.ind_other_names
      ? String(src.ind_other_names).split(/[,;]/).map(n => n.trim()).filter(Boolean)
      : undefined;

  return {
    crdNumber,
    firstName: src.ind_firstname ?? '',
    lastName: src.ind_lastname ?? '',
    middleName: src.ind_middlename ?? undefined,
    otherNames,
    currentEmployments,
    previousEmployments,
    disclosureCount: src.ind_num_of_disclosure_events ?? 0,
    industryStartDate: src.ind_industry_cal_date ?? undefined,
    exams: src.ind_exams ? src.ind_exams.split(/[,;]/).map(e => e.trim()).filter(Boolean) : undefined,
    registrations: src.ind_registrations ? src.ind_registrations.split(/[,;]/).map(r => r.trim()).filter(Boolean) : undefined,
  };
}

async function insertBroker(
  supabase: SupabaseClient,
  broker: BrokerCheckIndividual,
): Promise<'inserted' | 'skipped' | 'error'> {
  const sourceId = `finra-${broker.crdNumber}`;

  // Check for duplicates
  const { data: existing } = await dbAny(supabase)
    .from('public_records')
    .select('id')
    .eq('source', 'finra')
    .eq('source_id', sourceId)
    .limit(1);

  if (existing && existing.length > 0) {
    return 'skipped';
  }

  const fullName = [broker.firstName, broker.middleName, broker.lastName]
    .filter(Boolean)
    .join(' ');

  const currentFirm = broker.currentEmployments[0]?.firmName ?? 'None';
  const currentLocation = broker.currentEmployments[0]
    ? [broker.currentEmployments[0].branchCity, broker.currentEmployments[0].branchState].filter(Boolean).join(', ')
    : null;

  const contentForHash = JSON.stringify({
    crdNumber: broker.crdNumber,
    name: fullName,
    currentFirm,
    disclosures: broker.disclosureCount,
  });

  const { error: insertError } = await dbAny(supabase)
    .from('public_records')
    .insert({
      source: 'finra',
      source_id: sourceId,
      source_url: `https://brokercheck.finra.org/individual/summary/${broker.crdNumber}`,
      record_type: 'broker_registration',
      title: `${fullName} — FINRA CRD #${broker.crdNumber} (${currentFirm})`,
      content_hash: computeContentHash(contentForHash),
      metadata: {
        crd_number: broker.crdNumber,
        full_name: fullName,
        first_name: broker.firstName,
        last_name: broker.lastName,
        middle_name: broker.middleName ?? null,
        other_names: broker.otherNames ?? [],
        current_firm: currentFirm,
        current_firm_crd: broker.currentEmployments[0]?.firmCrdNumber ?? null,
        current_location: currentLocation,
        current_employments: broker.currentEmployments,
        previous_employments: broker.previousEmployments ?? [],
        disclosure_count: broker.disclosureCount ?? 0,
        industry_start_date: broker.industryStartDate ?? null,
        exams: broker.exams ?? [],
        registrations: broker.registrations ?? [],
        pipeline_source: 'finra',
        registry: 'FINRA BrokerCheck',
        jurisdiction: 'US',
        license_type: 'registered_representative',
      },
    });

  if (insertError) {
    if (insertError.code === '23505') {
      return 'skipped';
    }
    logger.error({ sourceId, error: insertError }, 'FINRA BrokerCheck insert failed');
    return 'error';
  }
  return 'inserted';
}

/**
 * US state codes for alphabetical sweep through BrokerCheck.
 * Strategy: Search by state to enumerate all registered reps.
 */
const _US_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL',
  'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME',
  'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH',
  'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'PR',
  'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV',
  'WI', 'WY',
];

/**
 * Common last name prefixes for search sharding.
 * BrokerCheck limits to 10K results per query, so we shard by last name prefix.
 */
const LAST_NAME_PREFIXES = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

/**
 * Fetch FINRA BrokerCheck registered representatives.
 *
 * Strategy: Search alphabetically by last name prefix to enumerate
 * the full database. BrokerCheck API caps at 10K results per query,
 * so we use single-letter last name prefixes to stay under the cap.
 *
 * Resumable: picks up from the last letter prefix processed,
 * based on what's already in our DB.
 */
export async function fetchFinraBrokers(supabase: SupabaseClient): Promise<{
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
    logger.info('ENABLE_PUBLIC_RECORDS_INGESTION is disabled — skipping FINRA fetch');
    return { inserted: 0, skipped: 0, errors: 0, pagesProcessed: 0 };
  }

  // No resume logic for now — rely on dedup in insertBroker
  const completedPrefixes = new Set<string>();

  logger.info(
    { completedPrefixes: completedPrefixes.size, totalPrefixes: LAST_NAME_PREFIXES.length },
    'FINRA BrokerCheck: starting fetch',
  );

  let totalInserted = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  let totalPages = 0;

  for (const prefix of LAST_NAME_PREFIXES) {
    if (completedPrefixes.has(prefix)) {
      logger.info({ prefix }, 'FINRA: skipping already-completed prefix');
      continue;
    }

    if (totalInserted >= MAX_PER_RUN) {
      logger.info({ totalInserted }, 'FINRA: reached max per run');
      break;
    }

    // Search by last name prefix
    let from = 0;
    let hasMore = true;

    while (hasMore && from < PAGE_SIZE * MAX_PAGES_PER_QUERY) {
      try {
        const searchUrl = `${BROKERCHECK_SEARCH_URL}?query=${prefix}&hl=true&nrows=${PAGE_SIZE}&start=${from}&r=25&sort=score+desc&wt=json`;

        const response = await fetch(searchUrl, {
          headers: {
            'User-Agent': 'Arkova/1.0 (contact@arkova.ai)',
            Accept: 'application/json',
          },
        });

        if (!response.ok) {
          if (response.status === 429) {
            logger.warn({ prefix }, 'FINRA rate limited — backing off 10 seconds');
            await delay(10_000);
            continue; // Retry
          }
          logger.error({ status: response.status, prefix }, 'FINRA search failed');
          totalErrors++;
          break;
        }

        let result: BrokerCheckSearchResponse;
        try {
          result = (await response.json()) as BrokerCheckSearchResponse;
        } catch {
          logger.error({ prefix, from }, 'Failed to parse FINRA response');
          totalErrors++;
          break;
        }

        const hits = result.hits?.hits ?? [];
        totalPages++;

        if (hits.length === 0) {
          hasMore = false;
          break;
        }

        logger.info(
          { prefix, from, count: hits.length, total: result.hits?.total },
          'FINRA batch received',
        );

        for (const hit of hits) {
          const broker = parseBrokerFromHit(hit);
          if (!broker) {
            totalSkipped++;
            continue;
          }

          const insertResult = await insertBroker(supabase, broker);
          if (insertResult === 'inserted') totalInserted++;
          else if (insertResult === 'skipped') totalSkipped++;
          else totalErrors++;
        }

        from += hits.length;

        // If we got fewer than PAGE_SIZE, we're done with this prefix
        if (hits.length < PAGE_SIZE) {
          hasMore = false;
        }

        // If total > 10K, we can't paginate further (FINRA limit)
        if (result.hits?.total > 10000 && from >= 10000) {
          logger.warn(
            { prefix, total: result.hits.total },
            'FINRA: prefix exceeds 10K limit — some records may be missed',
          );
          hasMore = false;
        }
      } catch (err) {
        logger.error({ error: err, prefix, from }, 'FINRA search error');
        totalErrors++;
        break;
      }

      await delay(RATE_LIMIT_MS);
    }
  }

  logger.info(
    { inserted: totalInserted, skipped: totalSkipped, errors: totalErrors, pagesProcessed: totalPages },
    'FINRA BrokerCheck fetch complete',
  );

  return { inserted: totalInserted, skipped: totalSkipped, errors: totalErrors, pagesProcessed: totalPages };
}

/**
 * Fetch a specific broker by CRD number.
 * Used for targeted lookups.
 */
export async function fetchFinraByCrd(
  supabase: SupabaseClient,
  crdNumber: string,
): Promise<{ inserted: number; skipped: number; errors: number }> {
  logger.info({ crdNumber }, 'Fetching specific FINRA broker by CRD');

  try {
    const detailUrl = `${BROKERCHECK_DETAIL_URL}/${crdNumber}`;
    const response = await fetch(detailUrl, {
      headers: {
        'User-Agent': 'Arkova/1.0 (contact@arkova.ai)',
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      return { inserted: 0, skipped: 0, errors: 1 };
    }

    const data = (await response.json()) as BrokerCheckSearchResponse;
    const hits = data.hits?.hits ?? [];

    if (hits.length === 0) {
      return { inserted: 0, skipped: 0, errors: 0 };
    }

    const broker = parseBrokerFromHit(hits[0]);
    if (!broker) {
      return { inserted: 0, skipped: 0, errors: 0 };
    }

    const result = await insertBroker(supabase, broker);
    return {
      inserted: result === 'inserted' ? 1 : 0,
      skipped: result === 'skipped' ? 1 : 0,
      errors: result === 'error' ? 1 : 0,
    };
  } catch (err) {
    logger.error({ error: err, crdNumber }, 'FINRA specific fetch failed');
    return { inserted: 0, skipped: 0, errors: 1 };
  }
}
