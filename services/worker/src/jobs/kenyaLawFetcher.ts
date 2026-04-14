/**
 * KAU-01: Kenya Data Protection Act 2019 + ODPC Regulations Fetcher
 * KAU-02: Kenya Court Decisions (Kenya Law Reports)
 *
 * Ingests Kenya compliance data for Nessie and Gemini training:
 * - Kenya Data Protection Act 2019 (full text)
 * - ODPC (Office of Data Protection Commissioner) regulations and guidelines
 * - Kenya Law Reports court decisions (kenyalaw.org)
 *
 * Critical for early Kenya clientele — Nessie must understand
 * Kenya data protection requirements and enforcement patterns.
 *
 * Sources:
 * - kenyalaw.org (public, free — Kenya Law Reports)
 * - dataprotection.go.ke (ODPC — public)
 *
 * Gated by ENABLE_PUBLIC_RECORDS_INGESTION switchboard flag.
 */

import { logger } from '../utils/logger.js';
import { computeContentHash, delay } from '../utils/pipeline.js';
import type { SupabaseClient } from '@supabase/supabase-js';

const RATE_LIMIT_MS = 500;
const MAX_PER_RUN = 500;
const INSERT_BATCH_SIZE = 50;

/** Kenya Law Reports search API */
const KENYA_LAW_SEARCH_URL = 'http://kenyalaw.org/caselaw/cases/advanced_search';

/** Key Kenya statutes for compliance training */
const KENYA_STATUTES = [
  {
    title: 'Kenya Data Protection Act, 2019',
    source_id: 'KE-DPA-2019',
    url: 'http://kenyalaw.org/kl/fileadmin/pdfdownloads/Acts/2019/TheDataProtectionAct__No24of2019.pdf',
    sections: [
      { id: 'KE-DPA-2019-S1', title: 'Preliminary — Short title and commencement', section: 'Part I' },
      { id: 'KE-DPA-2019-S2', title: 'Interpretation and definitions', section: 'Part I' },
      { id: 'KE-DPA-2019-S25', title: 'Principles of data processing', section: 'Part III' },
      { id: 'KE-DPA-2019-S26', title: 'Rights of data subjects', section: 'Part IV' },
      { id: 'KE-DPA-2019-S27', title: 'Obligations of data controllers', section: 'Part V' },
      { id: 'KE-DPA-2019-S41', title: 'Transfer of personal data outside Kenya', section: 'Part VI' },
      { id: 'KE-DPA-2019-S43', title: 'Offences and penalties', section: 'Part VII' },
      { id: 'KE-DPA-2019-S46', title: 'Data Protection Impact Assessment', section: 'Part VIII' },
      { id: 'KE-DPA-2019-S50', title: 'Registration of data controllers and processors', section: 'Part IX' },
      { id: 'KE-DPA-2019-S56', title: 'Enforcement by the Commissioner', section: 'Part X' },
    ],
  },
  {
    title: 'Kenya Data Protection (General) Regulations, 2021',
    source_id: 'KE-DPR-2021',
    url: 'https://www.odpc.go.ke/regulations/',
    sections: [
      { id: 'KE-DPR-2021-R3', title: 'Registration requirements', section: 'Part II' },
      { id: 'KE-DPR-2021-R7', title: 'Data protection impact assessment', section: 'Part III' },
      { id: 'KE-DPR-2021-R12', title: 'Cross-border data transfer', section: 'Part IV' },
      { id: 'KE-DPR-2021-R18', title: 'Data breach notification', section: 'Part V' },
      { id: 'KE-DPR-2021-R22', title: 'Complaints handling', section: 'Part VI' },
    ],
  },
  {
    title: 'Kenya Employment Act, 2007',
    source_id: 'KE-EA-2007',
    url: 'http://kenyalaw.org/kl/fileadmin/pdfdownloads/Acts/EmploymentAct_Cap226.pdf',
    sections: [
      { id: 'KE-EA-2007-S5', title: 'Prohibition of forced labour', section: 'Part II' },
      { id: 'KE-EA-2007-S44', title: 'Termination of employment', section: 'Part VII' },
      { id: 'KE-EA-2007-S47', title: 'Unfair termination', section: 'Part VII' },
    ],
  },
];

interface KenyaFetchResult {
  statutesInserted: number;
  casesInserted: number;
  skipped: number;
  errors: number;
}

/**
 * Ingest Kenya statutory text as structured records.
 */
async function ingestKenyaStatutes(
  supabase: SupabaseClient,
): Promise<{ inserted: number; skipped: number; errors: number }> {
  let inserted = 0;
  let skipped = 0;
  let errors = 0;

  const batch: Array<Record<string, unknown>> = [];

  for (const statute of KENYA_STATUTES) {
    for (const section of statute.sections) {
      // Check dedup
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: existing } = await (supabase as any)
        .from('public_records')
        .select('id')
        .eq('source', 'kenya_law')
        .eq('source_id', section.id)
        .limit(1);

      if (existing && existing.length > 0) {
        skipped++;
        continue;
      }

      batch.push({
        source: 'kenya_law',
        source_id: section.id,
        source_url: statute.url,
        record_type: 'regulation',
        title: `${statute.title} — ${section.title}`,
        content_hash: computeContentHash(JSON.stringify({
          statute: statute.source_id,
          section: section.id,
          title: section.title,
        })),
        metadata: {
          statute_name: statute.title,
          statute_id: statute.source_id,
          section_id: section.id,
          section_title: section.title,
          part: section.section,
          jurisdiction: 'Kenya',
          jurisdiction_code: 'KE',
          pipeline_source: 'kenya_law',
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
 * Fetch Kenya court decisions from Kenya Law Reports.
 */
async function fetchKenyaCaseLaw(
  supabase: SupabaseClient,
): Promise<{ inserted: number; skipped: number; errors: number }> {
  let inserted = 0;
  let skipped = 0;
  let errors = 0;

  // Kenya Law Reports — search for data protection and employment cases
  const searchTerms = [
    'data protection',
    'employment termination',
    'professional license',
    'medical practitioner',
    'advocate disciplinary',
  ];

  const batch: Array<Record<string, unknown>> = [];

  for (const term of searchTerms) {
    if (inserted + skipped >= MAX_PER_RUN) break;

    try {
      const response = await fetch(
        `${KENYA_LAW_SEARCH_URL}?q=${encodeURIComponent(term)}&type=Judgment&format=json`,
        { headers: { Accept: 'application/json' } },
      );

      if (!response.ok) {
        logger.warn({ term, status: response.status }, 'Kenya Law search failed');
        errors++;
        continue;
      }

      const data = await response.json() as {
        results?: Array<{
          id: string;
          title: string;
          court: string;
          date: string;
          citation: string;
          url: string;
          summary?: string;
        }>;
      };

      for (const caseItem of data.results ?? []) {
        if (inserted + skipped >= MAX_PER_RUN) break;

        batch.push({
          source: 'kenya_caselaw',
          source_id: `KE-CASE-${caseItem.id}`,
          source_url: caseItem.url || `http://kenyalaw.org/caselaw/cases/view/${caseItem.id}`,
          record_type: 'court_decision',
          title: caseItem.title,
          content_hash: computeContentHash(JSON.stringify({
            id: caseItem.id,
            title: caseItem.title,
            court: caseItem.court,
          })),
          metadata: {
            case_title: caseItem.title,
            court: caseItem.court,
            decision_date: caseItem.date ?? null,
            citation: caseItem.citation ?? null,
            summary: caseItem.summary?.slice(0, 1000) ?? null,
            search_term: term,
            jurisdiction: 'Kenya',
            jurisdiction_code: 'KE',
            pipeline_source: 'kenya_caselaw',
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
      logger.error({ term, error: err }, 'Kenya case law fetch failed');
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
 * Fetch Kenya regulatory and legal data for Nessie/Gemini training.
 */
export async function fetchKenyaComplianceData(
  supabase: SupabaseClient,
): Promise<KenyaFetchResult> {
  const { data: enabled } = await supabase.rpc('get_flag', {
    p_flag_key: 'ENABLE_PUBLIC_RECORDS_INGESTION',
  });
  if (!enabled) {
    logger.info('ENABLE_PUBLIC_RECORDS_INGESTION disabled — skipping Kenya compliance fetch');
    return { statutesInserted: 0, casesInserted: 0, skipped: 0, errors: 0 };
  }

  logger.info('Starting Kenya compliance data fetch (KAU-01/02)');

  const statutes = await ingestKenyaStatutes(supabase);
  const cases = await fetchKenyaCaseLaw(supabase);

  const result: KenyaFetchResult = {
    statutesInserted: statutes.inserted,
    casesInserted: cases.inserted,
    skipped: statutes.skipped + cases.skipped,
    errors: statutes.errors + cases.errors,
  };

  logger.info(result, 'Kenya compliance data fetch complete');
  return result;
}
