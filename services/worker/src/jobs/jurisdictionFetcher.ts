/**
 * KAU-01–04: Shared jurisdiction compliance fetcher.
 *
 * Generic statute ingestion + case law search for any jurisdiction.
 * Kenya and Australia fetchers are thin wrappers around this.
 */

import { logger } from '../utils/logger.js';
import { computeContentHash, delay, isIngestionEnabled, batchUpsertRecords, getExistingSourceIds } from '../utils/pipeline.js';
import type { SupabaseClient } from '@supabase/supabase-js';

const INSERT_BATCH_SIZE = 50;

export interface StatuteSection {
  id: string;
  title: string;
  section: string;
}

export interface StatuteDefinition {
  title: string;
  sourceId: string;
  url: string;
  sections: StatuteSection[];
}

export interface CaseLawSearchConfig {
  searchUrl: string;
  searchTerms: string[];
  source: string;
  court: string;
  parseResults: (html: string, term: string) => Array<{ id: string; title: string; url: string; summary?: string }>;
}

export interface JurisdictionFetchResult {
  statutesInserted: number;
  casesInserted: number;
  skipped: number;
  errors: number;
}

/**
 * Ingest statute sections with batch dedup.
 */
export async function ingestStatutes(
  supabase: SupabaseClient,
  source: string,
  jurisdiction: string,
  jurisdictionCode: string,
  statutes: StatuteDefinition[],
): Promise<{ inserted: number; skipped: number; errors: number }> {
  // Batch dedup: collect all section IDs upfront
  const allSectionIds = statutes.flatMap((s) => s.sections.map((sec) => sec.id));
  const existing = await getExistingSourceIds(supabase, source, allSectionIds);

  let inserted = 0;
  let skipped = 0;
  let errors = 0;
  let batch: Array<Record<string, unknown>> = [];

  for (const statute of statutes) {
    for (const section of statute.sections) {
      if (existing.has(section.id)) { skipped++; continue; }

      batch.push({
        source,
        source_id: section.id,
        source_url: statute.url,
        record_type: 'regulation',
        title: `${statute.title} — ${section.title}`,
        content_hash: computeContentHash(JSON.stringify({
          statute: statute.sourceId, section: section.id, title: section.title,
        })),
        metadata: {
          statute_name: statute.title,
          statute_id: statute.sourceId,
          section_id: section.id,
          section_title: section.title,
          part: section.section,
          jurisdiction,
          jurisdiction_code: jurisdictionCode,
          pipeline_source: source,
        },
      });

      if (batch.length >= INSERT_BATCH_SIZE) {
        const result = await batchUpsertRecords(supabase, batch);
        inserted += result.inserted;
        errors += result.errors;
        batch = [];
      }
    }
  }

  if (batch.length > 0) {
    const result = await batchUpsertRecords(supabase, batch);
    inserted += result.inserted;
    errors += result.errors;
  }

  return { inserted, skipped, errors };
}

/**
 * Fetch case law from a search API with HTML parsing.
 */
export async function fetchCaseLaw(
  supabase: SupabaseClient,
  config: CaseLawSearchConfig,
  jurisdiction: string,
  jurisdictionCode: string,
  maxPerRun: number = 500,
  rateLimitMs: number = 500,
): Promise<{ inserted: number; skipped: number; errors: number }> {
  let inserted = 0;
  let skipped = 0;
  let errors = 0;
  let batch: Array<Record<string, unknown>> = [];

  for (const term of config.searchTerms) {
    if (inserted + skipped >= maxPerRun) break;

    try {
      const response = await fetch(config.searchUrl.replace('{TERM}', encodeURIComponent(term)));
      if (!response.ok) {
        logger.warn({ term, status: response.status }, `${jurisdiction} case law search failed`);
        errors++;
        continue;
      }

      const body = await response.text();
      const cases = config.parseResults(body, term);

      for (const c of cases) {
        if (inserted + skipped >= maxPerRun) break;

        batch.push({
          source: config.source,
          source_id: c.id,
          source_url: c.url,
          record_type: 'court_decision',
          title: c.title,
          content_hash: computeContentHash(JSON.stringify({ id: c.id, title: c.title })),
          metadata: {
            case_title: c.title,
            court: config.court,
            summary: c.summary?.slice(0, 1000) ?? null,
            search_term: term,
            jurisdiction,
            jurisdiction_code: jurisdictionCode,
            pipeline_source: config.source,
          },
        });

        if (batch.length >= INSERT_BATCH_SIZE) {
          const result = await batchUpsertRecords(supabase, batch);
          inserted += result.inserted;
          errors += result.errors;
          batch = [];
        }
      }

      await delay(rateLimitMs);
    } catch (err) {
      logger.error({ term, error: err }, `${jurisdiction} case law fetch failed`);
      errors++;
    }
  }

  if (batch.length > 0) {
    const result = await batchUpsertRecords(supabase, batch);
    inserted += result.inserted;
    errors += result.errors;
  }

  return { inserted, skipped, errors };
}

/**
 * Full jurisdiction compliance fetch: statutes + case law.
 */
export async function fetchJurisdictionCompliance(
  supabase: SupabaseClient,
  opts: {
    jurisdiction: string;
    jurisdictionCode: string;
    statuteSource: string;
    statutes: StatuteDefinition[];
    caseLaw?: CaseLawSearchConfig;
  },
): Promise<JurisdictionFetchResult> {
  if (!(await isIngestionEnabled(supabase))) {
    logger.info(`ENABLE_PUBLIC_RECORDS_INGESTION disabled — skipping ${opts.jurisdiction} fetch`);
    return { statutesInserted: 0, casesInserted: 0, skipped: 0, errors: 0 };
  }

  logger.info(`Starting ${opts.jurisdiction} compliance data fetch`);

  const statutes = await ingestStatutes(
    supabase, opts.statuteSource, opts.jurisdiction, opts.jurisdictionCode, opts.statutes,
  );

  let cases = { inserted: 0, skipped: 0, errors: 0 };
  if (opts.caseLaw) {
    cases = await fetchCaseLaw(
      supabase, opts.caseLaw, opts.jurisdiction, opts.jurisdictionCode,
    );
  }

  const result: JurisdictionFetchResult = {
    statutesInserted: statutes.inserted,
    casesInserted: cases.inserted,
    skipped: statutes.skipped + cases.skipped,
    errors: statutes.errors + cases.errors,
  };

  logger.info(result, `${opts.jurisdiction} compliance data fetch complete`);
  return result;
}
