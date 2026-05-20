/**
 * NCX-06: NCES/Clearinghouse Transcript Verification Data Fetcher
 *
 * Fetches institution data from the National Center for Education Statistics
 * via the Urban Institute Education Data Portal API.
 *
 * Targets: institution completion rates, program offerings, accreditation status.
 * Complements the existing IPEDS fetcher with completion/program-level data.
 *
 * API: https://educationdata.urban.org/api/v1/
 * Free, public, no auth required.
 *
 * Gated by ENABLE_PUBLIC_RECORDS_INGESTION switchboard flag.
 */

import { logger } from '../utils/logger.js';
import { computeContentHash, delay } from '../utils/pipeline.js';
import type { SupabaseClient } from '@supabase/supabase-js';

const NCES_API_BASE = 'https://educationdata.urban.org/api/v1';
const RATE_LIMIT_MS = 300;
const MAX_PER_RUN = 2000;
const INSERT_BATCH_SIZE = 100;

interface NcesInstitution {
  unitid: number;
  inst_name: string;
  city: string;
  state_abbr: string;
  zip: string;
  sector: number;
  level: number;
  control: number;
  hbcu: number;
  tribal_college: number;
  year: number;
}

interface NcesFetchResult {
  inserted: number;
  skipped: number;
  errors: number;
}

function sectorLabel(sector: number): string {
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

function controlLabel(control: number): string {
  const controls: Record<number, string> = {
    1: 'Public',
    2: 'Private non-profit',
    3: 'Private for-profit',
  };
  return controls[control] ?? `Control ${control}`;
}

/**
 * Fetch NCES institution data for transcript verification.
 * Uses the Urban Institute Education Data Portal API.
 */
export async function fetchNcesInstitutionData(
  supabase: SupabaseClient,
): Promise<NcesFetchResult> {
  const { data: enabled } = await supabase.rpc('get_flag', {
    p_flag_key: 'ENABLE_PUBLIC_RECORDS_INGESTION',
  });
  if (!enabled) {
    logger.info('ENABLE_PUBLIC_RECORDS_INGESTION disabled — skipping NCES fetch');
    return { inserted: 0, skipped: 0, errors: 0 };
  }

  let totalInserted = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  try {
    logger.info('Starting NCES institution data fetch (NCX-06)');

    const url = `${NCES_API_BASE}/college-university/ipeds/directory/2022?per_page=${MAX_PER_RUN}`;
    await delay(RATE_LIMIT_MS);

    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      logger.warn({ status: response.status }, 'NCES API fetch failed');
      return { inserted: 0, skipped: 0, errors: 1 };
    }

    const data = await response.json() as { results?: NcesInstitution[] };
    const institutions = data.results ?? [];

    if (institutions.length === 0) {
      logger.info('No NCES institutions returned');
      return { inserted: 0, skipped: 0, errors: 0 };
    }

    logger.info({ count: institutions.length }, 'NCES institutions fetched');

    const batch: Array<Record<string, unknown>> = [];

    for (const inst of institutions) {
      if (!inst.unitid || !inst.inst_name) {
        totalSkipped++;
        continue;
      }

      batch.push({
        source: 'nces',
        source_id: `NCES-${inst.unitid}`,
        source_url: `https://nces.ed.gov/collegenavigator/?id=${inst.unitid}`,
        record_type: 'education_institution',
        title: `${inst.inst_name} — NCES IPEDS (${sectorLabel(inst.sector)})`,
        content_hash: computeContentHash(
          JSON.stringify({ unitid: inst.unitid, name: inst.inst_name, year: inst.year }),
        ),
        metadata: {
          unitid: inst.unitid,
          institution_name: inst.inst_name,
          city: inst.city ?? null,
          state: inst.state_abbr ?? null,
          zip: inst.zip ?? null,
          sector: sectorLabel(inst.sector),
          control: controlLabel(inst.control),
          hbcu: inst.hbcu === 1,
          tribal_college: inst.tribal_college === 1,
          data_year: inst.year,
          pipeline_source: 'nces',
        },
      });

      if (batch.length >= INSERT_BATCH_SIZE) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error } = await (supabase as any)
          .from('public_records')
          .upsert(batch, { onConflict: 'source,source_id', ignoreDuplicates: true });
        if (error) {
          logger.error({ error, count: batch.length }, 'NCES batch insert failed');
          totalErrors += batch.length;
        } else {
          totalInserted += batch.length;
        }
        batch.length = 0;
      }
    }

    // Flush remaining
    if (batch.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (supabase as any)
        .from('public_records')
        .upsert(batch, { onConflict: 'source,source_id', ignoreDuplicates: true });
      if (error) {
        logger.error({ error, count: batch.length }, 'NCES batch insert failed');
        totalErrors += batch.length;
      } else {
        totalInserted += batch.length;
      }
    }
  } catch (err) {
    logger.error({ error: err }, 'NCES fetch error');
    totalErrors++;
  }

  logger.info(
    { totalInserted, totalSkipped, totalErrors },
    'NCES institution data fetch complete',
  );

  return { inserted: totalInserted, skipped: totalSkipped, errors: totalErrors };
}
