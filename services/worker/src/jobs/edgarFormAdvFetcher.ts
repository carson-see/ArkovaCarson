/**
 * EDGAR Form ADV Fetcher — NPH-15 / SCRUM-727.
 *
 * Companion to `edgarFormAdvParser.ts`. Walks EDGAR's company-search by
 * SIC 6282 (Investment Advice), pulls each firm's submissions envelope,
 * feeds it through the pure parser, and writes normalised adviser
 * records into `public_records` with `source='edgar_form_adv'`.
 *
 * Why this exists: the IAPD API (`api.adviserinfo.sec.gov`) has been
 * 403-ing since 2026-04-14 (WAF). EDGAR is not behind the same WAF, so
 * we switched to Form ADV filings as the canonical adviser surface.
 *
 * Dependencies are injected so the fetcher is trivially testable —
 * network + DB shims are wired in `secIapdCron` / `cron.ts`, tests pass
 * fakes.
 */

import { createHash } from 'node:crypto';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  SIC_INVESTMENT_ADVICE,
  dedupeAdvisers,
  edgarSubmissionsUrl,
  padCik,
  parseEdgarSubmission,
  type EdgarSubmissionEnvelope,
  type FormAdvAdviser,
} from './edgarFormAdvParser.js';

/** EDGAR fair-access policy: 10 req/s; keep margin. */
const EDGAR_RATE_LIMIT_MS = 150;

/** Default cap per run — EDGAR SIC-6282 surface is ~15-20k firms. */
const DEFAULT_MAX_RECORDS = 2000;

/** EDGAR company-tickers-exchange endpoint exposes SIC per firm. */
const EDGAR_COMPANY_TICKERS_URL = 'https://www.sec.gov/files/company_tickers_exchange.json';

const SOURCE_NAME = 'edgar_form_adv';

export interface AdviserInsertRow {
  source: string;
  source_id: string;
  source_url: string;
  record_type: string;
  title: string;
  content_hash: string;
  metadata: Record<string, unknown>;
}

export interface EdgarFormAdvFetcherDeps {
  getFlag: () => Promise<boolean>;
  listInvestmentAdviserCiks: () => Promise<string[]>;
  fetchSubmissions: (cik: string) => Promise<EdgarSubmissionEnvelope | null>;
  recordExists: (sourceId: string) => Promise<boolean>;
  insertRecord: (row: AdviserInsertRow) => Promise<void>;
}

export interface FetchOptions {
  maxRecords?: number;
}

export interface FetchResult {
  inserted: number;
  skipped: number;
  errors: number;
  pagesProcessed: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

function sourceIdFor(adviser: FormAdvAdviser): string {
  return `edgar-form-adv-${adviser.crdNumber}`;
}

function buildInsertRow(adviser: FormAdvAdviser): AdviserInsertRow {
  const content = JSON.stringify({
    crd: adviser.crdNumber,
    name: adviser.organizationName,
    status: adviser.registrationStatus,
    lastFilingDate: adviser.lastFilingDate ?? null,
  });

  return {
    source: SOURCE_NAME,
    source_id: sourceIdFor(adviser),
    source_url: adviser.sourceUrl,
    record_type: 'investment_adviser',
    title: `${adviser.organizationName} — SEC Form ADV CRD/CIK #${adviser.crdNumber} (${adviser.registrationStatus})`,
    content_hash: computeContentHash(content),
    metadata: {
      crd_number: adviser.crdNumber,
      sec_number: adviser.secNumber ?? null,
      organization_name: adviser.organizationName,
      city: adviser.city ?? null,
      state: adviser.state ?? null,
      country: adviser.country ?? null,
      registration_status: adviser.registrationStatus,
      last_filing_date: adviser.lastFilingDate ?? null,
      pipeline_source: SOURCE_NAME,
      registry: 'SEC EDGAR Form ADV',
      jurisdiction: 'US',
      license_type: 'investment_adviser',
    },
  };
}

/**
 * Pure orchestrator — injectable dependencies. Used by both the Express
 * cron handler (via `makeSupabaseDeps`) and by tests (via fakes).
 */
export async function fetchEdgarFormAdvAdvisers(
  deps: EdgarFormAdvFetcherDeps,
  options: FetchOptions = {},
): Promise<FetchResult> {
  const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;

  const enabled = await deps.getFlag();
  if (!enabled) {
    logger.info('ENABLE_PUBLIC_RECORDS_INGESTION is disabled — skipping EDGAR Form ADV fetch');
    return { inserted: 0, skipped: 0, errors: 0, pagesProcessed: 0 };
  }

  const ciks = await deps.listInvestmentAdviserCiks();
  logger.info({ candidateCount: ciks.length }, 'EDGAR Form ADV: CIK candidates resolved');

  const advisers: FormAdvAdviser[] = [];
  let errors = 0;
  let pagesProcessed = 0;

  for (const cik of ciks) {
    if (advisers.length >= maxRecords) break;
    pagesProcessed++;
    try {
      const envelope = await deps.fetchSubmissions(cik);
      if (!envelope) continue;
      const adviser = parseEdgarSubmission(envelope);
      if (!adviser) continue;
      advisers.push(adviser);
    } catch (error) {
      errors++;
      logger.warn({ cik, error }, 'EDGAR Form ADV: submission fetch failed');
    }
  }

  const unique = dedupeAdvisers(advisers);
  const nonAdviserSkips = pagesProcessed - advisers.length - errors;

  let inserted = 0;
  let skipped = Math.max(0, nonAdviserSkips);

  for (const adviser of unique) {
    const sourceId = sourceIdFor(adviser);
    try {
      if (await deps.recordExists(sourceId)) {
        skipped++;
        continue;
      }
      await deps.insertRecord(buildInsertRow(adviser));
      inserted++;
    } catch (error) {
      errors++;
      logger.error({ sourceId, error }, 'EDGAR Form ADV: insert failed');
    }
  }

  logger.info({ inserted, skipped, errors, pagesProcessed }, 'EDGAR Form ADV fetch complete');
  return { inserted, skipped, errors, pagesProcessed };
}

/** EDGAR ticker file row shape (narrow — we only read SIC + CIK). */
interface TickerFileRow {
  cik_str?: number | string;
  cik?: number | string;
  sic?: number | string;
}

interface TickerFileEnvelope {
  fields?: string[];
  data?: unknown[][];
}

function getEdgarUserAgent(): string {
  return config.edgarUserAgent || 'Arkova contact@arkova.ai';
}

async function fetchJson<T>(url: string): Promise<T | null> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': getEdgarUserAgent(),
      Accept: 'application/json',
    },
  });
  if (!response.ok) {
    logger.warn({ url, status: response.status }, 'EDGAR Form ADV: upstream non-OK');
    return null;
  }
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Walk the public company_tickers_exchange.json file, return CIKs whose
 * SIC matches Investment Advice (6282). EDGAR publishes this nightly;
 * it's a stable, WAF-free feed.
 */
export async function defaultListInvestmentAdviserCiks(): Promise<string[]> {
  const envelope = await fetchJson<TickerFileEnvelope | TickerFileRow[]>(EDGAR_COMPANY_TICKERS_URL);
  if (!envelope) return [];

  if (Array.isArray(envelope)) {
    return envelope
      .filter((row) => String(row.sic ?? '') === SIC_INVESTMENT_ADVICE)
      .map((row) => String(row.cik_str ?? row.cik ?? ''))
      .filter(Boolean);
  }

  const fields = envelope.fields ?? [];
  const data = envelope.data ?? [];
  const cikIdx = fields.indexOf('cik');
  const sicIdx = fields.indexOf('sic');
  if (cikIdx < 0) return [];

  return data
    .filter((row) => sicIdx < 0 || String(row[sicIdx] ?? '') === SIC_INVESTMENT_ADVICE)
    .map((row) => String(row[cikIdx] ?? ''))
    .filter(Boolean);
}

async function defaultFetchSubmissions(cik: string): Promise<EdgarSubmissionEnvelope | null> {
  const url = `https://data.sec.gov/submissions/CIK${padCik(cik)}.json`;
  await delay(EDGAR_RATE_LIMIT_MS);
  const envelope = await fetchJson<EdgarSubmissionEnvelope>(url);
  if (!envelope) return null;
  return { ...envelope, cik };
}

/**
 * Build live Supabase-backed deps for the cron handler. Not called from
 * tests — tests inject fakes directly.
 */
export function makeSupabaseDeps(supabase: SupabaseClient): EdgarFormAdvFetcherDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabase as any;
  return {
    getFlag: async () => {
      const { data } = await supabase.rpc('get_flag', { p_flag_key: 'ENABLE_PUBLIC_RECORDS_INGESTION' });
      return Boolean(data);
    },
    listInvestmentAdviserCiks: defaultListInvestmentAdviserCiks,
    fetchSubmissions: defaultFetchSubmissions,
    recordExists: async (sourceId) => {
      const { data } = await db
        .from('public_records')
        .select('id')
        .eq('source', SOURCE_NAME)
        .eq('source_id', sourceId)
        .limit(1);
      return Array.isArray(data) && data.length > 0;
    },
    insertRecord: async (row) => {
      const { error } = await db.from('public_records').insert(row);
      if (error && error.code !== '23505') throw error;
    },
  };
}

/** Convenience wrapper used by the cron route. */
export async function fetchEdgarFormAdv(
  supabase: SupabaseClient,
  options: FetchOptions = {},
): Promise<FetchResult> {
  return fetchEdgarFormAdvAdvisers(makeSupabaseDeps(supabase), options);
}

/** Canonical landing-page URL for external linking (used in audit trails). */
export function canonicalAdviserUrl(cik: string): string {
  return edgarSubmissionsUrl(cik);
}
