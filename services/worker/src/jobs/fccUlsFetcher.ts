/**
 * FCC Universal Licensing System (ULS) Fetcher
 *
 * Fetches FCC license records from the ULS License View API.
 *
 * API: https://data.fcc.gov/api/license-view/
 * Auth: None required for basic search; API key optional for higher limits
 * Rate limit: 1,000 req/hour (default), higher with API key
 * Records: 3,000,000+ active licenses
 *
 * Why anchor this: FCC license verification — proves an entity held
 * a valid FCC license at a point in time. Covers broadcast, wireless,
 * amateur radio, satellite, microwave, and other spectrum licenses.
 *
 * Data includes: callsign, licensee name, FRN, grant/expiration dates,
 * service type, status, frequency assignments.
 *
 * Constitution refs:
 *   - 4A: Only metadata is stored server-side
 */

import { createHash } from 'node:crypto';
import { logger } from '../utils/logger.js';
import type { SupabaseClient } from '@supabase/supabase-js';

/** FCC ULS License View API */
/** FCC API redirects data.fcc.gov → www.fcc.gov. Use direct URL. */
const FCC_LICENSE_URL = 'https://www.fcc.gov/api/license-view/basicSearch/getLicenses';

/** Rate limit: ~3 req/sec to be safe (1000/hour) */
const RATE_LIMIT_MS = 350;

/** Results per page (API max varies, 100 is safe) */
const PAGE_SIZE = 100;

/** Max records per run */
const MAX_PER_RUN = 10000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbAny = (db: SupabaseClient) => db as any;

interface FccLicense {
  licName?: string;
  frn?: string;
  callsign?: string;
  categoryDesc?: string;
  serviceDesc?: string;
  statusDesc?: string;
  expiredDate?: string;
  grantDate?: string;
  lastActionDate?: string;
  licenseID?: string;
  commonName?: string;
}

interface FccSearchResponse {
  status?: string;
  Licenses?: {
    totalRows?: string;
    lastUpdate?: string;
    License?: FccLicense[] | FccLicense;
    page?: string;
    rowPerPage?: string;
  };
}

function computeContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function insertFccLicense(
  supabase: SupabaseClient,
  license: FccLicense,
): Promise<'inserted' | 'skipped' | 'error'> {
  const callsign = license.callsign?.trim() ?? '';
  const licenseId = license.licenseID?.trim() ?? '';
  const identifier = callsign || licenseId;
  if (!identifier) return 'skipped';

  const sourceId = `fcc-${identifier}`;

  // Check for duplicates
  const { data: existing } = await dbAny(supabase)
    .from('public_records')
    .select('id')
    .eq('source', 'fcc')
    .eq('source_id', sourceId)
    .limit(1);

  if (existing && existing.length > 0) {
    return 'skipped';
  }

  const name = license.licName ?? license.commonName ?? 'Unknown Licensee';
  const serviceType = license.serviceDesc ?? license.categoryDesc ?? 'Unknown';
  const status = license.statusDesc ?? 'Unknown';

  const contentForHash = JSON.stringify({
    callsign: identifier,
    name,
    service: serviceType,
    status,
  });

  const sourceUrl = callsign
    ? `https://wireless2.fcc.gov/UlsApp/UlsSearch/license.jsp?licKey=${licenseId || callsign}`
    : `https://wireless2.fcc.gov/UlsApp/UlsSearch/searchLicense.jsp`;

  const { error: insertError } = await dbAny(supabase)
    .from('public_records')
    .insert({
      source: 'fcc',
      source_id: sourceId,
      source_url: sourceUrl,
      record_type: 'fcc_license',
      title: `${name} — FCC ${callsign ? `Callsign ${callsign}` : `License ${licenseId}`} (${serviceType})`,
      content_hash: computeContentHash(contentForHash),
      metadata: {
        callsign: callsign || null,
        license_id: licenseId || null,
        licensee_name: name,
        common_name: license.commonName ?? null,
        frn: license.frn ?? null,
        category: license.categoryDesc ?? null,
        service_type: serviceType,
        status: status,
        grant_date: license.grantDate ?? null,
        expiration_date: license.expiredDate ?? null,
        last_action_date: license.lastActionDate ?? null,
        pipeline_source: 'fcc',
        registry: 'FCC Universal Licensing System',
        jurisdiction: 'US',
        license_type: 'fcc_license',
      },
    });

  if (insertError) {
    if (insertError.code === '23505') {
      return 'skipped';
    }
    logger.error({ sourceId, error: insertError }, 'FCC license insert failed');
    return 'error';
  }
  return 'inserted';
}

/**
 * FCC service codes for systematic enumeration.
 * Each code represents a license service type.
 * Major categories with largest record counts listed first.
 */
const _FCC_SERVICE_CODES = [
  'HA',  // Amateur - ~750K licenses
  'HV',  // Vanity Amateur
  'MG',  // Microwave (General)
  'IG',  // Industrial/Business Pool - conventional
  'LD',  // Local Exchange Carrier (LEC)
  'CF',  // Common Carrier Fixed Point-to-Point
  'AA',  // Aviation (Aircraft)
  'SA',  // Ship - Compulsory
  'SB',  // Ship - Voluntary
  'YG',  // Personal Use (900 MHz)
  'YH',  // Personal Use (GMRS)
  'WZ',  // Wireless (broadband)
  'CW',  // PCS - Broadband
  'ED',  // Educational Broadband
  'WS',  // Wireless (paging)
  'MM',  // Millimeter Wave
  'NN',  // 3650 MHz
  'WU',  // 700 MHz Upper Band
  'WX',  // 700 MHz Lower Band
  'TI',  // TV Intercity Relay
  'TB',  // TV Broadcast Translator
  'BL',  // Broadcast Auxiliary Low Power
];

/**
 * Two-letter state codes for name-based search sharding.
 */
const _US_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL',
  'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME',
  'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH',
  'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'PR',
  'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'VI', 'WA',
  'WV', 'WI', 'WY',
];

/** Last name prefixes for search sharding */
const NAME_PREFIXES = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

/**
 * Fetch FCC ULS licenses.
 *
 * Strategy: Search by name prefix to enumerate the full database.
 * The FCC API returns up to 1000 rows per query, so we shard by
 * first letter of licensee name.
 */
export async function fetchFccLicenses(
  supabase: SupabaseClient,
  options?: { maxPerRun?: number },
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
    logger.info('ENABLE_PUBLIC_RECORDS_INGESTION is disabled — skipping FCC fetch');
    return { inserted: 0, skipped: 0, errors: 0, pagesProcessed: 0 };
  }

  const maxPerRun = options?.maxPerRun ?? MAX_PER_RUN;

  logger.info({ maxPerRun }, 'FCC ULS: starting license fetch');

  let totalInserted = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  let totalPages = 0;

  for (const prefix of NAME_PREFIXES) {
    if (totalInserted >= maxPerRun) {
      logger.info({ totalInserted, prefix }, 'FCC: reached max per run');
      break;
    }

    let pageNum = 1;
    let hasMore = true;

    while (hasMore) {
      try {
        const params = new URLSearchParams({
          searchValue: prefix,
          format: 'json',
          pageNum: String(pageNum),
          size: String(PAGE_SIZE),
        });

        const response = await fetch(`${FCC_LICENSE_URL}?${params.toString()}`, {
          headers: {
            'User-Agent': 'Arkova/1.0 (contact@arkova.ai)',
            Accept: 'application/json',
          },
        });

        if (!response.ok) {
          if (response.status === 429) {
            logger.warn({ prefix }, 'FCC rate limited — backing off 60 seconds');
            await delay(60_000);
            continue;
          }
          logger.error({ status: response.status, prefix }, 'FCC search failed');
          totalErrors++;
          break;
        }

        let result: FccSearchResponse;
        try {
          result = (await response.json()) as FccSearchResponse;
        } catch {
          logger.error({ prefix, pageNum }, 'Failed to parse FCC response');
          totalErrors++;
          break;
        }

        // FCC API returns single object instead of array for 1 result
        const rawLicenses = result.Licenses?.License;
        const licenses: FccLicense[] = !rawLicenses
          ? []
          : Array.isArray(rawLicenses)
            ? rawLicenses
            : [rawLicenses];

        totalPages++;

        if (licenses.length === 0) {
          hasMore = false;
          break;
        }

        const totalRows = parseInt(result.Licenses?.totalRows ?? '0', 10);

        logger.info(
          { prefix, pageNum, count: licenses.length, totalRows },
          'FCC batch received',
        );

        for (const license of licenses) {
          const insertResult = await insertFccLicense(supabase, license);
          if (insertResult === 'inserted') totalInserted++;
          else if (insertResult === 'skipped') totalSkipped++;
          else totalErrors++;
        }

        pageNum++;

        if (licenses.length < PAGE_SIZE) {
          hasMore = false;
        }

        // Cap at 10 pages per prefix (1000 results)
        if (pageNum > 10) {
          if (totalRows > 1000) {
            logger.warn(
              { prefix, totalRows },
              'FCC: prefix exceeds 1000 results — some records may be missed',
            );
          }
          hasMore = false;
        }

        if (totalInserted > 0 && totalInserted % 500 === 0) {
          logger.info(
            { inserted: totalInserted, skipped: totalSkipped, errors: totalErrors, prefix, pageNum },
            'FCC progress',
          );
        }
      } catch (err) {
        logger.error({ error: err, prefix, pageNum }, 'FCC search error');
        totalErrors++;
        break;
      }

      await delay(RATE_LIMIT_MS);
    }
  }

  logger.info(
    { inserted: totalInserted, skipped: totalSkipped, errors: totalErrors, pagesProcessed: totalPages },
    'FCC ULS fetch complete',
  );

  return { inserted: totalInserted, skipped: totalSkipped, errors: totalErrors, pagesProcessed: totalPages };
}
