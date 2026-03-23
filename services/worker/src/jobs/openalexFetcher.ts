/**
 * OpenAlex Academic Paper Fetcher Job
 *
 * Fetches scholarly works metadata from OpenAlex API for Nessie training data.
 * Gated by ENABLE_PUBLIC_RECORDS_INGESTION switchboard flag.
 *
 * OpenAlex API:
 *   - Free, CC0 license, no auth required
 *   - Polite pool: include email in User-Agent → 10x rate limit
 *   - 100K API calls/day (polite pool)
 *   - Bulk download: ~330 GB compressed JSON Lines, monthly update
 *
 * 474 million scholarly works indexed, 100M deduplicated authors, 200K+ journals.
 * Strategy: Start with high-citation works (cited_by_count > 50) for highest value.
 *
 * Constitution 4A: Only metadata is stored (no full text).
 */

import { createHash } from 'node:crypto';
import { logger } from '../utils/logger.js';
import type { SupabaseClient } from '@supabase/supabase-js';

/** OpenAlex API base */
const OPENALEX_API_URL = 'https://api.openalex.org/works';

/** Polite pool rate limit — ~10 req/sec with email in User-Agent */
const OPENALEX_RATE_LIMIT_MS = 150;

/** Results per page (max 200) */
const PER_PAGE = 200;

/** Max pages per run to avoid runaway sessions */
const MAX_PAGES_PER_RUN = 50;

/** Contact email for polite pool access */
const POLITE_EMAIL = 'contact@arkova.io';

interface OpenAlexWork {
  id: string; // e.g. "https://openalex.org/W2741809807"
  doi: string | null;
  title: string | null;
  display_name: string | null;
  publication_date: string | null;
  publication_year: number | null;
  type: string; // 'article', 'book-chapter', etc.
  cited_by_count: number;
  is_retracted: boolean;
  primary_location: {
    source?: {
      display_name?: string;
      issn_l?: string;
      type?: string;
    };
  } | null;
  authorships: Array<{
    author: {
      id: string;
      display_name: string;
      orcid?: string;
    };
    institutions: Array<{
      display_name: string;
      country_code?: string;
    }>;
  }>;
  concepts: Array<{
    display_name: string;
    score: number;
  }>;
  open_access: {
    is_oa: boolean;
    oa_url?: string;
  };
  abstract_inverted_index?: Record<string, number[]>;
}

interface OpenAlexResponse {
  meta: {
    count: number;
    per_page: number;
    page: number;
    next_cursor: string | null;
  };
  results: OpenAlexWork[];
}

function computeContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reconstruct abstract from inverted index format used by OpenAlex.
 * The inverted index maps word → array of positions.
 */
function reconstructAbstract(invertedIndex: Record<string, number[]> | undefined): string | null {
  if (!invertedIndex) return null;

  const words: Array<[string, number]> = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    for (const pos of positions) {
      words.push([word, pos]);
    }
  }

  words.sort((a, b) => a[1] - b[1]);
  return words.map(([word]) => word).join(' ');
}

/**
 * Fetch academic works from OpenAlex and insert into public_records.
 * Strategy: Fetch recent, high-citation works first for maximum training value.
 * Resumable: picks up from the most recent publication date in the database.
 */
export async function fetchOpenAlexWorks(supabase: SupabaseClient): Promise<{
  inserted: number;
  skipped: number;
  errors: number;
}> {
  // Check switchboard flag
  const { data: enabled } = await supabase.rpc('get_flag', {
    p_flag_key: 'ENABLE_PUBLIC_RECORDS_INGESTION',
  });
  if (!enabled) {
    logger.info('ENABLE_PUBLIC_RECORDS_INGESTION is disabled — skipping OpenAlex fetch');
    return { inserted: 0, skipped: 0, errors: 0 };
  }

  // Determine resume point
  const { data: lastRecord } = await supabase
    .from('public_records')
    .select('metadata')
    .eq('source', 'openalex')
    .order('created_at', { ascending: false })
    .limit(1);

  const now = new Date();
  const lastDate = lastRecord?.[0]?.metadata?.publication_date;
  const startDate = lastDate
    ? String(lastDate)
    : new Date(now.getFullYear() - 2, 0, 1).toISOString().slice(0, 10);

  logger.info({ startDate }, 'Fetching OpenAlex academic works');

  let totalInserted = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  let cursor = '*'; // OpenAlex cursor-based pagination

  for (let pageCount = 0; pageCount < MAX_PAGES_PER_RUN; pageCount++) {
    const params = new URLSearchParams({
      'filter': `from_publication_date:${startDate},cited_by_count:>3,type:article`,
      'per_page': String(PER_PAGE),
      'cursor': cursor,
      'sort': 'cited_by_count:desc',
      'select': 'id,doi,title,display_name,publication_date,publication_year,type,cited_by_count,is_retracted,primary_location,authorships,concepts,open_access,abstract_inverted_index',
      'mailto': POLITE_EMAIL,
    });

    let response: Response;
    try {
      response = await fetch(`${OPENALEX_API_URL}?${params.toString()}`, {
        headers: {
          'User-Agent': `Arkova/1.0 (mailto:${POLITE_EMAIL})`,
          Accept: 'application/json',
        },
      });
    } catch (err) {
      logger.error({ error: err, page: pageCount }, 'OpenAlex API request failed');
      totalErrors++;
      break;
    }

    if (response.status === 429) {
      logger.warn('OpenAlex rate limited — backing off 5 seconds');
      await delay(5_000);
      continue;
    }

    if (!response.ok) {
      logger.error({ status: response.status, page: pageCount }, 'OpenAlex API returned error');
      totalErrors++;
      break;
    }

    let result: OpenAlexResponse;
    try {
      result = (await response.json()) as OpenAlexResponse;
    } catch {
      logger.error({ page: pageCount }, 'Failed to parse OpenAlex response');
      totalErrors++;
      break;
    }

    const works = result.results ?? [];
    if (works.length === 0) break;

    // Extract next cursor from response body
    const nextCursor = result.meta?.next_cursor ?? null;

    logger.info(
      { page: pageCount, count: works.length, total: result.meta?.count },
      'OpenAlex batch received',
    );

    for (const work of works) {
      // Extract OpenAlex ID (last segment)
      const openalexId = work.id.split('/').pop() ?? work.id;
      const doi = work.doi?.replace('https://doi.org/', '') ?? null;

      // Check for duplicates
      const { data: existing } = await supabase
        .from('public_records')
        .select('id')
        .eq('source', 'openalex')
        .eq('source_id', openalexId)
        .limit(1);

      if (existing && existing.length > 0) {
        totalSkipped++;
        continue;
      }

      const title = work.display_name ?? work.title ?? 'Untitled';
      const abstract = reconstructAbstract(work.abstract_inverted_index);

      const contentForHash = JSON.stringify({
        openalex_id: openalexId,
        doi,
        title,
        publication_date: work.publication_date,
      });

      const authors = work.authorships?.slice(0, 10).map((a) => ({
        name: a.author.display_name,
        orcid: a.author.orcid ?? null,
        institutions: a.institutions?.map((i) => i.display_name) ?? [],
      })) ?? [];

      const concepts = work.concepts?.slice(0, 5).map((c) => c.display_name) ?? [];

      const journal = work.primary_location?.source?.display_name ?? null;

      const sourceUrl = doi
        ? `https://doi.org/${doi}`
        : work.open_access?.oa_url ?? `https://openalex.org/${openalexId}`;

      const { error: insertError } = await supabase.from('public_records').insert({
        source: 'openalex',
        source_id: openalexId,
        source_url: sourceUrl,
        record_type: work.type ?? 'article',
        title,
        content_hash: computeContentHash(contentForHash),
        metadata: {
          doi,
          publication_date: work.publication_date,
          publication_year: work.publication_year,
          cited_by_count: work.cited_by_count,
          is_retracted: work.is_retracted,
          authors,
          concepts,
          journal,
          is_open_access: work.open_access?.is_oa ?? false,
          abstract: abstract?.slice(0, 2000) ?? null, // Truncate long abstracts
        },
      });

      if (insertError) {
        logger.error({ openalexId, error: insertError }, 'Failed to insert OpenAlex record');
        totalErrors++;
      } else {
        totalInserted++;
      }
    }

    if (!nextCursor || works.length < PER_PAGE) break;
    cursor = nextCursor;

    // Rate limit compliance
    await delay(OPENALEX_RATE_LIMIT_MS);
  }

  logger.info(
    { totalInserted, totalSkipped, totalErrors },
    'OpenAlex fetch complete',
  );

  return { inserted: totalInserted, skipped: totalSkipped, errors: totalErrors };
}
