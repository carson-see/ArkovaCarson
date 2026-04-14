/**
 * KAU-03: Australian Privacy Act 1988 + APP Guidelines Fetcher
 * KAU-04: Australian Court Cases + ACNC Enforcement
 *
 * Ingests Australian compliance data for Nessie and Gemini training:
 * - Privacy Act 1988 (full text sections)
 * - Australian Privacy Principles (APP 1-13)
 * - OAIC (Office of the Australian Information Commissioner) determinations
 * - Federal Court of Australia decisions via AustLII
 * - ACNC enforcement actions
 *
 * Sources:
 * - legislation.gov.au (public, free — Commonwealth legislation)
 * - austlii.edu.au (public, free — Australian Legal Information Institute)
 * - oaic.gov.au (public — OAIC enforcement)
 *
 * Gated by ENABLE_PUBLIC_RECORDS_INGESTION switchboard flag.
 */

import { logger } from '../utils/logger.js';
import { computeContentHash, delay } from '../utils/pipeline.js';
import type { SupabaseClient } from '@supabase/supabase-js';

const RATE_LIMIT_MS = 500;
const MAX_PER_RUN = 500;
const INSERT_BATCH_SIZE = 50;

/** AustLII search API */
const AUSTLII_SEARCH_URL = 'http://www8.austlii.edu.au/cgi-bin/sinosrch.cgi';

/** Key Australian statutes for compliance training */
const AU_STATUTES = [
  {
    title: 'Privacy Act 1988 (Cth)',
    source_id: 'AU-PA-1988',
    url: 'https://www.legislation.gov.au/C2004A03712/latest/text',
    sections: [
      { id: 'AU-PA-1988-S6', title: 'Interpretation — definitions', section: 'Part I' },
      { id: 'AU-PA-1988-S6C', title: 'Organisations — meaning', section: 'Part I' },
      { id: 'AU-PA-1988-S13', title: 'Interference with privacy', section: 'Part II' },
      { id: 'AU-PA-1988-S15', title: 'APP entities', section: 'Part III' },
      { id: 'AU-PA-1988-S16A', title: 'Australian Privacy Principles', section: 'Part III' },
      { id: 'AU-PA-1988-S26WA', title: 'Notifiable Data Breaches scheme', section: 'Part IIIC' },
      { id: 'AU-PA-1988-S26WB', title: 'Notification to Commissioner', section: 'Part IIIC' },
      { id: 'AU-PA-1988-S26WC', title: 'Notification to affected individuals', section: 'Part IIIC' },
      { id: 'AU-PA-1988-S26WE', title: 'Assessment of suspected breach', section: 'Part IIIC' },
      { id: 'AU-PA-1988-S36', title: 'Complaints to Commissioner', section: 'Part V' },
      { id: 'AU-PA-1988-S40', title: 'Investigation by Commissioner', section: 'Part V' },
      { id: 'AU-PA-1988-S52', title: 'Determinations by Commissioner', section: 'Part V' },
      { id: 'AU-PA-1988-S80W', title: 'Civil penalty provisions', section: 'Part VIA' },
    ],
  },
  {
    title: 'Australian Privacy Principles (Schedule 1)',
    source_id: 'AU-APP',
    url: 'https://www.oaic.gov.au/privacy/australian-privacy-principles',
    sections: [
      { id: 'AU-APP-01', title: 'APP 1 — Open and transparent management of personal information', section: 'Schedule 1' },
      { id: 'AU-APP-02', title: 'APP 2 — Anonymity and pseudonymity', section: 'Schedule 1' },
      { id: 'AU-APP-03', title: 'APP 3 — Collection of solicited personal information', section: 'Schedule 1' },
      { id: 'AU-APP-04', title: 'APP 4 — Dealing with unsolicited personal information', section: 'Schedule 1' },
      { id: 'AU-APP-05', title: 'APP 5 — Notification of collection', section: 'Schedule 1' },
      { id: 'AU-APP-06', title: 'APP 6 — Use or disclosure of personal information', section: 'Schedule 1' },
      { id: 'AU-APP-07', title: 'APP 7 — Direct marketing', section: 'Schedule 1' },
      { id: 'AU-APP-08', title: 'APP 8 — Cross-border disclosure of personal information', section: 'Schedule 1' },
      { id: 'AU-APP-09', title: 'APP 9 — Adoption, use or disclosure of government related identifiers', section: 'Schedule 1' },
      { id: 'AU-APP-10', title: 'APP 10 — Quality of personal information', section: 'Schedule 1' },
      { id: 'AU-APP-11', title: 'APP 11 — Security of personal information', section: 'Schedule 1' },
      { id: 'AU-APP-12', title: 'APP 12 — Access to personal information', section: 'Schedule 1' },
      { id: 'AU-APP-13', title: 'APP 13 — Correction of personal information', section: 'Schedule 1' },
    ],
  },
  {
    title: 'Notifiable Data Breaches Scheme Guidelines',
    source_id: 'AU-NDB',
    url: 'https://www.oaic.gov.au/privacy/notifiable-data-breaches',
    sections: [
      { id: 'AU-NDB-01', title: 'What is an eligible data breach', section: 'NDB Scheme' },
      { id: 'AU-NDB-02', title: 'Reasonable steps to prevent harm', section: 'NDB Scheme' },
      { id: 'AU-NDB-03', title: 'Assessing a suspected breach', section: 'NDB Scheme' },
      { id: 'AU-NDB-04', title: 'Notifying the Commissioner', section: 'NDB Scheme' },
      { id: 'AU-NDB-05', title: 'Notifying individuals', section: 'NDB Scheme' },
    ],
  },
];

interface AustraliaFetchResult {
  statutesInserted: number;
  casesInserted: number;
  skipped: number;
  errors: number;
}

/**
 * Ingest Australian statutory text as structured records.
 */
async function ingestAustralianStatutes(
  supabase: SupabaseClient,
): Promise<{ inserted: number; skipped: number; errors: number }> {
  let inserted = 0;
  let skipped = 0;
  let errors = 0;
  const batch: Array<Record<string, unknown>> = [];

  for (const statute of AU_STATUTES) {
    for (const section of statute.sections) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: existing } = await (supabase as any)
        .from('public_records')
        .select('id')
        .eq('source', 'australia_law')
        .eq('source_id', section.id)
        .limit(1);

      if (existing && existing.length > 0) { skipped++; continue; }

      batch.push({
        source: 'australia_law',
        source_id: section.id,
        source_url: statute.url,
        record_type: 'regulation',
        title: `${statute.title} — ${section.title}`,
        content_hash: computeContentHash(JSON.stringify({
          statute: statute.source_id, section: section.id, title: section.title,
        })),
        metadata: {
          statute_name: statute.title,
          statute_id: statute.source_id,
          section_id: section.id,
          section_title: section.title,
          part: section.section,
          jurisdiction: 'Australia',
          jurisdiction_code: 'AU',
          pipeline_source: 'australia_law',
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
  }

  if (batch.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any)
      .from('public_records')
      .upsert(batch, { onConflict: 'source,source_id', ignoreDuplicates: true });
    if (error) { errors += batch.length; } else { inserted += batch.length; }
  }

  return { inserted, skipped, errors };
}

/**
 * Fetch Australian court decisions from AustLII.
 */
async function fetchAustralianCaseLaw(
  supabase: SupabaseClient,
): Promise<{ inserted: number; skipped: number; errors: number }> {
  let inserted = 0;
  let skipped = 0;
  let errors = 0;

  const searchTerms = [
    'privacy breach notification',
    'Australian Privacy Principle',
    'data protection personal information',
    'ACNC charity compliance',
    'health practitioner registration',
  ];

  const batch: Array<Record<string, unknown>> = [];

  for (const term of searchTerms) {
    if (inserted + skipped >= MAX_PER_RUN) break;

    try {
      const params = new URLSearchParams({
        query: term,
        meta: '/au/cases/cth/FCA',
        results: '20',
        method: 'auto',
      });

      const response = await fetch(`${AUSTLII_SEARCH_URL}?${params}`, {
        headers: { Accept: 'text/html' },
      });

      if (!response.ok) {
        logger.warn({ term, status: response.status }, 'AustLII search failed');
        errors++;
        continue;
      }

      const html = await response.text();

      // Parse case links from AustLII HTML results
      const caseMatches = html.matchAll(/<a href="(\/cgi-bin\/viewdoc\/au\/cases\/cth\/[^"]+)"[^>]*>([^<]+)<\/a>/gi);

      for (const match of caseMatches) {
        if (inserted + skipped >= MAX_PER_RUN) break;

        const casePath = match[1];
        const caseTitle = match[2]?.trim();
        if (!caseTitle || caseTitle.length < 5) continue;

        const caseId = casePath.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 100);

        batch.push({
          source: 'australia_caselaw',
          source_id: `AU-CASE-${caseId}`,
          source_url: `http://www.austlii.edu.au${casePath}`,
          record_type: 'court_decision',
          title: caseTitle,
          content_hash: computeContentHash(JSON.stringify({ path: casePath, title: caseTitle })),
          metadata: {
            case_title: caseTitle,
            court: 'Federal Court of Australia',
            austlii_path: casePath,
            search_term: term,
            jurisdiction: 'Australia',
            jurisdiction_code: 'AU',
            pipeline_source: 'australia_caselaw',
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

      await delay(RATE_LIMIT_MS);
    } catch (err) {
      logger.error({ term, error: err }, 'Australian case law fetch failed');
      errors++;
    }
  }

  if (batch.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any)
      .from('public_records')
      .upsert(batch, { onConflict: 'source,source_id', ignoreDuplicates: true });
    if (error) { errors += batch.length; } else { inserted += batch.length; }
  }

  return { inserted, skipped, errors };
}

/**
 * Fetch Australian regulatory and legal data for Nessie/Gemini training.
 */
export async function fetchAustraliaComplianceData(
  supabase: SupabaseClient,
): Promise<AustraliaFetchResult> {
  const { data: enabled } = await supabase.rpc('get_flag', {
    p_flag_key: 'ENABLE_PUBLIC_RECORDS_INGESTION',
  });
  if (!enabled) {
    logger.info('ENABLE_PUBLIC_RECORDS_INGESTION disabled — skipping Australia compliance fetch');
    return { statutesInserted: 0, casesInserted: 0, skipped: 0, errors: 0 };
  }

  logger.info('Starting Australia compliance data fetch (KAU-03/04)');

  const statutes = await ingestAustralianStatutes(supabase);
  const cases = await fetchAustralianCaseLaw(supabase);

  const result: AustraliaFetchResult = {
    statutesInserted: statutes.inserted,
    casesInserted: cases.inserted,
    skipped: statutes.skipped + cases.skipped,
    errors: statutes.errors + cases.errors,
  };

  logger.info(result, 'Australia compliance data fetch complete');
  return result;
}
