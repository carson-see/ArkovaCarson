/**
 * NCX-03: NASBA/CPE Continuing Education Registry Fetcher
 * NCX-04: CME/ACCME Medical Continuing Education Fetcher
 *
 * Fetches continuing education provider/course data:
 * - NASBA CPE sponsor registry (accounting CE)
 * - ACCME accredited provider directory (medical CE)
 *
 * Sources:
 * - nasbaregistry.org (NASBA CPE sponsor search — public)
 * - accme.org/accredited-providers (ACCME directory — public)
 *
 * Gated by ENABLE_PUBLIC_RECORDS_INGESTION switchboard flag.
 */

import { logger } from '../utils/logger.js';
import { computeContentHash } from '../utils/pipeline.js';
import type { SupabaseClient } from '@supabase/supabase-js';

const INSERT_BATCH_SIZE = 50;

interface CeFetchResult {
  nasbaInserted: number;
  accmeInserted: number;
  skipped: number;
  errors: number;
}

/**
 * Fetch NASBA CPE sponsor registry data.
 * NASBA maintains the National Registry of CPE Sponsors.
 */
async function fetchNasbaCpeSponsors(
  supabase: SupabaseClient,
): Promise<{ inserted: number; skipped: number; errors: number }> {
  let inserted = 0;
  const skipped = 0;
  let errors = 0;

  try {
    const response = await fetch('https://www.nasbaregistry.org/sponsor-search?page=1&size=100', {
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      logger.warn({ status: response.status }, 'NASBA registry fetch failed');
      return { inserted: 0, skipped: 0, errors: 1 };
    }

    const data = await response.json() as {
      sponsors?: Array<{
        id: string;
        name: string;
        city: string;
        state: string;
        status: string;
        registryNumber: string;
      }>;
    };

    const batch: Array<Record<string, unknown>> = [];

    for (const sponsor of data.sponsors ?? []) {
      batch.push({
        source: 'nasba_cpe',
        source_id: `NASBA-${sponsor.registryNumber || sponsor.id}`,
        source_url: `https://www.nasbaregistry.org/sponsor/${sponsor.id}`,
        record_type: 'ce_provider',
        title: `${sponsor.name} — NASBA CPE Sponsor (${sponsor.status})`,
        content_hash: computeContentHash(JSON.stringify({ name: sponsor.name, id: sponsor.id })),
        metadata: {
          provider_name: sponsor.name,
          registry_number: sponsor.registryNumber ?? null,
          city: sponsor.city ?? null,
          state: sponsor.state ?? null,
          status: sponsor.status ?? null,
          ce_type: 'CPE',
          registry: 'NASBA',
          pipeline_source: 'nasba_cpe',
        },
      });

      if (batch.length >= INSERT_BATCH_SIZE) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error } = await (supabase as any)
          .from('public_records')
          .upsert(batch, { onConflict: 'source,source_id', ignoreDuplicates: true });
        if (error) { errors += batch.length; } else { inserted += batch.length; }
        batch.length = 0;
      }
    }

    if (batch.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (supabase as any)
        .from('public_records')
        .upsert(batch, { onConflict: 'source,source_id', ignoreDuplicates: true });
      if (error) { errors += batch.length; } else { inserted += batch.length; }
    }
  } catch (err) {
    logger.error({ error: err }, 'NASBA CPE fetch error');
    errors++;
  }

  return { inserted, skipped, errors };
}

/**
 * Fetch ACCME accredited CME provider directory.
 */
async function fetchAccmeProviders(
  supabase: SupabaseClient,
): Promise<{ inserted: number; skipped: number; errors: number }> {
  let inserted = 0;
  const skipped = 0;
  let errors = 0;

  try {
    const response = await fetch('https://www.accme.org/accredited-providers', {
      headers: { Accept: 'text/html' },
    });

    if (!response.ok) {
      logger.warn({ status: response.status }, 'ACCME directory fetch failed');
      return { inserted: 0, skipped: 0, errors: 1 };
    }

    const html = await response.text();

    // Parse provider entries from ACCME directory page
    const providerMatches = html.matchAll(
      /<td[^>]*class="[^"]*views-field-title[^"]*"[^>]*>\s*<a[^>]*>([^<]+)<\/a>/gi,
    );

    const batch: Array<Record<string, unknown>> = [];

    for (const match of providerMatches) {
      const providerName = match[1]?.trim();
      if (!providerName || providerName.length < 3) continue;

      const providerId = computeContentHash(providerName).slice(0, 16);

      batch.push({
        source: 'accme',
        source_id: `ACCME-${providerId}`,
        source_url: 'https://www.accme.org/accredited-providers',
        record_type: 'ce_provider',
        title: `${providerName} — ACCME Accredited CME Provider`,
        content_hash: computeContentHash(JSON.stringify({ name: providerName, type: 'CME' })),
        metadata: {
          provider_name: providerName,
          ce_type: 'CME',
          credit_type: 'AMA PRA Category 1',
          registry: 'ACCME',
          pipeline_source: 'accme',
        },
      });

      if (batch.length >= INSERT_BATCH_SIZE) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error } = await (supabase as any)
          .from('public_records')
          .upsert(batch, { onConflict: 'source,source_id', ignoreDuplicates: true });
        if (error) { errors += batch.length; } else { inserted += batch.length; }
        batch.length = 0;
      }
    }

    if (batch.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (supabase as any)
        .from('public_records')
        .upsert(batch, { onConflict: 'source,source_id', ignoreDuplicates: true });
      if (error) { errors += batch.length; } else { inserted += batch.length; }
    }
  } catch (err) {
    logger.error({ error: err }, 'ACCME fetch error');
    errors++;
  }

  return { inserted, skipped, errors };
}

/**
 * Fetch continuing education provider data for Nessie training.
 */
export async function fetchContinuingEducationData(
  supabase: SupabaseClient,
): Promise<CeFetchResult> {
  const { data: enabled } = await supabase.rpc('get_flag', {
    p_flag_key: 'ENABLE_PUBLIC_RECORDS_INGESTION',
  });
  if (!enabled) {
    logger.info('ENABLE_PUBLIC_RECORDS_INGESTION disabled — skipping CE fetch');
    return { nasbaInserted: 0, accmeInserted: 0, skipped: 0, errors: 0 };
  }

  logger.info('Starting continuing education data fetch (NCX-03/04)');

  const nasba = await fetchNasbaCpeSponsors(supabase);
  const accme = await fetchAccmeProviders(supabase);

  const result: CeFetchResult = {
    nasbaInserted: nasba.inserted,
    accmeInserted: accme.inserted,
    skipped: nasba.skipped + accme.skipped,
    errors: nasba.errors + accme.errors,
  };

  logger.info(result, 'Continuing education data fetch complete');
  return result;
}
