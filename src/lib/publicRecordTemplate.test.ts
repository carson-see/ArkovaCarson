/**
 * publicRecordTemplate.test.ts (SCRUM-5105)
 */

import { describe, it, expect } from 'vitest';
import { projectPublicRecordToTemplate, formatAuthorsDisplay } from './publicRecordTemplate';
import openalexFixture from './__fixtures__/public-record-openalex.json';
import registrySourceFixtures from './__fixtures__/public-record-sources.json';
import expectedProjections from './__fixtures__/public-record-projections.expected.json';

const FORBIDDEN_VALUE_PATTERN = /Dr\. Jane Smith|John Q\. Broker|New York, NY|Maria Garcia|Riverside State University|500 University Ave|Helping Hands Charity Ltd|10 Collins St|Roberts, C\.J\.|The Court held that|Summit Capital Advisers LLC|Harborview Wealth Management|Lion City Trading Pte Ltd|Comercio Exemplo LTDA|Rua Exemplo 123|Sunrise Medical Clinic|88 Orchard Rd|Dr\. Tan Wei Ming/;

const FORBIDDEN_KEY_PATTERN = /email|phone|ssn|dob|address/i;

type SourceFixture = { title: string | null; source_id: string; metadata: Record<string, unknown> };

/** Type-safe accessor for a row in the shared public-record-sources.json fixture (skips '_comment'). */
function fixtureFor(source: string): SourceFixture {
  const raw = (registrySourceFixtures as Record<string, unknown>)[source] as SourceFixture | undefined;
  if (!raw) throw new Error(`no fixture for source ${source}`);
  return raw;
}

describe('projectPublicRecordToTemplate — openalex', () => {
  it('maps the full fixture onto template + extras keys', () => {
    const result = projectPublicRecordToTemplate('openalex', openalexFixture);

    expect(result.fieldOfStudy).toBe(openalexFixture.title);
    expect(result.issuerName).toBe('Journal of Open Machine Learning Research');
    expect(result.issuedDate).toBe('2026-02-14');
    expect(result.licenseNumber).toBe('10.1234/arkova.example.5105');
    expect(result.authors).toEqual([
      { name: 'Jane Q. Researcher', orcid: '0000-0001-2345-6789' },
      { name: 'Alex Chen' },
    ]);
    expect(result.concepts).toEqual([
      'Machine learning',
      'Natural language processing',
      'Neural network',
      'Computer science',
      'Scaling law',
    ]);
    expect(result.publicationYear).toBe(2026);
    expect(result.citedByCount).toBe(482);
    expect(result.isRetracted).toBe(false);
    expect(result.isOpenAccess).toBe(true);
  });

  it('never emits the abstract, or any raw nested object other than the authors {name, orcid?} shape', () => {
    const result = projectPublicRecordToTemplate('openalex', openalexFixture);
    expect(result.abstract).toBeUndefined();
    expect(result.description).toBeUndefined();
    expect(result.summary).toBeUndefined();
    for (const [key, value] of Object.entries(result)) {
      if (key === 'authors') {
        expect(Array.isArray(value)).toBe(true);
        for (const entry of value as unknown[]) {
          expect(typeof entry).toBe('object');
          expect(typeof (entry as { name: unknown }).name).toBe('string');
          const keys = Object.keys(entry as object);
          for (const k of keys) expect(['name', 'orcid']).toContain(k);
        }
        continue;
      }
      expect(typeof value === 'object' ? Array.isArray(value) : true).toBe(true);
      if (Array.isArray(value)) {
        for (const entry of value) expect(typeof entry).toBe('string');
      } else {
        expect(['string', 'number', 'boolean']).toContain(typeof value);
      }
    }
  });

  it('never emits a key that looks like a forbidden PII field', () => {
    const result = projectPublicRecordToTemplate('openalex', openalexFixture);
    for (const key of Object.keys(result)) {
      expect(FORBIDDEN_KEY_PATTERN.test(key)).toBe(false);
    }
  });

  it('does not write authors into recipientIdentifier', () => {
    const result = projectPublicRecordToTemplate('openalex', openalexFixture);
    expect(result.recipientIdentifier).toBeUndefined();
    expect(result.authors).toBeDefined();
  });

  it('handles missing fields gracefully', () => {
    const result = projectPublicRecordToTemplate('openalex', { title: null, metadata: {} });
    expect(result).toEqual({});
  });

  it('handles a partial record with only some fields present', () => {
    const result = projectPublicRecordToTemplate('openalex', {
      title: 'Solo Title',
      metadata: { doi: '10.1/no-prefix' },
    });
    expect(result).toEqual({ fieldOfStudy: 'Solo Title', licenseNumber: '10.1/no-prefix' });
  });

  it('strips a leading https://doi.org/ prefix from the DOI', () => {
    const result = projectPublicRecordToTemplate('openalex', {
      title: null,
      metadata: { doi: 'https://doi.org/10.5/example' },
    });
    expect(result.licenseNumber).toBe('10.5/example');
  });

  it('leaves a bare DOI (no prefix) untouched', () => {
    const result = projectPublicRecordToTemplate('openalex', {
      title: null,
      metadata: { doi: '10.5/example' },
    });
    expect(result.licenseNumber).toBe('10.5/example');
  });

  it('normalises a journal object with display_name', () => {
    const result = projectPublicRecordToTemplate('openalex', {
      title: null,
      metadata: { journal: { display_name: 'Object Journal' } },
    });
    expect(result.issuerName).toBe('Object Journal');
  });

  it('normalises a journal object with name', () => {
    const result = projectPublicRecordToTemplate('openalex', {
      title: null,
      metadata: { journal: { name: 'Name Journal' } },
    });
    expect(result.issuerName).toBe('Name Journal');
  });

  it('caps authors at 20 entries', () => {
    const authors = Array.from({ length: 30 }, (_, i) => ({ name: `Author ${i}` }));
    const result = projectPublicRecordToTemplate('openalex', { title: null, metadata: { authors } });
    const projected = result.authors as { name: string; orcid?: string }[];
    expect(projected).toHaveLength(20);
    expect(projected[0]).toEqual({ name: 'Author 0' });
    expect(projected[19]).toEqual({ name: 'Author 19' });
  });

  it('caps concepts at 10 entries', () => {
    const concepts = Array.from({ length: 15 }, (_, i) => `Concept ${i}`);
    const result = projectPublicRecordToTemplate('openalex', { title: null, metadata: { concepts } });
    expect(result.concepts).toHaveLength(10);
  });

  it('handles authors as bare strings (no orcid key when there is none)', () => {
    const result = projectPublicRecordToTemplate('openalex', {
      title: null,
      metadata: { authors: ['Bare String Author'] },
    });
    expect(result.authors).toEqual([{ name: 'Bare String Author' }]);
  });

  it('handles the raw OpenAlex authorship shape { author: { display_name } }', () => {
    const result = projectPublicRecordToTemplate('openalex', {
      title: null,
      metadata: { authors: [{ author: { display_name: 'Nested Author' } }] },
    });
    expect(result.authors).toEqual([{ name: 'Nested Author' }]);
  });

  it('strips a leading https://orcid.org/ prefix from a nested authorship orcid', () => {
    const result = projectPublicRecordToTemplate('openalex', {
      title: null,
      metadata: { authors: [{ author: { display_name: 'Nested Author', orcid: 'https://orcid.org/0000-0002-0000-0000' } }] },
    });
    expect(result.authors).toEqual([{ name: 'Nested Author', orcid: '0000-0002-0000-0000' }]);
  });

  it('drops author entries that cannot be normalised to a name', () => {
    const result = projectPublicRecordToTemplate('openalex', {
      title: null,
      metadata: { authors: [{ orcid: '0000' }, 'Valid Name', 42, null] },
    });
    expect(result.authors).toEqual([{ name: 'Valid Name' }]);
  });

  it('omits the orcid key entirely when the source orcid is null/blank', () => {
    const result = projectPublicRecordToTemplate('openalex', {
      title: null,
      metadata: { authors: [{ name: 'No Orcid Author', orcid: null }, { name: 'Blank Orcid Author', orcid: '   ' }] },
    });
    expect(result.authors).toEqual([{ name: 'No Orcid Author' }, { name: 'Blank Orcid Author' }]);
    for (const author of result.authors as { name: string; orcid?: string }[]) {
      expect(Object.keys(author)).not.toContain('orcid');
    }
  });

  it('caps a string field at 500 chars', () => {
    const longJournal = 'x'.repeat(600);
    const result = projectPublicRecordToTemplate('openalex', {
      title: null,
      metadata: { journal: longJournal },
    });
    expect((result.issuerName as string).length).toBe(500);
  });

  it('trims whitespace and drops blank strings', () => {
    const result = projectPublicRecordToTemplate('openalex', {
      title: '   ',
      metadata: { journal: '  ', doi: '  10.1/spaced  ' },
    });
    expect(result.fieldOfStudy).toBeUndefined();
    expect(result.issuerName).toBeUndefined();
    expect(result.licenseNumber).toBe('10.1/spaced');
  });
});

describe('projectPublicRecordToTemplate — edgar', () => {
  it('maps document-level fields onto template + extras keys', () => {
    const result = projectPublicRecordToTemplate('edgar', {
      title: 'Example Corp — 10-K (2026-01-15)',
      source_id: '0000320193-26-000015',
      metadata: {
        form_type: '10-K',
        entity_name: 'Example Corp',
        filing_date: '2026-01-15',
        period_of_report: '2025-12-31',
        tickers: ['EXCO'],
        ciks: ['0000320193'],
        display_names: ['EXAMPLE CORP (EXCO) (CIK 0000320193)'],
        file_description: '10-K Annual Report',
      },
    });

    expect(result.issuerName).toBe('Example Corp');
    expect(result.issuedDate).toBe('2026-01-15');
    // licenseNumber is the record's OWN identifier — the accession number
    // (source_id), never a CIK (the FILER's id, shared across every filing
    // that company makes).
    expect(result.licenseNumber).toBe('0000320193-26-000015');
    expect(result.ciks).toEqual(['0000320193']);
    expect(result.fieldOfStudy).toBe('10-K');
    expect(result.periodOfReport).toBe('2025-12-31');
    expect(result.tickers).toEqual(['EXCO']);
    expect(result.fileDescription).toBe('10-K Annual Report');
    expect(result).not.toHaveProperty('formType'); // form_type surfaces as fieldOfStudy, not a duplicate extra
  });

  it('never emits display_names (may carry an individual filer name on Form 3/4/5)', () => {
    const result = projectPublicRecordToTemplate('edgar', {
      title: null,
      metadata: { entity_name: 'Example Corp', display_names: ['JANE DOE (Reporting Person)'] },
    });
    expect(Object.keys(result)).not.toContain('display_names');
    expect(JSON.stringify(result)).not.toContain('JANE DOE');
  });

  it('falls back to primary_doc_description when file_description is absent', () => {
    const result = projectPublicRecordToTemplate('edgar', {
      title: null,
      metadata: { primary_doc_description: 'Fallback description' },
    });
    expect(result.fileDescription).toBe('Fallback description');
  });

  it('uses primary_document when present', () => {
    const result = projectPublicRecordToTemplate('edgar', {
      title: null,
      metadata: { primary_document: 'exco-10k.htm' },
    });
    expect(result.primaryDocument).toBe('exco-10k.htm');
  });

  it('handles missing fields gracefully', () => {
    const result = projectPublicRecordToTemplate('edgar', { title: null, metadata: {} });
    expect(result).toEqual({});
  });
});

describe('projectPublicRecordToTemplate — federal_register', () => {
  it('maps document-level fields onto template + extras keys', () => {
    const result = projectPublicRecordToTemplate('federal_register', {
      title: 'National Emission Standards for Hazardous Air Pollutants',
      metadata: {
        document_number: '2026-01234',
        type: 'Rule',
        publication_date: '2026-03-01',
        agencies: ['Environmental Protection Agency'],
        citation: '91 FR 12345',
        abstract: 'This rule amends national emission standards.',
        pdf_url: 'https://www.federalregister.gov/documents/example.pdf',
      },
    });

    expect(result.fieldOfStudy).toBe('National Emission Standards for Hazardous Air Pollutants');
    expect(result.licenseNumber).toBe('2026-01234');
    expect(result.issuedDate).toBe('2026-03-01');
    expect(result.issuerName).toBe('Environmental Protection Agency');
    expect(result.agencies).toEqual(['Environmental Protection Agency']);
    expect(result.documentType).toBe('Rule');
    expect(result.citation).toBe('91 FR 12345');
    expect(result.pdfUrl).toBe('https://www.federalregister.gov/documents/example.pdf');
  });

  it('never emits the abstract', () => {
    const result = projectPublicRecordToTemplate('federal_register', {
      title: null,
      metadata: { abstract: 'Should never appear anywhere in the output.' },
    });
    expect(JSON.stringify(result)).not.toContain('Should never appear');
    expect(Object.keys(result)).not.toContain('abstract');
  });

  it('handles missing fields gracefully', () => {
    const result = projectPublicRecordToTemplate('federal_register', { title: null, metadata: {} });
    expect(result).toEqual({});
  });
});

describe('projectPublicRecordToTemplate — openstates', () => {
  it('maps document-level fields onto template + extras keys', () => {
    const result = projectPublicRecordToTemplate('openstates', {
      title: 'HB123: An act relating to example matters (California 2025-2026)',
      metadata: {
        bill_id: 'ocd-bill/abc123',
        identifier: 'HB123',
        session: '2025-2026',
        state: 'CA',
        state_name: 'California',
        classification: ['bill'],
        subjects: ['Education'],
        primary_sponsors: ['Jane Legislator'],
        latest_action_date: '2026-02-01',
        latest_action: 'Referred to committee',
        abstract: 'An act relating to example matters.',
        chamber: 'House',
        jurisdiction: 'US-CA',
      },
    });

    expect(result.licenseNumber).toBe('HB123');
    // issuerName is the issuing legislative body (chamber), not the state
    // name — "chamber" is explicitly named as a valid issuerName source
    // alongside registry/court/agency/journal.
    expect(result.issuerName).toBe('House');
    expect(result.issuedDate).toBe('2026-02-01');
    expect(result.session).toBe('2025-2026');
    expect(result.classification).toEqual(['bill']);
    expect(result.subjects).toEqual(['Education']);
    expect(result.state).toBe('CA');
    expect(result.stateName).toBe('California');
    expect(result.jurisdiction).toBe('US-CA');
    expect(result.latestAction).toBe('Referred to committee');
    expect(result.fieldOfStudy).toBeUndefined();
  });

  it('never emits sponsor names', () => {
    const result = projectPublicRecordToTemplate('openstates', {
      title: null,
      metadata: { primary_sponsors: ['Jane Legislator', 'John Sponsor'] },
    });
    expect(Object.keys(result)).not.toContain('primary_sponsors');
    expect(JSON.stringify(result)).not.toContain('Jane Legislator');
    expect(JSON.stringify(result)).not.toContain('John Sponsor');
  });

  it('never emits the abstract', () => {
    const result = projectPublicRecordToTemplate('openstates', {
      title: null,
      metadata: { abstract: 'Should never appear anywhere in the output.' },
    });
    expect(JSON.stringify(result)).not.toContain('Should never appear');
  });

  it('handles missing fields gracefully', () => {
    const result = projectPublicRecordToTemplate('openstates', { title: null, metadata: {} });
    expect(result).toEqual({});
  });
});

describe('projectPublicRecordToTemplate — unknown/unsupported sources', () => {
  // npi/finra/calbar/acnc/dapip/uspto/courtlistener/edgar_form_adv/
  // sec_adv_bulk/sec_iapd/acra_sg/cnpj_br/australia_law/australia_caselaw/
  // kenya_law/kenya_caselaw/moh_sg are now implemented — see the dedicated
  // "registry sources" describe block below. Only genuinely unimplemented
  // sources belong in this list.
  it.each([
    'sam_gov',
    'something_totally_unknown',
  ])('returns {} for %s (zero prod rows at time of writing, or genuinely unknown)', (source) => {
    const result = projectPublicRecordToTemplate(source, {
      title: 'Some Title',
      metadata: { name: 'Should never leak', ssn: '000-00-0000' },
    });
    expect(result).toEqual({});
  });
});

describe('projectPublicRecordToTemplate — global invariants across all shipped sources', () => {
  const cases: Array<[string, unknown]> = [
    ['openalex', openalexFixture],
    ['edgar', { title: 't', metadata: { entity_name: 'e', display_names: ['Individual Name'] } }],
    ['federal_register', { title: 't', metadata: { agencies: ['Agency'] } }],
    ['openstates', { title: 't', metadata: { state_name: 'CA', primary_sponsors: ['Individual Name'] } }],
  ];

  it.each(cases)('never emits a forbidden key for %s', (source, record) => {
    const result = projectPublicRecordToTemplate(source, record as { title: string | null; metadata: Record<string, unknown> });
    for (const key of Object.keys(result)) {
      expect(FORBIDDEN_KEY_PATTERN.test(key)).toBe(false);
      expect(key).not.toBe('abstract');
      expect(key).not.toBe('description');
      expect(key).not.toBe('summary');
    }
  });

  it.each(cases)('every value is string | number | boolean | string[] | authors-object[] for %s', (source, record) => {
    const result = projectPublicRecordToTemplate(source, record as { title: string | null; metadata: Record<string, unknown> });
    for (const [key, value] of Object.entries(result)) {
      if (key === 'authors') {
        expect(Array.isArray(value)).toBe(true);
        for (const entry of value as unknown[]) {
          expect(typeof (entry as { name: unknown }).name).toBe('string');
        }
        continue;
      }
      if (Array.isArray(value)) {
        for (const entry of value) expect(typeof entry).toBe('string');
      } else {
        expect(['string', 'number', 'boolean']).toContain(typeof value);
      }
    }
  });
});

describe('formatAuthorsDisplay', () => {
  it('joins names with ", "', () => {
    expect(formatAuthorsDisplay([{ name: 'Jane Q. Researcher' }, { name: 'Alex Chen' }])).toBe('Jane Q. Researcher, Alex Chen');
  });

  it('shows "+N more" past the first 10', () => {
    const authors = Array.from({ length: 13 }, (_, i) => ({ name: `Author ${i}` }));
    const result = formatAuthorsDisplay(authors);
    expect(result).toBe(
      'Author 0, Author 1, Author 2, Author 3, Author 4, Author 5, Author 6, Author 7, Author 8, Author 9 +3 more',
    );
  });

  it('does not append "+N more" when there are 10 or fewer', () => {
    const authors = Array.from({ length: 10 }, (_, i) => ({ name: `Author ${i}` }));
    expect(formatAuthorsDisplay(authors)).not.toMatch(/more/);
  });

  it('returns null for a non-array value', () => {
    expect(formatAuthorsDisplay('not an array')).toBeNull();
    expect(formatAuthorsDisplay(null)).toBeNull();
    expect(formatAuthorsDisplay(undefined)).toBeNull();
  });

  it('returns null for an empty array', () => {
    expect(formatAuthorsDisplay([])).toBeNull();
  });

  it('returns null when no entry has a usable name', () => {
    expect(formatAuthorsDisplay([{ orcid: '0000' }, 'bare string', 42])).toBeNull();
  });

  it('skips entries without a usable name but keeps the rest', () => {
    expect(formatAuthorsDisplay([{ name: 'Has Name' }, { orcid: 'no-name' }])).toBe('Has Name');
  });

  it('ignores orcid in the display string', () => {
    expect(formatAuthorsDisplay([{ name: 'Jane', orcid: '0000-0001-2345-6789' }])).toBe('Jane');
  });
});

// SCRUM-5105/5106 reconciliation (2026-09-13): registry / person-adjacent and
// document/legal sources beyond the original four, now sourced from the
// SHARED cross-package fixture (public-record-sources.json — byte-identical
// to services/worker/src/jobs/__fixtures__/public-record-sources.json). See
// the ALLOW_LIST table at the top of publicRecordTemplate.ts for the exact
// source -> field mapping this section pins.
describe('projectPublicRecordToTemplate — registry sources', () => {
  it('npi: registry-level identifiers only, never provider_name/gender/authorized_official', () => {
    const result = projectPublicRecordToTemplate('npi', fixtureFor('npi'));
    expect(result.licenseNumber).toBe('1234567890');
    expect(result.issuerName).toBe('NPPES NPI Registry (CMS)');
    expect(result.issuedDate).toBe('2010-06-01');
    expect(result.fieldOfStudy).toBe('Internal Medicine');
    expect(result.licenseType).toBe('healthcare_provider');
    expect(JSON.stringify(result)).not.toMatch(/Dr\. Jane Smith|\bF\b/);
    expect(Object.keys(result)).not.toContain('provider_name');
    expect(Object.keys(result)).not.toContain('gender');
    expect(Object.keys(result)).not.toContain('authorized_official');
  });

  it('finra: CRD + firm + registrations, never the broker\'s own name', () => {
    const result = projectPublicRecordToTemplate('finra', fixtureFor('finra'));
    expect(result.licenseNumber).toBe('2233445');
    expect(result.issuerName).toBe('FINRA BrokerCheck');
    expect(result.currentFirm).toBe('Meridian Securities LLC');
    expect(result.currentFirmCrd).toBe('998877');
    expect(result.registrations).toEqual(['NY', 'NJ']);
    expect(JSON.stringify(result)).not.toMatch(/John Q\. Broker|New York, NY/);
    expect(Object.keys(result)).not.toContain('full_name');
    expect(Object.keys(result)).not.toContain('first_name');
    expect(Object.keys(result)).not.toContain('current_location');
  });

  it('calbar: bar number + status, never the attorney\'s name/city/discipline_history', () => {
    const result = projectPublicRecordToTemplate('calbar', fixtureFor('calbar'));
    expect(result.licenseNumber).toBe('345678');
    expect(result.issuerName).toBe('State Bar of California');
    expect(result.issuedDate).toBe('2005-12-01');
    expect(result.jurisdiction).toBe('US-CA');
    expect(JSON.stringify(result)).not.toMatch(/Maria Garcia|Los Angeles/);
    expect(Object.keys(result)).not.toContain('discipline_history');
    expect(Object.keys(result)).not.toContain('city');
  });

  it('dapip: OPE id + institution type, never issuerName or the address (no registry field exists for this source)', () => {
    const result = projectPublicRecordToTemplate('dapip', fixtureFor('dapip'));
    expect(result.licenseNumber).toBe('00445500');
    expect(result.issuerName).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/Riverside State University|500 University Ave/);
    expect(Object.keys(result)).not.toContain('address');
    expect(Object.keys(result)).not.toContain('institution_name');
  });

  it('acnc: ABN + registration date, never the address (not even city/postcode)', () => {
    const result = projectPublicRecordToTemplate('acnc', fixtureFor('acnc'));
    expect(result.licenseNumber).toBe('51234567890');
    expect(result.issuerName).toBe('Australian Charities and Not-for-profits Commission');
    expect(result.issuedDate).toBe('2015-03-10');
    expect(result.jurisdiction).toBe('AU');
    expect(JSON.stringify(result)).not.toMatch(/Helping Hands Charity Ltd|10 Collins St|\b3000\b/);
    expect(Object.keys(result)).not.toContain('address');
    expect(Object.keys(result)).not.toContain('postcode');
  });

  it('uspto: patent id/type/date + title, never the abstract, no fabricated authors', () => {
    const result = projectPublicRecordToTemplate('uspto', fixtureFor('uspto'));
    expect(result.licenseNumber).toBe('US11234567B2');
    expect(result.issuedDate).toBe('2026-01-20');
    expect(result.fieldOfStudy).toBe('Method and Apparatus for Distributed Ledger Anchoring');
    expect(result.authors).toBeUndefined();
    expect(Object.keys(result)).not.toContain('abstract');
  });

  it('courtlistener: court + docket + case title + citations, never judges or the syllabus', () => {
    const result = projectPublicRecordToTemplate('courtlistener', fixtureFor('courtlistener'));
    expect(result.issuerName).toBe('Supreme Court of the United States');
    expect(result.licenseNumber).toBe('5544332'); // numeric docket_id, stringified
    expect(result.issuedDate).toBe('2026-05-01');
    expect(result.fieldOfStudy).toBe('Smith v. Jones');
    expect(result.citations).toEqual(['512 U.S. 100']);
    expect(result.opinionCount).toBe(1);
    expect(result.courtId).toBe('scotus');
    expect(JSON.stringify(result)).not.toMatch(/Roberts, C\.J\.|The Court held that/);
    expect(Object.keys(result)).not.toContain('judges');
    expect(Object.keys(result)).not.toContain('syllabus');
  });

  it('edgar_form_adv: CRD + registry, never the organization name/city', () => {
    const result = projectPublicRecordToTemplate('edgar_form_adv', fixtureFor('edgar_form_adv'));
    expect(result.licenseNumber).toBe('170392');
    expect(result.issuerName).toBe('SEC EDGAR Form ADV');
    expect(result.issuedDate).toBe('2026-01-10');
    expect(result.jurisdiction).toBe('US');
    expect(JSON.stringify(result)).not.toMatch(/Summit Capital Advisers LLC|Denver/);
    expect(Object.keys(result)).not.toContain('city');
    expect(Object.keys(result)).not.toContain('organization_name');
  });

  it('sec_adv_bulk aliases edgar_form_adv\'s projection (legacy prod source name, same fetcher shape)', () => {
    const result = projectPublicRecordToTemplate('sec_adv_bulk', fixtureFor('sec_adv_bulk'));
    // Deliberately different title/source_id/organization_name from the
    // edgar_form_adv fixture (the real prod situation) — none of those feed
    // the shared spec, so the projection matches byte-for-byte anyway.
    expect(result).toEqual(projectPublicRecordToTemplate('edgar_form_adv', fixtureFor('edgar_form_adv')));
    expect(result.licenseNumber).toBe('170392');
    expect(result.issuerName).toBe('SEC EDGAR Form ADV');
  });

  it('sec_iapd: CRD + firm-level assets/accounts, no address or person fields', () => {
    const result = projectPublicRecordToTemplate('sec_iapd', fixtureFor('sec_iapd'));
    expect(result.licenseNumber).toBe('104822');
    expect(result.issuerName).toBe('SEC Investment Adviser Public Disclosure');
    expect(result.registrationStatus).toBe('APPROVED');
    expect(result.totalAssets).toBe(812000000);
    expect(result.numberOfAccounts).toBe(340);
    expect(result.jurisdictions).toEqual(['MA', 'NY']);
    expect(result.licenseType).toBe('investment_adviser');
    expect(JSON.stringify(result)).not.toMatch(/Harborview Wealth Management|Boston/);
    expect(Object.keys(result)).not.toContain('city');
    expect(Object.keys(result)).not.toContain('website');
  });

  it('acra_sg: UEN + entity/SSIC codes, never the entity name', () => {
    const result = projectPublicRecordToTemplate('acra_sg', fixtureFor('acra_sg'));
    expect(result.licenseNumber).toBe('201512345A');
    expect(result.issuerName).toBe('Accounting and Corporate Regulatory Authority (ACRA)');
    expect(result.issuedDate).toBe('2015-07-22');
    expect(result.primarySsicCode).toBe('46900');
    expect(JSON.stringify(result)).not.toMatch(/Lion City Trading Pte Ltd/);
    expect(Object.keys(result)).not.toContain('entity_name');
  });

  it('cnpj_br: CNPJ + registry + CNAE, never the address or entity names', () => {
    const result = projectPublicRecordToTemplate('cnpj_br', fixtureFor('cnpj_br'));
    expect(result.licenseNumber).toBe('12.345.678/0001-90');
    expect(result.issuerName).toBe('Receita Federal (CNPJ)');
    expect(result.cnaeFiscal).toBe('4711302');
    expect(result.cnaeDescricao).toBe('Comercio varejista');
    expect(JSON.stringify(result)).not.toMatch(/Comercio Exemplo LTDA|Exemplo Store|Rua Exemplo 123/);
    expect(Object.keys(result)).not.toContain('address');
    expect(Object.keys(result)).not.toContain('municipio');
    expect(Object.keys(result)).not.toContain('cep');
    expect(Object.keys(result)).not.toContain('razao_social');
  });

  it('australia_law: statute SECTION id/title (not the shared statute_id), jurisdiction as issuer', () => {
    const result = projectPublicRecordToTemplate('australia_law', fixtureFor('australia_law'));
    expect(result.licenseNumber).toBe('AU-PA-1988-S26WA'); // section_id, not statute_id
    expect(result.issuerName).toBe('Australia');
    expect(result.fieldOfStudy).toBe('Notifiable Data Breaches scheme');
    expect(result.statuteName).toBe('Privacy Act 1988 (Cth)');
  });

  it('kenya_law: statute section id/title, jurisdiction as issuer', () => {
    const result = projectPublicRecordToTemplate('kenya_law', fixtureFor('kenya_law'));
    expect(result.licenseNumber).toBe('KE-DPA-2019-S18');
    expect(result.issuerName).toBe('Kenya');
    expect(result.fieldOfStudy).toBe('Registration of data controllers');
  });

  it('australia_caselaw: court + case title + the row\'s own source_id as licenseNumber, never the summary', () => {
    const result = projectPublicRecordToTemplate('australia_caselaw', fixtureFor('australia_caselaw'));
    expect(result.issuerName).toBe('Federal Court of Australia');
    expect(result.fieldOfStudy).toBe('Commissioner v Example Pty Ltd');
    // No docket/case number in metadata — the record's own identifier is
    // the pipeline source_id column.
    expect(result.licenseNumber).toBe(fixtureFor('australia_caselaw').source_id);
    expect(Object.keys(result)).not.toContain('summary');
  });

  it('kenya_caselaw: court + case title, never the summary', () => {
    const result = projectPublicRecordToTemplate('kenya_caselaw', fixtureFor('kenya_caselaw'));
    expect(result.issuerName).toBe('High Court of Kenya');
    expect(result.fieldOfStudy).toBe('ODPC v Example Data Ltd');
    expect(result.licenseNumber).toBe(fixtureFor('kenya_caselaw').source_id);
    expect(Object.keys(result)).not.toContain('summary');
  });

  it('moh_sg: licence number + registry, never premises_address or the licensee\'s name', () => {
    const result = projectPublicRecordToTemplate('moh_sg', fixtureFor('moh_sg'));
    expect(result.licenseNumber).toBe('L12345A');
    expect(result.issuerName).toBe('Ministry of Health Singapore');
    expect(result.issuedDate).toBe('2020-01-01');
    expect(result.jurisdiction).toBe('SG');
    expect(JSON.stringify(result)).not.toMatch(/Sunrise Medical Clinic|88 Orchard Rd|Dr\. Tan Wei Ming/);
    expect(Object.keys(result)).not.toContain('premises_address');
    expect(Object.keys(result)).not.toContain('licensee_name');
  });
});

describe('projectPublicRecordToTemplate — forbidden-keys property test across every shipped source', () => {
  // Excludes '_comment' (not a fixture row) and 'openalex' (added to this
  // shared fixture for the cross-package parity test below; it legitimately
  // DOES emit `authors`, which the "no source here emits authors" assertion
  // in this describe block assumes false for every entry — openalex already
  // has its own dedicated author-aware test suite above).
  const allSources = Object.keys(registrySourceFixtures).filter(
    (k) => k !== '_comment' && k !== 'openalex',
  ) as Array<keyof typeof registrySourceFixtures>;

  it.each(allSources)('never emits a forbidden key or leaks a fixture PII-flavored value for %s', (source) => {
    const record = fixtureFor(source);
    const result = projectPublicRecordToTemplate(source, record);
    for (const key of Object.keys(result)) {
      expect(FORBIDDEN_KEY_PATTERN.test(key)).toBe(false);
      expect(key).not.toBe('abstract');
      expect(key).not.toBe('description');
      expect(key).not.toBe('summary');
    }
    expect(FORBIDDEN_VALUE_PATTERN.test(JSON.stringify(result))).toBe(false);
  });

  it.each(allSources)('every value is string | number | boolean | string[] for %s (no source here emits authors)', (source) => {
    const record = fixtureFor(source);
    const result = projectPublicRecordToTemplate(source, record);
    expect(result.authors).toBeUndefined();
    for (const value of Object.values(result)) {
      if (Array.isArray(value)) {
        for (const entry of value) expect(typeof entry).toBe('string');
      } else {
        expect(['string', 'number', 'boolean']).toContain(typeof value);
      }
    }
  });

  it('sam_gov and any other genuinely unimplemented source still returns {}', () => {
    expect(projectPublicRecordToTemplate('sam_gov', { title: 'x', metadata: { name: 'y' } })).toEqual({});
  });
});

describe('projectPublicRecordToTemplate — cross-package parity (SCRUM-5105/5106)', () => {
  // public-record-sources.json and public-record-projections.expected.json
  // are BYTE-IDENTICAL copies of the files under
  // services/worker/src/jobs/__fixtures__/ on the worker side (no
  // cross-package imports — this is the parity proof). If this test and the
  // worker's equivalent both pass against the same two files, the frontend
  // SOURCE_FIELD_ALLOW_LIST and the worker SOURCE_FIELD_TABLE project every
  // shared source identically.
  const parityCases = Object.keys(registrySourceFixtures).filter((k) => k !== '_comment');

  it('covers every source in the fixture with an expected projection', () => {
    for (const source of parityCases) {
      expect(expectedProjections as Record<string, unknown>, `missing expected projection for ${source}`).toHaveProperty(source);
    }
  });

  it.each(parityCases)('projects %s identically to the shared expected output', (source) => {
    const fixture = fixtureFor(source);
    const out = projectPublicRecordToTemplate(source, {
      title: fixture.title,
      metadata: fixture.metadata,
      source_id: fixture.source_id,
    });
    expect(out).toEqual((expectedProjections as Record<string, unknown>)[source]);
  });
});
