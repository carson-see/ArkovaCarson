/**
 * NCX-02: Enforcement Action Fetchers
 *
 * Fetches enforcement actions so Nessie learns what compliance violations look like.
 * Sources:
 * - HHS OCR (HIPAA breach portal — public, structured)
 * - HHS OIG (enforcement actions — public)
 *
 * HHS Breach Portal API: https://ocrportal.hhs.gov/ocr/breach/breach_report.jsf
 * Structured CSV available at:
 *   https://ocrportal.hhs.gov/ocr/breach/breach_report.jsf (export)
 *
 * Gated by ENABLE_PUBLIC_RECORDS_INGESTION switchboard flag.
 */

import { logger } from '../utils/logger.js';
import { computeContentHash, delay } from '../utils/pipeline.js';
import type { SupabaseClient } from '@supabase/supabase-js';

const RATE_LIMIT_MS = 300;
const MAX_PER_RUN = 1000;
const INSERT_BATCH_SIZE = 100;

/** HHS HIPAA Breach Portal — structured breach reports */
const HHS_BREACH_URL = 'https://ocrportal.hhs.gov/ocr/breach/breach_report.jsf';

interface EnforcementFetchResult {
  hipaaBreaches: number;
  skipped: number;
  errors: number;
}

/**
 * Fetch HIPAA breach reports from HHS OCR portal.
 * The portal publishes breaches affecting 500+ individuals.
 */
async function fetchHipaaBreaches(
  supabase: SupabaseClient,
): Promise<{ inserted: number; skipped: number; errors: number }> {
  let inserted = 0;
  let skipped = 0;
  let errors = 0;

  // HHS publishes a downloadable breach report — try the CSV endpoint
  try {
    const response = await fetch(
      'https://ocrportal.hhs.gov/ocr/breach/breach_report.jsf?breachSubmissionYear=2025',
      { headers: { Accept: 'text/html' } },
    );

    if (!response.ok) {
      logger.warn({ status: response.status }, 'HHS breach portal fetch failed');
      return { inserted: 0, skipped: 0, errors: 1 };
    }

    const html = await response.text();

    // Parse breach entries from the portal HTML table
    const rowMatches = html.matchAll(
      /<tr[^>]*class="[^"]*breach[^"]*"[^>]*>[\s\S]*?<td[^>]*>([^<]+)<\/td>[\s\S]*?<td[^>]*>([^<]+)<\/td>[\s\S]*?<td[^>]*>([^<]+)<\/td>[\s\S]*?<td[^>]*>([^<]+)<\/td>[\s\S]*?<td[^>]*>([^<]+)<\/td>/gi,
    );

    const batch: Array<Record<string, unknown>> = [];

    for (const match of rowMatches) {
      if (inserted + skipped >= MAX_PER_RUN) break;

      const entityName = match[1]?.trim();
      const state = match[2]?.trim();
      const individualAffected = match[3]?.trim();
      const breachDate = match[4]?.trim();
      const breachType = match[5]?.trim();

      if (!entityName || entityName.length < 3) continue;

      const sourceId = `HHS-BREACH-${computeContentHash(entityName + breachDate).slice(0, 16)}`;

      batch.push({
        source: 'hhs_breach',
        source_id: sourceId,
        source_url: HHS_BREACH_URL,
        record_type: 'enforcement_action',
        title: `HIPAA Breach: ${entityName} (${state}) — ${individualAffected} affected`,
        content_hash: computeContentHash(JSON.stringify({ entity: entityName, date: breachDate, type: breachType })),
        metadata: {
          entity_name: entityName,
          state: state ?? null,
          individuals_affected: individualAffected ?? null,
          breach_date: breachDate ?? null,
          breach_type: breachType ?? null,
          regulation: 'HIPAA',
          enforcement_body: 'HHS Office for Civil Rights',
          jurisdiction: 'United States',
          pipeline_source: 'hhs_breach',
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
    logger.error({ error: err }, 'HIPAA breach fetch error');
    errors++;
  }

  return { inserted, skipped, errors };
}

/**
 * Fetch enforcement actions for Nessie compliance training.
 */
export async function fetchEnforcementActions(
  supabase: SupabaseClient,
): Promise<EnforcementFetchResult> {
  const { data: enabled } = await supabase.rpc('get_flag', {
    p_flag_key: 'ENABLE_PUBLIC_RECORDS_INGESTION',
  });
  if (!enabled) {
    logger.info('ENABLE_PUBLIC_RECORDS_INGESTION disabled — skipping enforcement fetch');
    return { hipaaBreaches: 0, skipped: 0, errors: 0 };
  }

  logger.info('Starting enforcement action fetch (NCX-02)');
  const hipaa = await fetchHipaaBreaches(supabase);

  const result: EnforcementFetchResult = {
    hipaaBreaches: hipaa.inserted,
    skipped: hipaa.skipped,
    errors: hipaa.errors,
  };

  logger.info(result, 'Enforcement action fetch complete');
  return result;
}
