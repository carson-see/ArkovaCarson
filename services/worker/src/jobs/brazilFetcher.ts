/**
 * CNPJ Brazil Companies Fetcher
 *
 * Fetches Brazilian company registration data via the BrasilAPI,
 * which provides free access to CNPJ (Cadastro Nacional da Pessoa
 * Juridica) records from the Receita Federal.
 *
 * API: https://brasilapi.com.br/api/cnpj/v1/{cnpj}
 * Bulk seed: known CNPJs from publicly listed Brazilian companies
 * Auth: None required (public API)
 * Rate limit: 3 req/sec max (enforced client-side at 350ms delay)
 *
 * Why anchor this: Business registration verification — proves a
 * company was registered with the Receita Federal at a point in
 * time. Critical for Brazilian KYB due diligence.
 */

import { logger } from '../utils/logger.js';
import { computeContentHash, delay, isIngestionEnabled } from '../utils/pipeline.js';
import type { SupabaseClient } from '@supabase/supabase-js';

const BRASIL_API_BASE = 'https://brasilapi.com.br/api/cnpj/v1';

const RATE_LIMIT_MS = 350; // ~3 req/sec max

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbAny = (db: SupabaseClient) => db as any;

/**
 * Seed CNPJs: major publicly listed or well-known Brazilian companies.
 * These provide an initial dataset for verification anchoring.
 * Can be expanded via admin UI or bulk upload.
 */
const SEED_CNPJS = [
  // Petrobras
  '33000167000101',
  // Vale S.A.
  '33592510000154',
  // Itau Unibanco
  '60701190000104',
  // Banco do Brasil
  '00000000000191',
  // Ambev
  '07526557000100',
  // JBS S.A.
  '02916265000160',
  // Magazine Luiza
  '47960950000121',
  // B3 (Brasil Bolsa Balcao)
  '09346601000125',
  // Weg S.A.
  '84429695000111',
  // Embraer
  '07689002000189',
  // Natura
  '71673990000177',
  // Totvs
  '53113791000122',
  // Localiza
  '16670085000155',
  // Suzano
  '16404287000155',
  // CPFL Energia
  '02429144000193',
  // Energisa
  '00864214000106',
  // Equatorial Energia
  '03220438000173',
  // Tim S.A.
  '02421421000111',
  // Raia Drogasil
  '61585865000151',
  // Hapvida
  '63554067000198',
];

interface BrasilApiResponse {
  cnpj: string;
  razao_social: string;
  nome_fantasia?: string;
  descricao_situacao_cadastral?: string;
  data_inicio_atividade?: string;
  cnae_fiscal_descricao?: string;
  cnae_fiscal?: number;
  logradouro?: string;
  numero?: string;
  complemento?: string;
  bairro?: string;
  municipio?: string;
  uf?: string;
  cep?: string;
  natureza_juridica?: string;
  porte?: string;
  capital_social?: number;
  [key: string]: unknown;
}

interface FetchResult {
  inserted: number;
  skipped: number;
  errors: number;
}

function formatCnpj(cnpj: string): string {
  const clean = cnpj.replace(/\D/g, '').padStart(14, '0');
  return `${clean.slice(0, 2)}.${clean.slice(2, 5)}.${clean.slice(5, 8)}/${clean.slice(8, 12)}-${clean.slice(12, 14)}`;
}

async function fetchAndInsertCnpj(
  supabase: SupabaseClient,
  cnpj: string,
): Promise<'inserted' | 'skipped' | 'error'> {
  const cleanCnpj = cnpj.replace(/\D/g, '');
  if (cleanCnpj.length !== 14) {
    logger.warn({ cnpj }, 'Invalid CNPJ length');
    return 'error';
  }

  const sourceId = `cnpj-br-${cleanCnpj}`;

  // Check for duplicates
  const { data: existing } = await dbAny(supabase)
    .from('public_records')
    .select('id')
    .eq('source', 'cnpj_br')
    .eq('source_id', sourceId)
    .limit(1);

  if (existing && existing.length > 0) {
    return 'skipped';
  }

  let response: Response;
  try {
    response = await fetch(`${BRASIL_API_BASE}/${cleanCnpj}`, {
      headers: {
        'User-Agent': 'Arkova/1.0 (contact@arkova.ai)',
        Accept: 'application/json',
      },
    });
  } catch (err) {
    logger.error({ error: err, cnpj: cleanCnpj }, 'BrasilAPI request failed (network)');
    return 'error';
  }

  if (!response.ok) {
    if (response.status === 404) {
      logger.warn({ cnpj: cleanCnpj }, 'CNPJ not found in BrasilAPI');
      return 'skipped';
    }
    if (response.status === 429) {
      logger.warn({ cnpj: cleanCnpj }, 'BrasilAPI rate limit hit — backing off');
      await delay(2000); // Extra backoff on 429
      return 'error';
    }
    logger.warn({ cnpj: cleanCnpj, status: response.status }, 'BrasilAPI returned error');
    return 'error';
  }

  const data = (await response.json()) as BrasilApiResponse;

  const companyName = data.razao_social ?? data.nome_fantasia ?? 'Unknown Company';
  const formattedCnpj = formatCnpj(cleanCnpj);

  const address = [data.logradouro, data.numero, data.complemento, data.bairro, data.municipio, data.uf, data.cep]
    .filter(Boolean)
    .join(', ');

  const contentForHash = JSON.stringify({
    cnpj: cleanCnpj,
    razao_social: data.razao_social,
    situacao: data.descricao_situacao_cadastral,
    data_inicio: data.data_inicio_atividade,
    uf: data.uf,
  });

  const { error: insertError } = await dbAny(supabase)
    .from('public_records')
    .insert({
      source: 'cnpj_br',
      source_id: sourceId,
      source_url: `https://brasilapi.com.br/api/cnpj/v1/${cleanCnpj}`,
      record_type: 'business_registration',
      title: `${companyName} — CNPJ ${formattedCnpj}`,
      content_hash: computeContentHash(contentForHash),
      metadata: {
        cnpj: cleanCnpj,
        cnpj_formatted: formattedCnpj,
        razao_social: data.razao_social ?? null,
        nome_fantasia: data.nome_fantasia ?? null,
        situacao_cadastral: data.descricao_situacao_cadastral ?? null,
        data_inicio_atividade: data.data_inicio_atividade ?? null,
        cnae_fiscal: data.cnae_fiscal ?? null,
        cnae_descricao: data.cnae_fiscal_descricao ?? null,
        address: address || null,
        municipio: data.municipio ?? null,
        uf: data.uf ?? null,
        cep: data.cep ?? null,
        natureza_juridica: data.natureza_juridica ?? null,
        porte: data.porte ?? null,
        capital_social: data.capital_social ?? null,
        pipeline_source: 'cnpj_br',
        registry: 'Receita Federal (CNPJ)',
        jurisdiction: 'BR',
      },
    });

  if (insertError) {
    if (insertError.code === '23505') {
      return 'skipped';
    }
    logger.error({ sourceId, error: insertError }, 'CNPJ BR insert failed');
    return 'error';
  }
  return 'inserted';
}

/**
 * Fetch CNPJ records for seed companies + any custom CNPJs.
 *
 * Unlike paginated fetchers, CNPJ uses per-entity lookups.
 * The seed list provides initial coverage of major Brazilian companies.
 */
export async function fetchCnpjBrCompanies(
  supabase: SupabaseClient,
  customCnpjs?: string[],
): Promise<FetchResult> {
  if (!(await isIngestionEnabled(supabase))) {
    logger.info('ENABLE_PUBLIC_RECORDS_INGESTION disabled — skipping CNPJ BR fetch');
    return { inserted: 0, skipped: 0, errors: 0 };
  }

  const cnpjsToFetch = customCnpjs ?? SEED_CNPJS;

  let totalInserted = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  logger.info({ count: cnpjsToFetch.length }, 'CNPJ BR fetch starting');

  for (const cnpj of cnpjsToFetch) {
    await delay(RATE_LIMIT_MS);
    const result = await fetchAndInsertCnpj(supabase, cnpj);
    if (result === 'inserted') totalInserted++;
    else if (result === 'skipped') totalSkipped++;
    else totalErrors++;
  }

  logger.info(
    { totalInserted, totalSkipped, totalErrors, total: cnpjsToFetch.length },
    'CNPJ BR fetch complete',
  );
  return { inserted: totalInserted, skipped: totalSkipped, errors: totalErrors };
}
