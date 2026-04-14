/**
 * NCX-01: eCFR (Electronic Code of Federal Regulations) Fetcher
 *
 * Fetches federal regulatory text from the eCFR API.
 * This is the foundation for Nessie's compliance reasoning —
 * without the actual rule text, Nessie can't assess compliance.
 *
 * API: https://www.ecfr.gov/api/versioner/v1/
 * Free, public, no auth required. Rate limit: ~10 req/s.
 *
 * Priority titles for credential compliance:
 * - Title 34: Education (FERPA — 34 CFR Part 99)
 * - Title 45: Public Welfare (HIPAA — 45 CFR Parts 160, 162, 164)
 * - Title 17: Securities (SOX — 17 CFR Parts 210, 240, 249)
 * - Title 12: Banks/Banking (BSA/AML — 12 CFR Part 1010)
 * - Title 29: Labor (OSHA, ERISA)
 * - Title 42: Public Health (CMS, Medicare/Medicaid)
 *
 * Gated by ENABLE_PUBLIC_RECORDS_INGESTION switchboard flag.
 */

import { logger } from '../utils/logger.js';
import { computeContentHash, delay } from '../utils/pipeline.js';
import type { SupabaseClient } from '@supabase/supabase-js';

const ECFR_API_BASE = 'https://www.ecfr.gov/api/versioner/v1';
const RATE_LIMIT_MS = 200;
const MAX_SECTIONS_PER_RUN = 500;
const INSERT_BATCH_SIZE = 50;

/** Priority CFR titles for compliance */
const PRIORITY_TITLES = [
  { title: 34, name: 'Education', parts: [99], reason: 'FERPA' },
  { title: 45, name: 'Public Welfare', parts: [160, 162, 164], reason: 'HIPAA' },
  { title: 17, name: 'Commodity and Securities', parts: [210, 240, 249], reason: 'SOX/SEC' },
  { title: 12, name: 'Banks and Banking', parts: [1010, 1020, 1022], reason: 'BSA/AML' },
  { title: 29, name: 'Labor', parts: [1910, 1926], reason: 'OSHA' },
  { title: 42, name: 'Public Health', parts: [482, 483, 484], reason: 'CMS' },
];

interface EcfrSection {
  identifier: string;
  label: string;
  title: string;
  reserved: boolean;
  type: string;
  children?: EcfrSection[];
}

interface EcfrFetchResult {
  inserted: number;
  skipped: number;
  errors: number;
  titlesProcessed: number;
}

/**
 * Fetch the structure (table of contents) for a CFR title + part.
 */
async function fetchPartStructure(title: number, part: number): Promise<EcfrSection[]> {
  const url = `${ECFR_API_BASE}/structure/${new Date().toISOString().slice(0, 10)}/title-${title}.json?part=${part}`;
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    logger.warn({ title, part, status: response.status }, 'eCFR structure fetch failed');
    return [];
  }

  const data = await response.json() as { children?: EcfrSection[] };
  return data.children ?? [];
}

/**
 * Fetch the full text of a CFR section.
 */
async function fetchSectionText(title: number, section: string): Promise<string | null> {
  const date = new Date().toISOString().slice(0, 10);
  const url = `${ECFR_API_BASE}/full/${date}/title-${title}.json?section=${section}`;
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) return null;

  const data = await response.json() as { content?: string };
  return data.content ?? null;
}

/**
 * Recursively collect all section identifiers from a structure tree.
 */
function collectSections(nodes: EcfrSection[], prefix: string = ''): Array<{ identifier: string; label: string }> {
  const sections: Array<{ identifier: string; label: string }> = [];
  for (const node of nodes) {
    if (node.type === 'section' && !node.reserved) {
      sections.push({ identifier: node.identifier, label: node.label || node.title });
    }
    if (node.children) {
      sections.push(...collectSections(node.children, node.identifier));
    }
  }
  return sections;
}

/**
 * Fetch eCFR regulatory text for priority compliance titles.
 */
export async function fetchEcfrRegulations(
  supabase: SupabaseClient,
): Promise<EcfrFetchResult> {
  const { data: enabled } = await supabase.rpc('get_flag', {
    p_flag_key: 'ENABLE_PUBLIC_RECORDS_INGESTION',
  });
  if (!enabled) {
    logger.info('ENABLE_PUBLIC_RECORDS_INGESTION disabled — skipping eCFR fetch');
    return { inserted: 0, skipped: 0, errors: 0, titlesProcessed: 0 };
  }

  let totalInserted = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  let sectionsProcessed = 0;

  for (const { title, name, parts, reason } of PRIORITY_TITLES) {
    if (sectionsProcessed >= MAX_SECTIONS_PER_RUN) break;

    for (const part of parts) {
      if (sectionsProcessed >= MAX_SECTIONS_PER_RUN) break;

      logger.info({ title, part, reason }, `Fetching eCFR Title ${title} Part ${part}`);

      const structure = await fetchPartStructure(title, part);
      const sections = collectSections(structure);

      if (sections.length === 0) {
        logger.warn({ title, part }, 'No sections found in eCFR part');
        continue;
      }

      const batch: Array<Record<string, unknown>> = [];

      for (const section of sections) {
        if (sectionsProcessed >= MAX_SECTIONS_PER_RUN) break;

        // Check if already ingested
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: existing } = await (supabase as any)
          .from('public_records')
          .select('id')
          .eq('source', 'ecfr')
          .eq('source_id', `${title}-CFR-${section.identifier}`)
          .limit(1);

        if (existing && existing.length > 0) {
          totalSkipped++;
          sectionsProcessed++;
          continue;
        }

        await delay(RATE_LIMIT_MS);
        const text = await fetchSectionText(title, section.identifier);

        if (!text) {
          totalErrors++;
          sectionsProcessed++;
          continue;
        }

        batch.push({
          source: 'ecfr',
          source_id: `${title}-CFR-${section.identifier}`,
          source_url: `https://www.ecfr.gov/current/title-${title}/part-${part}/section-${section.identifier}`,
          record_type: 'federal_regulation',
          title: `${title} CFR § ${section.identifier} — ${section.label}`,
          content_hash: computeContentHash(text),
          metadata: {
            cfr_title: title,
            cfr_title_name: name,
            cfr_part: part,
            cfr_section: section.identifier,
            section_label: section.label,
            compliance_reason: reason,
            text_length: text.length,
            pipeline_source: 'ecfr',
          },
        });

        sectionsProcessed++;

        if (batch.length >= INSERT_BATCH_SIZE) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { error } = await (supabase as any)
            .from('public_records')
            .upsert(batch, { onConflict: 'source,source_id', ignoreDuplicates: true });
          if (error) {
            logger.error({ error, count: batch.length }, 'eCFR batch insert failed');
            totalErrors += batch.length;
          } else {
            totalInserted += batch.length;
          }
          batch.length = 0;
        }
      }

      // Flush remaining
      if (batch.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error } = await (supabase as any)
          .from('public_records')
          .upsert(batch, { onConflict: 'source,source_id', ignoreDuplicates: true });
        if (error) totalErrors += batch.length;
        else totalInserted += batch.length;
      }
    }
  }

  logger.info(
    { totalInserted, totalSkipped, totalErrors, sectionsProcessed, titlesProcessed: PRIORITY_TITLES.length },
    'eCFR regulatory text fetch complete',
  );

  return {
    inserted: totalInserted,
    skipped: totalSkipped,
    errors: totalErrors,
    titlesProcessed: PRIORITY_TITLES.length,
  };
}
