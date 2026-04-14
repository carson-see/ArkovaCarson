/**
 * NPH-07: Insurance License & Entity Fetcher
 *
 * Fetches insurance producer license records from NAIC (National Association
 * of Insurance Commissioners) and state DOI (Department of Insurance) databases.
 *
 * Primary source: NIPR (National Insurance Producer Registry)
 * - PDB (Producer Database): https://nipr.com/products-and-services/pdb-hub
 * - Public lookup available per-state
 *
 * Phase 1: California DOI (CDI) — largest state market
 * CDI License Search: https://interactive.web.insurance.ca.gov/apex_extprd/f?p=102
 *
 * Gated by ENABLE_PUBLIC_RECORDS_INGESTION switchboard flag.
 */

import { logger } from '../utils/logger.js';
import { computeContentHash, delay } from '../utils/pipeline.js';
import type { SupabaseClient } from '@supabase/supabase-js';

const RATE_LIMIT_MS = 500;
const MAX_PER_RUN = 2000;

interface InsuranceLicenseFetchResult {
  source: string;
  inserted: number;
  skipped: number;
  errors: number;
}

/**
 * Fetch California DOI insurance producer licenses.
 */
async function fetchCdiLicenses(
  supabase: SupabaseClient,
): Promise<InsuranceLicenseFetchResult> {
  const CDI_SEARCH_URL = 'https://interactive.web.insurance.ca.gov/apex_extprd/f';
  let inserted = 0;
  let skipped = 0;
  let errors = 0;

  // Resume from last fetched license number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: lastRecord } = await (supabase as any)
    .from('public_records')
    .select('metadata')
    .eq('source', 'insurance_ca_cdi')
    .order('created_at', { ascending: false })
    .limit(1);

  const lastLicenseNum = lastRecord?.[0]?.metadata?.license_number
    ? parseInt(String(lastRecord[0].metadata.license_number), 10)
    : 0;

  logger.info({ lastLicenseNum, maxPerRun: MAX_PER_RUN }, 'CDI insurance license fetch starting');

  // CDI license numbers are sequential integers
  const batch: Array<Record<string, unknown>> = [];

  for (let num = lastLicenseNum + 1; num <= lastLicenseNum + MAX_PER_RUN; num++) {
    const licenseNum = String(num).padStart(7, '0');

    try {
      const response = await fetch(`${CDI_SEARCH_URL}?p=102:3:::NO::P3_LICENSE_NBR:${licenseNum}`);

      if (!response.ok) {
        if (response.status === 404) { skipped++; continue; }
        errors++;
        continue;
      }

      const html = await response.text();

      // Parse producer name and license info from CDI page
      const nameMatch = html.match(/Producer Name[^>]*>([^<]+)</);
      const typeMatch = html.match(/License Type[^>]*>([^<]+)</);
      const statusMatch = html.match(/Status[^>]*>(Active|Inactive|Expired|Suspended)/i);

      if (!nameMatch) {
        skipped++;
        continue;
      }

      batch.push({
        source: 'insurance_ca_cdi',
        source_id: `CA-INS-${licenseNum}`,
        source_url: `${CDI_SEARCH_URL}?p=102:3:::NO::P3_LICENSE_NBR:${licenseNum}`,
        record_type: 'insurance_license',
        title: `${nameMatch[1].trim()} — CA Insurance ${typeMatch?.[1]?.trim() ?? 'Producer'} (${statusMatch?.[1] ?? 'Unknown'})`,
        content_hash: computeContentHash(JSON.stringify({
          name: nameMatch[1].trim(),
          license: licenseNum,
          state: 'CA',
        })),
        metadata: {
          producer_name: nameMatch[1].trim(),
          license_number: licenseNum,
          license_type: typeMatch?.[1]?.trim() ?? 'Producer',
          status: statusMatch?.[1] ?? 'Unknown',
          state: 'CA',
          department: 'California Department of Insurance',
          pipeline_source: 'insurance_ca_cdi',
        },
      });

      if (batch.length >= 100) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error } = await (supabase as any)
          .from('public_records')
          .upsert(batch, { onConflict: 'source,source_id', ignoreDuplicates: true });
        if (error) errors += batch.length;
        else inserted += batch.length;
        batch.length = 0;
      }

      await delay(RATE_LIMIT_MS);
    } catch {
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

  return { source: 'CA CDI', inserted, skipped, errors };
}

/**
 * Fetch insurance license records from NAIC/state DOI databases.
 */
export async function fetchInsuranceLicenses(
  supabase: SupabaseClient,
  source?: string,
): Promise<InsuranceLicenseFetchResult[]> {
  const { data: enabled } = await supabase.rpc('get_flag', {
    p_flag_key: 'ENABLE_PUBLIC_RECORDS_INGESTION',
  });
  if (!enabled) {
    logger.info('ENABLE_PUBLIC_RECORDS_INGESTION disabled — skipping insurance license fetch');
    return [];
  }

  const results: InsuranceLicenseFetchResult[] = [];
  const sources = source ? [source] : ['ca_cdi'];

  for (const s of sources) {
    logger.info({ source: s }, 'Starting insurance license fetch');
    try {
      switch (s) {
        case 'ca_cdi':
          results.push(await fetchCdiLicenses(supabase));
          break;
        default:
          logger.warn({ source: s }, 'Insurance license fetcher not implemented');
          results.push({ source: s, inserted: 0, skipped: 0, errors: 0 });
      }
    } catch (err) {
      logger.error({ source: s, error: err }, 'Insurance license fetch failed');
      results.push({ source: s, inserted: 0, skipped: 0, errors: 1 });
    }
  }

  logger.info({ results }, 'Insurance license fetch complete');
  return results;
}
