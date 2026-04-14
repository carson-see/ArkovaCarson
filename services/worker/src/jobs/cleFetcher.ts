/**
 * NPH-08: CLE Credit & Compliance Fetcher
 *
 * Fetches Continuing Legal Education (CLE) credit records from
 * state bar CLE databases. Lawyers must maintain CLE credits to
 * keep their license active — this data verifies compliance.
 *
 * Phase 1: New York CLE Board, Texas MCLE
 * - NY CLE: https://ww2.nycourts.gov/attorneys/cle/
 * - TX MCLE: https://www.texasbar.com/mcle
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface CleFetchResult {
  source: string;
  inserted: number;
  skipped: number;
  errors: number;
}

/**
 * Fetch CLE provider/course data from NY CLE Board.
 * The NY CLE Board publishes accredited CLE providers and courses.
 */
async function fetchNyCle(
  supabase: SupabaseClient,
): Promise<CleFetchResult> {
  const NY_CLE_URL = 'https://ww2.nycourts.gov/attorneys/cle/approvedproviders.shtml';
  let inserted = 0;
  let skipped = 0;
  let errors = 0;

  try {
    const response = await fetch(NY_CLE_URL);
    if (!response.ok) {
      logger.error({ status: response.status }, 'NY CLE page fetch failed');
      return { source: 'NY CLE Board', inserted: 0, skipped: 0, errors: 1 };
    }

    const html = await response.text();

    // Parse provider list from the page
    // NY CLE Board lists approved providers in a table format
    const providerMatches = html.matchAll(/<tr[^>]*>\s*<td[^>]*>([^<]+)<\/td>\s*<td[^>]*>([^<]*)<\/td>/gi);

    const batch: Array<Record<string, unknown>> = [];

    for (const match of providerMatches) {
      const providerName = match[1]?.trim();
      const providerNumber = match[2]?.trim();

      if (!providerName || providerName.length < 3) continue;

      batch.push({
        source: 'cle_ny',
        source_id: `NY-CLE-${providerNumber || computeContentHash(providerName).slice(0, 12)}`,
        source_url: NY_CLE_URL,
        record_type: 'cle_provider',
        title: `${providerName} — NY CLE Approved Provider`,
        content_hash: computeContentHash(JSON.stringify({ name: providerName, state: 'NY' })),
        metadata: {
          provider_name: providerName,
          provider_number: providerNumber || null,
          state: 'NY',
          board: 'NY CLE Board',
          pipeline_source: 'cle_ny',
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
    }

    if (batch.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (supabase as any)
        .from('public_records')
        .upsert(batch, { onConflict: 'source,source_id', ignoreDuplicates: true });
      if (error) errors += batch.length;
      else inserted += batch.length;
    }
  } catch (err) {
    logger.error({ error: err }, 'NY CLE fetch error');
    errors++;
  }

  return { source: 'NY CLE Board', inserted, skipped, errors };
}

/**
 * Fetch CLE records from state bar databases.
 */
export async function fetchCleRecords(
  supabase: SupabaseClient,
  source?: string,
): Promise<CleFetchResult[]> {
  const { data: enabled } = await supabase.rpc('get_flag', {
    p_flag_key: 'ENABLE_PUBLIC_RECORDS_INGESTION',
  });
  if (!enabled) {
    logger.info('ENABLE_PUBLIC_RECORDS_INGESTION disabled — skipping CLE fetch');
    return [];
  }

  const results: CleFetchResult[] = [];
  const sources = source ? [source] : ['ny_cle'];

  for (const s of sources) {
    logger.info({ source: s }, 'Starting CLE fetch');
    try {
      switch (s) {
        case 'ny_cle':
          results.push(await fetchNyCle(supabase));
          break;
        default:
          logger.warn({ source: s }, 'CLE fetcher not implemented');
          results.push({ source: s, inserted: 0, skipped: 0, errors: 0 });
      }
    } catch (err) {
      logger.error({ source: s, error: err }, 'CLE fetch failed');
      results.push({ source: s, inserted: 0, skipped: 0, errors: 1 });
    }
  }

  logger.info({ results }, 'CLE fetch complete');
  return results;
}
