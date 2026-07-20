import { describe, expect, it } from 'vitest';
import {
  parseCtdlDocument,
  parseCtdlNode,
  CtdlImportError,
  type ImportedCtdlRecord,
} from './ctdl-importer.js';

// A stable clock so the SCRUM-2599 expiration-vs-status reconciliation is
// deterministic (never Date.now()). "now" = 2026-07-20T00:00:00Z.
const NOW = new Date('2026-07-20T00:00:00Z');

describe('parseCtdlDocument — @graph walking', () => {
  it('(a) parses a full/rich credential wrapped in @graph', () => {
    const doc = {
      '@context': 'https://credreg.net/ctdl/schema/context/json',
      '@graph': [
        {
          '@id': 'https://credentialengineregistry.org/resources/ce-1111',
          '@type': 'ceterms:License',
          'ceterms:ctid': 'ce-11111111-1111-4111-8111-111111111111',
          'ceterms:name': { 'en-US': 'Registered Nurse' },
          'ceterms:dateEffective': '2020-05-01',
          'ceterms:expirationDate': '2030-05-01',
          'ceterms:lifecycleStatusType': 'lifecycle:Active',
          'ceterms:ownedBy': [
            {
              '@id': 'https://credentialengineregistry.org/resources/ce-org-1',
              '@type': 'ceterms:Organization',
              'ceterms:ctid': 'ce-22222222-2222-4222-8222-222222222222',
              'ceterms:name': { 'en-US': 'State Board of Nursing' },
            },
          ],
        },
      ],
    };

    const records = parseCtdlDocument(doc, { now: NOW });
    expect(records).toHaveLength(1);
    const rec = records[0]!;
    expect(rec.type).toBe('ceterms:License');
    expect(rec.name).toBe('Registered Nurse');
    expect(rec.sourceId).toBe('ce-11111111-1111-4111-8111-111111111111');
    expect(rec.issuedAt).toBe('2020-05-01');
    expect(rec.expiresAt).toBe('2030-05-01');
    // expiration is in the FUTURE relative to NOW -> active stays active.
    expect(rec.sourceStatus).toBe('active');
    expect(rec.status).toBe('active');
    expect(rec.issuer).toEqual({
      id: 'https://credentialengineregistry.org/resources/ce-org-1',
      ctid: 'ce-22222222-2222-4222-8222-222222222222',
      name: 'State Board of Nursing',
    });
  });

  it('(b) parses a sparse @graph node (only required-ish fields) without throwing; optionals become null', () => {
    const doc = {
      '@graph': [
        {
          '@type': 'ceterms:Certificate',
          'ceterms:name': { 'en-US': 'Basic Safety' },
        },
      ],
    };

    const records = parseCtdlDocument(doc, { now: NOW });
    expect(records).toHaveLength(1);
    const rec = records[0]!;
    expect(rec.name).toBe('Basic Safety');
    expect(rec.sourceId).toBeNull();
    expect(rec.issuer).toBeNull();
    expect(rec.issuedAt).toBeNull();
    expect(rec.expiresAt).toBeNull();
    expect(rec.sourceStatus).toBeNull();
    // No status claim and no expiry -> unknown (not a throw).
    expect(rec.status).toBe('unknown');
  });

  it('accepts a top-level single node (no @graph wrapper)', () => {
    const node = {
      '@type': 'ceterms:Certificate',
      'ceterms:name': 'Plain String Name',
    };
    const records = parseCtdlDocument(node, { now: NOW });
    expect(records).toHaveLength(1);
    expect(records[0]!.name).toBe('Plain String Name');
  });

  it('accepts a bare array of nodes', () => {
    const arr = [
      { '@type': 'ceterms:Certificate', 'ceterms:name': 'One' },
      { '@type': 'ceterms:License', 'ceterms:name': 'Two' },
    ];
    const records = parseCtdlDocument(arr, { now: NOW });
    expect(records.map((r) => r.name)).toEqual(['One', 'Two']);
  });
});

describe('SCRUM-2599 — expirationDate-vs-status reconciliation', () => {
  it('(c) an expired credential (expirationDate in the past) resolves to expired even when source status claims active', () => {
    const node = {
      '@type': 'ceterms:License',
      'ceterms:name': 'Lapsed License',
      'ceterms:lifecycleStatusType': 'lifecycle:Active',
      'ceterms:expirationDate': '2021-01-01',
    };
    const rec = parseCtdlNode(node, { now: NOW });
    // The SOURCE claimed active...
    expect(rec.sourceStatus).toBe('active');
    // ...but the past expiration date wins: precedence is explicit.
    expect(rec.status).toBe('expired');
    expect(rec.expiresAt).toBe('2021-01-01');
  });

  it('a future expiration date does not override an active source status', () => {
    const node = {
      '@type': 'ceterms:License',
      'ceterms:name': 'Current License',
      'ceterms:lifecycleStatusType': 'lifecycle:Active',
      'ceterms:expirationDate': '2099-01-01',
    };
    const rec = parseCtdlNode(node, { now: NOW });
    expect(rec.status).toBe('active');
  });

  it('a datetime expiration exactly in the past is treated as expired', () => {
    const node = {
      '@type': 'ceterms:Certificate',
      'ceterms:name': 'Edge Case',
      'ceterms:lifecycleStatusType': 'lifecycle:Active',
      'ceterms:expirationDate': '2026-07-19T23:59:59Z',
    };
    const rec = parseCtdlNode(node, { now: NOW });
    expect(rec.status).toBe('expired');
  });

  it('maps a deprecated/ceased source status to inactive when not expired', () => {
    const node = {
      '@type': 'ceterms:Certificate',
      'ceterms:name': 'Old Program',
      'ceterms:lifecycleStatusType': 'lifecycle:Deprecated',
    };
    const rec = parseCtdlNode(node, { now: NOW });
    expect(rec.sourceStatus).toBe('inactive');
    expect(rec.status).toBe('inactive');
  });
});

describe('ceterms:name resolution', () => {
  it('(d) resolves a language-map object, preferring en/en-US', () => {
    const node = {
      '@type': 'ceterms:Certificate',
      'ceterms:name': { fr: 'Infirmière', 'en-US': 'Nurse', es: 'Enfermera' },
    };
    expect(parseCtdlNode(node, { now: NOW }).name).toBe('Nurse');
  });

  it('resolves a language map with a bare "en" key', () => {
    const node = {
      '@type': 'ceterms:Certificate',
      'ceterms:name': { en: 'English Name', de: 'Deutscher Name' },
    };
    expect(parseCtdlNode(node, { now: NOW }).name).toBe('English Name');
  });

  it('falls back to the first available language when no en variant exists', () => {
    const node = {
      '@type': 'ceterms:Certificate',
      'ceterms:name': { fr: 'Bonjour', es: 'Hola' },
    };
    expect(parseCtdlNode(node, { now: NOW }).name).toBe('Bonjour');
  });

  it('(e) resolves the JSON-LD @value/@language form (single object)', () => {
    const node = {
      '@type': 'ceterms:Certificate',
      'ceterms:name': { '@value': 'Value Form Name', '@language': 'en' },
    };
    expect(parseCtdlNode(node, { now: NOW }).name).toBe('Value Form Name');
  });

  it('resolves an array of @value/@language objects, preferring en', () => {
    const node = {
      '@type': 'ceterms:Certificate',
      'ceterms:name': [
        { '@value': 'Nombre', '@language': 'es' },
        { '@value': 'Name', '@language': 'en-US' },
      ],
    };
    expect(parseCtdlNode(node, { now: NOW }).name).toBe('Name');
  });

  it('returns null for missing or empty names', () => {
    expect(parseCtdlNode({ '@type': 'ceterms:Certificate' }, { now: NOW }).name).toBeNull();
    expect(
      parseCtdlNode({ '@type': 'ceterms:Certificate', 'ceterms:name': { 'en-US': '   ' } }, { now: NOW })
        .name,
    ).toBeNull();
    expect(
      parseCtdlNode({ '@type': 'ceterms:Certificate', 'ceterms:name': {} }, { now: NOW }).name,
    ).toBeNull();
  });
});

describe('ceterms:ownedBy -> issuer', () => {
  it('(f) takes the first org from an ownedBy array and extracts id/ctid/name', () => {
    const node = {
      '@type': 'ceterms:License',
      'ceterms:name': 'Cred',
      'ceterms:ownedBy': [
        {
          '@id': 'https://credentialengineregistry.org/resources/ce-orgA',
          'ceterms:ctid': 'ce-33333333-3333-4333-8333-333333333333',
          'ceterms:name': { 'en-US': 'First Org' },
        },
        {
          '@id': 'https://credentialengineregistry.org/resources/ce-orgB',
          'ceterms:name': { 'en-US': 'Second Org' },
        },
      ],
    };
    expect(parseCtdlNode(node, { now: NOW }).issuer).toEqual({
      id: 'https://credentialengineregistry.org/resources/ce-orgA',
      ctid: 'ce-33333333-3333-4333-8333-333333333333',
      name: 'First Org',
    });
  });

  it('handles ownedBy as a bare @id URI string and extracts the ctid from the URI', () => {
    const node = {
      '@type': 'ceterms:License',
      'ceterms:name': 'Cred',
      'ceterms:ownedBy':
        'https://credentialengineregistry.org/resources/ce-44444444-4444-4444-8444-444444444444',
    };
    expect(parseCtdlNode(node, { now: NOW }).issuer).toEqual({
      id: 'https://credentialengineregistry.org/resources/ce-44444444-4444-4444-8444-444444444444',
      ctid: 'ce-44444444-4444-4444-8444-444444444444',
      name: null,
    });
  });

  it('handles a single ownedBy object (not wrapped in an array)', () => {
    const node = {
      '@type': 'ceterms:License',
      'ceterms:name': 'Cred',
      'ceterms:ownedBy': {
        '@id': 'https://example.org/org',
        'ceterms:name': 'Lone Org',
      },
    };
    expect(parseCtdlNode(node, { now: NOW }).issuer).toEqual({
      id: 'https://example.org/org',
      ctid: null,
      name: 'Lone Org',
    });
  });

  it('returns a null issuer when ownedBy is absent', () => {
    expect(parseCtdlNode({ '@type': 'ceterms:License', 'ceterms:name': 'Cred' }, { now: NOW }).issuer)
      .toBeNull();
  });
});

describe('ceterms:ctid -> sourceId and dates', () => {
  it('(g) omits sourceId when ctid is missing (null, not a throw)', () => {
    const node = {
      '@type': 'ceterms:Certificate',
      'ceterms:name': 'No CTID',
      'ceterms:dateEffective': '2022-03-03',
    };
    const rec = parseCtdlNode(node, { now: NOW });
    expect(rec.sourceId).toBeNull();
    expect(rec.issuedAt).toBe('2022-03-03');
  });

  it('(h) leaves issuedAt null when dateEffective is absent', () => {
    const node = {
      '@type': 'ceterms:Certificate',
      'ceterms:name': 'No Date',
      'ceterms:ctid': 'ce-55555555-5555-4555-8555-555555555555',
    };
    const rec = parseCtdlNode(node, { now: NOW });
    expect(rec.issuedAt).toBeNull();
    expect(rec.sourceId).toBe('ce-55555555-5555-4555-8555-555555555555');
  });

  it('normalizes a full datetime dateEffective to an ISO string', () => {
    const node = {
      '@type': 'ceterms:Certificate',
      'ceterms:name': 'Datetime',
      'ceterms:dateEffective': '2022-03-03T12:30:00Z',
    };
    expect(parseCtdlNode(node, { now: NOW }).issuedAt).toBe('2022-03-03T12:30:00.000Z');
  });

  it('unwraps a JSON-LD @value typed date', () => {
    const node = {
      '@type': 'ceterms:Certificate',
      'ceterms:name': 'Typed Date',
      'ceterms:dateEffective': { '@value': '2021-06-06', '@type': 'xsd:date' },
    };
    expect(parseCtdlNode(node, { now: NOW }).issuedAt).toBe('2021-06-06');
  });

  it('drops an unparseable date to null rather than throwing', () => {
    const node = {
      '@type': 'ceterms:Certificate',
      'ceterms:name': 'Bad Date',
      'ceterms:dateEffective': 'not-a-date',
    };
    expect(parseCtdlNode(node, { now: NOW }).issuedAt).toBeNull();
  });
});

describe('input guards', () => {
  it('returns an empty array for a null/undefined/primitive document', () => {
    expect(parseCtdlDocument(null, { now: NOW })).toEqual([]);
    expect(parseCtdlDocument(undefined, { now: NOW })).toEqual([]);
    expect(parseCtdlDocument('nope', { now: NOW })).toEqual([]);
  });

  it('throws CtdlImportError when a node is not an object', () => {
    expect(() => parseCtdlNode('nope', { now: NOW })).toThrow(CtdlImportError);
  });

  it('every returned record satisfies the Zod-validated shape', () => {
    const records: ImportedCtdlRecord[] = parseCtdlDocument(
      { '@graph': [{ '@type': 'ceterms:Certificate', 'ceterms:name': 'X' }] },
      { now: NOW },
    );
    for (const rec of records) {
      expect(rec).toHaveProperty('status');
      expect(['active', 'expired', 'inactive', 'unknown']).toContain(rec.status);
    }
  });
});
