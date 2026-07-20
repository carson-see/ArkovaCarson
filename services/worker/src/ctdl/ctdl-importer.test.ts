import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  parseCtdlDocument,
  parseCtdlEnvelope,
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
    // TAXONOMY (SCRUM-2374): ceterms:expirationDate -> resourceAvailableUntil.
    expect(rec.resourceAvailableUntil).toBe('2030-05-01');
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
    expect(rec.resourceAvailableUntil).toBeNull();
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

describe('SCRUM-2599 — expirationDate-vs-status reconciliation (OPT-IN, default OFF)', () => {
  // The offering-availability -> person-credential-expired coupling is an
  // unratified taxonomy decision (SCRUM-2374), so it is OPT-IN and OFF by
  // default. These tests exercise it via the explicit flag.
  const OPT_IN = { now: NOW, treatResourceExpiryAsCredentialExpired: true } as const;

  it('DEFAULT (flag off): a past expirationDate does NOT force expired — sourceStatus is preserved as data', () => {
    const node = {
      '@type': 'ceterms:License',
      'ceterms:name': 'Lapsed Offering',
      'ceterms:lifecycleStatusType': 'lifecycle:Active',
      'ceterms:expirationDate': '2021-01-01',
    };
    const rec = parseCtdlNode(node, { now: NOW });
    // Source claim preserved unchanged...
    expect(rec.sourceStatus).toBe('active');
    expect(rec.status).toBe('active');
    // ...and the offering-availability date is still captured as data.
    expect(rec.resourceAvailableUntil).toBe('2021-01-01');
  });

  it('(c) OPT-IN: an expired credential (expirationDate in the past) resolves to expired even when source status claims active', () => {
    const node = {
      '@type': 'ceterms:License',
      'ceterms:name': 'Lapsed License',
      'ceterms:lifecycleStatusType': 'lifecycle:Active',
      'ceterms:expirationDate': '2021-01-01',
    };
    const rec = parseCtdlNode(node, OPT_IN);
    // The SOURCE claimed active...
    expect(rec.sourceStatus).toBe('active');
    // ...but with the opt-in enabled, the past expiration date wins.
    expect(rec.status).toBe('expired');
    expect(rec.resourceAvailableUntil).toBe('2021-01-01');
  });

  it('OPT-IN: a future expiration date does not override an active source status', () => {
    const node = {
      '@type': 'ceterms:License',
      'ceterms:name': 'Current License',
      'ceterms:lifecycleStatusType': 'lifecycle:Active',
      'ceterms:expirationDate': '2099-01-01',
    };
    const rec = parseCtdlNode(node, OPT_IN);
    expect(rec.status).toBe('active');
  });

  it('OPT-IN: a datetime expiration exactly in the past is treated as expired', () => {
    const node = {
      '@type': 'ceterms:Certificate',
      'ceterms:name': 'Edge Case',
      'ceterms:lifecycleStatusType': 'lifecycle:Active',
      'ceterms:expirationDate': '2026-07-19T23:59:59Z',
    };
    const rec = parseCtdlNode(node, OPT_IN);
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

describe('provenance dual-link (registryUrl + sourceUrl)', () => {
  it('derives BOTH the registry URL (from ctid) and the source URL (from subjectWebpage)', () => {
    const node = {
      '@type': 'ceterms:License',
      'ceterms:name': 'Dual Provenance',
      'ceterms:ctid': 'ce-66666666-6666-4666-8666-666666666666',
      'ceterms:subjectWebpage': 'https://issuer.example.org/credentials/rn',
    };
    const rec = parseCtdlNode(node, { now: NOW });
    // Default registry base is prod.
    expect(rec.registryUrl).toBe(
      'https://credentialengineregistry.org/resources/ce-66666666-6666-4666-8666-666666666666',
    );
    // Source link is the credential's OWN origin, kept separate from registryUrl.
    expect(rec.sourceUrl).toBe('https://issuer.example.org/credentials/rn');
    // sourceId stays the raw ctid — never collapsed into a URL.
    expect(rec.sourceId).toBe('ce-66666666-6666-4666-8666-666666666666');
  });

  it('uses an INJECTED registry base (sandbox) for the registry URL', () => {
    const node = {
      '@type': 'ceterms:License',
      'ceterms:name': 'Sandbox Cred',
      'ceterms:ctid': 'ce-77777777-7777-4777-8777-777777777777',
    };
    const rec = parseCtdlNode(node, {
      now: NOW,
      registryBaseUrl: 'https://sandbox.credentialengineregistry.org',
    });
    expect(rec.registryUrl).toBe(
      'https://sandbox.credentialengineregistry.org/resources/ce-77777777-7777-4777-8777-777777777777',
    );
  });

  it('tolerates a trailing slash on the injected registry base (no double slash)', () => {
    const node = {
      '@type': 'ceterms:License',
      'ceterms:name': 'Trailing Slash',
      'ceterms:ctid': 'ce-88888888-8888-4888-8888-888888888888',
    };
    const rec = parseCtdlNode(node, {
      now: NOW,
      registryBaseUrl: 'https://sandbox.credentialengineregistry.org/',
    });
    expect(rec.registryUrl).toBe(
      'https://sandbox.credentialengineregistry.org/resources/ce-88888888-8888-4888-8888-888888888888',
    );
  });

  it('leaves registryUrl null when the ctid is absent', () => {
    const node = {
      '@type': 'ceterms:License',
      'ceterms:name': 'No CTID',
      'ceterms:subjectWebpage': 'https://issuer.example.org/x',
    };
    const rec = parseCtdlNode(node, { now: NOW });
    expect(rec.registryUrl).toBeNull();
    expect(rec.sourceUrl).toBe('https://issuer.example.org/x');
  });

  it('falls back to ceterms:source for sourceUrl when subjectWebpage is absent', () => {
    const node = {
      '@type': 'ceterms:License',
      'ceterms:name': 'Source Fallback',
      'ceterms:source': 'https://origin.example.org/doc.pdf',
    };
    const rec = parseCtdlNode(node, { now: NOW });
    expect(rec.sourceUrl).toBe('https://origin.example.org/doc.pdf');
  });

  it('prefers subjectWebpage over source when both are present', () => {
    const node = {
      '@type': 'ceterms:License',
      'ceterms:name': 'Both Sources',
      'ceterms:subjectWebpage': 'https://preferred.example.org/page',
      'ceterms:source': 'https://fallback.example.org/doc',
    };
    expect(parseCtdlNode(node, { now: NOW }).sourceUrl).toBe('https://preferred.example.org/page');
  });

  it('resolves subjectWebpage given as an @id object or an array', () => {
    const objNode = {
      '@type': 'ceterms:License',
      'ceterms:name': 'Obj Webpage',
      'ceterms:subjectWebpage': { '@id': 'https://obj.example.org/p' },
    };
    expect(parseCtdlNode(objNode, { now: NOW }).sourceUrl).toBe('https://obj.example.org/p');

    const arrNode = {
      '@type': 'ceterms:License',
      'ceterms:name': 'Arr Webpage',
      'ceterms:subjectWebpage': ['https://arr.example.org/first', 'https://arr.example.org/second'],
    };
    expect(parseCtdlNode(arrNode, { now: NOW }).sourceUrl).toBe('https://arr.example.org/first');
  });

  it('leaves both provenance links null when neither ctid nor a source is present', () => {
    const rec = parseCtdlNode({ '@type': 'ceterms:License', 'ceterms:name': 'Bare' }, { now: NOW });
    expect(rec.registryUrl).toBeNull();
    expect(rec.sourceUrl).toBeNull();
  });

  it('drops a non-http(s) source value to null (honest omission)', () => {
    const node = {
      '@type': 'ceterms:License',
      'ceterms:name': 'Bad Source',
      'ceterms:subjectWebpage': 'javascript:alert(1)',
      'ceterms:source': 'not a url',
    };
    expect(parseCtdlNode(node, { now: NOW }).sourceUrl).toBeNull();
  });
});

describe('provenance — retrievedAt + envelope fingerprint (tamper scope)', () => {
  const node = { '@type': 'ceterms:License', 'ceterms:name': 'Cred', 'ceterms:ctid': 'ce-99999999-9999-4999-8999-999999999999' };

  it('stamps retrievedAt from the injected now by default', () => {
    expect(parseCtdlNode(node, { now: NOW }).retrievedAt).toBe('2026-07-20T00:00:00.000Z');
  });

  it('uses an explicit retrievedAt option when provided', () => {
    const rec = parseCtdlNode(node, { now: NOW, retrievedAt: new Date('2026-01-02T03:04:05Z') });
    expect(rec.retrievedAt).toBe('2026-01-02T03:04:05.000Z');
  });

  it('threads a valid registry envelope SHA-256 (lowercased) and drops invalid ones', () => {
    const sha = 'A'.repeat(64);
    expect(parseCtdlNode(node, { now: NOW, ceEnvelopeSha256: sha }).ceEnvelopeSha256).toBe(
      'a'.repeat(64),
    );
    expect(parseCtdlNode(node, { now: NOW, ceEnvelopeSha256: 'too-short' }).ceEnvelopeSha256)
      .toBeNull();
    expect(parseCtdlNode(node, { now: NOW }).ceEnvelopeSha256).toBeNull();
  });

  it('threads ceEnvelopeSignatureVerified only as a real boolean (else null)', () => {
    expect(parseCtdlNode(node, { now: NOW, ceEnvelopeSignatureVerified: true })
      .ceEnvelopeSignatureVerified).toBe(true);
    expect(parseCtdlNode(node, { now: NOW, ceEnvelopeSignatureVerified: false })
      .ceEnvelopeSignatureVerified).toBe(false);
    expect(parseCtdlNode(node, { now: NOW }).ceEnvelopeSignatureVerified).toBeNull();
  });
});

describe('parseCtdlEnvelope — SHA-256 of the exact consumed bytes', () => {
  it('computes the envelope fingerprint from the raw bytes and stamps every record', () => {
    const raw = JSON.stringify({
      '@graph': [
        { '@type': 'ceterms:License', 'ceterms:name': 'A', 'ceterms:ctid': 'ce-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        { '@type': 'ceterms:Certificate', 'ceterms:name': 'B' },
      ],
    });
    const expectedSha = createHash('sha256').update(raw, 'utf8').digest('hex');

    const records = parseCtdlEnvelope(raw, { now: NOW });
    expect(records).toHaveLength(2);
    for (const rec of records) {
      expect(rec.ceEnvelopeSha256).toBe(expectedSha);
    }
    expect(records[0]!.name).toBe('A');
  });

  it('a computed hash overrides any ceEnvelopeSha256 passed in options', () => {
    const raw = JSON.stringify({ '@type': 'ceterms:License', 'ceterms:name': 'X' });
    const records = parseCtdlEnvelope(raw, { now: NOW, ceEnvelopeSha256: 'b'.repeat(64) });
    expect(records[0]!.ceEnvelopeSha256).toBe(
      createHash('sha256').update(raw, 'utf8').digest('hex'),
    );
  });

  it('throws CtdlImportError on non-JSON bytes', () => {
    expect(() => parseCtdlEnvelope('{not json', { now: NOW })).toThrow(CtdlImportError);
  });
});

describe('taxonomy round-trip alignment (SCRUM-2374)', () => {
  it('reads ceterms:expirationDate into resourceAvailableUntil — the field the serializer re-emits', () => {
    // Type-only import (erased at runtime, so this does NOT pull the serializer's
    // express dependency into the test bundle). The compile-time check proves the
    // importer's output field name is exactly the serializer's input field name,
    // so an import -> re-serialize round-trip is lossless. The serializer's own
    // suite (ctdl-serializer.test.ts) proves resourceAvailableUntil ->
    // ceterms:expirationDate emission.
    type SerializerAnchor = import('./ctdl-serializer.js').CtdlAnchor;

    const rec = parseCtdlNode(
      {
        '@type': 'ceterms:License',
        'ceterms:name': 'Round Trip',
        'ceterms:expirationDate': '2030-01-01',
      },
      { now: NOW },
    );

    // The imported offering-availability date populates the serializer's
    // resourceAvailableUntil (NOT expiresAt) — the round-trip anchor.
    const roundTripAnchor: Pick<SerializerAnchor, 'resourceAvailableUntil'> = {
      resourceAvailableUntil: rec.resourceAvailableUntil,
    };
    expect(roundTripAnchor.resourceAvailableUntil).toBe('2030-01-01');
  });
});

describe('strict calendar-date validation (rejects impossible dates)', () => {
  const dateNode = (value: string) => ({
    '@type': 'ceterms:Certificate',
    'ceterms:name': 'Date Check',
    'ceterms:dateEffective': value,
  });

  it('rejects an impossible day-of-month (2026-02-31) instead of normalizing it', () => {
    // new Date("2026-02-31") silently rolls to 2026-03-03 — must be rejected.
    expect(parseCtdlNode(dateNode('2026-02-31'), { now: NOW }).issuedAt).toBeNull();
  });

  it('rejects an out-of-range month (2026-13-01)', () => {
    expect(parseCtdlNode(dateNode('2026-13-01'), { now: NOW }).issuedAt).toBeNull();
  });

  it('rejects a zero month (2026-00-10) and zero day (2026-05-00)', () => {
    expect(parseCtdlNode(dateNode('2026-00-10'), { now: NOW }).issuedAt).toBeNull();
    expect(parseCtdlNode(dateNode('2026-05-00'), { now: NOW }).issuedAt).toBeNull();
  });

  it('accepts a real leap day (2024-02-29) and rejects a non-leap-year Feb 29 (2026-02-29)', () => {
    expect(parseCtdlNode(dateNode('2024-02-29'), { now: NOW }).issuedAt).toBe('2024-02-29');
    expect(parseCtdlNode(dateNode('2026-02-29'), { now: NOW }).issuedAt).toBeNull();
  });

  it('rejects a datetime whose date portion is an impossible calendar day', () => {
    expect(parseCtdlNode(dateNode('2026-02-31T12:00:00Z'), { now: NOW }).issuedAt).toBeNull();
  });

  it('an impossible expirationDate does not drive the opt-in reconciliation (it is dropped)', () => {
    const node = {
      '@type': 'ceterms:License',
      'ceterms:name': 'Bad Expiry',
      'ceterms:lifecycleStatusType': 'lifecycle:Active',
      'ceterms:expirationDate': '2026-02-31',
    };
    const rec = parseCtdlNode(node, { now: NOW, treatResourceExpiryAsCredentialExpired: true });
    // The malformed date is dropped, so it cannot force an expired status.
    expect(rec.resourceAvailableUntil).toBeNull();
    expect(rec.status).toBe('active');
  });

  it('still accepts ordinary valid dates and datetimes', () => {
    expect(parseCtdlNode(dateNode('2026-07-20'), { now: NOW }).issuedAt).toBe('2026-07-20');
    expect(parseCtdlNode(dateNode('2026-07-20T08:30:00Z'), { now: NOW }).issuedAt).toBe(
      '2026-07-20T08:30:00.000Z',
    );
  });
});

describe('JSON-LD @type arrays', () => {
  it('resolves an @type array to the first ceterms: term', () => {
    const node = {
      '@type': ['ceterms:Certificate', 'ceterms:Credential'],
      'ceterms:name': 'Multi Type',
    };
    expect(parseCtdlNode(node, { now: NOW }).type).toBe('ceterms:Certificate');
  });

  it('prefers a ceterms: term even when it is not first in the array', () => {
    const node = {
      '@type': ['schema:EducationalOccupationalCredential', 'ceterms:License'],
      'ceterms:name': 'Mixed Vocab',
    };
    expect(parseCtdlNode(node, { now: NOW }).type).toBe('ceterms:License');
  });

  it('falls back to the first non-empty string when no ceterms: term is present', () => {
    const node = { '@type': ['schema:Thing', 'ex:Other'], 'ceterms:name': 'No CE Type' };
    expect(parseCtdlNode(node, { now: NOW }).type).toBe('schema:Thing');
  });

  it('resolves to null for an empty @type array or non-string entries', () => {
    expect(parseCtdlNode({ '@type': [], 'ceterms:name': 'X' }, { now: NOW }).type).toBeNull();
    expect(parseCtdlNode({ '@type': [123, null], 'ceterms:name': 'X' }, { now: NOW }).type).toBeNull();
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
