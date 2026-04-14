/**
 * NPH-06: State Professional Licensing Board Fetcher
 *
 * Fetches professional license records from state licensing boards.
 * Phase 1: Nursing (state boards), Engineering (NCEES/state), Real Estate (state DOL), Teaching (state DOE)
 *
 * Most state licensing boards publish licensee directories online.
 * This fetcher targets the largest publicly searchable databases.
 *
 * Gated by ENABLE_PUBLIC_RECORDS_INGESTION switchboard flag.
 */

import { createHash } from 'node:crypto';
import { logger } from '../utils/logger.js';
import type { SupabaseClient } from '@supabase/supabase-js';

const RATE_LIMIT_MS = 500;
const MAX_PER_RUN = 2000;
const INSERT_BATCH_SIZE = 100;

function computeContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface LicenseRecord {
  licenseNumber: string;
  licenseType: string;       // nursing, engineering, real_estate, teaching
  licenseeType: string;      // individual or entity
  name: string;
  state: string;
  status: string;
  issueDate: string | null;
  expirationDate: string | null;
  sourceUrl: string;
  boardName: string;
}

interface LicenseFetchResult {
  board: string;
  inserted: number;
  skipped: number;
  errors: number;
}

/**
 * Fetch California nursing licenses from the BRN (Board of Registered Nursing).
 * Public license verification: https://www.rn.ca.gov/verification.shtml
 */
async function fetchCaNursing(
  supabase: SupabaseClient,
): Promise<LicenseFetchResult> {
  // CA BRN License Verification API
  const baseUrl = 'https://www.rn.ca.gov/consumers/verification.shtml';
  let inserted = 0;
  let skipped = 0;
  let errors = 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { count: existingCount } = await (supabase as any)
    .from('public_records')
    .select('id', { count: 'exact', head: true })
    .eq('source', 'license_ca_nursing');

  const startFrom = existingCount ?? 0;

  // CA BRN doesn't have a bulk API — license numbers are sequential (RN XXXXXXX)
  for (let i = startFrom; i < startFrom + MAX_PER_RUN; i++) {
    const licenseNum = `RN${String(i + 1).padStart(7, '0')}`;

    try {
      const response = await fetch(
        `https://search.dca.ca.gov/results?licenseNumber=${licenseNum}&boardCode=RN`,
        { headers: { Accept: 'application/json' } },
      );

      if (!response.ok) {
        if (response.status === 404) { skipped++; continue; }
        errors++;
        continue;
      }

      const data = await response.json() as {
        results?: Array<{
          name: string;
          licenseNumber: string;
          licenseType: string;
          status: string;
          issueDate: string;
          expirationDate: string;
          address: { city: string; state: string };
        }>;
      };

      if (!data.results || data.results.length === 0) {
        skipped++;
        continue;
      }

      const records = data.results.map((r) => ({
        source: 'license_ca_nursing',
        source_id: `CA-RN-${r.licenseNumber}`,
        source_url: `https://search.dca.ca.gov/results?licenseNumber=${r.licenseNumber}&boardCode=RN`,
        record_type: 'professional_license',
        title: `${r.name} — CA RN ${r.licenseNumber} (${r.status})`,
        content_hash: computeContentHash(JSON.stringify({
          name: r.name, license: r.licenseNumber, type: 'nursing', state: 'CA',
        })),
        metadata: {
          licensee_name: r.name,
          license_number: r.licenseNumber,
          license_type: 'nursing',
          board: 'CA Board of Registered Nursing',
          state: 'CA',
          status: r.status,
          issue_date: r.issueDate ?? null,
          expiration_date: r.expirationDate ?? null,
          pipeline_source: 'license_ca_nursing',
        },
      }));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (supabase as any)
        .from('public_records')
        .upsert(records, { onConflict: 'source,source_id', ignoreDuplicates: true });

      if (error) {
        errors += records.length;
      } else {
        inserted += records.length;
      }

      await delay(RATE_LIMIT_MS);
    } catch (err) {
      errors++;
    }
  }

  return { board: 'CA Nursing (BRN)', inserted, skipped, errors };
}

/**
 * Fetch professional licenses from state boards.
 */
export async function fetchLicensingBoardRecords(
  supabase: SupabaseClient,
  board?: string,
): Promise<LicenseFetchResult[]> {
  const { data: enabled } = await supabase.rpc('get_flag', {
    p_flag_key: 'ENABLE_PUBLIC_RECORDS_INGESTION',
  });
  if (!enabled) {
    logger.info('ENABLE_PUBLIC_RECORDS_INGESTION disabled — skipping licensing board fetch');
    return [];
  }

  const results: LicenseFetchResult[] = [];
  const boards = board ? [board] : ['ca_nursing'];

  for (const b of boards) {
    logger.info({ board: b }, 'Starting licensing board fetch');
    try {
      switch (b) {
        case 'ca_nursing':
          results.push(await fetchCaNursing(supabase));
          break;
        default:
          logger.warn({ board: b }, 'Licensing board fetcher not implemented');
          results.push({ board: b, inserted: 0, skipped: 0, errors: 0 });
      }
    } catch (err) {
      logger.error({ board: b, error: err }, 'Licensing board fetch failed');
      results.push({ board: b, inserted: 0, skipped: 0, errors: 1 });
    }
  }

  logger.info({ results }, 'Licensing board fetch complete');
  return results;
}
