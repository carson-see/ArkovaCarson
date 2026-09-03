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

  // The raw Cloud Run host (no arkova.* vanity domain) is still an
  // Arkova-operated endpoint — it's the SDK's DEFAULT_BASE_URL
  // (packages/sdk/src/client.ts). A caller who typos or copy-pastes it into
  // --rpc would otherwise route the "independent" confirmation straight back
  // through Arkova's own worker, defeating the whole point of this guard.
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
});
