/**
 * EDGAR Form ADV parser tests — NPH-15 / SCRUM-727.
 *
 * Pure-function tests; no network. Fixtures match the shape of
 * `data.sec.gov/submissions/CIK{cik}.json` restricted to the fields the
 * parser consumes. If EDGAR ever changes the envelope shape, failures
 * here flag the drift before the cron job runs.
 */

import { describe, expect, it } from 'vitest';
import {
  FORM_ADV_TYPES,
  SIC_INVESTMENT_ADVICE,
  dedupeAdvisers,
  edgarSubmissionsUrl,
  isInvestmentAdviser,
  mostRecentAdvFiling,
  padCik,
  parseEdgarSubmission,
  registrationStatusFromLatestForm,
  type EdgarSubmissionEnvelope,
  type FormAdvAdviser,
} from './edgarFormAdvParser.js';

function envelope(over: Partial<EdgarSubmissionEnvelope> = {}): EdgarSubmissionEnvelope {
  return {
    cik: '1234567',
    name: 'Acme Investment Advisers LLC',
    sic: SIC_INVESTMENT_ADVICE,
    addresses: {
      business: { city: 'Boston', stateOrCountry: 'MA', stateOrCountryDescription: 'United States' },
    },
    filings: {
      recent: {
        form: ['ADV', '10-K', 'ADV/A'],
        filingDate: ['2026-01-15', '2025-12-01', '2026-03-10'],
        accessionNumber: ['0001-1', '0002-1', '0003-1'],
      },
    },
    ...over,
  };
}

describe('padCik', () => {
  it('zero-pads short CIKs to 10 digits', () => {
    expect(padCik('320193')).toBe('0000320193');
  });

  it('strips non-digit characters before padding', () => {
    expect(padCik('CIK-0000320193')).toBe('0000320193');
  });

  it('leaves already-10-digit CIKs unchanged', () => {
    expect(padCik('0001234567')).toBe('0001234567');
  });
});

describe('edgarSubmissionsUrl', () => {
  it('builds a canonical EDGAR browse-edgar URL with ADV form filter', () => {
    expect(edgarSubmissionsUrl('320193')).toBe(
      'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000320193&type=ADV&dateb=&owner=include&count=40',
    );
  });
});

describe('isInvestmentAdviser', () => {
  it('is true when SIC is Investment Advice', () => {
    expect(isInvestmentAdviser(envelope())).toBe(true);
  });

  it('is true when any ADV-family form has been filed (even without SIC)', () => {
    expect(
      isInvestmentAdviser(
        envelope({
          sic: '9999',
          filings: {
            recent: {
              form: ['10-K', 'ADV-W'],
              filingDate: ['2025-01-01', '2026-01-01'],
              accessionNumber: ['a', 'b'],
            },
          },
        }),
      ),
    ).toBe(true);
  });

  it('is false when neither SIC nor ADV forms match', () => {
    expect(
      isInvestmentAdviser(
        envelope({
          sic: '1234',
          filings: {
            recent: {
              form: ['10-K'],
              filingDate: ['2025-01-01'],
              accessionNumber: ['a'],
            },
          },
        }),
      ),
    ).toBe(false);
  });
});

describe('mostRecentAdvFiling', () => {
  it('returns the latest ADV-family filing by filingDate', () => {
    const got = mostRecentAdvFiling(envelope());
    expect(got).toEqual({ form: 'ADV/A', filingDate: '2026-03-10', accessionNumber: '0003-1' });
  });

  it('returns null when no ADV filings exist', () => {
    expect(
      mostRecentAdvFiling(
        envelope({
          filings: {
            recent: {
              form: ['10-K', '10-Q'],
              filingDate: ['2025-01-01', '2025-04-01'],
              accessionNumber: ['a', 'b'],
            },
          },
        }),
      ),
    ).toBeNull();
  });

  it('returns null when envelope has no filings', () => {
    expect(mostRecentAdvFiling(envelope({ filings: undefined }))).toBeNull();
  });
});

describe('registrationStatusFromLatestForm', () => {
  it('maps ADV-W to Terminated', () => {
    expect(registrationStatusFromLatestForm('ADV-W')).toBe('Terminated');
  });

  it('maps ADV-E and ADV-NR to Pending', () => {
    expect(registrationStatusFromLatestForm('ADV-E')).toBe('Pending');
    expect(registrationStatusFromLatestForm('ADV-NR')).toBe('Pending');
  });

  it('maps ADV and ADV/A to Approved', () => {
    expect(registrationStatusFromLatestForm('ADV')).toBe('Approved');
    expect(registrationStatusFromLatestForm('ADV/A')).toBe('Approved');
  });

  it('covers every form type in FORM_ADV_TYPES', () => {
    for (const f of FORM_ADV_TYPES) {
      expect(() => registrationStatusFromLatestForm(f)).not.toThrow();
    }
  });
});

describe('parseEdgarSubmission', () => {
  it('returns null for non-adviser submissions', () => {
    expect(
      parseEdgarSubmission(
        envelope({
          sic: '3711',
          filings: {
            recent: { form: ['10-K'], filingDate: ['2026-01-01'], accessionNumber: ['a'] },
          },
        }),
      ),
    ).toBeNull();
  });

  it('parses a full adviser submission end-to-end', () => {
    const got = parseEdgarSubmission(envelope());
    expect(got).toMatchObject<Partial<FormAdvAdviser>>({
      organizationName: 'Acme Investment Advisers LLC',
      city: 'Boston',
      state: 'MA',
      country: 'United States',
      registrationStatus: 'Approved',
      lastFilingDate: '2026-03-10',
    });
    expect(got?.crdNumber).toBe('0001234567');
    expect(got?.sourceUrl).toContain('CIK=0001234567');
  });

  it('prefers an embedded CRD number over padded CIK when present', () => {
    const got = parseEdgarSubmission(envelope({ crdNumber: 'CRD-987654' }));
    expect(got?.crdNumber).toBe('CRD-987654');
  });

  it('sets registrationStatus=Unknown when no ADV filing is present but SIC matches', () => {
    const got = parseEdgarSubmission(
      envelope({
        filings: {
          recent: {
            form: ['10-K'],
            filingDate: ['2025-01-01'],
            accessionNumber: ['a'],
          },
        },
      }),
    );
    expect(got?.registrationStatus).toBe('Unknown');
    expect(got?.lastFilingDate).toBeUndefined();
  });
});

describe('dedupeAdvisers', () => {
  it('keeps the record with the most recent filing when duplicates exist', () => {
    const older: FormAdvAdviser = {
      crdNumber: 'crd-1',
      organizationName: 'Older Record',
      registrationStatus: 'Approved',
      lastFilingDate: '2025-01-01',
      sourceUrl: 'https://example/1',
    };
    const newer: FormAdvAdviser = {
      crdNumber: 'crd-1',
      organizationName: 'Newer Record',
      registrationStatus: 'Terminated',
      lastFilingDate: '2026-02-01',
      sourceUrl: 'https://example/1',
    };
    const got = dedupeAdvisers([older, newer]);
    expect(got).toHaveLength(1);
    expect(got[0].organizationName).toBe('Newer Record');
  });

  it('preserves distinct CRDs', () => {
    const a: FormAdvAdviser = {
      crdNumber: 'a',
      organizationName: 'A',
      registrationStatus: 'Approved',
      sourceUrl: 'https://example/a',
    };
    const b: FormAdvAdviser = {
      crdNumber: 'b',
      organizationName: 'B',
      registrationStatus: 'Approved',
      sourceUrl: 'https://example/b',
    };
    expect(dedupeAdvisers([a, b])).toHaveLength(2);
  });

  it('returns an empty array for an empty input', () => {
    expect(dedupeAdvisers([])).toEqual([]);
  });
});
