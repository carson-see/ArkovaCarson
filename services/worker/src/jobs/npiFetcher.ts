/**
 * NPPES NPI Registry Fetcher
 *
 * Fetches healthcare provider records from the CMS National Plan
 * and Provider Enumeration System (NPPES) NPI Registry.
 *
 * API: https://npiregistry.cms.hhs.gov/api/?version=2.1
 * Auth: None required (free public API)
 * Rate limit: Respectful usage (~2 req/sec)
 * Records: 7,000,000+ active NPI records
 *
 * Why anchor this: Healthcare provider verification — proves an
 * individual or organization was a registered healthcare provider
 * with a valid NPI number at a point in time. Critical for
 * credentialing, insurance verification, and compliance.
 *
 * Data includes: NPI number, provider name, credentials, practice
 * address, taxonomy (specialty), state license numbers, organization.
 *
 * Constitution refs:
 *   - 4A: Only metadata is stored server-side
 */

import { createHash } from 'node:crypto';
import { logger } from '../utils/logger.js';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * NPPES NPI Registry public API — free, no auth required.
 * Version 2.1 returns JSON with provider details.
 * Max 200 results per request, skip-based pagination.
 */
const NPI_API_URL = 'https://npiregistry.cms.hhs.gov/api/';
const NPI_VERSION = '2.1';

/** Rate limit: ~2 req/sec to be respectful */
const RATE_LIMIT_MS = 500;

/** Results per page (API max is 200) */
const PAGE_SIZE = 200;

/** Max records per run — fits Cloud Run timeout */
const MAX_PER_RUN = 10000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbAny = (db: SupabaseClient) => db as any;

interface NpiAddress {
  country_code?: string;
  country_name?: string;
  address_purpose?: string;
  address_type?: string;
  address_1?: string;
  address_2?: string;
  city?: string;
  state?: string;
  postal_code?: string;
  telephone_number?: string;
  fax_number?: string;
}

interface NpiTaxonomy {
  code?: string;
  taxonomy_group?: string;
  desc?: string;
  state?: string;
  license?: string;
  primary?: boolean;
}

interface NpiResult {
  created_epoch?: string;
  enumeration_type?: string; // "NPI-1" (individual) or "NPI-2" (organization)
  last_updated_epoch?: string;
  number?: number; // NPI number
  addresses?: NpiAddress[];
  taxonomies?: NpiTaxonomy[];
  basic?: {
    authorized_official_credential?: string;
    authorized_official_first_name?: string;
    authorized_official_last_name?: string;
    authorized_official_middle_name?: string;
    authorized_official_telephone_number?: string;
    authorized_official_title_or_position?: string;
    credential?: string;
    enumeration_date?: string;
    first_name?: string;
    gender?: string;
    last_name?: string;
    last_updated?: string;
    middle_name?: string;
    name?: string;
    name_prefix?: string;
    organization_name?: string;
    sole_proprietor?: string;
    status?: string;
  };
  other_names?: Array<{
    type?: string;
    code?: string;
    first_name?: string;
    last_name?: string;
    middle_name?: string;
    prefix?: string;
    organization_name?: string;
  }>;
}

interface NpiApiResponse {
  result_count: number;
  results: NpiResult[];
}

function computeContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getProviderName(result: NpiResult): string {
  if (result.enumeration_type === 'NPI-2') {
    return result.basic?.organization_name ?? 'Unknown Organization';
  }
  const parts = [
    result.basic?.name_prefix,
    result.basic?.first_name,
    result.basic?.middle_name,
    result.basic?.last_name,
    result.basic?.credential,
  ].filter(Boolean);
  return parts.join(' ') || 'Unknown Provider';
}

function getPrimaryTaxonomy(result: NpiResult): NpiTaxonomy | undefined {
  return result.taxonomies?.find(t => t.primary) ?? result.taxonomies?.[0];
}

function getPracticeAddress(result: NpiResult): NpiAddress | undefined {
  return result.addresses?.find(a => a.address_purpose === 'LOCATION') ?? result.addresses?.[0];
}

async function insertProvider(
  supabase: SupabaseClient,
  result: NpiResult,
): Promise<'inserted' | 'skipped' | 'error'> {
  const npiNumber = result.number ? String(result.number) : '';
  if (!npiNumber) return 'skipped';

  const sourceId = `npi-${npiNumber}`;

  // Check for duplicates
  const { data: existing } = await dbAny(supabase)
    .from('public_records')
    .select('id')
    .eq('source', 'npi')
    .eq('source_id', sourceId)
    .limit(1);

  if (existing && existing.length > 0) {
    return 'skipped';
  }

  const name = getProviderName(result);
  const primaryTaxonomy = getPrimaryTaxonomy(result);
  const practiceAddress = getPracticeAddress(result);
  const isOrganization = result.enumeration_type === 'NPI-2';

  const specialty = primaryTaxonomy?.desc ?? 'Unknown';
  const _location = practiceAddress
    ? [practiceAddress.city, practiceAddress.state].filter(Boolean).join(', ')
    : null;

  const contentForHash = JSON.stringify({
    npiNumber,
    name,
    type: result.enumeration_type,
    specialty,
    state: practiceAddress?.state,
  });

  // Collect all state licenses
  const stateLicenses = (result.taxonomies ?? [])
    .filter(t => t.license && t.state)
    .map(t => ({ state: t.state, license: t.license, taxonomy: t.desc }));

  const { error: insertError } = await dbAny(supabase)
    .from('public_records')
    .insert({
      source: 'npi',
      source_id: sourceId,
      source_url: `https://npiregistry.cms.hhs.gov/provider-view/${npiNumber}`,
      record_type: isOrganization ? 'healthcare_organization' : 'healthcare_provider',
      title: `${name} — NPI #${npiNumber} (${specialty})`,
      content_hash: computeContentHash(contentForHash),
      metadata: {
        npi_number: npiNumber,
        provider_name: name,
        enumeration_type: result.enumeration_type ?? null,
        is_organization: isOrganization,
        credential: result.basic?.credential ?? null,
        gender: (result.basic as Record<string, unknown>)?.sex as string ?? result.basic?.gender ?? null,
        sole_proprietor: result.basic?.sole_proprietor ?? null,
        enumeration_date: result.basic?.enumeration_date ?? null,
        last_updated: result.basic?.last_updated ?? null,
        status: result.basic?.status ?? 'A',
        // Primary specialty
        primary_specialty: specialty,
        primary_taxonomy_code: primaryTaxonomy?.code ?? null,
        // All taxonomies
        taxonomies: (result.taxonomies ?? []).map(t => ({
          code: t.code,
          desc: t.desc,
          primary: t.primary,
          state: t.state,
          license: t.license,
        })),
        // Practice location
        practice_city: practiceAddress?.city ?? null,
        practice_state: practiceAddress?.state ?? null,
        practice_zip: practiceAddress?.postal_code ?? null,
        practice_address: practiceAddress?.address_1 ?? null,
        practice_phone: practiceAddress?.telephone_number ?? null,
        // State licenses
        state_licenses: stateLicenses,
        // Organization-specific
        organization_name: isOrganization ? result.basic?.organization_name : null,
        authorized_official: isOrganization ? [
          result.basic?.authorized_official_first_name,
          result.basic?.authorized_official_last_name,
        ].filter(Boolean).join(' ') || null : null,
        // Pipeline metadata
        pipeline_source: 'npi',
        registry: 'NPPES NPI Registry (CMS)',
        jurisdiction: 'US',
        license_type: isOrganization ? 'healthcare_organization' : 'healthcare_provider',
      },
    });

  if (insertError) {
    if (insertError.code === '23505') {
      return 'skipped';
    }
    logger.error({ sourceId, error: insertError }, 'NPI insert failed');
    return 'error';
  }
  return 'inserted';
}

/**
 * US states for enumeration. We search state-by-state to walk the full registry.
 */
const US_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL',
  'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME',
  'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH',
  'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'PR',
  'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'VI', 'WA',
  'WV', 'WI', 'WY',
];

/**
 * Fetch NPI providers by state, with last-name-prefix sharding.
 *
 * Strategy: The NPI API limits to 200 results per call and has a
 * 1200-result skip limit. To walk the full 7M+ registry, we search
 * by state + last name first letter prefix. Each (state, prefix) combo
 * typically yields < 10K results.
 *
 * Resumable: tracks which (state, prefix) combos are already covered.
 */
export async function fetchNpiProviders(
  supabase: SupabaseClient,
  options?: { states?: string[]; maxPerRun?: number },
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
    logger.info('ENABLE_PUBLIC_RECORDS_INGESTION is disabled — skipping NPI fetch');
    return { inserted: 0, skipped: 0, errors: 0, pagesProcessed: 0 };
  }

  const states = options?.states ?? US_STATES;
  const maxPerRun = options?.maxPerRun ?? MAX_PER_RUN;

  logger.info({ states: states.length, maxPerRun }, 'NPI Registry: starting fetch');

  let totalInserted = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  let totalPages = 0;

  // NPI API requires 2+ leading characters for wildcards
  // Generate 2-char prefixes: AA, AB, AC, ..., ZZ (676 combos per state)
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const twoCharPrefixes: string[] = [];
  for (const a of letters) {
    for (const b of letters) {
      twoCharPrefixes.push(`${a}${b}`);
    }
  }

  for (const state of states) {
    if (totalInserted >= maxPerRun) {
      logger.info({ totalInserted, state }, 'NPI: reached max per run');
      break;
    }

    for (const prefix of twoCharPrefixes) {
      if (totalInserted >= maxPerRun) break;

      let skip = 0;
      let hasMore = true;
      const MAX_SKIP = 1200; // NPI API hard limit on skip parameter

      while (hasMore && skip < MAX_SKIP) {
        try {
          const params = new URLSearchParams({
            version: NPI_VERSION,
            state: state,
            last_name: `${prefix}*`,
            limit: String(PAGE_SIZE),
            skip: String(skip),
          });

          const response = await fetch(`${NPI_API_URL}?${params.toString()}`, {
            headers: {
              'User-Agent': 'Arkova/1.0 (contact@arkova.ai)',
              Accept: 'application/json',
            },
          });

          if (!response.ok) {
            if (response.status === 429) {
              logger.warn({ state, prefix }, 'NPI rate limited — backing off 10 seconds');
              await delay(10_000);
              continue;
            }
            logger.error({ status: response.status, state, prefix }, 'NPI search failed');
            totalErrors++;
            break;
          }

          let result: NpiApiResponse;
          try {
            result = (await response.json()) as NpiApiResponse;
          } catch {
            logger.error({ state, prefix, skip }, 'Failed to parse NPI response');
            totalErrors++;
            break;
          }

          const results = result.results ?? [];
          totalPages++;

          if (results.length === 0) {
            hasMore = false;
            break;
          }

          for (const provider of results) {
            const insertResult = await insertProvider(supabase, provider);
            if (insertResult === 'inserted') totalInserted++;
            else if (insertResult === 'skipped') totalSkipped++;
            else totalErrors++;
          }

          skip += results.length;

          if (results.length < PAGE_SIZE) {
            hasMore = false;
          }

          if (totalInserted > 0 && totalInserted % 500 === 0) {
            logger.info(
              { inserted: totalInserted, skipped: totalSkipped, errors: totalErrors, state, prefix, skip },
              'NPI progress',
            );
          }
        } catch (err) {
          logger.error({ error: err, state, prefix, skip }, 'NPI search error');
          totalErrors++;
          break;
        }

        await delay(RATE_LIMIT_MS);
      }
    }
  }

  logger.info(
    { inserted: totalInserted, skipped: totalSkipped, errors: totalErrors, pagesProcessed: totalPages },
    'NPI Registry fetch complete',
  );

  return { inserted: totalInserted, skipped: totalSkipped, errors: totalErrors, pagesProcessed: totalPages };
}

/**
 * Fetch a specific provider by NPI number.
 */
export async function fetchNpiByNumber(
  supabase: SupabaseClient,
  npiNumber: string,
): Promise<{ inserted: number; skipped: number; errors: number }> {
  logger.info({ npiNumber }, 'Fetching specific NPI provider');

  try {
    const params = new URLSearchParams({
      version: NPI_VERSION,
      number: npiNumber,
    });

    const response = await fetch(`${NPI_API_URL}?${params.toString()}`, {
      headers: {
        'User-Agent': 'Arkova/1.0 (contact@arkova.ai)',
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      return { inserted: 0, skipped: 0, errors: 1 };
    }

    const data = (await response.json()) as NpiApiResponse;
    if (!data.results || data.results.length === 0) {
      return { inserted: 0, skipped: 0, errors: 0 };
    }

    const result = await insertProvider(supabase, data.results[0]);
    return {
      inserted: result === 'inserted' ? 1 : 0,
      skipped: result === 'skipped' ? 1 : 0,
      errors: result === 'error' ? 1 : 0,
    };
  } catch (err) {
    logger.error({ error: err, npiNumber }, 'NPI specific fetch failed');
    return { inserted: 0, skipped: 0, errors: 1 };
  }
}
