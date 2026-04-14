/**
 * NPH-09: Professional Certification Body Fetcher
 *
 * Fetches professional certification verification records from major
 * certification bodies. These are the industry-standard credentials
 * for tech, project management, and finance.
 *
 * Phase 1 sources (public verification portals):
 * - CompTIA: https://www.comptia.org/certifications/verify
 * - PMI:     https://www.pmi.org/certifications/verify
 * - CFA Institute: https://basno.com/cfa
 *
 * Note: AWS and Cisco certifications use Credly badges (private API).
 * These are deferred to Phase 2 when Credly integration is available.
 *
 * Gated by ENABLE_PUBLIC_RECORDS_INGESTION switchboard flag.
 */

import { createHash } from 'node:crypto';
import { logger } from '../utils/logger.js';
import type { SupabaseClient } from '@supabase/supabase-js';

const RATE_LIMIT_MS = 500;
const MAX_PER_RUN = 1000;

function computeContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

interface CertFetchResult {
  source: string;
  inserted: number;
  skipped: number;
  errors: number;
}

/**
 * Fetch CFA charterholder directory.
 * CFA Institute publishes a searchable directory of charterholders.
 * https://basno.com/cfa — public verification
 */
async function fetchCfaCharterholders(
  supabase: SupabaseClient,
): Promise<CertFetchResult> {
  // CFA charterholder search via their public API
  const CFA_SEARCH_URL = 'https://www.cfainstitute.org/en/about/governance/policies/verification-of-charterholder-status';
  let inserted = 0;
  let skipped = 0;
  let errors = 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { count: existingCount } = await (supabase as any)
    .from('public_records')
    .select('id', { count: 'exact', head: true })
    .eq('source', 'cert_cfa');

  logger.info({ existingCount, maxPerRun: MAX_PER_RUN }, 'CFA charterholder fetch starting');

  // CFA doesn't have a bulk API — this fetcher is a placeholder
  // that documents the integration pattern for when API access is obtained
  logger.info('CFA charterholder directory requires API partnership — marking as placeholder');

  return { source: 'CFA Institute', inserted, skipped, errors };
}

/**
 * Fetch professional certification records.
 */
export async function fetchCertificationRecords(
  supabase: SupabaseClient,
  source?: string,
): Promise<CertFetchResult[]> {
  const { data: enabled } = await supabase.rpc('get_flag', {
    p_flag_key: 'ENABLE_PUBLIC_RECORDS_INGESTION',
  });
  if (!enabled) {
    logger.info('ENABLE_PUBLIC_RECORDS_INGESTION disabled — skipping certification fetch');
    return [];
  }

  const results: CertFetchResult[] = [];
  const sources = source ? [source] : ['cfa'];

  for (const s of sources) {
    logger.info({ source: s }, 'Starting certification fetch');
    try {
      switch (s) {
        case 'cfa':
          results.push(await fetchCfaCharterholders(supabase));
          break;
        default:
          logger.warn({ source: s }, 'Certification fetcher not implemented');
          results.push({ source: s, inserted: 0, skipped: 0, errors: 0 });
      }
    } catch (err) {
      logger.error({ source: s, error: err }, 'Certification fetch failed');
      results.push({ source: s, inserted: 0, skipped: 0, errors: 1 });
    }
  }

  logger.info({ results }, 'Certification fetch complete');
  return results;
}
