/**
 * CourtListener Case Law Fetcher Job
 *
 * Fetches court opinions from the CourtListener (RECAP) API for Nessie's
 * legal context. Covers all US federal and state courts — 8M+ opinions.
 *
 * CourtListener API:
 *   - Free, public interest project by Free Law Project
 *   - Auth: API token (optional, higher rate limit with it)
 *   - Rate limit: ~5000 req/hour (with token), ~500/hour (anonymous)
 *   - Bulk data available via courtlistener.com/api/bulk-info/
 *
 * Constitution 4A: Only metadata is stored (no full text).
 */

import { createHash } from 'node:crypto';
import { logger } from '../utils/logger.js';
import type { SupabaseClient } from '@supabase/supabase-js';

/** CourtListener API base */
const CL_API_URL = 'https://www.courtlistener.com/api/rest/v4';

/** Rate limit: ~1.4 req/sec anonymous, ~5 req/sec with token */
const CL_RATE_LIMIT_MS = 750;

/** Results per page (max 20 for CourtListener) */
const PER_PAGE = 20;

/** Max pages per bulk run */
const BULK_MAX_PAGES = 500;

/** Max records per batch insert */
const BULK_INSERT_BATCH = 500;

interface CLOpinion {
  id: number;
  absolute_url: string;
  cluster: string; // URL to cluster
  cluster_id: number;
  author_str: string;
  per_curiam: boolean;
  date_created: string;
  date_modified: string;
  type: string; // '010combined', '015unamimous', '020lead', '025plurality', '030concurrence', '040dissent', etc.
  sha1: string;
  download_url: string | null;
  local_path: string | null;
  plain_text: string;
  html: string;
  html_lawbox: string;
  html_columbia: string;
  html_with_citations: string;
  extracted_by_ocr: boolean;
  opinions_cited: Array<{ id: number; resource_uri: string }>;
}

interface CLCluster {
  id: number;
  absolute_url: string;
  case_name: string;
  case_name_short: string;
  case_name_full: string;
  date_filed: string;
  date_filed_is_approximate: boolean;
  docket: string; // URL
  docket_id: number;
  citation_count: number;
  court: string; // URL
  court_id: string;
  judges: string;
  nature_of_suit: string;
  precedential_status: string; // 'Published', 'Unpublished', 'Errata', 'Separate', 'In-chambers', 'Relating-to', 'Unknown'
  citations: Array<{ volume: number; reporter: string; page: string; type: number }>;
  sub_opinions: Array<{ id: number; resource_uri: string }>;
  source: string;
  syllabus: string;
}

interface CLSearchResponse {
  count: number;
  next: string | null;
  previous: string | null;
  results: CLCluster[];
}

function computeContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Map CourtListener court_id to human-readable court name.
 * Covers major federal courts — full mapping at courtlistener.com/api/rest/v4/courts/
 */
function getCourtLabel(courtId: string): string {
  const courts: Record<string, string> = {
    scotus: 'Supreme Court of the United States',
    ca1: 'First Circuit', ca2: 'Second Circuit', ca3: 'Third Circuit',
    ca4: 'Fourth Circuit', ca5: 'Fifth Circuit', ca6: 'Sixth Circuit',
    ca7: 'Seventh Circuit', ca8: 'Eighth Circuit', ca9: 'Ninth Circuit',
    ca10: 'Tenth Circuit', ca11: 'Eleventh Circuit', cadc: 'D.C. Circuit',
    cafc: 'Federal Circuit',
  };
  return courts[courtId] ?? courtId;
}

/**
 * Format citation for display.
 */
function formatCitation(c: { volume: number; reporter: string; page: string }): string {
  return `${c.volume} ${c.reporter} ${c.page}`;
}

/**
 * Fetch court opinions from CourtListener and insert into public_records.
 *
 * Uses the /clusters/ endpoint (case clusters) which groups opinions per case.
 * Each cluster becomes one public_record entry.
 *
 * @param startDate — earliest filing date
 * @param maxPages — max API pages per invocation
 * @param courtFilter — optional court ID filter (e.g. 'scotus', 'ca9')
 * @param statusFilter — 'Published' for precedential opinions only
 */
export async function fetchCourtOpinions(
  supabase: SupabaseClient,
  options: {
    startDate?: string;
    endDate?: string;
    maxPages?: number;
    courtFilter?: string;
    statusFilter?: string;
    offsetPage?: number;
  } = {},
): Promise<{
  inserted: number;
  skipped: number;
  errors: number;
  pagesProcessed: number;
}> {
  // Check switchboard flag
  const { data: enabled } = await supabase.rpc('get_flag', {
    p_flag_key: 'ENABLE_PUBLIC_RECORDS_INGESTION',
  });
  if (!enabled) {
    logger.info('ENABLE_PUBLIC_RECORDS_INGESTION is disabled — skipping CourtListener');
    return { inserted: 0, skipped: 0, errors: 0, pagesProcessed: 0 };
  }

  const startDate = options.startDate ?? '1950-01-01';
  const endDate = options.endDate ?? new Date().toISOString().slice(0, 10);
  const maxPages = options.maxPages ?? BULK_MAX_PAGES;
  const courtFilter = options.courtFilter;
  const statusFilter = options.statusFilter ?? 'Published';

  let totalInserted = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  let nextUrl: string | null = null;

  // Build initial URL
  const params = new URLSearchParams({
    date_filed__gte: startDate,
    date_filed__lte: endDate,
    order_by: '-date_filed',
    format: 'json',
  });
  if (courtFilter) params.set('court__id', courtFilter);
  if (statusFilter) params.set('precedential_status', statusFilter);
  if (options.offsetPage) params.set('offset', String(options.offsetPage * PER_PAGE));

  nextUrl = `${CL_API_URL}/clusters/?${params.toString()}`;

  logger.info({ startDate, endDate, courtFilter, statusFilter, maxPages }, 'Starting CourtListener fetch');

  for (let page = 0; page < maxPages; page++) {
    if (!nextUrl) break;

    let response: Response;
    try {
      response = await fetch(nextUrl, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Arkova/1.0 (contact@arkova.io)',
        },
      });
    } catch (err) {
      logger.error({ error: err, page }, 'CourtListener API request failed');
      totalErrors++;
      break;
    }

    if (response.status === 429) {
      logger.warn('CourtListener rate limited — backing off 30s');
      await delay(30_000);
      continue;
    }

    if (!response.ok) {
      logger.error({ status: response.status, page }, 'CourtListener API error');
      totalErrors++;
      break;
    }

    let result: CLSearchResponse;
    try {
      result = (await response.json()) as CLSearchResponse;
    } catch {
      logger.error({ page }, 'Failed to parse CourtListener response');
      totalErrors++;
      break;
    }

    const clusters = result.results ?? [];
    if (clusters.length === 0) break;

    nextUrl = result.next;

    if (page % 50 === 0) {
      logger.info({ page, count: clusters.length, total: result.count }, 'CourtListener progress');
    }

    // Build batch of records
    const records: Array<{
      source: string;
      source_id: string;
      source_url: string;
      record_type: string;
      title: string;
      content_hash: string;
      metadata: Record<string, unknown>;
    }> = [];

    for (const cluster of clusters) {
      const sourceId = `cl-${cluster.id}`;
      const caseName = cluster.case_name || cluster.case_name_short || 'Unknown Case';
      const courtId = cluster.court_id || cluster.court?.split('/').filter(Boolean).pop() || 'unknown';
      const citations = cluster.citations?.map(formatCitation) ?? [];
      const primaryCitation = citations[0] ?? '';

      const title = primaryCitation
        ? `${caseName} — ${primaryCitation} (${cluster.date_filed})`
        : `${caseName} (${cluster.date_filed})`;

      const contentForHash = JSON.stringify({
        cluster_id: cluster.id,
        case_name: caseName,
        date_filed: cluster.date_filed,
        court_id: courtId,
      });

      records.push({
        source: 'courtlistener',
        source_id: sourceId,
        source_url: `https://www.courtlistener.com${cluster.absolute_url}`,
        record_type: 'court_opinion',
        title,
        content_hash: computeContentHash(contentForHash),
        metadata: {
          cluster_id: cluster.id,
          docket_id: cluster.docket_id,
          case_name: caseName,
          case_name_full: cluster.case_name_full || null,
          date_filed: cluster.date_filed,
          date_filed_is_approximate: cluster.date_filed_is_approximate,
          court_id: courtId,
          court_name: getCourtLabel(courtId),
          judges: cluster.judges || null,
          nature_of_suit: cluster.nature_of_suit || null,
          precedential_status: cluster.precedential_status,
          citation_count: cluster.citation_count,
          citations,
          syllabus: cluster.syllabus?.slice(0, 2000) || null,
          opinion_count: cluster.sub_opinions?.length ?? 0,
        },
      });
    }

    // Batch upsert
    for (let i = 0; i < records.length; i += BULK_INSERT_BATCH) {
      const batch = records.slice(i, i + BULK_INSERT_BATCH);
      const { error: insertError, count } = await supabase
        .from('public_records')
        .upsert(batch, { onConflict: 'source,source_id', ignoreDuplicates: true, count: 'exact' });

      if (insertError) {
        logger.error({ error: insertError, batchSize: batch.length }, 'CourtListener batch insert failed');
        totalErrors += batch.length;
      } else {
        const insertedCount = count ?? batch.length;
        totalInserted += insertedCount;
        totalSkipped += batch.length - insertedCount;
      }
    }

    await delay(CL_RATE_LIMIT_MS);
  }

  logger.info(
    { totalInserted, totalSkipped, totalErrors },
    'CourtListener fetch complete',
  );

  return { inserted: totalInserted, skipped: totalSkipped, errors: totalErrors, pagesProcessed: maxPages };
}
