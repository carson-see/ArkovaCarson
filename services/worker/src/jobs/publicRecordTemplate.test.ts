/**
 * Unit tests for the public-record → credential-template projector
 * (SCRUM-5106). See publicRecordTemplate.ts's header for the ruled design
 * and the per-source SOURCE_FIELD_TABLE this exercises.
 */
import { describe, it, expect } from 'vitest';
import {
  projectPublicRecordToTemplate,
  ProjectedTemplateSchema,
  SOURCE_FIELD_TABLE,
  type ProjectedTemplate,
} from './publicRecordTemplate.js';
import openalexFixture from './__fixtures__/public-record-openalex.json' with { type: 'json' };
import sourceFixtures from './__fixtures__/public-record-sources.json' with { type: 'json' };

type Fixture = { title: string; source_id: string; metadata: Record<string, unknown> };

const OTHER_SOURCES = Object.keys(sourceFixtures).filter((k) => k !== '_comment');

function fixtureFor(source: string): Fixture {
  const raw = (sourceFixtures as Record<string, unknown>)[source] as Fixture;
  if (!raw) throw new Error(`no fixture for source ${source}`);
  return raw;
}

describe('projectPublicRecordToTemplate — openalex', () => {
  const record = {
    title: openalexFixture.title,
    metadata: openalexFixture.metadata as Record<string, unknown>,
    source_id: openalexFixture.source_id,
  };

  it('maps the full openalex fixture', () => {
    const out = projectPublicRecordToTemplate('openalex', record);

    expect(out.issuerName).toBe('Journal of Verifiable Computing');
    expect(out.issuedDate).toBe('2026-03-15');
    expect(out.licenseNumber).toBe('10.1234/example.5678'); // https://doi.org/ stripped
    expect(out.fieldOfStudy).toBe(openalexFixture.title);
    expect(out.authors).toEqual([
      { name: 'Dr. Ada Lovelace', orcid: '0000-0001-2345-6789' },
      { name: 'Grace Hopper' }, // no orcid key when source orcid is null
    ]);
    expect(out.publicationYear).toBe(2026);
    expect(out.citedByCount).toBe(42);
    expect(out.isRetracted).toBe(false);
    expect(out.isOpenAccess).toBe(true);
    expect(out.concepts).toEqual(['Machine learning', 'Cryptography', 'Distributed ledger']);

    // Never the banned keys.
    expect(out).not.toHaveProperty('abstract');
    expect(out).not.toHaveProperty('description');
    expect(out).not.toHaveProperty('recipientIdentifier');
  });

  it('caps authors at 20 and leaves an already-bare (non-URL) orcid unchanged', () => {
    const authors = Array.from({ length: 25 }, (_, i) => ({
      name: `Author ${i}`,
      orcid: i % 2 === 0 ? `https://orcid.org/0000-000${i % 10}-0000-0000` : null,
    }));
    // Author index 1 carries a bare orcid (no URL prefix) — stripUrlPrefix
    // must be a no-op here, not mangle an already-clean value.
    authors[1].orcid = '0000-0001-2345-0000';
    const out = projectPublicRecordToTemplate('openalex', {
      title: 'Many-author paper',
      metadata: { ...record.metadata, authors },
    });
    expect(out.authors).toHaveLength(20);
    expect((out.authors as Array<{ orcid?: string }>)[0].orcid).toBe('0000-0000-0000-0000');
    expect((out.authors as Array<{ orcid?: string }>)[1].orcid).toBe('0000-0001-2345-0000');
  });

  it('normalizes a journal stored as an object with display_name', () => {
    const out = projectPublicRecordToTemplate('openalex', {
      title: 'Test',
      metadata: { ...record.metadata, journal: { display_name: 'Nested Journal Name', issn_l: '1234-5678' } },
    });
    expect(out.issuerName).toBe('Nested Journal Name');
  });

  it('caps concepts at 10', () => {
    const concepts = Array.from({ length: 15 }, (_, i) => `Concept ${i}`);
    const out = projectPublicRecordToTemplate('openalex', {
      title: 'Test',
      metadata: { ...record.metadata, concepts },
    });
    expect(out.concepts).toHaveLength(10);
  });

  it('truncates every string field at 500 UTF-16 units, surrogate-safely', () => {
    const longJournal = 'J'.repeat(600);
    // A 500-unit cut here would land inside a surrogate pair (a 4-byte emoji
    // is 2 UTF-16 units) — this is the exact poison-record shape from the
    // 2026-08-17 incident this module reuses truncateUtf16Safe to avoid.
    const poisonTitle = 'T'.repeat(499) + '😀'.repeat(50);
    const out = projectPublicRecordToTemplate('openalex', {
      title: poisonTitle,
      metadata: { ...record.metadata, journal: longJournal },
    });
    expect((out.issuerName as string).length).toBeLessThanOrEqual(500);
    expect((out.fieldOfStudy as string).length).toBeLessThanOrEqual(500);
    // Must survive JSON round-trip (no lone surrogate).
    expect(() => JSON.parse(JSON.stringify(out))).not.toThrow();
    expect(Buffer.byteLength(out.fieldOfStudy as string, 'utf8')).toBeGreaterThan(0);
  });

  it('enforces the 4KB bound by dropping concepts, then authors beyond 5, then cited_by_count, in that order', () => {
    // Deliberately oversized so that dropping concepts ALONE is not enough —
    // the authors-trim step must also engage. 20 authors x a ~300-char
    // padded name dominates the budget; concepts are modest so we can prove
    // they're dropped FIRST without them being sufficient on their own.
    const authorPad = 'X'.repeat(300);
    const authors = Array.from({ length: 20 }, (_, i) => ({
      name: `Author ${i} ${authorPad}`,
      orcid: `https://orcid.org/0000-000${i % 10}-1111-2222`,
    }));
    const concepts = Array.from({ length: 10 }, (_, i) => `Concept ${i}`);

    const withoutConceptsSize = Buffer.byteLength(JSON.stringify({ authors }), 'utf8');
    expect(withoutConceptsSize).toBeGreaterThan(4096); // sanity: concepts alone can't fix this

    const out = projectPublicRecordToTemplate('openalex', {
      title: 'A title long enough to matter but not to dominate the byte budget on its own',
      metadata: {
        ...record.metadata,
        authors,
        concepts,
        journal: 'A Journal Name',
      },
    });

    const size = Buffer.byteLength(JSON.stringify(out), 'utf8');
    expect(size).toBeLessThanOrEqual(4096);
    // concepts dropped first
    expect(out.concepts).toBeUndefined();
    // authors trimmed to 5 (not dropped entirely — 5 padded authors fit)
    expect(out.authors).toBeDefined();
    expect((out.authors as unknown[]).length).toBe(5);
    // core fields survive
    expect(out.fieldOfStudy).toBeDefined();
    expect(out.licenseNumber).toBeDefined();
  });

  it('parses under the Zod schema', () => {
    const out = projectPublicRecordToTemplate('openalex', record);
    expect(() => ProjectedTemplateSchema.parse(out)).not.toThrow();
  });
});

describe('projectPublicRecordToTemplate — unknown source', () => {
  it('returns {} for a source with no table entry', () => {
    expect(projectPublicRecordToTemplate('some_unmapped_future_source', {
      title: 'x',
      metadata: { email: 'a@b.com' },
    })).toEqual({});
  });
});

describe('projectPublicRecordToTemplate — sec_adv_bulk is an alias of edgar_form_adv', () => {
  it('projects identically to edgar_form_adv given the same registry-shaped metadata', () => {
    const edgarFormAdv = fixtureFor('edgar_form_adv');
    const secAdvBulk = fixtureFor('sec_adv_bulk');

    // The two fixtures deliberately differ on title/source_id/organization_name
    // (the real prod situation: two source tags, same fetcher shape) — none
    // of those feed EDGAR_FORM_ADV_SPEC, so the projections must still match
    // byte-for-byte once pipeline_source-derived differences are excluded.
    const edgarOut = projectPublicRecordToTemplate('edgar_form_adv', {
      title: edgarFormAdv.title, metadata: edgarFormAdv.metadata, source_id: edgarFormAdv.source_id,
    });
    const bulkOut = projectPublicRecordToTemplate('sec_adv_bulk', {
      title: secAdvBulk.title, metadata: secAdvBulk.metadata, source_id: secAdvBulk.source_id,
    });

    expect(bulkOut).toEqual(edgarOut);
    expect(edgarOut.issuerName).toBe('SEC EDGAR Form ADV');
    expect(edgarOut.licenseNumber).toBe('170392');
  });

  it('SOURCE_FIELD_TABLE points both source keys at the exact same spec object', () => {
    expect(SOURCE_FIELD_TABLE.sec_adv_bulk).toBe(SOURCE_FIELD_TABLE.edgar_form_adv);
  });
});

describe('projectPublicRecordToTemplate — every non-openalex pipeline source', () => {
  it.each(OTHER_SOURCES)('produces a schema-valid, non-empty projection for %s', (source) => {
    const fixture = fixtureFor(source);
    const out = projectPublicRecordToTemplate(source, {
      title: fixture.title,
      metadata: fixture.metadata,
      source_id: fixture.source_id,
    });

    expect(() => ProjectedTemplateSchema.parse(out)).not.toThrow();
    // Every declared source should surface at least one of the three
    // identity-bearing template keys the SCRUM-5106 probe checks for.
    const hasIdentitySignal = Boolean(out.issuerName || out.licenseNumber || out.authors);
    expect(hasIdentitySignal).toBe(true);

    const size = Buffer.byteLength(JSON.stringify(out), 'utf8');
    expect(size).toBeLessThanOrEqual(4096);
  });

  it('every source in the fixture map has a SOURCE_FIELD_TABLE entry (fixtures and table stay in sync)', () => {
    for (const source of OTHER_SOURCES) {
      expect(SOURCE_FIELD_TABLE[source], `missing SOURCE_FIELD_TABLE entry for ${source}`).toBeDefined();
    }
  });

  it('every SOURCE_FIELD_TABLE entry has a fixture (table and test coverage stay in sync)', () => {
    for (const source of Object.keys(SOURCE_FIELD_TABLE)) {
      if (source === 'openalex') continue;
      expect(OTHER_SOURCES, `missing fixture for ${source}`).toContain(source);
    }
  });
});

describe('projectPublicRecordToTemplate — registry sources never leak address or person-name fields', () => {
  it('excludes full address, city, and person-name fields present in the raw fetcher metadata', () => {
    const dapip = fixtureFor('dapip');
    const dapipOut = projectPublicRecordToTemplate('dapip', {
      title: dapip.title, metadata: dapip.metadata, source_id: dapip.source_id,
    });
    expect(dapipOut).not.toHaveProperty('address');

    const finra = fixtureFor('finra');
    const finraOut = projectPublicRecordToTemplate('finra', {
      title: finra.title, metadata: finra.metadata, source_id: finra.source_id,
    });
    expect(finraOut).not.toHaveProperty('fullName');
    expect(finraOut).not.toHaveProperty('currentLocation');
    expect(JSON.stringify(finraOut)).not.toContain('New York, NY'); // current_location value

    const acnc = fixtureFor('acnc');
    const acncOut = projectPublicRecordToTemplate('acnc', {
      title: acnc.title, metadata: acnc.metadata, source_id: acnc.source_id,
    });
    expect(acncOut).not.toHaveProperty('address');
    expect(JSON.stringify(acncOut)).not.toContain('Collins St');

    const calbar = fixtureFor('calbar');
    const calbarOut = projectPublicRecordToTemplate('calbar', {
      title: calbar.title, metadata: calbar.metadata, source_id: calbar.source_id,
    });
    expect(calbarOut).not.toHaveProperty('city');
  });

  it('excludes openstates bill sponsor names', () => {
    const openstates = fixtureFor('openstates');
    const out = projectPublicRecordToTemplate('openstates', {
      title: openstates.title, metadata: openstates.metadata, source_id: openstates.source_id,
    });
    expect(out).not.toHaveProperty('primarySponsors');
    expect(JSON.stringify(out)).not.toContain('Jane Doe');
  });

  it('excludes courtlistener judge names', () => {
    const cl = fixtureFor('courtlistener');
    const out = projectPublicRecordToTemplate('courtlistener', {
      title: cl.title, metadata: cl.metadata, source_id: cl.source_id,
    });
    expect(out).not.toHaveProperty('judges');
    expect(JSON.stringify(out)).not.toContain('Roberts, C.J.');
  });
});

describe('projectPublicRecordToTemplate — forbidden keys never emitted (property test)', () => {
  const forbiddenSeed = {
    email: 'person@example.com',
    phone: '+1-555-0100',
    ssn: '123-45-6789',
    dob: '1990-01-01',
    address: '123 Main St',
    recipientIdentifier: 'should-never-appear',
    abstract: 'should never appear either',
    description: 'nor this',
    summary: 'nor this either',
  };

  it.each(['openalex', ...OTHER_SOURCES])('never emits a forbidden key even when %s metadata is seeded with one', (source) => {
    const base = source === 'openalex'
      ? { title: openalexFixture.title, metadata: openalexFixture.metadata as Record<string, unknown> }
      : (() => {
        const f = fixtureFor(source);
        return { title: f.title, metadata: f.metadata, source_id: f.source_id };
      })();

    const seeded = { ...base, metadata: { ...base.metadata, ...forbiddenSeed } };
    const out = projectPublicRecordToTemplate(source, seeded);

    for (const forbiddenKey of Object.keys(forbiddenSeed)) {
      expect(out).not.toHaveProperty(forbiddenKey);
    }
    for (const key of Object.keys(out)) {
      expect(key).not.toMatch(/email|phone|ssn|dob|address/i);
    }
    expect(() => ProjectedTemplateSchema.parse(out)).not.toThrow();
  });
});

describe('ProjectedTemplateSchema', () => {
  it('rejects a projection carrying a forbidden key directly', () => {
    const bad: ProjectedTemplate = { recipientIdentifier: 'nope' };
    expect(() => ProjectedTemplateSchema.parse(bad)).toThrow();
  });

  it('rejects an authors entry with an unrecognized field', () => {
    const bad = { authors: [{ name: 'X', ssn: '123-45-6789' }] };
    expect(() => ProjectedTemplateSchema.parse(bad)).toThrow();
  });

  it('rejects a raw nested object value on an arbitrary extra key', () => {
    const bad = { someExtra: { nested: 'object' } };
    expect(() => ProjectedTemplateSchema.parse(bad)).toThrow();
  });

  it('accepts an empty projection', () => {
    expect(() => ProjectedTemplateSchema.parse({})).not.toThrow();
  });
});
