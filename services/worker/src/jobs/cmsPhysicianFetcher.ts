/**
 * CMS Physician Compare + State Medical Board Fetchers (NPH-11)
 *
 * Two medical source fetchers beyond NPI:
 *
 * 1. CMS Physician Compare (Medicare Provider Utilization)
 *    API: data.cms.gov SODA API (free, no auth)
 *    Records: ~1.2M Medicare-enrolled physicians
 *    credential_type = MEDICAL
 *
 * 2. State Medical Board aggregator
 *    Sources: CA MBC, TX TMB, NY OPMC open data APIs
 *    Records: ~500K+ state-licensed physicians with disciplinary data
 *    credential_type = MEDICAL
 *
 * Constitution refs:
 *   - 4A: Only metadata is stored server-side
 */

import { logger } from '../utils/logger.js';
import { computeContentHash, delay, isIngestionEnabled, batchUpsertRecords } from '../utils/pipeline.js';
import type { SupabaseClient } from '@supabase/supabase-js';

const CMS_API_URL = 'https://data.cms.gov/provider-data/api/1/datastore/query/mj5m-pzi6/0';
const RATE_LIMIT_MS = 500;
const BATCH_SIZE = 100;
const MAX_PER_RUN = 10000;

interface CmsPhysician {
  npi?: string;
  ind_enrl_id?: string;
  lst_nm?: string;
  frst_nm?: string;
  mid_nm?: string;
  cred?: string;
  gndr?: string;
  pri_spec?: string;
  sec_spec_1?: string;
  sec_spec_2?: string;
  sec_spec_3?: string;
  sec_spec_4?: string;
  st?: string;
  cty?: string;
  zip?: string;
  adr_ln_1?: string;
  adr_ln_2?: string;
  tel_nbr?: string;
  hosp_afl_1?: string;
  hosp_afl_2?: string;
  hosp_afl_3?: string;
  hosp_afl_4?: string;
  hosp_afl_5?: string;
  grp_assgn?: string;
  assgn?: string;
  num_org_mem?: string;
}

function buildPhysicianRecord(doc: CmsPhysician) {
  const npi = doc.npi ?? '';
  if (!npi) return null;

  const sourceId = `cms-physician-${npi}`;
  const name = [doc.frst_nm, doc.mid_nm, doc.lst_nm].filter(Boolean).join(' ');
  const specialty = doc.pri_spec ?? 'Unknown';
  const location = [doc.cty, doc.st].filter(Boolean).join(', ');

  const contentForHash = JSON.stringify({ npi, name, specialty, state: doc.st });

  const specialties = [doc.pri_spec, doc.sec_spec_1, doc.sec_spec_2, doc.sec_spec_3, doc.sec_spec_4]
    .filter(Boolean) as string[];

  const hospitalAffiliations = [doc.hosp_afl_1, doc.hosp_afl_2, doc.hosp_afl_3, doc.hosp_afl_4, doc.hosp_afl_5]
    .filter(Boolean) as string[];

  return {
    source: 'cms_physician',
    source_id: sourceId,
    source_url: `https://data.cms.gov/provider-data/physician/${npi}`,
    record_type: 'medicare_physician',
    title: `${name || 'Unknown'} ${doc.cred ? `(${doc.cred})` : ''} — ${specialty}${location ? `, ${location}` : ''}`,
    content_hash: computeContentHash(contentForHash),
    metadata: {
      npi,
      provider_name: name || null,
      credential: doc.cred ?? null,
      gender: doc.gndr ?? null,
      primary_specialty: specialty,
      specialties,
      city: doc.cty ?? null,
      state: doc.st ?? null,
      zip: doc.zip ?? null,
      address: doc.adr_ln_1 ?? null,
      phone: doc.tel_nbr ?? null,
      hospital_affiliations: hospitalAffiliations,
      medicare_assignment: doc.assgn ?? null,
      group_practice: doc.grp_assgn ?? null,
      group_member_count: doc.num_org_mem ? parseInt(doc.num_org_mem, 10) : null,
      credential_type: 'MEDICAL',
      pipeline_source: 'cms_physician_compare',
      registry: 'CMS Physician Compare (Medicare)',
      jurisdiction: 'US',
    },
  };
}

export async function fetchCmsPhysicians(
  supabase: SupabaseClient,
  options?: { states?: string[]; maxPerRun?: number },
): Promise<{ inserted: number; skipped: number; errors: number }> {
  if (!(await isIngestionEnabled(supabase))) {
    logger.info('ENABLE_PUBLIC_RECORDS_INGESTION disabled — skipping CMS Physician fetch');
    return { inserted: 0, skipped: 0, errors: 0 };
  }

  const maxPerRun = options?.maxPerRun ?? MAX_PER_RUN;
  const states = options?.states;

  logger.info({ maxPerRun, states }, 'CMS Physician Compare: starting fetch');

  let totalInserted = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  let offset = 0;

  while (totalInserted < maxPerRun) {
    try {
      const params: Record<string, unknown> = {
        offset,
        count: true,
        results: true,
        schema: true,
        keys: true,
        format: 'json',
        limit: BATCH_SIZE,
      };

      if (states?.length) {
        params.conditions = states.map(st => ({ property: 'st', value: st, operator: '=' }));
      }

      const response = await fetch(CMS_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Arkova/1.0 (contact@arkova.ai)',
        },
        body: JSON.stringify(params),
      });

      if (!response.ok) {
        if (response.status === 429) {
          logger.warn('CMS rate limited — backing off 10 seconds');
          await delay(10_000);
          continue;
        }
        logger.error({ status: response.status }, 'CMS Physician API request failed');
        totalErrors++;
        break;
      }

      const data = await response.json() as { results?: CmsPhysician[]; count?: number };
      const results = data.results ?? (Array.isArray(data) ? data as CmsPhysician[] : []);

      if (results.length === 0) break;

      const batch = results
        .map(buildPhysicianRecord)
        .filter((r): r is NonNullable<typeof r> => r !== null);

      if (batch.length > 0) {
        const { inserted, errors } = await batchUpsertRecords(supabase, batch);
        totalInserted += inserted;
        totalErrors += errors;
        if (errors > 0) totalSkipped += batch.length - inserted;
      }

      offset += results.length;

      if (results.length < BATCH_SIZE) break;

      if (totalInserted > 0 && totalInserted % 500 === 0) {
        logger.info({ inserted: totalInserted, errors: totalErrors, offset }, 'CMS Physician progress');
      }
    } catch (err) {
      logger.error({ error: err, offset }, 'CMS Physician fetch error');
      totalErrors++;
      break;
    }

    await delay(RATE_LIMIT_MS);
  }

  logger.info(
    { inserted: totalInserted, skipped: totalSkipped, errors: totalErrors },
    'CMS Physician Compare fetch complete',
  );

  return { inserted: totalInserted, skipped: totalSkipped, errors: totalErrors };
}

interface StateMedicalBoardConfig {
  state: string;
  name: string;
  apiUrl: string;
  parseRecords: (data: unknown) => MedicalBoardRecord[];
}

interface MedicalBoardRecord {
  license_number: string;
  first_name: string;
  last_name: string;
  license_type: string;
  status: string;
  specialty?: string;
  city?: string;
  state: string;
  expiration_date?: string;
  disciplinary_action?: string;
}

function parseRecordArray(data: unknown, state: string): MedicalBoardRecord[] {
  const records = Array.isArray(data) ? data : [];
  return (records as Record<string, unknown>[]).map((r) => ({
    license_number: String(r.license_number ?? r.LICENSE_NUMBER ?? ''),
    first_name: String(r.first_name ?? r.FIRST_NAME ?? ''),
    last_name: String(r.last_name ?? r.LAST_NAME ?? ''),
    license_type: String(r.license_type ?? r.LICENSE_TYPE ?? 'MD'),
    status: String(r.status ?? r.STATUS ?? 'Active'),
    specialty: r.specialty ? String(r.specialty) : undefined,
    city: r.city ? String(r.city) : undefined,
    state,
    expiration_date: r.expiration_date ? String(r.expiration_date) : undefined,
    disciplinary_action: r.disciplinary_action ? String(r.disciplinary_action) : undefined,
  }));
}

const STATE_BOARDS: StateMedicalBoardConfig[] = [
  {
    state: 'CA',
    name: 'California Medical Board',
    apiUrl: 'https://data.ca.gov/api/3/action/datastore_search?resource_id=physicians&limit=100',
    // CA wraps records inside result.records
    parseRecords: (data: unknown) => {
      const nested = ((data as Record<string, unknown>)?.result as Record<string, unknown>)?.records;
      return parseRecordArray(nested, 'CA');
    },
  },
  {
    state: 'TX',
    name: 'Texas Medical Board',
    apiUrl: 'https://data.texas.gov/api/views/physician-profiles/rows.json?accessType=DOWNLOAD',
    parseRecords: (data: unknown) => parseRecordArray(data, 'TX'),
  },
  {
    state: 'NY',
    name: 'New York OPMC',
    apiUrl: 'https://health.data.ny.gov/api/views/physician-profiles/rows.json?accessType=DOWNLOAD',
    parseRecords: (data: unknown) => parseRecordArray(data, 'NY'),
  },
];

function buildBoardRecord(record: MedicalBoardRecord, boardName: string) {
  if (!record.license_number) return null;

  const sourceId = `medical-board-${record.state}-${record.license_number}`;
  const name = [record.first_name, record.last_name].filter(Boolean).join(' ');
  const specialty = record.specialty ?? 'General';

  return {
    source: 'state_medical_board',
    source_id: sourceId,
    source_url: `https://www.${record.state.toLowerCase()}.gov/medical-board/verify/${record.license_number}`,
    record_type: 'medical_license',
    title: `${name || 'Unknown'} (${record.license_type}) — ${record.state} License #${record.license_number}`,
    content_hash: computeContentHash(JSON.stringify({
      licenseNumber: record.license_number,
      name,
      state: record.state,
      status: record.status,
    })),
    metadata: {
      license_number: record.license_number,
      provider_name: name || null,
      license_type: record.license_type,
      license_status: record.status,
      specialty,
      city: record.city ?? null,
      state: record.state,
      expiration_date: record.expiration_date ?? null,
      disciplinary_action: record.disciplinary_action ?? null,
      has_disciplinary_action: Boolean(record.disciplinary_action),
      credential_type: 'MEDICAL',
      pipeline_source: 'state_medical_board',
      registry: boardName,
      jurisdiction: 'US',
    },
  };
}

export async function fetchStateMedicalBoards(
  supabase: SupabaseClient,
  options?: { states?: string[]; maxPerRun?: number },
): Promise<{ inserted: number; skipped: number; errors: number }> {
  if (!(await isIngestionEnabled(supabase))) {
    logger.info('ENABLE_PUBLIC_RECORDS_INGESTION disabled — skipping state medical board fetch');
    return { inserted: 0, skipped: 0, errors: 0 };
  }

  const maxPerRun = options?.maxPerRun ?? MAX_PER_RUN;
  const targetStates = options?.states;

  const boards = targetStates
    ? STATE_BOARDS.filter(b => targetStates.includes(b.state))
    : STATE_BOARDS;

  logger.info({ boards: boards.map(b => b.state), maxPerRun }, 'State Medical Boards: starting fetch');

  let totalInserted = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  for (const board of boards) {
    if (totalInserted >= maxPerRun) break;

    try {
      const response = await fetch(board.apiUrl, {
        headers: {
          'User-Agent': 'Arkova/1.0 (contact@arkova.ai)',
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        logger.error({ status: response.status, state: board.state }, 'Medical board API request failed');
        totalErrors++;
        continue;
      }

      const data = await response.json();
      const records = board.parseRecords(data);

      const batch: Record<string, unknown>[] = [];
      for (const record of records) {
        if (totalInserted + batch.length >= maxPerRun) break;

        const dbRecord = buildBoardRecord(record, board.name);
        if (dbRecord) batch.push(dbRecord);

        if (batch.length >= BATCH_SIZE) {
          const { inserted, errors } = await batchUpsertRecords(supabase, batch);
          totalInserted += inserted;
          totalErrors += errors;
          if (errors > 0) totalSkipped += batch.length - inserted;
          batch.length = 0;
          await delay(RATE_LIMIT_MS);
        }
      }

      if (batch.length > 0) {
        const { inserted, errors } = await batchUpsertRecords(supabase, batch);
        totalInserted += inserted;
        totalErrors += errors;
        if (errors > 0) totalSkipped += batch.length - inserted;
      }

      logger.info({ state: board.state, inserted: totalInserted }, `${board.name} fetch complete`);
    } catch (err) {
      logger.error({ error: err, state: board.state }, 'Medical board fetch error');
      totalErrors++;
    }

    await delay(RATE_LIMIT_MS);
  }

  logger.info(
    { inserted: totalInserted, skipped: totalSkipped, errors: totalErrors },
    'State Medical Boards fetch complete',
  );

  return { inserted: totalInserted, skipped: totalSkipped, errors: totalErrors };
}
