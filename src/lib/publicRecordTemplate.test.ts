/**
 * publicRecordTemplate.test.ts (SCRUM-5105)
 */

import { describe, it, expect } from 'vitest';
import { projectPublicRecordToTemplate, formatAuthorsDisplay } from './publicRecordTemplate';
import openalexFixture from './__fixtures__/public-record-openalex.json';

const FORBIDDEN_KEY_PATTERN = /email|phone|ssn|dob|address/i;

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
    expect(result.publication_year).toBe(2026);
    expect(result.cited_by_count).toBe(482);
    expect(result.is_retracted).toBe(false);
    expect(result.is_open_access).toBe(true);
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
    expect(result.licenseNumber).toBe('0000320193');
    expect(result.ciks).toEqual(['0000320193']);
    expect(result.formType).toBe('10-K');
    expect(result.periodOfReport).toBe('2025-12-31');
    expect(result.tickers).toEqual(['EXCO']);
    expect(result.fileDescription).toBe('10-K Annual Report');
    expect(result.fieldOfStudy).toBeUndefined();
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
    expect(result.issuerName).toBe('California');
    expect(result.issuedDate).toBe('2026-02-01');
    expect(result.session).toBe('2025-2026');
    expect(result.classification).toEqual(['bill']);
    expect(result.subjects).toEqual(['Education']);
    expect(result.chamber).toBe('House');
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
  it.each([
    'npi',
    'finra',
    'calbar',
    'acnc',
    'dapip',
    'uspto',
    'courtlistener',
    'sam_gov',
    'something_totally_unknown',
  ])('returns {} for %s (deferred pending PII review, or genuinely unknown)', (source) => {
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
