/**
 * California State Bar Attorney Fetcher
 *
 * Fetches licensed attorney records from the California State Bar
 * public member directory API.
 *
 * API: https://members.calbar.ca.gov/
 * Auth: None required (public directory)
 * Rate limit: Respectful usage (~2 req/sec)
 * Records: ~270,000+ active attorneys
 *
 * Why anchor this: Attorney verification — proves an individual was
 * licensed with the California State Bar at a point in time. Core
 * use case for legal credential verification.
 *
 * Data includes: bar number, name, status (Active/Inactive/Suspended/
 * Disbarred), admission date, address, sections, discipline history.
 *
 * Constitution refs:
 *   - 4A: Only metadata is stored server-side
 */

import { createHash } from 'node:crypto';
import { logger } from '../utils/logger.js';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * California State Bar member search API.
 * Public JSON endpoint — no API key required.
 * Returns attorney records by bar number range or name search.
 */
const _CALBAR_API_URL = 'https://members.calbar.ca.gov/search/MemberSearch.aspx';
const _CALBAR_PROFILE_URL = 'https://members.calbar.ca.gov/fal/MemberSearch/QuickSearch';

/** Rate limit: ~2 req/sec to be respectful */
const RATE_LIMIT_MS = 500;

/** Batch size for bar number sequential scan */
const _BATCH_SIZE = 50;

/** Max attorneys per run — fits Cloud Run timeout */
const MAX_PER_RUN = 5000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbAny = (db: SupabaseClient) => db as any;

interface CalBarAttorney {
  barNumber: string;
  name: string;
  status: string;
  city?: string;
  state?: string;
  admissionDate?: string;
  sections?: string[];
  advancedSpecializations?: string[];
  disciplineHistory?: string;
}

interface _CalBarSearchResponse {
  // The API returns HTML or JSON depending on endpoint
  // We use the JSON-returning endpoint
  attorneys: CalBarAttorney[];
  totalResults: number;
  hasMore: boolean;
}

function computeContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse attorney data from CalBar API response.
 * The CalBar QuickSearch endpoint returns JSON with attorney details.
 */
function _parseAttorneyFromJson(data: Record<string, unknown>): CalBarAttorney | null {
  const barNumber = String(data.number ?? data.barNumber ?? data.memberNumber ?? '').trim();
  if (!barNumber) return null;

  const firstName = String(data.firstName ?? data.first_name ?? '').trim();
  const lastName = String(data.lastName ?? data.last_name ?? data.name ?? '').trim();
  const name = [firstName, lastName].filter(Boolean).join(' ') || 'Unknown';

  return {
    barNumber,
    name,
    status: String(data.status ?? data.memberStatus ?? 'Unknown'),
    city: data.city ? String(data.city) : undefined,
    state: data.state ? String(data.state) : undefined,
    admissionDate: data.admitDate ? String(data.admitDate) : (data.admissionDate ? String(data.admissionDate) : undefined),
    sections: Array.isArray(data.sections) ? data.sections.map(String) : undefined,
    advancedSpecializations: Array.isArray(data.advancedSpecializations) ? data.advancedSpecializations.map(String) : undefined,
    disciplineHistory: data.disciplineHistory ? String(data.disciplineHistory) : undefined,
  };
}

async function insertAttorney(
  supabase: SupabaseClient,
  attorney: CalBarAttorney,
): Promise<'inserted' | 'skipped' | 'error'> {
  const sourceId = `calbar-${attorney.barNumber}`;

  // Check for duplicates
  const { data: existing } = await dbAny(supabase)
    .from('public_records')
    .select('id')
    .eq('source', 'calbar')
    .eq('source_id', sourceId)
    .limit(1);

  if (existing && existing.length > 0) {
    return 'skipped';
  }

  const contentForHash = JSON.stringify({
    barNumber: attorney.barNumber,
    name: attorney.name,
    status: attorney.status,
    admissionDate: attorney.admissionDate,
  });

  const { error: insertError } = await dbAny(supabase)
    .from('public_records')
    .insert({
      source: 'calbar',
      source_id: sourceId,
      source_url: `https://members.calbar.ca.gov/fal/Licensee/Detail/${attorney.barNumber}`,
      record_type: 'attorney_license',
      title: `${attorney.name} — CA Bar #${attorney.barNumber} (${attorney.status})`,
      content_hash: computeContentHash(contentForHash),
      metadata: {
        bar_number: attorney.barNumber,
        full_name: attorney.name,
        status: attorney.status,
        city: attorney.city ?? null,
        state: attorney.state ?? null,
        admission_date: attorney.admissionDate ?? null,
        sections: attorney.sections ?? [],
        advanced_specializations: attorney.advancedSpecializations ?? [],
        discipline_history: attorney.disciplineHistory ?? null,
        pipeline_source: 'calbar',
        registry: 'State Bar of California',
        jurisdiction: 'US-CA',
        license_type: 'attorney',
      },
    });

  if (insertError) {
    if (insertError.code === '23505') {
      return 'skipped';
    }
    logger.error({ sourceId, error: insertError }, 'CalBar insert failed');
    return 'error';
  }
  return 'inserted';
}

/**
 * Fetch California State Bar attorneys via sequential bar number scan.
 *
 * Strategy: Bar numbers are sequential integers. We scan ranges,
 * starting from the highest bar number already in our DB.
 * CA bar numbers range from ~1 to ~350,000+.
 *
 * Uses the CalBar website's internal JSON API which returns
 * attorney details for a given bar number.
 */
export async function fetchCalBarAttorneys(supabase: SupabaseClient): Promise<{
  inserted: number;
  skipped: number;
  errors: number;
}> {
  // Check switchboard flag
  const { data: enabled } = await supabase.rpc('get_flag', {
    p_flag_key: 'ENABLE_PUBLIC_RECORDS_INGESTION',
  });
  if (!enabled) {
    logger.info('ENABLE_PUBLIC_RECORDS_INGESTION is disabled — skipping CalBar fetch');
    return { inserted: 0, skipped: 0, errors: 0 };
  }

  // Determine resume point — find highest bar number already ingested
  const { data: lastRecord } = await dbAny(supabase)
    .from('public_records')
    .select('source_id')
    .eq('source', 'calbar')
    .order('source_id', { ascending: false })
    .limit(1);

  let startBarNumber = 1;
  if (lastRecord?.[0]?.source_id) {
    const match = String(lastRecord[0].source_id).match(/calbar-(\d+)/);
    if (match) {
      startBarNumber = parseInt(match[1], 10) + 1;
    }
  }

  logger.info({ startBarNumber, maxPerRun: MAX_PER_RUN }, 'Fetching CalBar attorneys');

  let totalInserted = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  let consecutiveNotFound = 0;
  const MAX_CONSECUTIVE_NOT_FOUND = 200; // Stop if 200 consecutive bar numbers return nothing

  for (let barNum = startBarNumber; barNum < startBarNumber + MAX_PER_RUN; barNum++) {
    if (consecutiveNotFound >= MAX_CONSECUTIVE_NOT_FOUND) {
      logger.info(
        { barNum, consecutiveNotFound },
        'CalBar: stopping after too many consecutive misses — likely reached end of range',
      );
      break;
    }

    try {
      // CalBar public profile endpoint returns attorney data
      const profileUrl = `https://members.calbar.ca.gov/fal/Licensee/Detail/${barNum}`;
      const response = await fetch(profileUrl, {
        headers: {
          'User-Agent': 'Arkova/1.0 (contact@arkova.ai)',
          Accept: 'text/html,application/json',
        },
        redirect: 'follow',
      });

      if (!response.ok) {
        if (response.status === 404) {
          consecutiveNotFound++;
          continue;
        }
        if (response.status === 429) {
          logger.warn('CalBar rate limited — backing off 10 seconds');
          await delay(10_000);
          barNum--; // Retry this number
          continue;
        }
        totalErrors++;
        consecutiveNotFound++;
        continue;
      }

      const html = await response.text();

      // Parse attorney details from HTML response
      const attorney = parseAttorneyFromHtml(html, String(barNum));
      if (!attorney) {
        consecutiveNotFound++;
        continue;
      }

      consecutiveNotFound = 0; // Reset on successful find

      const result = await insertAttorney(supabase, attorney);
      if (result === 'inserted') totalInserted++;
      else if (result === 'skipped') totalSkipped++;
      else totalErrors++;

      if (totalInserted > 0 && totalInserted % 100 === 0) {
        logger.info(
          { inserted: totalInserted, skipped: totalSkipped, errors: totalErrors, currentBarNum: barNum },
          'CalBar progress',
        );
      }
    } catch (err) {
      logger.error({ error: err, barNum }, 'CalBar fetch error for bar number');
      totalErrors++;
      consecutiveNotFound++;
    }

    await delay(RATE_LIMIT_MS);
  }

  logger.info(
    { inserted: totalInserted, skipped: totalSkipped, errors: totalErrors },
    'CalBar fetch complete',
  );

  return { inserted: totalInserted, skipped: totalSkipped, errors: totalErrors };
}

/**
 * Parse attorney data from CalBar HTML profile page.
 * Extracts name, status, admission date, etc. from the member detail page.
 */
function parseAttorneyFromHtml(html: string, barNumber: string): CalBarAttorney | null {
  // Check if this is a valid attorney page (not a redirect or error)
  if (html.includes('No records found') || html.includes('Member Not Found') || html.length < 500) {
    return null;
  }

  // Extract name — typically in <h3> or specific div
  const nameMatch = html.match(/<span[^>]*id="[^"]*Name[^"]*"[^>]*>([^<]+)<\/span>/i)
    || html.match(/<h3[^>]*class="[^"]*attorney-name[^"]*"[^>]*>([^<]+)<\/h3>/i)
    || html.match(/<title>([^<]*?)(?:\s*-\s*State Bar|<)/i);

  const name = nameMatch ? nameMatch[1].trim() : null;
  if (!name || name === 'State Bar of California') return null;

  // Extract status
  const statusMatch = html.match(/Status[^:]*:\s*<[^>]*>([^<]+)<\/(?:span|td|div)/i)
    || html.match(/Member\s*Status[^:]*:\s*([A-Za-z]+)/i)
    || html.match(/<span[^>]*id="[^"]*Status[^"]*"[^>]*>([^<]+)<\/span>/i);
  const status = statusMatch ? statusMatch[1].trim() : 'Unknown';

  // Extract admission date
  const admitMatch = html.match(/Admit(?:ted|.*Date)[^:]*:\s*<[^>]*>([^<]+)<\/(?:span|td|div)/i)
    || html.match(/Admitted[^:]*:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i)
    || html.match(/<span[^>]*id="[^"]*Admit[^"]*"[^>]*>([^<]+)<\/span>/i);
  const admissionDate = admitMatch ? admitMatch[1].trim() : undefined;

  // Extract city/state
  const cityMatch = html.match(/City[^:]*:\s*<[^>]*>([^<]+)</i)
    || html.match(/<span[^>]*id="[^"]*City[^"]*"[^>]*>([^<]+)<\/span>/i);
  const stateMatch = html.match(/State[^:]*:\s*<[^>]*>([^<]+)</i);

  // Extract sections
  const sectionsMatch = html.match(/Sections?[^:]*:\s*<[^>]*>([^<]+)</i);
  const sections = sectionsMatch ? sectionsMatch[1].split(/[,;]/).map(s => s.trim()).filter(Boolean) : undefined;

  return {
    barNumber,
    name,
    status,
    city: cityMatch ? cityMatch[1].trim() : undefined,
    state: stateMatch ? stateMatch[1].trim() : undefined,
    admissionDate,
    sections,
  };
}

/**
 * Fetch a specific attorney by bar number.
 * Used for targeted lookups.
 */
export async function fetchCalBarByNumber(
  supabase: SupabaseClient,
  barNumber: string,
): Promise<{ inserted: number; skipped: number; errors: number }> {
  logger.info({ barNumber }, 'Fetching specific CalBar attorney');

  try {
    const profileUrl = `https://members.calbar.ca.gov/fal/Licensee/Detail/${barNumber}`;
    const response = await fetch(profileUrl, {
      headers: {
        'User-Agent': 'Arkova/1.0 (contact@arkova.ai)',
        Accept: 'text/html,application/json',
      },
    });

    if (!response.ok) {
      return { inserted: 0, skipped: 0, errors: 1 };
    }

    const html = await response.text();
    const attorney = parseAttorneyFromHtml(html, barNumber);
    if (!attorney) {
      return { inserted: 0, skipped: 0, errors: 0 };
    }

    const result = await insertAttorney(supabase, attorney);
    return {
      inserted: result === 'inserted' ? 1 : 0,
      skipped: result === 'skipped' ? 1 : 0,
      errors: result === 'error' ? 1 : 0,
    };
  } catch (err) {
    logger.error({ error: err, barNumber }, 'CalBar specific fetch failed');
    return { inserted: 0, skipped: 0, errors: 1 };
  }
}
