/**
 * SAM.gov Entity Registration Fetcher
 *
 * Fetches federal contractor/grantee entity registrations from SAM.gov
 * (System for Award Management).
 *
 * API: https://api.sam.gov/entity-information/v3/entities
 * Auth: Free API key required (register at https://api.sam.gov/)
 * Rate limit: 10 req/sec, 10,000/day
 * Records: 900,000+ active entity registrations
 *
 * Why anchor this: Federal contractor verification — proves an entity
 * was registered in SAM.gov (required for federal contracting) at a
 * point in time. Critical for compliance, due diligence, procurement.
 *
 * Data includes: UEI (Unique Entity ID), CAGE code, legal name, DBA,
 * physical address, NAICS codes, registration dates, business type.
 *
 * Also ingests the SAM.gov Exclusions list (debarred/suspended entities).
 *
 * Constitution refs:
 *   - 4A: Only metadata is stored server-side
 */

import { createHash } from 'node:crypto';
import { logger } from '../utils/logger.js';
import type { SupabaseClient } from '@supabase/supabase-js';

/** SAM.gov Entity Information API v3 */
const SAM_ENTITY_URL = 'https://api.sam.gov/entity-information/v3/entities';
const SAM_EXCLUSIONS_URL = 'https://api.sam.gov/entity-information/v2/exclusions';

/** Rate limit: 10 req/sec → 100ms + margin */
const RATE_LIMIT_MS = 150;

/** Results per page (API max is 100) */
const PAGE_SIZE = 100;

/** Max records per run — fits Cloud Run timeout */
const MAX_PER_RUN = 10000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbAny = (db: SupabaseClient) => db as any;

interface SamEntity {
  ueiSAM?: string;
  ueiDUNS?: string;
  entityEFTIndicator?: string;
  cageCode?: string;
  dodaac?: string;
  legalBusinessName?: string;
  dbaName?: string;
  purposeOfRegistrationCode?: string;
  purposeOfRegistrationDesc?: string;
  registrationStatus?: string;
  registrationDate?: string;
  lastUpdateDate?: string;
  expirationDate?: string;
  activeDate?: string;
  congressionalDistrict?: string;
  countryCode?: string;
  stateCode?: string;
  cityCode?: string;
  zipCode?: string;
  addressLine1?: string;
  naicsCode?: string;
  naicsList?: Array<{
    naicsCode?: string;
    naicsDescription?: string;
    sbaSmallBusiness?: string;
    isPrimary?: boolean;
  }>;
  pscList?: Array<{ pscCode?: string; pscDescription?: string }>;
  businessTypes?: string[];
  organizationStructureCode?: string;
  organizationStructureDesc?: string;
  entityURL?: string;
  companyDivision?: string;
}

interface SamSearchResponse {
  totalRecords?: number;
  entityData?: Array<{
    entityRegistration?: SamEntity;
  }>;
}

interface SamExclusion {
  classificationType?: string;
  exclusionType?: string;
  exclusionProgram?: string;
  excludingAgencyCode?: string;
  excludingAgencyName?: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  middleName?: string;
  prefix?: string;
  suffix?: string;
  entityEFTIndicator?: string;
  ueiSAM?: string;
  cageCode?: string;
  npi?: string;
  duns?: string;
  activeDateStart?: string;
  activeDateEnd?: string;
  terminationDate?: string;
  createDate?: string;
  updateDate?: string;
  stateProvince?: string;
  country?: string;
  zipCode?: string;
  city?: string;
  addressLine1?: string;
}

interface SamExclusionsResponse {
  totalRecords?: number;
  excludedEntity?: SamExclusion[];
}

function computeContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function insertSamEntity(
  supabase: SupabaseClient,
  entity: SamEntity,
): Promise<'inserted' | 'skipped' | 'error'> {
  const uei = entity.ueiSAM ?? entity.ueiDUNS ?? '';
  if (!uei) return 'skipped';

  const sourceId = `sam-${uei}`;

  // Check for duplicates
  const { data: existing } = await dbAny(supabase)
    .from('public_records')
    .select('id')
    .eq('source', 'sam_gov')
    .eq('source_id', sourceId)
    .limit(1);

  if (existing && existing.length > 0) {
    return 'skipped';
  }

  const name = entity.legalBusinessName ?? entity.dbaName ?? 'Unknown Entity';
  const _location = [entity.cityCode, entity.stateCode].filter(Boolean).join(', ');
  const primaryNaics = entity.naicsList?.find(n => n.isPrimary);

  const contentForHash = JSON.stringify({
    uei,
    name,
    status: entity.registrationStatus,
    state: entity.stateCode,
  });

  const { error: insertError } = await dbAny(supabase)
    .from('public_records')
    .insert({
      source: 'sam_gov',
      source_id: sourceId,
      source_url: `https://sam.gov/entity/${uei}/coreData`,
      record_type: 'federal_contractor',
      title: `${name} — SAM.gov UEI ${uei} (${entity.registrationStatus ?? 'Unknown'})`,
      content_hash: computeContentHash(contentForHash),
      metadata: {
        uei_sam: uei,
        cage_code: entity.cageCode ?? null,
        legal_name: entity.legalBusinessName ?? null,
        dba_name: entity.dbaName ?? null,
        registration_status: entity.registrationStatus ?? null,
        registration_date: entity.registrationDate ?? null,
        last_update_date: entity.lastUpdateDate ?? null,
        expiration_date: entity.expirationDate ?? null,
        active_date: entity.activeDate ?? null,
        purpose: entity.purposeOfRegistrationDesc ?? null,
        congressional_district: entity.congressionalDistrict ?? null,
        country: entity.countryCode ?? null,
        state: entity.stateCode ?? null,
        city: entity.cityCode ?? null,
        zip: entity.zipCode ?? null,
        address: entity.addressLine1 ?? null,
        primary_naics: primaryNaics?.naicsCode ?? entity.naicsCode ?? null,
        primary_naics_desc: primaryNaics?.naicsDescription ?? null,
        naics_list: (entity.naicsList ?? []).map(n => ({
          code: n.naicsCode,
          desc: n.naicsDescription,
          primary: n.isPrimary,
          small_business: n.sbaSmallBusiness,
        })),
        business_types: entity.businessTypes ?? [],
        organization_structure: entity.organizationStructureDesc ?? null,
        entity_url: entity.entityURL ?? null,
        pipeline_source: 'sam_gov',
        registry: 'SAM.gov (System for Award Management)',
        jurisdiction: 'US',
        license_type: 'federal_contractor_registration',
      },
    });

  if (insertError) {
    if (insertError.code === '23505') {
      return 'skipped';
    }
    logger.error({ sourceId, error: insertError }, 'SAM.gov entity insert failed');
    return 'error';
  }
  return 'inserted';
}

async function insertSamExclusion(
  supabase: SupabaseClient,
  exclusion: SamExclusion,
): Promise<'inserted' | 'skipped' | 'error'> {
  // Use UEI or name-based ID
  const identifier = exclusion.ueiSAM
    ?? exclusion.cageCode
    ?? `${exclusion.firstName ?? ''}-${exclusion.lastName ?? ''}-${exclusion.name ?? ''}`.replace(/\s+/g, '-').toLowerCase();

  if (!identifier || identifier === '--') return 'skipped';

  const sourceId = `sam-excl-${identifier}`;

  const { data: existing } = await dbAny(supabase)
    .from('public_records')
    .select('id')
    .eq('source', 'sam_gov_exclusions')
    .eq('source_id', sourceId)
    .limit(1);

  if (existing && existing.length > 0) {
    return 'skipped';
  }

  const entityName = exclusion.name
    ?? [exclusion.firstName, exclusion.middleName, exclusion.lastName].filter(Boolean).join(' ')
    ?? 'Unknown';

  const contentForHash = JSON.stringify({
    id: identifier,
    name: entityName,
    type: exclusion.exclusionType,
    program: exclusion.exclusionProgram,
  });

  const { error: insertError } = await dbAny(supabase)
    .from('public_records')
    .insert({
      source: 'sam_gov_exclusions',
      source_id: sourceId,
      source_url: `https://sam.gov/search/?keywords=${encodeURIComponent(entityName)}&index=excl`,
      record_type: 'federal_exclusion',
      title: `${entityName} — SAM.gov Exclusion (${exclusion.exclusionType ?? 'Unknown'})`,
      content_hash: computeContentHash(contentForHash),
      metadata: {
        entity_name: entityName,
        first_name: exclusion.firstName ?? null,
        last_name: exclusion.lastName ?? null,
        uei_sam: exclusion.ueiSAM ?? null,
        cage_code: exclusion.cageCode ?? null,
        npi: exclusion.npi ?? null,
        classification_type: exclusion.classificationType ?? null,
        exclusion_type: exclusion.exclusionType ?? null,
        exclusion_program: exclusion.exclusionProgram ?? null,
        excluding_agency: exclusion.excludingAgencyName ?? null,
        active_date_start: exclusion.activeDateStart ?? null,
        active_date_end: exclusion.activeDateEnd ?? null,
        termination_date: exclusion.terminationDate ?? null,
        state: exclusion.stateProvince ?? null,
        country: exclusion.country ?? null,
        city: exclusion.city ?? null,
        zip: exclusion.zipCode ?? null,
        pipeline_source: 'sam_gov_exclusions',
        registry: 'SAM.gov Exclusions (Debarment)',
        jurisdiction: 'US',
        license_type: 'federal_exclusion',
      },
    });

  if (insertError) {
    if (insertError.code === '23505') {
      return 'skipped';
    }
    logger.error({ sourceId, error: insertError }, 'SAM.gov exclusion insert failed');
    return 'error';
  }
  return 'inserted';
}

/**
 * US states for entity search sharding.
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
 * Fetch SAM.gov entity registrations.
 *
 * Strategy: Search by state to enumerate registered entities.
 * The API supports pagination up to 10,000 records per query.
 * We shard by state to stay within limits.
 */
export async function fetchSamEntities(
  supabase: SupabaseClient,
  options?: { apiKey?: string; states?: string[]; maxPerRun?: number },
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
    logger.info('ENABLE_PUBLIC_RECORDS_INGESTION is disabled — skipping SAM.gov fetch');
    return { inserted: 0, skipped: 0, errors: 0, pagesProcessed: 0 };
  }

  const apiKey = options?.apiKey ?? process.env.SAM_GOV_API_KEY ?? '';
  if (!apiKey) {
    logger.error('SAM_GOV_API_KEY not configured — skipping SAM.gov fetch');
    return { inserted: 0, skipped: 0, errors: 0, pagesProcessed: 0 };
  }

  const states = options?.states ?? US_STATES;
  const maxPerRun = options?.maxPerRun ?? MAX_PER_RUN;

  logger.info({ states: states.length, maxPerRun }, 'SAM.gov: starting entity fetch');

  let totalInserted = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  let totalPages = 0;

  for (const state of states) {
    if (totalInserted >= maxPerRun) {
      logger.info({ totalInserted, state }, 'SAM.gov: reached max per run');
      break;
    }

    let page = 0;
    let hasMore = true;

    while (hasMore) {
      try {
        const params = new URLSearchParams({
          api_key: apiKey,
          registrationStatus: 'A', // Active registrations
          stateCode: state,
          includeSections: 'entityRegistration',
          page: String(page),
          size: String(PAGE_SIZE),
        });

        const response = await fetch(`${SAM_ENTITY_URL}?${params.toString()}`, {
          headers: {
            'User-Agent': 'Arkova/1.0 (contact@arkova.ai)',
            Accept: 'application/json',
          },
        });

        if (!response.ok) {
          if (response.status === 429) {
            logger.warn({ state }, 'SAM.gov rate limited — backing off 30 seconds');
            await delay(30_000);
            continue;
          }
          if (response.status === 403) {
            logger.error('SAM.gov API key invalid or expired');
            return { inserted: totalInserted, skipped: totalSkipped, errors: totalErrors + 1, pagesProcessed: totalPages };
          }
          logger.error({ status: response.status, state }, 'SAM.gov search failed');
          totalErrors++;
          break;
        }

        let result: SamSearchResponse;
        try {
          result = (await response.json()) as SamSearchResponse;
        } catch {
          logger.error({ state, page }, 'Failed to parse SAM.gov response');
          totalErrors++;
          break;
        }

        const entities = result.entityData ?? [];
        totalPages++;

        if (entities.length === 0) {
          hasMore = false;
          break;
        }

        logger.info(
          { state, page, count: entities.length, total: result.totalRecords },
          'SAM.gov batch received',
        );

        for (const entry of entities) {
          const entity = entry.entityRegistration;
          if (!entity) {
            totalSkipped++;
            continue;
          }

          const insertResult = await insertSamEntity(supabase, entity);
          if (insertResult === 'inserted') totalInserted++;
          else if (insertResult === 'skipped') totalSkipped++;
          else totalErrors++;
        }

        page++;

        if (entities.length < PAGE_SIZE) {
          hasMore = false;
        }

        // SAM.gov caps at 100 pages (10K records per query)
        if (page >= 100) {
          logger.warn({ state, total: result.totalRecords }, 'SAM.gov: reached 10K page cap for state');
          hasMore = false;
        }

        if (totalInserted > 0 && totalInserted % 500 === 0) {
          logger.info(
            { inserted: totalInserted, skipped: totalSkipped, errors: totalErrors, state, page },
            'SAM.gov progress',
          );
        }
      } catch (err) {
        logger.error({ error: err, state, page }, 'SAM.gov search error');
        totalErrors++;
        break;
      }

      await delay(RATE_LIMIT_MS);
    }
  }

  logger.info(
    { inserted: totalInserted, skipped: totalSkipped, errors: totalErrors, pagesProcessed: totalPages },
    'SAM.gov entity fetch complete',
  );

  return { inserted: totalInserted, skipped: totalSkipped, errors: totalErrors, pagesProcessed: totalPages };
}

/**
 * Fetch SAM.gov exclusions (debarred/suspended entities).
 * Smaller dataset (~80K) but high-value for compliance.
 */
export async function fetchSamExclusions(
  supabase: SupabaseClient,
  options?: { apiKey?: string; maxPerRun?: number },
): Promise<{
  inserted: number;
  skipped: number;
  errors: number;
  pagesProcessed: number;
}> {
  const { data: enabled } = await supabase.rpc('get_flag', {
    p_flag_key: 'ENABLE_PUBLIC_RECORDS_INGESTION',
  });
  if (!enabled) {
    logger.info('ENABLE_PUBLIC_RECORDS_INGESTION is disabled — skipping SAM.gov exclusions');
    return { inserted: 0, skipped: 0, errors: 0, pagesProcessed: 0 };
  }

  const apiKey = options?.apiKey ?? process.env.SAM_GOV_API_KEY ?? '';
  if (!apiKey) {
    logger.error('SAM_GOV_API_KEY not configured — skipping SAM.gov exclusions');
    return { inserted: 0, skipped: 0, errors: 0, pagesProcessed: 0 };
  }

  const maxPerRun = options?.maxPerRun ?? MAX_PER_RUN;

  logger.info('SAM.gov: starting exclusions fetch');

  let totalInserted = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  let totalPages = 0;
  let page = 0;
  let hasMore = true;

  while (hasMore && totalInserted < maxPerRun) {
    try {
      const params = new URLSearchParams({
        api_key: apiKey,
        page: String(page),
        size: String(PAGE_SIZE),
      });

      const response = await fetch(`${SAM_EXCLUSIONS_URL}?${params.toString()}`, {
        headers: {
          'User-Agent': 'Arkova/1.0 (contact@arkova.ai)',
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        if (response.status === 429) {
          logger.warn('SAM.gov exclusions rate limited — backing off 30 seconds');
          await delay(30_000);
          continue;
        }
        logger.error({ status: response.status }, 'SAM.gov exclusions search failed');
        totalErrors++;
        break;
      }

      let result: SamExclusionsResponse;
      try {
        result = (await response.json()) as SamExclusionsResponse;
      } catch {
        logger.error({ page }, 'Failed to parse SAM.gov exclusions response');
        totalErrors++;
        break;
      }

      const exclusions = result.excludedEntity ?? [];
      totalPages++;

      if (exclusions.length === 0) {
        hasMore = false;
        break;
      }

      for (const excl of exclusions) {
        const insertResult = await insertSamExclusion(supabase, excl);
        if (insertResult === 'inserted') totalInserted++;
        else if (insertResult === 'skipped') totalSkipped++;
        else totalErrors++;
      }

      page++;
      if (exclusions.length < PAGE_SIZE) hasMore = false;
    } catch (err) {
      logger.error({ error: err, page }, 'SAM.gov exclusions error');
      totalErrors++;
      break;
    }

    await delay(RATE_LIMIT_MS);
  }

  logger.info(
    { inserted: totalInserted, skipped: totalSkipped, errors: totalErrors, pagesProcessed: totalPages },
    'SAM.gov exclusions fetch complete',
  );

  return { inserted: totalInserted, skipped: totalSkipped, errors: totalErrors, pagesProcessed: totalPages };
}
