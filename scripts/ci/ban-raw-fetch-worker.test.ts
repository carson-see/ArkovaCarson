/**
 * SCRUM-2483 — tests for the ban-raw-fetch-worker lint.
 *
 * The lint bans bare `fetch(` and `from 'undici'` in services/worker/src/**,
 * EXCEPT a reviewed allow-list of already-safe internal callers (mempool.space
 * providers, Gemini/Vertex AI, government-registry fetchers, OCSP/CRL/RFC3161,
 * GCP auth, Upstash middleware, cloud-logging + BQ export). It ships WARN-first:
 * findings outside the allow-list are WARNINGS, not errors, until the WARN→ERROR
 * ratchet lands in a separate PR after all egress is migrated to safeFetch.
 */

import { describe, it, expect } from 'vitest';
import {
  scanTextForRawFetch,
  isAllowlisted,
  RAW_FETCH_ALLOWLIST,
  GIT_BIN,
  type RawFetchFinding,
} from './ban-raw-fetch-worker.js';

describe('scanTextForRawFetch', () => {
  it('flags a bare fetch( call', () => {
    const findings = scanTextForRawFetch('some/file.ts', 'const r = await fetch(url);');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ file: 'some/file.ts', line: 1, kind: 'fetch' });
  });

  it('flags a static import from undici', () => {
    const findings = scanTextForRawFetch('some/file.ts', "import { Agent } from 'undici';");
    expect(findings.some((f) => f.kind === 'undici')).toBe(true);
  });

  it('flags a require of undici', () => {
    const findings = scanTextForRawFetch('some/file.ts', "const u = require('undici');");
    expect(findings.some((f) => f.kind === 'undici')).toBe(true);
  });

  it('does NOT flag a method call named fetch (obj.fetch())', () => {
    const findings = scanTextForRawFetch('some/file.ts', 'await deps.fetch(url);');
    expect(findings).toHaveLength(0);
  });

  it('does NOT flag safeFetch / createSafeFetchImpl', () => {
    const findings = scanTextForRawFetch(
      'some/file.ts',
      'await safeFetch(url, {}, deps);\nconst impl = createSafeFetchImpl();',
    );
    expect(findings).toHaveLength(0);
  });

  it('does NOT flag comments or strings mentioning fetch', () => {
    const findings = scanTextForRawFetch(
      'some/file.ts',
      "// use fetch( here later\nconst s = 'fetch(';",
    );
    expect(findings).toHaveLength(0);
  });

  it('ignores window.fetch-style property access with a leading dot', () => {
    const findings = scanTextForRawFetch('some/file.ts', 'globalThis.fetch(url);');
    expect(findings).toHaveLength(0);
  });

  it('does NOT flag fetch( or undici mentioned in a JSDoc block comment', () => {
    const src = [
      '/**',
      ' * A did:web resolver maps the DID to an HTTPS fetch( ... ).',
      ' * We could use undici here but do not.',
      ' */',
      'export const x = 1;',
    ].join('\n');
    expect(scanTextForRawFetch('some/file.ts', src)).toHaveLength(0);
  });

  it('still flags real code after a block comment closes on the same line', () => {
    const findings = scanTextForRawFetch(
      'some/file.ts',
      '/* comment fetch( */ const r = await fetch(u);',
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe('fetch');
  });
});

describe('isAllowlisted', () => {
  it('allows the reviewed mempool.space chain providers', () => {
    expect(isAllowlisted('chain/utxo-provider.ts')).toBe(true);
    expect(isAllowlisted('chain/fee-estimator.ts')).toBe(true);
  });

  it('allows the AI providers', () => {
    expect(isAllowlisted('ai/gemini.ts')).toBe(true);
    expect(isAllowlisted('ai/vertex-client.ts')).toBe(true);
  });

  it('allows the government-registry job fetchers', () => {
    expect(isAllowlisted('jobs/npiFetcher.ts')).toBe(true);
    expect(isAllowlisted('jobs/edgarFetcher.ts')).toBe(true);
  });

  it('allows OCSP/CRL/RFC3161 signature clients', () => {
    expect(isAllowlisted('signatures/pki/ocspClient.ts')).toBe(true);
    expect(isAllowlisted('signatures/timestamp/rfc3161Client.ts')).toBe(true);
  });

  it('does NOT allow an arbitrary new lib file', () => {
    expect(isAllowlisted('lib/some-new-egress.ts')).toBe(false);
  });

  it('the allow-list is non-empty and every entry is a string glob/prefix', () => {
    expect(RAW_FETCH_ALLOWLIST.length).toBeGreaterThan(0);
    for (const entry of RAW_FETCH_ALLOWLIST) {
      expect(typeof entry).toBe('string');
    }
  });
});

describe('finding shape', () => {
  it('carries file, line, kind, and text', () => {
    const findings: RawFetchFinding[] = scanTextForRawFetch(
      'x.ts',
      'a\nb\nconst r = await fetch(u);',
    );
    expect(findings[0]).toEqual({
      file: 'x.ts',
      line: 3,
      kind: 'fetch',
      text: 'const r = await fetch(u);',
    });
  });
});

describe('git binary', () => {
  it('uses a fixed git executable path by default, not a PATH lookup', () => {
    expect(GIT_BIN).toBe('/usr/bin/git');
  });
});
