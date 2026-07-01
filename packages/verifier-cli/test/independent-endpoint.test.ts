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

  it('rejects an invalid URL', () => {
    expect(() => assertIndependentEndpoint('not a url')).toThrow(/Invalid --rpc/);
  });
});
