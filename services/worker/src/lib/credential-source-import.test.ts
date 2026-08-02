import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  CREDENTIAL_SOURCE_IMPORT_MAX_BYTES,
  CredentialSourceImportError,
  buildCredentialSourceImportPreview,
} from './credential-source-import.js';

const FIXED_NOW = new Date('2026-05-05T18:45:00.000Z');
// SCRUM-2484: the recipient identifier hash is now a keyed HMAC; a pepper is
// required for it to be produced at all.
const TEST_RECIPIENT_PEPPER = 'test-recipient-pepper-0123456789';

function response(body: string, init?: ResponseInit): Response {
  return new Response(body, init);
}

describe('credential-source-import', () => {
  it('builds public-safe captured-url evidence from HTML metadata', async () => {
    const fetchFn = vi.fn().mockResolvedValue(response(`
      <html>
        <head>
          <meta property="og:title" content="Cloud Architecture Fundamentals" />
          <script type="application/ld+json">
            {
              "name": "Cloud Architecture Fundamentals",
              "issuer": { "name": "Example Cloud" },
              "credentialSubject": { "name": "Ada Lovelace", "id": "did:example:ada" },
              "issuedOn": "2026-04-15",
              "id": "badge-123"
            }
          </script>
        </head>
      </html>
    `, { headers: { 'content-type': 'text/html; charset=utf-8' } }));
    const urlGuard = vi.fn().mockResolvedValue(false);

    const result = await buildCredentialSourceImportPreview({
      source_url: 'https://www.credly.example/badges/badge-123?token=secret&utm_source=ad&locale=en',
      credential_type: 'BADGE',
    }, { fetchFn, urlGuard, now: () => FIXED_NOW, recipientPepper: TEST_RECIPIENT_PEPPER });

    expect(fetchFn).toHaveBeenCalledWith(
      'https://www.credly.example/badges/badge-123?locale=en',
      expect.objectContaining({ redirect: 'manual' }),
    );
    expect(result.preview).toMatchObject({
      normalized_source_url: 'https://www.credly.example/badges/badge-123?locale=en',
      source_provider: 'credly',
      source_id: 'badge-123',
      source_fetched_at: '2026-05-05T18:45:00.000Z',
      credential_type: 'BADGE',
      credential_title: 'Cloud Architecture Fundamentals',
      credential_issuer: 'Example Cloud',
      credential_recipient_display: 'Ada Lovelace',
      credential_issued_at: '2026-04-15',
      verification_level: 'captured_url',
      extraction_method: 'json_ld',
    });
    expect(result.preview.credential_recipient_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.preview.evidence_package_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.preview.anchor_fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.preview.anchor_fingerprint).not.toBe(result.preview.evidence_package_hash);
    expect(result.preview.public_metadata).not.toHaveProperty('token');
    expect(result.preview.public_metadata).not.toHaveProperty('recipient_display_name');
    expect(result.preview.public_metadata).not.toHaveProperty('credential_recipient_display');
    // SCRUM-2484: the recipient identifier hash is returned in the PREVIEW (for
    // the authenticated importer) but must NOT appear in public_metadata (which
    // is spread into stored anchors.metadata → get_public_anchor → anon callers).
    expect(result.preview.public_metadata).not.toHaveProperty('recipient_identifier_hash');
  });

  it('prefers issuer metadata extracted from HTML over the caller hint', async () => {
    const result = await buildCredentialSourceImportPreview({
      source_url: 'https://credentials.example.com/certificate',
      issuer_hint: 'Caller Supplied Issuer',
    }, {
      fetchFn: vi.fn().mockResolvedValue(response(`
        <html>
          <head>
            <title>Compliance Certificate</title>
            <meta name="issuer" content="Source Metadata Issuer" />
          </head>
        </html>
      `, { headers: { 'content-type': 'text/html' } })),
      urlGuard: vi.fn().mockResolvedValue(false),
      now: () => FIXED_NOW,
    });

    expect(result.preview.credential_issuer).toBe('Source Metadata Issuer');
  });

  it('prefers structured JSON issuer metadata over the caller hint', async () => {
    const result = await buildCredentialSourceImportPreview({
      source_url: 'https://credentials.example.com/certificate.json',
      issuer_hint: 'Caller Supplied Issuer',
    }, {
      fetchFn: vi.fn().mockResolvedValue(response(JSON.stringify({
        name: 'Compliance Certificate',
        issuer: { name: 'Structured Issuer' },
        recipientName: 'Source Recipient',
      }), { headers: { 'content-type': 'application/json' } })),
      urlGuard: vi.fn().mockResolvedValue(false),
      now: () => FIXED_NOW,
      recipientPepper: TEST_RECIPIENT_PEPPER,
    });

    expect(result.preview.credential_issuer).toBe('Structured Issuer');
    expect(result.preview.credential_recipient_display).toBe('Source Recipient');
    expect(result.preview.credential_recipient_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  // SCRUM-2913 (Lane 2) — 0362's get_public_anchor allow-list widening exists
  // to project `registry_url` + `ce_envelope_sha256`, but nothing on main wrote
  // them into anchors.metadata (an inert column). This wires the producer side:
  // when a credential source is genuinely fetched from the CE Registry AND the
  // envelope carries a real `ceterms:ctid`, stamp both provenance keys onto
  // `preview.public_metadata` (which `buildAnchorInsertPayload` spreads into
  // `anchors.metadata`, and 0362 projects to anon callers).
  describe('CE Registry provenance (registry_url + ce_envelope_sha256)', () => {
    const REAL_CTID = 'ce-11111111-2222-4333-8444-555555555555';

    it('stamps registry_url + ce_envelope_sha256 when fetched from the real CE Registry host with a real ctid', async () => {
      const body = JSON.stringify({
        '@context': 'https://credentialengineregistry.org/ns/ctdlasn',
        '@type': 'ceterms:Certificate',
        'ceterms:ctid': REAL_CTID,
        'ceterms:name': 'Example CE Certificate',
        'ceterms:ownedBy': [{ 'ceterms:name': 'Example CE Org' }],
      });
      const expectedHash = createHash('sha256').update(body).digest('hex');

      const result = await buildCredentialSourceImportPreview({
        source_url: `https://credentialengineregistry.org/graph/${REAL_CTID}`,
      }, {
        fetchFn: vi.fn().mockResolvedValue(response(body, { headers: { 'content-type': 'application/ld+json' } })),
        urlGuard: vi.fn().mockResolvedValue(false),
        now: () => FIXED_NOW,
      });

      expect(result.preview.registry_url).toBe(`https://credentialengineregistry.org/resources/${REAL_CTID}`);
      expect(result.preview.ce_envelope_sha256).toBe(expectedHash);
      expect(result.preview.public_metadata).toMatchObject({
        registry_url: `https://credentialengineregistry.org/resources/${REAL_CTID}`,
        ce_envelope_sha256: expectedHash,
      });
    });

    it('omits registry_url + ce_envelope_sha256 (never null-writes them) when the source is NOT the real CE Registry host, even with a matching ceterms:ctid claim', async () => {
      const body = JSON.stringify({
        '@type': 'ceterms:Certificate',
        'ceterms:ctid': REAL_CTID,
        'ceterms:name': 'Spoofed CE-shaped payload',
      });

      const result = await buildCredentialSourceImportPreview({
        source_url: 'https://not-the-real-registry.example/graph/spoof',
      }, {
        fetchFn: vi.fn().mockResolvedValue(response(body, { headers: { 'content-type': 'application/ld+json' } })),
        urlGuard: vi.fn().mockResolvedValue(false),
        now: () => FIXED_NOW,
      });

      expect(result.preview.registry_url).toBeNull();
      expect(result.preview.ce_envelope_sha256).toBeNull();
      expect(result.preview.public_metadata).not.toHaveProperty('registry_url');
      expect(result.preview.public_metadata).not.toHaveProperty('ce_envelope_sha256');
    });

    it('omits registry_url + ce_envelope_sha256 when the CE Registry host is real but the envelope carries no ctid', async () => {
      const body = JSON.stringify({
        '@type': 'ceterms:Certificate',
        'ceterms:name': 'CE Registry response with no ctid',
      });

      const result = await buildCredentialSourceImportPreview({
        source_url: 'https://credentialengineregistry.org/graph/unknown',
      }, {
        fetchFn: vi.fn().mockResolvedValue(response(body, { headers: { 'content-type': 'application/ld+json' } })),
        urlGuard: vi.fn().mockResolvedValue(false),
        now: () => FIXED_NOW,
      });

      expect(result.preview.registry_url).toBeNull();
      expect(result.preview.ce_envelope_sha256).toBeNull();
      expect(result.preview.public_metadata).not.toHaveProperty('registry_url');
      expect(result.preview.public_metadata).not.toHaveProperty('ce_envelope_sha256');
    });

    it('omits registry_url + ce_envelope_sha256 when the ctid is fabricated-shaped (not a real ce-<uuid>)', async () => {
      const body = JSON.stringify({
        '@type': 'ceterms:Certificate',
        'ceterms:ctid': 'urn:ctid:fake-org',
        'ceterms:name': 'Fabricated ctid shape',
      });

      const result = await buildCredentialSourceImportPreview({
        source_url: 'https://credentialengineregistry.org/graph/fabricated',
      }, {
        fetchFn: vi.fn().mockResolvedValue(response(body, { headers: { 'content-type': 'application/ld+json' } })),
        urlGuard: vi.fn().mockResolvedValue(false),
        now: () => FIXED_NOW,
      });

      expect(result.preview.registry_url).toBeNull();
      expect(result.preview.ce_envelope_sha256).toBeNull();
      expect(result.preview.public_metadata).not.toHaveProperty('registry_url');
    });
  });

  it('ignores invalid date-shaped metadata instead of building invalid evidence', async () => {
    const result = await buildCredentialSourceImportPreview({
      source_url: 'https://credentials.example.com/invalid-date',
    }, {
      fetchFn: vi.fn().mockResolvedValue(response(JSON.stringify({
        name: 'Malformed Date Credential',
        issuer: { name: 'Example Issuer' },
        issuedOn: '2026-02-31',
      }), { headers: { 'content-type': 'application/json' } })),
      urlGuard: vi.fn().mockResolvedValue(false),
      now: () => FIXED_NOW,
    });

    expect(result.preview.credential_title).toBe('Malformed Date Credential');
    expect(result.preview.credential_issued_at).toBeNull();
  });

  it('marks plain text sources as manually extracted evidence', async () => {
    const result = await buildCredentialSourceImportPreview({
      source_url: 'https://credentials.example.com/manual.txt',
      issuer_hint: 'Example Issuer',
    }, {
      fetchFn: vi.fn().mockResolvedValue(response('Plain text certificate\nIssued by Example Issuer', {
        headers: { 'content-type': 'text/plain' },
      })),
      urlGuard: vi.fn().mockResolvedValue(false),
      now: () => FIXED_NOW,
    });

    expect(result.preview.credential_title).toBe('Plain text certificate');
    expect(result.preview.extraction_method).toBe('manual');
  });

  it('blocks private or internal targets before fetching', async () => {
    const fetchFn = vi.fn();
    const urlGuard = vi.fn().mockResolvedValue(true);

    await expect(buildCredentialSourceImportPreview({
      source_url: 'https://credentials.example.com/private',
    }, { fetchFn, urlGuard })).rejects.toMatchObject({
      code: 'private_source_url',
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('revalidates redirects and stores the final sanitized URL', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(response('', {
        status: 302,
        headers: { location: 'https://final.example/credential/abc?signature=secret&view=public' },
      }))
      .mockResolvedValueOnce(response('<title>Redirected Credential</title>', {
        headers: { 'content-type': 'text/html' },
      }));
    const urlGuard = vi.fn().mockResolvedValue(false);

    const result = await buildCredentialSourceImportPreview({
      source_url: 'https://start.example/credential/abc',
    }, { fetchFn, urlGuard, now: () => FIXED_NOW });

    expect(urlGuard).toHaveBeenNthCalledWith(1, 'https://start.example/credential/abc');
    expect(urlGuard).toHaveBeenNthCalledWith(2, 'https://final.example/credential/abc?view=public');
    expect(fetchFn).toHaveBeenNthCalledWith(
      2,
      'https://final.example/credential/abc?view=public',
      expect.any(Object),
    );
    expect(result.preview.normalized_source_url).toBe('https://final.example/credential/abc?view=public');
  });

  it('uses one fetch timeout budget across redirect hops', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(response('', {
      status: 302,
      headers: { location: 'https://final.example/credential/abc' },
    }));
    const urlGuard = vi.fn().mockResolvedValue(false);
    const nowSpy = vi.spyOn(Date, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(5001);

    await expect(buildCredentialSourceImportPreview({
      source_url: 'https://start.example/credential/abc',
    }, { fetchFn, urlGuard, now: () => FIXED_NOW })).rejects.toMatchObject({
      code: 'source_fetch_timeout',
    });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    nowSpy.mockRestore();
  });

  it('blocks a redirect target when DNS guard rejects the final URL', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(response('', {
      status: 302,
      headers: { location: 'https://internal.example/credential' },
    }));
    const urlGuard = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await expect(buildCredentialSourceImportPreview({
      source_url: 'https://start.example/credential',
    }, { fetchFn, urlGuard })).rejects.toMatchObject({
      code: 'private_source_url',
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('rejects unsupported content types and oversized sources', async () => {
    await expect(buildCredentialSourceImportPreview({
      source_url: 'https://credentials.example.com/image',
    }, {
      fetchFn: vi.fn().mockResolvedValue(response('not an image', {
        headers: { 'content-type': 'image/png' },
      })),
      urlGuard: vi.fn().mockResolvedValue(false),
    })).rejects.toBeInstanceOf(CredentialSourceImportError);

    await expect(buildCredentialSourceImportPreview({
      source_url: 'https://credentials.example.com/huge',
    }, {
      fetchFn: vi.fn().mockResolvedValue(response('too large', {
        headers: {
          'content-type': 'text/html',
          'content-length': String(CREDENTIAL_SOURCE_IMPORT_MAX_BYTES + 1),
        },
      })),
      urlGuard: vi.fn().mockResolvedValue(false),
    })).rejects.toMatchObject({
      code: 'source_too_large',
    });
  });
});
