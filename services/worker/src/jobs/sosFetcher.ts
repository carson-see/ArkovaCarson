/**
 * NPH-05: State Secretary of State Business Entity Fetcher
 *
 * Fetches business entity records from state SOS databases.
 * Phase 1: Delaware (ECORP), California (bizfile), New York (DOS), Texas (SOSDirect)
 *
 * These are the four most important states for business entity verification:
 * - Delaware: ~1.9M entities (most US companies incorporate here)
 * - California: ~4M entities
 * - New York: ~1.2M entities
 * - Texas: ~2.5M entities
 *
 * Strategy: Each state has a different API/scraping approach.
 * For now, we use publicly available bulk data where possible,
 * and paginated API access where available.
 *
 * Gated by ENABLE_PUBLIC_RECORDS_INGESTION switchboard flag.
 */

import { logger } from '../utils/logger.js';
import { computeContentHash, delay } from '../utils/pipeline.js';
import type { SupabaseClient } from '@supabase/supabase-js';

const RATE_LIMIT_MS = 500;
const MAX_PER_RUN = 2000;
const INSERT_BATCH_SIZE = 50;

interface SosEntity {
  name: string;
  entityNumber: string;
  state: string;
  entityType: string;
  status: string;
  formationDate: string | null;
  agentName: string | null;
  sourceUrl: string;
}

interface SosFetchResult {
  state: string;
  inserted: number;
  skipped: number;
  errors: number;
}

async function insertBatch(
  supabase: SupabaseClient,
  entities: SosEntity[],
): Promise<{ inserted: number; skipped: number; errors: number }> {
  const records = entities.map((e) => ({
    source: `sos_${e.state.toLowerCase()}`,
    source_id: `${e.state}-${e.entityNumber}`,
    source_url: e.sourceUrl,
    record_type: 'business_entity',
    title: `${e.name} (${e.state} ${e.entityType})`,
    content_hash: computeContentHash(JSON.stringify({
      name: e.name,
      number: e.entityNumber,
      state: e.state,
      type: e.entityType,
    })),
    metadata: {
      entity_name: e.name,
      entity_number: e.entityNumber,
      entity_type: e.entityType,
      state: e.state,
      status: e.status,
      formation_date: e.formationDate,
      agent_name: e.agentName,
      pipeline_source: `sos_${e.state.toLowerCase()}`,
    },
  }));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase as any)
    .from('public_records')
    .upsert(records, { onConflict: 'source,source_id', ignoreDuplicates: true });

  if (error) {
    logger.error({ error, batch: records.length }, 'SOS batch insert failed');
    return { inserted: 0, skipped: 0, errors: records.length };
  }
  return { inserted: records.length, skipped: 0, errors: 0 };
}

/**
 * Fetch Delaware Division of Corporations entities.
 * Uses the ECORP search API (public, no auth).
 * https://icis.corp.delaware.gov/ecorp/entitysearch/namesearch.aspx
 */
async function fetchDelawareEntities(
  supabase: SupabaseClient,
  maxPerRun: number,
): Promise<SosFetchResult> {
  // Delaware ECORP doesn't have a bulk download API.
  // We search by entity number ranges — file numbers are sequential.
  // Resume from last fetched number.

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: lastRecord } = await (supabase as any)
    .from('public_records')
    .select('source_id')
    .eq('source', 'sos_de')
    .order('created_at', { ascending: false })
    .limit(1);

  const lastNumber = lastRecord?.[0]?.source_id
    ? parseInt(String(lastRecord[0].source_id).replace('DE-', ''), 10)
    : 0;

  const startNumber = lastNumber + 1;
  let inserted = 0;
  let skipped = 0;
  let errors = 0;
  const batch: SosEntity[] = [];

  // Delaware file numbers are typically 7-digit integers
  for (let num = startNumber; num < startNumber + maxPerRun && inserted + skipped < maxPerRun; num++) {
    const fileNumber = String(num).padStart(7, '0');

    try {
      const response = await fetch(
        `https://icis.corp.delaware.gov/ecorp/entitysearch/NameSearch.aspx?fileNumber=${fileNumber}`,
        { headers: { Accept: 'application/json' } },
      );

      if (!response.ok) {
        if (response.status === 404) {
          skipped++;
          continue;
        }
        errors++;
        continue;
      }

      // The DE ECORP returns HTML — parse entity name from title
      const html = await response.text();
      const nameMatch = html.match(/<span id="lblEntityName"[^>]*>([^<]+)<\/span>/);
      const typeMatch = html.match(/<span id="lblEntityType"[^>]*>([^<]+)<\/span>/);
      const statusMatch = html.match(/<span id="lblStatus"[^>]*>([^<]+)<\/span>/);
      const dateMatch = html.match(/<span id="lblIncDate"[^>]*>([^<]+)<\/span>/);

      if (!nameMatch) {
        skipped++;
        continue;
      }

      batch.push({
        name: nameMatch[1].trim(),
        entityNumber: fileNumber,
        state: 'DE',
        entityType: typeMatch?.[1]?.trim() ?? 'Corporation',
        status: statusMatch?.[1]?.trim() ?? 'Unknown',
        formationDate: dateMatch?.[1]?.trim() ?? null,
        agentName: null,
        sourceUrl: `https://icis.corp.delaware.gov/ecorp/entitysearch/NameSearch.aspx?fileNumber=${fileNumber}`,
      });

      if (batch.length >= INSERT_BATCH_SIZE) {
        const result = await insertBatch(supabase, batch);
        inserted += result.inserted;
        errors += result.errors;
        batch.length = 0;
      }

      await delay(RATE_LIMIT_MS);
    } catch (err) {
      logger.warn({ fileNumber, error: err }, 'DE entity fetch error');
      errors++;
    }
  }

  // Flush remaining
  if (batch.length > 0) {
    const result = await insertBatch(supabase, batch);
    inserted += result.inserted;
    errors += result.errors;
  }

  return { state: 'DE', inserted, skipped, errors };
}

/**
 * Fetch California SOS business entities.
 * Uses the bizfile API (public).
 */
async function fetchCaliforniaEntities(
  supabase: SupabaseClient,
  maxPerRun: number,
): Promise<SosFetchResult> {
  // CA bizfile search API — paginated, public
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: lastRecord } = await (supabase as any)
    .from('public_records')
    .select('metadata')
    .eq('source', 'sos_ca')
    .order('created_at', { ascending: false })
    .limit(1);

  const lastEntityNum = lastRecord?.[0]?.metadata?.entity_number
    ? String(lastRecord[0].metadata.entity_number)
    : '';

  let inserted = 0;
  let skipped = 0;
  let errors = 0;
  const batch: SosEntity[] = [];

  // CA entity numbers are like C1234567, LLC12345678, etc.
  // Use search API with pagination
  const searchUrl = 'https://bizfileonline.sos.ca.gov/api/records/search';

  for (let page = 1; inserted + skipped < maxPerRun; page++) {
    try {
      const response = await fetch(`${searchUrl}?page=${page}&pageSize=100&sortOrder=asc`, {
        headers: { Accept: 'application/json' },
      });

      if (!response.ok) break;

      const data = await response.json() as {
        rows?: Array<{
          entityNumber: string;
          entityName: string;
          entityType: string;
          status: string;
          formationDate: string;
          agentName: string;
        }>;
      };

      if (!data.rows || data.rows.length === 0) break;

      for (const row of data.rows) {
        if (lastEntityNum && row.entityNumber <= lastEntityNum) {
          skipped++;
          continue;
        }

        batch.push({
          name: row.entityName,
          entityNumber: row.entityNumber,
          state: 'CA',
          entityType: row.entityType ?? 'Corporation',
          status: row.status ?? 'Active',
          formationDate: row.formationDate ?? null,
          agentName: row.agentName ?? null,
          sourceUrl: `https://bizfileonline.sos.ca.gov/search/business?entityNumber=${row.entityNumber}`,
        });

        if (batch.length >= INSERT_BATCH_SIZE) {
          const result = await insertBatch(supabase, batch);
          inserted += result.inserted;
          errors += result.errors;
          batch.length = 0;
        }
      }

      await delay(RATE_LIMIT_MS);
    } catch (err) {
      logger.warn({ page, error: err }, 'CA SOS fetch error');
      errors++;
      break;
    }
  }

  if (batch.length > 0) {
    const result = await insertBatch(supabase, batch);
    inserted += result.inserted;
    errors += result.errors;
  }

  return { state: 'CA', inserted, skipped, errors };
}

/**
 * Fetch business entities from a specific state SOS.
 */
export async function fetchSosEntities(
  supabase: SupabaseClient,
  state?: string,
): Promise<SosFetchResult[]> {
  // Check switchboard flag
  const { data: enabled } = await supabase.rpc('get_flag', {
    p_flag_key: 'ENABLE_PUBLIC_RECORDS_INGESTION',
  });
  if (!enabled) {
    logger.info('ENABLE_PUBLIC_RECORDS_INGESTION disabled — skipping SOS fetch');
    return [];
  }

  const results: SosFetchResult[] = [];
  const states = state ? [state.toUpperCase()] : ['DE', 'CA'];

  for (const s of states) {
    logger.info({ state: s }, 'Starting SOS entity fetch');
    try {
      switch (s) {
        case 'DE':
          results.push(await fetchDelawareEntities(supabase, MAX_PER_RUN));
          break;
        case 'CA':
          results.push(await fetchCaliforniaEntities(supabase, MAX_PER_RUN));
          break;
        default:
          logger.warn({ state: s }, 'SOS fetcher not implemented for state');
          results.push({ state: s, inserted: 0, skipped: 0, errors: 0 });
      }
    } catch (err) {
      logger.error({ state: s, error: err }, 'SOS fetch failed');
      results.push({ state: s, inserted: 0, skipped: 0, errors: 1 });
    }
  }

  const totals = results.reduce(
    (acc, r) => ({ inserted: acc.inserted + r.inserted, skipped: acc.skipped + r.skipped, errors: acc.errors + r.errors }),
    { inserted: 0, skipped: 0, errors: 0 },
  );
  logger.info({ results, totals }, 'SOS entity fetch complete');
  return results;
}
