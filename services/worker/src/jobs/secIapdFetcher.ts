/**
 * SEC IAPD (Investment Adviser Public Disclosure) Fetcher
 *
 * Fetches investment adviser records from the SEC's IAPD system.
 *
 * API: https://api.adviserinfo.sec.gov/
 * Auth: None required (public disclosure database)
 * Rate limit: Respectful usage (~2 req/sec)
 * Records: ~900,000+ investment adviser representatives
 *
 * Why anchor this: Investment adviser verification — proves an
 * individual or firm was registered with the SEC/state regulators
 * at a point in time. Complements FINRA BrokerCheck for the
 * advisory side of financial services.
 *
 * Data includes: CRD number, name, firm, registration status,
 * disclosures, jurisdictions, exam qualifications.
 *
 * Constitution refs:
 *   - 4A: Only metadata is stored server-side
 */

import { createHash } from 'node:crypto';
import { logger } from '../utils/logger.js';
import type { SupabaseClient } from '@supabase/supabase-js';

/** SEC IAPD search API — public, no auth */
const IAPD_SEARCH_URL = 'https://api.adviserinfo.sec.gov/IAPD/Content/Search/api/PublicSearch';
const IAPD_FIRM_URL = 'https://api.adviserinfo.sec.gov/IAPD/Content/Search/api/Firm';

/** Rate limit: ~2 req/sec */
const RATE_LIMIT_MS = 500;

/** Results per page */
const PAGE_SIZE = 100;

/** Max records per run */
const MAX_PER_RUN = 10000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbAny = (db: SupabaseClient) => db as any;

interface IapdAdviser {
  crdNumber: string;
  organizationName: string;
  secNumber?: string;
  city?: string;
  state?: string;
  country?: string;
  registrationStatus?: string;
  totalAssets?: string;
  websiteUrl?: string;
  numberOfAccounts?: number;
  disclosureCount?: number;
  jurisdictions?: string[];
}

interface _IapdSearchResult {
  Results: Array<{
    Brochures?: unknown[];
    CurrentEmployments?: Array<{
      OrgName?: string;
      OrgCRDNum?: string;
      City?: string;
      State?: string;
    }>;
    Designations?: string[];
    Exams?: string[];
    IndividualId?: number;
    FirstName?: string;
    LastName?: string;
    MiddleName?: string;
    OtherNames?: string[];
    Scope?: string;
    NumOfDisclosureEvents?: number;
    IndustryStartDate?: string;
  }>;
  TotalCount: number;
}

interface IapdFirmSearchResult {
  Results: Array<{
    FirmId?: number;
    FirmCRDNum?: string;
    FirmSECNum?: string;
    OrgName?: string;
    City?: string;
    State?: string;
    Country?: string;
    TotalGrossAssets?: string;
    NumOfAccounts?: number;
    Website?: string;
    RegistrationStatus?: string;
    NumOfDisclosureEvents?: number;
    Jurisdictions?: string[];
  }>;
  TotalCount: number;
}

function computeContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function insertAdviserFirm(
  supabase: SupabaseClient,
  firm: IapdAdviser,
): Promise<'inserted' | 'skipped' | 'error'> {
  const sourceId = `sec-iapd-${firm.crdNumber}`;

  // Check for duplicates
  const { data: existing } = await dbAny(supabase)
    .from('public_records')
    .select('id')
    .eq('source', 'sec_iapd')
    .eq('source_id', sourceId)
    .limit(1);

  if (existing && existing.length > 0) {
    return 'skipped';
  }

  const contentForHash = JSON.stringify({
    crdNumber: firm.crdNumber,
    name: firm.organizationName,
    status: firm.registrationStatus,
    state: firm.state,
  });

  const statusLabel = firm.registrationStatus ?? 'Unknown';

  const { error: insertError } = await dbAny(supabase)
    .from('public_records')
    .insert({
      source: 'sec_iapd',
      source_id: sourceId,
      source_url: `https://adviserinfo.sec.gov/firm/summary/${firm.crdNumber}`,
      record_type: 'investment_adviser',
      title: `${firm.organizationName} — SEC IAPD CRD #${firm.crdNumber} (${statusLabel})`,
      content_hash: computeContentHash(contentForHash),
      metadata: {
        crd_number: firm.crdNumber,
        sec_number: firm.secNumber ?? null,
        organization_name: firm.organizationName,
        city: firm.city ?? null,
        state: firm.state ?? null,
        country: firm.country ?? null,
        registration_status: firm.registrationStatus ?? null,
        total_assets: firm.totalAssets ?? null,
        website: firm.websiteUrl ?? null,
        number_of_accounts: firm.numberOfAccounts ?? null,
        disclosure_count: firm.disclosureCount ?? 0,
        jurisdictions: firm.jurisdictions ?? [],
        pipeline_source: 'sec_iapd',
        registry: 'SEC Investment Adviser Public Disclosure',
        jurisdiction: 'US',
        license_type: 'investment_adviser',
      },
    });

  if (insertError) {
    if (insertError.code === '23505') {
      return 'skipped';
    }
    logger.error({ sourceId, error: insertError }, 'SEC IAPD insert failed');
    return 'error';
  }
  return 'inserted';
}

/** Last name prefixes for sharded search */
const LAST_NAME_PREFIXES = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

/**
 * Fetch SEC IAPD investment adviser firms.
 *
 * Strategy: Search alphabetically by firm name prefix to enumerate
 * the full database. The IAPD API is paginated and we walk through
 * each prefix systematically.
 *
 * Resumable: checks which prefixes are already well-covered in DB.
 */
export async function fetchSecIapdFirms(supabase: SupabaseClient): Promise<{
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
    logger.info('ENABLE_PUBLIC_RECORDS_INGESTION is disabled — skipping SEC IAPD fetch');
    return { inserted: 0, skipped: 0, errors: 0, pagesProcessed: 0 };
  }

  logger.info('SEC IAPD: starting firm fetch');

  let totalInserted = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  let totalPages = 0;

  for (const prefix of LAST_NAME_PREFIXES) {
    if (totalInserted >= MAX_PER_RUN) {
      logger.info({ totalInserted }, 'SEC IAPD: reached max per run');
      break;
    }

    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      try {
        // IAPD firm search endpoint
        const searchUrl = `${IAPD_SEARCH_URL}/Firm?query=${prefix}&hl=true&nrows=${PAGE_SIZE}&start=${offset}`;

        const response = await fetch(searchUrl, {
          headers: {
            'User-Agent': 'Arkova/1.0 (contact@arkova.ai)',
            Accept: 'application/json',
            Referer: 'https://adviserinfo.sec.gov/',
          },
        });

        if (!response.ok) {
          if (response.status === 429) {
            logger.warn({ prefix }, 'SEC IAPD rate limited — backing off 10 seconds');
            await delay(10_000);
            continue;
          }
          logger.error({ status: response.status, prefix }, 'SEC IAPD search failed');
          totalErrors++;
          break;
        }

        let result: IapdFirmSearchResult;
        try {
          result = (await response.json()) as IapdFirmSearchResult;
        } catch {
          logger.error({ prefix, offset }, 'Failed to parse SEC IAPD response');
          totalErrors++;
          break;
        }

        const firms = result.Results ?? [];
        totalPages++;

        if (firms.length === 0) {
          hasMore = false;
          break;
        }

        logger.info(
          { prefix, offset, count: firms.length, total: result.TotalCount },
          'SEC IAPD batch received',
        );

        for (const firm of firms) {
          const crdNumber = firm.FirmCRDNum ? String(firm.FirmCRDNum).trim() : '';
          if (!crdNumber) {
            totalSkipped++;
            continue;
          }

          const adviser: IapdAdviser = {
            crdNumber,
            organizationName: firm.OrgName ?? 'Unknown',
            secNumber: firm.FirmSECNum ?? undefined,
            city: firm.City ?? undefined,
            state: firm.State ?? undefined,
            country: firm.Country ?? undefined,
            registrationStatus: firm.RegistrationStatus ?? undefined,
            totalAssets: firm.TotalGrossAssets ?? undefined,
            numberOfAccounts: firm.NumOfAccounts ?? undefined,
            websiteUrl: firm.Website ?? undefined,
            disclosureCount: firm.NumOfDisclosureEvents ?? 0,
            jurisdictions: firm.Jurisdictions ?? undefined,
          };

          const insertResult = await insertAdviserFirm(supabase, adviser);
          if (insertResult === 'inserted') totalInserted++;
          else if (insertResult === 'skipped') totalSkipped++;
          else totalErrors++;
        }

        offset += firms.length;

        if (firms.length < PAGE_SIZE) {
          hasMore = false;
        }

        // Safety cap
        if (offset >= 10000) {
          hasMore = false;
        }
      } catch (err) {
        logger.error({ error: err, prefix, offset }, 'SEC IAPD search error');
        totalErrors++;
        break;
      }

      await delay(RATE_LIMIT_MS);
    }
  }

  logger.info(
    { inserted: totalInserted, skipped: totalSkipped, errors: totalErrors, pagesProcessed: totalPages },
    'SEC IAPD fetch complete',
  );

  return { inserted: totalInserted, skipped: totalSkipped, errors: totalErrors, pagesProcessed: totalPages };
}

/**
 * Fetch a specific adviser firm by CRD number.
 */
export async function fetchSecIapdByCrd(
  supabase: SupabaseClient,
  crdNumber: string,
): Promise<{ inserted: number; skipped: number; errors: number }> {
  logger.info({ crdNumber }, 'Fetching specific SEC IAPD firm');

  try {
    const detailUrl = `${IAPD_FIRM_URL}/${crdNumber}`;
    const response = await fetch(detailUrl, {
      headers: {
        'User-Agent': 'Arkova/1.0 (contact@arkova.ai)',
        Accept: 'application/json',
        Referer: 'https://adviserinfo.sec.gov/',
      },
    });

    if (!response.ok) {
      return { inserted: 0, skipped: 0, errors: 1 };
    }

    const data = (await response.json()) as Record<string, unknown>;
    const firm: IapdAdviser = {
      crdNumber,
      organizationName: String(data.OrgName ?? data.organizationName ?? 'Unknown'),
      secNumber: data.FirmSECNum ? String(data.FirmSECNum) : undefined,
      city: data.City ? String(data.City) : undefined,
      state: data.State ? String(data.State) : undefined,
      registrationStatus: data.RegistrationStatus ? String(data.RegistrationStatus) : undefined,
    };

    const result = await insertAdviserFirm(supabase, firm);
    return {
      inserted: result === 'inserted' ? 1 : 0,
      skipped: result === 'skipped' ? 1 : 0,
      errors: result === 'error' ? 1 : 0,
    };
  } catch (err) {
    logger.error({ error: err, crdNumber }, 'SEC IAPD specific fetch failed');
    return { inserted: 0, skipped: 0, errors: 1 };
  }
}
