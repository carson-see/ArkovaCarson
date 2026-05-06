import { describe, expect, it, vi } from 'vitest';
import {
  CREDENTIAL_SOURCE_IMPORT_MAX_BYTES,
  CredentialSourceImportError,
  buildCredentialSourceImportPreview,
} from './credential-source-import.js';

const FIXED_NOW = new Date('2026-05-05T18:45:00.000Z');

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
    }, { fetchFn, urlGuard, now: () => FIXED_NOW });

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
      credential_issued_at: '2026-04-15',
      verification_level: 'captured_url',
      extraction_method: 'json_ld',
    });
    expect(result.preview.evidence_package_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.preview.anchor_fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.preview.anchor_fingerprint).not.toBe(result.preview.evidence_package_hash);
    expect(result.preview.public_metadata).not.toHaveProperty('token');
    expect(result.preview.public_metadata).not.toHaveProperty('recipient_display_name');
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
      }), { headers: { 'content-type': 'application/json' } })),
      urlGuard: vi.fn().mockResolvedValue(false),
      now: () => FIXED_NOW,
    });

    expect(result.preview.credential_issuer).toBe('Structured Issuer');
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
