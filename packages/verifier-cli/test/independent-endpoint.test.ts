import { describe, it, expect } from 'vitest';
import { assertIndependentEndpoint, DEFAULT_ESPLORA } from '../src/lib/independent-endpoint.js';

describe('independent-node guard', () => {
  it('accepts a third-party Esplora endpoint', () => {
    expect(() => assertIndependentEndpoint(DEFAULT_ESPLORA)).not.toThrow();
    expect(() => assertIndependentEndpoint('https://mempool.space/api')).not.toThrow();
    expect(() => assertIndependentEndpoint('http://127.0.0.1:3000')).not.toThrow();
  });

  it('returns the parsed URL with its hostname (used as the report label)', () => {
    const url = assertIndependentEndpoint('https://blockstream.info/api');
    expect(url.hostname).toBe('blockstream.info');
  });

  it('REFUSES any Arkova-operated host (cannot route confirmation back to us)', () => {
    for (const host of [
      'https://api.arkova.io',
      'https://app.arkova.ai/api',
      'https://arkova.com/esplora',
      'https://edge.arkova.dev',
    ]) {
      expect(() => assertIndependentEndpoint(host), host).toThrow(/Arkova-operated/);
    }
  });

  // 2026-09-21 review (#3035): packages/sdk's DEFAULT_BASE_URL and
  // packages/embed's DEFAULT_API_BASE moved from the raw Cloud Run host to
  // the public gateway `https://api.arkova.ai`. `ARKOVA_HOST_RE`'s
  // `(^|\.)arkova\.(io|ai|com|app|dev)$` suffix match already covers every
  // `*.arkova.ai` subdomain (verified: `api.`, `edge.`, `app.`, `search.`
  // all match — this is a suffix anchor, not a fixed subdomain list), so
  // this was not actually a gap. Explicit regression coverage for the exact
  // hostnames the review asked about, so a future edit to the regex that
  // narrowed it (e.g. to only `app.arkova.ai`) would be caught here
  // directly rather than only by the broader tests above.
  it('REFUSES the public API gateway and its sibling subdomains (api./edge./app./search.arkova.ai)', () => {
    for (const host of [
      'https://api.arkova.ai',
      'https://api.arkova.ai/api/v1/verify',
      'https://edge.arkova.ai',
      'https://app.arkova.ai',
      'https://search.arkova.ai',
    ]) {
      expect(() => assertIndependentEndpoint(host), host).toThrow(/Arkova-operated/);
    }
  });

  // The raw Cloud Run host (no arkova.* vanity domain) is still a live,
  // directly reachable Arkova-operated endpoint (CLAUDE.md §1.1: it answers
  // publicly and unauthenticated, nothing in front of it) — even though
  // packages/sdk/src/client.ts's DEFAULT_BASE_URL no longer defaults to it
  // as of 2026-09-21 (see the source file's comment on CLOUD_RUN_HOST_RE).
  // A caller who typos or copy-pastes the raw host into --rpc would
  // otherwise route the "independent" confirmation straight back through
  // Arkova's own worker, defeating the whole point of this guard.
  it('REFUSES any *.run.app host (the raw Cloud Run host is an Arkova endpoint)', () => {
    for (const host of [
      'https://arkova-worker-270018525501.us-central1.run.app',
      'https://arkova-worker-staging-270018525501.us-central1.run.app',
      'https://some-other-service-270018525501.us-central1.run.app',
    ]) {
      expect(() => assertIndependentEndpoint(host), host).toThrow(/Arkova-operated/);
    }
  });

  it('rejects an invalid URL', () => {
    expect(() => assertIndependentEndpoint('not a url')).toThrow(/Invalid --rpc/);
  });

  it('refuses operator hosts with a DNS root dot', () => {
    for (const endpoint of [
      'https://arkova-worker-270018525501.us-central1.run.app./api',
      'https://app.arkova.ai./api',
    ]) {
      expect(() => assertIndependentEndpoint(endpoint), endpoint).toThrow(/Arkova-operated/);
    }
  });

  // SCRUM-4463: the trailing-root-dot normalization and the case-insensitive
  // host match must both be scoped to the operator-host policy, not turn into
  // a blanket "reject any host with a root dot / any-case host" rule. A
  // third-party host that merely LOOKS like an Arkova host after case-folding
  // or dot-stripping (it doesn't here — these are plain non-Arkova examples)
  // must still be accepted, and an all-uppercase Arkova host must still be
  // refused so the `/i` flag on ARKOVA_HOST_RE is exercised directly (the
  // pre-existing REFUSES tests above are all lowercase).
  it('accepts a third-party host with a DNS root dot (example.com.)', () => {
    const url = assertIndependentEndpoint('https://example.com./api');
    expect(url.hostname).toBe('example.com.');
  });

  it('accepts an upper-case third-party host (EXAMPLE.COM)', () => {
    // WHATWG URL parsing lower-cases hostname on the way in — the input is
    // 'EXAMPLE.COM' (per the ticket), the assertion is on the parsed,
    // normalized form the guard actually evaluates.
    const url = assertIndependentEndpoint('https://EXAMPLE.COM/api');
    expect(url.hostname).toBe('example.com');
  });

  it('REFUSES an upper-case Arkova host, root dot and all (EXAMPLE case: APP.ARKOVA.AI.)', () => {
    expect(() => assertIndependentEndpoint('https://APP.ARKOVA.AI./api')).toThrow(/Arkova-operated/);
  });
});
