/**
 * DAPIP Accredited Institutions Fetcher
 *
 * Fetches accredited postsecondary institutions from the U.S. Department
 * of Education DAPIP (Database of Accredited Postsecondary Institutions
 * and Programs) API.
 *
 * Free, public, no auth required.
 * ~7,000 accredited institutions.
 * Data includes: institution name, accreditor, accreditation status,
 * accreditation dates, address, programs.
 *
 * API docs: https://ope.ed.gov/dapip/api
 *
 * Why anchor this: Credential verification requires knowing whether
 * the issuing institution is legitimately accredited. This is the
 * foundation for diploma/degree verification.
 */

import { createHash } from 'node:crypto';
import { logger } from '../utils/logger.js';
import type { SupabaseClient } from '@supabase/supabase-js';

const DAPIP_API_URL = 'https://ope.ed.gov/dapip/api/PostInstitution';
const RATE_LIMIT_MS = 500; // Conservative — Dept of Ed API
const BATCH_SIZE = 100;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbAny = (db: SupabaseClient) => db as any;

interface DapipInstitution {
  InstitutionId: number;
  InstitutionName: string;
  GeneralInformation: {
    Address: string;
    City: string;
    State: string;
    Zip: string;
    Country: string;
    Website: string;
    InstitutionType: string;
  };
  InstitutionalAccreditations: Array<{
    AgencyName: string;
    AccreditationType: string;
    AccreditationStatus: string;
    Periods: Array<{
      AccreditationActionDate: string;
      AccreditationEndDate: string;
    }>;
  }>;
}

function computeContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch accredited institutions from DAPIP.
 * Uses the search endpoint with state-by-state queries for complete coverage.
 */
export async function fetchDapipInstitutions(supabase: SupabaseClient): Promise<{
  inserted: number;
  skipped: number;
  errors: number;
}> {
  // Check switchboard flag
  const { data: enabled } = await supabase.rpc('get_flag', {
    p_flag_key: 'ENABLE_PUBLIC_RECORDS_INGESTION',
  });
  if (!enabled) {
    logger.info('ENABLE_PUBLIC_RECORDS_INGESTION disabled — skipping DAPIP fetch');
    return { inserted: 0, skipped: 0, errors: 0 };
  }

  const US_STATES = [
    'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA',
    'HI','ID','IL','IN','IA','KS','KY','LA','ME','MD',
    'MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
    'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC',
    'SD','TN','TX','UT','VT','VA','WA','WV','WI','WY',
    'DC','PR','GU','VI','AS',
  ];

  let totalInserted = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  for (const state of US_STATES) {
    try {
      const response = await fetch(DAPIP_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          State: state,
          PageSize: BATCH_SIZE,
          PageNumber: 1,
        }),
      });

      if (!response.ok) {
        logger.warn({ state, status: response.status }, 'DAPIP API request failed');
        totalErrors++;
        await delay(RATE_LIMIT_MS);
        continue;
      }

      const data = await response.json() as { Results: DapipInstitution[]; TotalRowCount: number };
      const institutions = data.Results ?? [];

      for (const inst of institutions) {
        const gi = inst.GeneralInformation;
        const accred = inst.InstitutionalAccreditations?.[0];
        const sourceId = `dapip-${inst.InstitutionId}`;

        // Check for duplicates
        const { data: existing } = await dbAny(supabase)
          .from('public_records')
          .select('id')
          .eq('source', 'dapip')
          .eq('source_id', sourceId)
          .limit(1);

        if (existing && existing.length > 0) {
          totalSkipped++;
          continue;
        }

        const contentForHash = JSON.stringify({
          id: inst.InstitutionId,
          name: inst.InstitutionName,
          state: gi?.State,
          accreditor: accred?.AgencyName,
          status: accred?.AccreditationStatus,
        });

        const { error: insertError } = await dbAny(supabase)
          .from('public_records')
          .insert({
            source: 'dapip',
            source_id: sourceId,
            source_url: `https://ope.ed.gov/dapip/#/institution-profile/${inst.InstitutionId}`,
            record_type: 'accreditation',
            title: `${inst.InstitutionName} — ${accred?.AccreditationStatus ?? 'Accredited'}`,
            content_hash: computeContentHash(contentForHash),
            metadata: {
              institution_name: inst.InstitutionName,
              institution_type: gi?.InstitutionType ?? null,
              address: gi ? `${gi.Address}, ${gi.City}, ${gi.State} ${gi.Zip}` : null,
              state: gi?.State ?? state,
              website: gi?.Website ?? null,
              accreditor: accred?.AgencyName ?? null,
              accreditation_type: accred?.AccreditationType ?? null,
              accreditation_status: accred?.AccreditationStatus ?? null,
              accreditation_date: accred?.Periods?.[0]?.AccreditationActionDate ?? null,
              accreditation_end_date: accred?.Periods?.[0]?.AccreditationEndDate ?? null,
              dapip_id: inst.InstitutionId,
            },
          });

        if (insertError) {
          if (insertError.code !== '23505') {
            logger.error({ sourceId, error: insertError }, 'DAPIP insert failed');
            totalErrors++;
          } else {
            totalSkipped++;
          }
        } else {
          totalInserted++;
        }
      }

      // Handle pagination — fetch remaining pages
      const totalPages = Math.ceil((data.TotalRowCount ?? 0) / BATCH_SIZE);
      for (let page = 2; page <= Math.min(totalPages, 10); page++) {
        await delay(RATE_LIMIT_MS);
        try {
          const pageResp = await fetch(DAPIP_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ State: state, PageSize: BATCH_SIZE, PageNumber: page }),
          });
          if (!pageResp.ok) continue;
          const pageData = await pageResp.json() as { Results: DapipInstitution[] };
          for (const inst of pageData.Results ?? []) {
            const gi = inst.GeneralInformation;
            const accred = inst.InstitutionalAccreditations?.[0];
            const sourceId = `dapip-${inst.InstitutionId}`;

            const { data: existing } = await dbAny(supabase)
              .from('public_records').select('id').eq('source', 'dapip').eq('source_id', sourceId).limit(1);
            if (existing && existing.length > 0) { totalSkipped++; continue; }

            const contentForHash = JSON.stringify({ id: inst.InstitutionId, name: inst.InstitutionName, state: gi?.State });
            const { error: insertError } = await dbAny(supabase).from('public_records').insert({
              source: 'dapip', source_id: sourceId,
              source_url: `https://ope.ed.gov/dapip/#/institution-profile/${inst.InstitutionId}`,
              record_type: 'accreditation',
              title: `${inst.InstitutionName} — ${accred?.AccreditationStatus ?? 'Accredited'}`,
              content_hash: computeContentHash(contentForHash),
              metadata: {
                institution_name: inst.InstitutionName, institution_type: gi?.InstitutionType ?? null,
                state: gi?.State ?? state, website: gi?.Website ?? null,
                accreditor: accred?.AgencyName ?? null, accreditation_status: accred?.AccreditationStatus ?? null,
                dapip_id: inst.InstitutionId,
              },
            });
            if (insertError && insertError.code !== '23505') { totalErrors++; } else if (!insertError) { totalInserted++; } else { totalSkipped++; }
          }
        } catch { totalErrors++; }
      }

      await delay(RATE_LIMIT_MS);
    } catch (err) {
      logger.error({ state, error: err }, 'DAPIP fetch failed for state');
      totalErrors++;
    }
  }

  logger.info({ totalInserted, totalSkipped, totalErrors }, 'DAPIP fetch complete');
  return { inserted: totalInserted, skipped: totalSkipped, errors: totalErrors };
}
