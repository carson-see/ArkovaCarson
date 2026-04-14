/**
 * NPH-10: Education Verification Fetcher (IPEDS)
 *
 * Fetches institution data from IPEDS (Integrated Postsecondary Education
 * Data System) maintained by NCES (National Center for Education Statistics).
 *
 * IPEDS is the definitive federal database of US postsecondary institutions.
 * ~6,500 Title IV institutions + ~2,000 non-Title IV.
 *
 * API: https://educationdata.urban.org/api/v1/
 * Bulk data: https://nces.ed.gov/ipeds/use-the-data
 *
 * This complements DAPIP (accreditation) with enrollment, completion,
 * financial data that supports education credential verification.
 *
 * Gated by ENABLE_PUBLIC_RECORDS_INGESTION switchboard flag.
 */

import { logger } from '../utils/logger.js';
import { computeContentHash, delay } from '../utils/pipeline.js';
import type { SupabaseClient } from '@supabase/supabase-js';

const RATE_LIMIT_MS = 300;
const MAX_PER_RUN = 3000;
const INSERT_BATCH_SIZE = 100;

/** Urban Institute Education Data Portal API (free, no auth) */
const IPEDS_API_BASE = 'https://educationdata.urban.org/api/v1';

interface IpedsInstitution {
  unitid: number;
  inst_name: string;
  city: string;
  state_abbr: string;
  zip: string;
  sector: number;
  sector_name?: string;
  level: number;
  level_name?: string;
  control: number;
  control_name?: string;
  hbcu: number;
  tribal_college: number;
  year: number;
}

interface IpedsFetchResult {
  inserted: number;
  skipped: number;
  errors: number;
  total: number;
}

function sectorName(sector: number): string {
  const sectors: Record<number, string> = {
    1: 'Public, 4-year',
    2: 'Private non-profit, 4-year',
    3: 'Private for-profit, 4-year',
    4: 'Public, 2-year',
    5: 'Private non-profit, 2-year',
    6: 'Private for-profit, 2-year',
    7: 'Public, less-than-2-year',
    8: 'Private non-profit, less-than-2-year',
    9: 'Private for-profit, less-than-2-year',
  };
  return sectors[sector] ?? `Sector ${sector}`;
}

/**
 * Fetch IPEDS institution directory data.
 * Uses the Urban Institute Education Data Portal API.
 */
export async function fetchIpedsInstitutions(
  supabase: SupabaseClient,
): Promise<IpedsFetchResult> {
  // Check switchboard flag
  const { data: enabled } = await supabase.rpc('get_flag', {
    p_flag_key: 'ENABLE_PUBLIC_RECORDS_INGESTION',
  });
  if (!enabled) {
    logger.info('ENABLE_PUBLIC_RECORDS_INGESTION disabled — skipping IPEDS fetch');
    return { inserted: 0, skipped: 0, errors: 0, total: 0 };
  }

  const year = new Date().getFullYear() - 1; // IPEDS data lags ~1 year

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { count: existingCount } = await (supabase as any)
    .from('public_records')
    .select('id', { count: 'exact', head: true })
    .eq('source', 'ipeds');

  const offset = existingCount ?? 0;

  logger.info({ year, offset, maxPerRun: MAX_PER_RUN }, 'IPEDS institution fetch starting');

  let inserted = 0;
  let skipped = 0;
  let errors = 0;
  let total = 0;
  const batch: Array<Record<string, unknown>> = [];

  let page = Math.floor(offset / 100);
  const maxPages = Math.ceil(MAX_PER_RUN / 100);

  for (let p = 0; p < maxPages; p++) {
    try {
      const url = `${IPEDS_API_BASE}/college-university/ipeds/directory/${year}/?page=${page + p}&per_page=100`;
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
      });

      if (!response.ok) {
        if (response.status === 404) break; // No more pages
        logger.warn({ page: page + p, status: response.status }, 'IPEDS page fetch failed');
        errors++;
        continue;
      }

      const data = await response.json() as {
        results: IpedsInstitution[];
        count?: number;
      };

      if (!data.results || data.results.length === 0) break;
      if (data.count && total === 0) total = data.count;

      for (const inst of data.results) {
        batch.push({
          source: 'ipeds',
          source_id: `IPEDS-${inst.unitid}`,
          source_url: `https://nces.ed.gov/ipeds/datacenter/institutionprofile.aspx?unitId=${inst.unitid}`,
          record_type: 'education_institution',
          title: `${inst.inst_name} (${inst.city}, ${inst.state_abbr})`,
          content_hash: computeContentHash(JSON.stringify({
            unitid: inst.unitid,
            name: inst.inst_name,
            state: inst.state_abbr,
            sector: inst.sector,
          })),
          metadata: {
            institution_name: inst.inst_name,
            unitid: inst.unitid,
            city: inst.city,
            state: inst.state_abbr,
            zip: inst.zip,
            sector: sectorName(inst.sector),
            hbcu: inst.hbcu === 1,
            tribal_college: inst.tribal_college === 1,
            year: inst.year ?? year,
            pipeline_source: 'ipeds',
          },
        });

        if (batch.length >= INSERT_BATCH_SIZE) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { error } = await (supabase as any)
            .from('public_records')
            .upsert(batch, { onConflict: 'source,source_id', ignoreDuplicates: true });
          if (error) {
            logger.error({ error, count: batch.length }, 'IPEDS batch insert failed');
            errors += batch.length;
          } else {
            inserted += batch.length;
          }
          batch.length = 0;
        }
      }

      await delay(RATE_LIMIT_MS);

      if ((p + 1) % 10 === 0) {
        logger.info({ page: page + p, inserted, skipped, errors }, 'IPEDS fetch progress');
      }
    } catch (err) {
      logger.error({ page: page + p, error: err }, 'IPEDS page fetch error');
      errors++;
    }
  }

  // Flush remaining
  if (batch.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any)
      .from('public_records')
      .upsert(batch, { onConflict: 'source,source_id', ignoreDuplicates: true });
    if (error) errors += batch.length;
    else inserted += batch.length;
  }

  logger.info({ inserted, skipped, errors, total }, 'IPEDS institution fetch complete');
  return { inserted, skipped, errors, total };
}
