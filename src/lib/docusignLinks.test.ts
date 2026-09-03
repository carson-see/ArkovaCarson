/**
 * docusignLinks.test.ts
 *
 * DocuSign record deep links (bilateral rollout, frontend-targeted T2).
 * Security-critical property under test: a candidate value becomes part of
 * an href ONLY after passing strict UUID validation — every builder must
 * return null (never a best-effort or partially-built URL) on anything that
 * does not match, including javascript:/data:-shaped injection attempts.
 */

import { describe, it, expect } from 'vitest';
import {
  isStrictUuid,
  resolveDocusignEnv,
  accountUrl,
  envelopeUrl,
  signerUrl,
  type DocusignEnv,
} from './docusignLinks';

const VALID_UUID = '11111111-2222-4333-8444-555555555555';
const VALID_UUID_UPPER = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';
const ANOTHER_VALID_UUID = '66666666-7777-4888-8999-aaaaaaaaaaaa';

describe('isStrictUuid', () => {
  it('accepts a canonical lowercase UUID', () => {
    expect(isStrictUuid(VALID_UUID)).toBe(true);
  });

  it('accepts an uppercase UUID (case-insensitive)', () => {
    expect(isStrictUuid(VALID_UUID_UPPER)).toBe(true);
  });

  it('accepts a UUID with zeroed version/variant bits (not RFC 4122 strict)', () => {
    // Arkova's own deterministic seed ids use this shape (see
    // e2e/fixtures/supabase.ts POSTGRES_UUID_RE) — the property this module
    // guarantees is "safe to interpolate into a URL", not "is a v4 UUID".
    expect(isStrictUuid('00000000-0000-0000-0000-000000000001')).toBe(true);
  });

  it('rejects an empty string', () => {
    expect(isStrictUuid('')).toBe(false);
  });

  it('rejects null', () => {
    expect(isStrictUuid(null)).toBe(false);
  });

  it('rejects undefined', () => {
    expect(isStrictUuid(undefined)).toBe(false);
  });

  it('rejects a number', () => {
    expect(isStrictUuid(123)).toBe(false);
  });

  it('rejects an object', () => {
    expect(isStrictUuid({ toString: () => VALID_UUID })).toBe(false);
  });

  it('rejects an array', () => {
    expect(isStrictUuid([VALID_UUID])).toBe(false);
  });

  it('rejects a UUID missing a hyphen', () => {
    expect(isStrictUuid('111111112222-4333-8444-555555555555')).toBe(false);
  });

  it('rejects a UUID with wrong segment lengths', () => {
    expect(isStrictUuid('1111111-2222-4333-8444-555555555555')).toBe(false);
  });

  it('rejects a UUID with extra trailing characters', () => {
    expect(isStrictUuid(`${VALID_UUID}x`)).toBe(false);
  });

  it('rejects a UUID with leading whitespace', () => {
    expect(isStrictUuid(` ${VALID_UUID}`)).toBe(false);
  });

  it('rejects a UUID with trailing whitespace', () => {
    expect(isStrictUuid(`${VALID_UUID} `)).toBe(false);
  });

  it('rejects a UUID with trailing newline (header/response-splitting shape)', () => {
    expect(isStrictUuid(`${VALID_UUID}\n`)).toBe(false);
  });

  it('rejects non-hex characters in place of hex digits', () => {
    expect(isStrictUuid('gggggggg-2222-4333-8444-555555555555')).toBe(false);
  });

  // Injection-shaped inputs — the actual security property under test.
  it('rejects a javascript: URI', () => {
    expect(isStrictUuid('javascript:alert(1)')).toBe(false);
  });

  it('rejects a javascript: URI smuggled after a valid-looking prefix', () => {
    expect(isStrictUuid(`${VALID_UUID}"><script>alert(1)</script>`)).toBe(false);
  });

  it('rejects a data: URI', () => {
    expect(isStrictUuid('data:text/html,<script>alert(1)</script>')).toBe(false);
  });

  it('rejects a vbscript: URI', () => {
    expect(isStrictUuid('vbscript:msgbox(1)')).toBe(false);
  });

  it('rejects a protocol-relative redirect payload', () => {
    expect(isStrictUuid('//evil.example.com')).toBe(false);
  });

  it('rejects an open-redirect-shaped absolute URL', () => {
    expect(isStrictUuid('https://evil.example.com')).toBe(false);
  });

  it('rejects a UUID embedding a query-string injection attempt', () => {
    expect(isStrictUuid(`${VALID_UUID}&redirect=https://evil.example.com`)).toBe(false);
  });

  it('rejects a UUID wrapped in braces (Windows GUID form)', () => {
    expect(isStrictUuid(`{${VALID_UUID}}`)).toBe(false);
  });

  it('rejects a UUID with the hyphens stripped (32-hex form)', () => {
    expect(isStrictUuid(VALID_UUID.replaceAll('-', ''))).toBe(false);
  });
});

describe('resolveDocusignEnv', () => {
  it('resolves the exact string "demo" to demo', () => {
    expect(resolveDocusignEnv('demo')).toBe('demo');
  });

  it('resolves the exact string "prod" to prod', () => {
    expect(resolveDocusignEnv('prod')).toBe('prod');
  });

  it('defaults to prod when the value is undefined (absent metadata field)', () => {
    expect(resolveDocusignEnv(undefined)).toBe('prod');
  });

  it('defaults to prod when the value is null', () => {
    expect(resolveDocusignEnv(null)).toBe('prod');
  });

  it('defaults to prod on an unrecognised string', () => {
    expect(resolveDocusignEnv('staging')).toBe('prod');
  });

  it('defaults to prod on a case variant of "demo" (exact-match only)', () => {
    expect(resolveDocusignEnv('DEMO')).toBe('prod');
  });

  it('defaults to prod on a non-string value', () => {
    expect(resolveDocusignEnv(42)).toBe('prod');
  });
});

describe('accountUrl', () => {
  it('builds a prod URL for a valid account id (default env)', () => {
    expect(accountUrl(VALID_UUID)).toBe(`https://apps.docusign.com/send/home?account=${VALID_UUID}`);
  });

  it('builds a prod URL when env is explicitly "prod"', () => {
    expect(accountUrl(VALID_UUID, 'prod')).toBe(`https://apps.docusign.com/send/home?account=${VALID_UUID}`);
  });

  it('builds a demo URL when env is "demo"', () => {
    expect(accountUrl(VALID_UUID, 'demo')).toBe(`https://apps-d.docusign.com/send/home?account=${VALID_UUID}`);
  });

  it('returns null for a non-UUID account id', () => {
    expect(accountUrl('not-a-uuid')).toBeNull();
  });

  it('returns null for an empty account id', () => {
    expect(accountUrl('')).toBeNull();
  });

  it('returns null for a javascript: URI passed as account id', () => {
    expect(accountUrl('javascript:alert(document.cookie)')).toBeNull();
  });

  it('returns null for a null account id', () => {
    expect(accountUrl(null)).toBeNull();
  });

  it('returns null for an undefined account id', () => {
    expect(accountUrl(undefined)).toBeNull();
  });

  it('never contains the raw injection payload anywhere in a null result', () => {
    // Belt-and-suspenders: assert there is genuinely no string to leak, not
    // just that the return value happens to look right.
    const result = accountUrl('"><img src=x onerror=alert(1)>');
    expect(result).toBeNull();
  });
});

describe('envelopeUrl', () => {
  it('builds a prod URL for a valid envelope id (default env)', () => {
    expect(envelopeUrl(ANOTHER_VALID_UUID)).toBe(`https://apps.docusign.com/send/documents/details/${ANOTHER_VALID_UUID}`);
  });

  it('builds a demo URL when env is "demo"', () => {
    expect(envelopeUrl(ANOTHER_VALID_UUID, 'demo')).toBe(`https://apps-d.docusign.com/send/documents/details/${ANOTHER_VALID_UUID}`);
  });

  it('returns null for a non-UUID envelope id', () => {
    expect(envelopeUrl('drop table anchors;')).toBeNull();
  });

  it('returns null for an empty envelope id', () => {
    expect(envelopeUrl('')).toBeNull();
  });

  it('returns null for a data: URI passed as envelope id', () => {
    expect(envelopeUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
  });
});

describe('signerUrl', () => {
  it('resolves to the same URL shape as envelopeUrl for a valid id (default env)', () => {
    expect(signerUrl(VALID_UUID)).toBe(envelopeUrl(VALID_UUID));
    expect(signerUrl(VALID_UUID)).toBe(`https://apps.docusign.com/send/documents/details/${VALID_UUID}`);
  });

  it('resolves to the demo envelope-details URL when env is "demo"', () => {
    expect(signerUrl(VALID_UUID, 'demo')).toBe(`https://apps-d.docusign.com/send/documents/details/${VALID_UUID}`);
  });

  it('accepts a recipient GUID (the actual call-site shape — no separate per-signer endpoint exists)', () => {
    const recipientGuid = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
    expect(signerUrl(recipientGuid)).toBe(`https://apps.docusign.com/send/documents/details/${recipientGuid}`);
  });

  it('returns null for a non-UUID id', () => {
    expect(signerUrl('not-a-guid')).toBeNull();
  });

  it('returns null for a javascript: URI', () => {
    expect(signerUrl('javascript:alert(1)')).toBeNull();
  });
});

describe('env selection never widens beyond the two fixed bases', () => {
  it('every non-null accountUrl/envelopeUrl/signerUrl result starts with one of the two fixed origins', () => {
    const envs: DocusignEnv[] = ['prod', 'demo'];
    for (const env of envs) {
      const urls = [accountUrl(VALID_UUID, env), envelopeUrl(VALID_UUID, env), signerUrl(VALID_UUID, env)];
      for (const url of urls) {
        expect(url).not.toBeNull();
        expect(url?.startsWith('https://apps.docusign.com/') || url?.startsWith('https://apps-d.docusign.com/')).toBe(true);
      }
    }
  });
});
