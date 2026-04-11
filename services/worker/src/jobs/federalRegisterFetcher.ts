/**
 * Federal Register Fetcher Job
 *
 * Fetches regulatory documents from the Federal Register API for Nessie training data.
 * Gated by ENABLE_PUBLIC_RECORDS_INGESTION switchboard flag.
 *
 * API: No authentication required, JSON/CSV, daily updates.
 * Pagination: 2,000 results per query (use date filters for full coverage).
 * 50,000+ documents/year: proposed rules, final rules, notices, presidential documents.
 */

import { createHash } from 'node:crypto';
import { logger } from '../utils/logger.js';
import type { SupabaseClient } from '@supabase/supabase-js';

/** Federal Register API base */
const FR_API_URL = 'https://www.federalregister.gov/api/v1/documents.json';

/** Max results per page (API limit) */
const PER_PAGE = 100;

/** Rate limit: be respectful even though no official limit */
const FR_RATE_LIMIT_MS = 500;

interface FRDocument {
  document_number: string;
  title: string;
  type: string; // 'Rule', 'Proposed Rule', 'Notice', 'Presidential Document'
  abstract: string | null;
  publication_date: string;
  html_url: string;
  pdf_url: string;
  agencies: Array<{ name: string; id: number }>;
  citation: string | null;
}

interface FRResponse {
  count: number;
  results: FRDocument[];
  next_page_url: string | null;
  total_pages: number;
}

/**
 * Compute SHA-256 hex digest of a string.
 */
function computeContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch Federal Register documents and insert into public_records.
 * Resumable: picks up from the most recent publication date in the database.
 */
export async function fetchFederalRegisterDocuments(supabase: SupabaseClient): Promise<void> {
  // Check switchboard flag
  const { data: enabled } = await supabase.rpc('get_flag', {
    p_flag_key: 'ENABLE_PUBLIC_RECORDS_INGESTION',
  });
  if (!enabled) {
    logger.info('ENABLE_PUBLIC_RECORDS_INGESTION is disabled — skipping Federal Register fetch');
    return;
  }

  // Determine resume point
  const { data: lastRecord } = await supabase
    .from('public_records')
    .select('metadata')
    .eq('source', 'federal_register')
    .order('created_at', { ascending: false })
    .limit(1);

  const now = new Date();
  const startDate = lastRecord?.[0]?.metadata?.publication_date
    ? (lastRecord[0].metadata as Record<string, string>).publication_date
    : new Date(now.getFullYear(), now.getMonth() - 3, 1).toISOString().slice(0, 10);
  const endDate = now.toISOString().slice(0, 10);

  logger.info({ startDate, endDate }, 'Fetching Federal Register documents');

  let page = 1;
  let hasMore = true;
  let totalInserted = 0;

  while (hasMore) {
    const params = new URLSearchParams();
    params.set('conditions[publication_date][gte]', startDate);
    params.set('conditions[publication_date][lte]', endDate);
    params.set('per_page', String(PER_PAGE));
    params.set('page', String(page));
    params.set('order', 'oldest');
    // Federal Register API requires repeated fields[] params for each field
    for (const field of ['document_number', 'title', 'type', 'abstract', 'publication_date', 'html_url', 'pdf_url', 'agencies', 'citation']) {
      params.append('fields[]', field);
    }

    let response: Response;
    try {
      response = await fetch(`${FR_API_URL}?${params.toString()}`, {
        headers: {
          'User-Agent': 'Arkova contact@arkova.ai',
          Accept: 'application/json',
        },
      });
    } catch (err) {
      logger.error({ error: err, page }, 'Federal Register API request failed');
      break;
    }

    if (!response.ok) {
      logger.error({ status: response.status, page }, 'Federal Register API returned error');
      break;
    }

    const result = (await response.json()) as FRResponse;
    const docs = result.results ?? [];

    if (docs.length === 0) {
      hasMore = false;
      break;
    }

    logger.info({ page, count: docs.length, totalPages: result.total_pages }, 'Federal Register batch received');

    for (const doc of docs) {
      // Check for duplicates
      const { data: existing } = await supabase
        .from('public_records')
        .select('id')
        .eq('source', 'federal_register')
        .eq('source_id', doc.document_number)
        .limit(1);

      if (existing && existing.length > 0) {
        continue;
      }

      const contentForHash = JSON.stringify({
        document_number: doc.document_number,
        title: doc.title,
        type: doc.type,
        publication_date: doc.publication_date,
      });

      const agencyNames = doc.agencies?.map((a) => a.name) ?? [];

      const { error: insertError } = await supabase.from('public_records').insert({
        source: 'federal_register',
        source_id: doc.document_number,
        source_url: doc.html_url,
        record_type: doc.type.toLowerCase().replace(/ /g, '_'),
        title: doc.title,
        content_hash: computeContentHash(contentForHash),
        metadata: {
          document_number: doc.document_number,
          type: doc.type,
          publication_date: doc.publication_date,
          agencies: agencyNames,
          citation: doc.citation,
          abstract: doc.abstract,
          pdf_url: doc.pdf_url,
        },
      });

      if (insertError) {
        logger.error({ docNumber: doc.document_number, error: insertError }, 'Failed to insert Federal Register record');
      } else {
        totalInserted++;
      }
    }

    // Check if there are more pages
    if (!result.next_page_url || page >= result.total_pages) {
      hasMore = false;
    } else {
      page++;
    }

    // Rate limiting
    await delay(FR_RATE_LIMIT_MS);
  }

  logger.info({ pagesProcessed: page, totalInserted }, 'Federal Register fetch complete');
}
