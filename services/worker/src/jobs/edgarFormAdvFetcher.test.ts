/**
 * EDGAR Form ADV fetcher tests — NPH-15 / SCRUM-727.
 *
 * Network + DB are injected, so the tests stay hermetic. We focus on:
 *   1) the switchboard gate,
 *   2) ticker-file → SIC filter → envelope iteration,
 *   3) dedupe + insert mapping to `public_records`.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../config.js', () => ({
  config: { edgarUserAgent: 'Arkova test@example.com' },
}));

import type { EdgarSubmissionEnvelope } from './edgarFormAdvParser.js';
import {
  fetchEdgarFormAdvAdvisers,
  type EdgarFormAdvFetcherDeps,
} from './edgarFormAdvFetcher.js';

type Insert = { source: string; source_id: string; metadata: Record<string, unknown> };

function makeDeps(overrides: Partial<EdgarFormAdvFetcherDeps> = {}): {
  deps: EdgarFormAdvFetcherDeps;
  inserts: Insert[];
  existing: Set<string>;
} {
  const inserts: Insert[] = [];
  const existing = new Set<string>();

  const deps: EdgarFormAdvFetcherDeps = {
    getFlag: async () => true,
    listInvestmentAdviserCiks: async () => ['320193', '789019'],
    fetchSubmissions: async (cik: string): Promise<EdgarSubmissionEnvelope | null> => {
      if (cik === '320193') {
        return {
          cik: '320193',
          name: 'Acme Advisers LLC',
          sic: '6282',
          addresses: {
            business: { city: 'Boston', stateOrCountry: 'MA' },
          },
          filings: {
            recent: {
              form: ['ADV', 'ADV/A'],
              filingDate: ['2026-01-15', '2026-02-20'],
              accessionNumber: ['0001-1', '0002-2'],
            },
          },
        };
      }
      if (cik === '789019') {
        return {
          cik: '789019',
          name: 'Bedrock Capital Management',
          sic: '6282',
          filings: {
            recent: {
              form: ['ADV-W'],
              filingDate: ['2025-09-01'],
              accessionNumber: ['0003-3'],
            },
          },
        };
      }
      return null;
    },
    recordExists: async (sourceId: string) => existing.has(sourceId),
    insertRecord: async (row) => {
      inserts.push(row);
    },
    ...overrides,
  };

  return { deps, inserts, existing };
}

describe('fetchEdgarFormAdvAdvisers', () => {
  it('no-ops and returns zeros when the switchboard flag is disabled', async () => {
    const { deps } = makeDeps({ getFlag: async () => false });
    const listSpy = vi.fn();
    deps.listInvestmentAdviserCiks = listSpy;

    const result = await fetchEdgarFormAdvAdvisers(deps);

    expect(result).toEqual({ inserted: 0, skipped: 0, errors: 0, pagesProcessed: 0 });
    expect(listSpy).not.toHaveBeenCalled();
  });

  it('fetches each CIK, maps via parser, and inserts new advisers', async () => {
    const { deps, inserts } = makeDeps();

    const result = await fetchEdgarFormAdvAdvisers(deps);

    expect(result.inserted).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);
    expect(inserts).toHaveLength(2);
    expect(inserts[0].source).toBe('edgar_form_adv');
    expect(inserts[0].source_id).toBe('edgar-form-adv-0000320193');
    expect(inserts[0].metadata.registration_status).toBe('Approved');
    expect(inserts[1].metadata.registration_status).toBe('Terminated');
  });

  it('skips existing records without calling insertRecord', async () => {
    const { deps, inserts, existing } = makeDeps();
    existing.add('edgar-form-adv-0000320193');

    const result = await fetchEdgarFormAdvAdvisers(deps);

    expect(result.inserted).toBe(1);
    expect(result.skipped).toBe(1);
    expect(inserts).toHaveLength(1);
  });

  it('counts and swallows per-envelope errors so a single bad CIK cannot tank the batch', async () => {
    const { deps, inserts } = makeDeps({
      fetchSubmissions: async (cik) => {
        if (cik === '320193') throw new Error('network');
        return {
          cik: '789019',
          name: 'Bedrock Capital Management',
          sic: '6282',
          filings: { recent: { form: ['ADV'], filingDate: ['2026-02-01'], accessionNumber: ['x'] } },
        };
      },
    });

    const result = await fetchEdgarFormAdvAdvisers(deps);

    expect(result.errors).toBe(1);
    expect(result.inserted).toBe(1);
    expect(inserts).toHaveLength(1);
  });

  it('skips envelopes that the parser classifies as non-advisers (no insert)', async () => {
    const { deps, inserts } = makeDeps({
      listInvestmentAdviserCiks: async () => ['111'],
      fetchSubmissions: async () => ({
        cik: '111',
        name: 'Widget Co',
        sic: '3990',
        filings: { recent: { form: ['10-K'], filingDate: ['2026-01-01'], accessionNumber: ['x'] } },
      }),
    });

    const result = await fetchEdgarFormAdvAdvisers(deps);

    expect(result.inserted).toBe(0);
    expect(result.skipped).toBe(1);
    expect(inserts).toHaveLength(0);
  });

  it('respects maxRecords to cap work per run', async () => {
    const { deps, inserts } = makeDeps({
      listInvestmentAdviserCiks: async () => ['320193', '789019', '999999'],
    });

    const result = await fetchEdgarFormAdvAdvisers(deps, { maxRecords: 1 });

    expect(result.inserted).toBe(1);
    expect(inserts).toHaveLength(1);
  });
});
