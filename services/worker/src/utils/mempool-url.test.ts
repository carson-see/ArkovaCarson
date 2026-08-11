/**
 * Tests for the MEMPOOL_API_URL /api contract fix (SCRUM-3016 / BUG-2026-07-26-003).
 *
 * See mempool-url.ts's module docstring for the full incident writeup. Short
 * version: five call sites read `config.mempoolApiUrl` (the raw
 * MEMPOOL_API_URL env var) and disagreed on whether it already includes a
 * trailing `/api` segment. No single value satisfied all five, and this
 * froze 2 isolated soak rigs for ~24h before being root-caused.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  MEMPOOL_API_BASES,
  mempoolApiBaseForNetwork,
  normalizeMempoolHostUrl,
  resolveMempoolApiBase,
  resolveMempoolHostBase,
} from './mempool-url.js';
import { createUtxoProvider } from '../chain/utxo-provider.js';
import { createFeeEstimator, MempoolFeeEstimator } from '../chain/fee-estimator.js';

// The parity test imports the REAL createUtxoProvider; stub its logging and
// Sentry edges the same way src/chain/utxo-provider.test.ts does, so the test
// exercises URL construction without pulling in the Sentry SDK.
vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('./sentry.js', () => ({
  emitRpcFallback: vi.fn(),
}));

describe('normalizeMempoolHostUrl', () => {
  it('returns undefined for an unset value', () => {
    expect(normalizeMempoolHostUrl(undefined)).toBeUndefined();
  });

  it('treats an empty string as unset', () => {
    expect(normalizeMempoolHostUrl('')).toBeUndefined();
  });

  it('leaves a bare host untouched', () => {
    expect(normalizeMempoolHostUrl('https://mempool.space')).toBe('https://mempool.space');
  });

  it('strips a trailing slash', () => {
    expect(normalizeMempoolHostUrl('https://mempool.space/')).toBe('https://mempool.space');
  });

  it('strips a trailing /api segment', () => {
    expect(normalizeMempoolHostUrl('https://mempool.space/api')).toBe('https://mempool.space');
  });

  it('strips a trailing /api/ (segment + slash)', () => {
    expect(normalizeMempoolHostUrl('https://mempool.space/api/')).toBe('https://mempool.space');
  });

  it('preserves a network-suffixed path that is not /api', () => {
    expect(normalizeMempoolHostUrl('https://mempool.space/signet')).toBe(
      'https://mempool.space/signet',
    );
  });

  it('strips a trailing /api after a network-suffixed path', () => {
    expect(normalizeMempoolHostUrl('https://mempool.space/signet/api')).toBe(
      'https://mempool.space/signet',
    );
  });

  it('does not strip "/api" as a mid-path substring, only a trailing segment', () => {
    expect(normalizeMempoolHostUrl('https://api.example.com')).toBe('https://api.example.com');
  });
});

describe('resolveMempoolApiBase (for consumers that append no further /api themselves)', () => {
  it('falls back verbatim when unset', () => {
    expect(resolveMempoolApiBase(undefined, 'https://mempool.space/api')).toBe(
      'https://mempool.space/api',
    );
  });

  it('falls back verbatim on an empty string', () => {
    expect(resolveMempoolApiBase('', 'https://mempool.space/api')).toBe(
      'https://mempool.space/api',
    );
  });

  it('appends /api when the operator set a bare host', () => {
    expect(resolveMempoolApiBase('https://mempool.space', 'https://mempool.space/api')).toBe(
      'https://mempool.space/api',
    );
  });

  it('does not double up /api when the operator already included it', () => {
    expect(resolveMempoolApiBase('https://mempool.space/api', 'https://mempool.space/api')).toBe(
      'https://mempool.space/api',
    );
  });

  it('normalizes a trailing slash before appending /api', () => {
    expect(resolveMempoolApiBase('https://mempool.space/', 'https://mempool.space/api')).toBe(
      'https://mempool.space/api',
    );
  });

  it('produces the SAME result regardless of which of the two conventions the operator used (the actual incident)', () => {
    const withApi = resolveMempoolApiBase('https://custom.example.com/api', 'https://mempool.space/api');
    const withoutApi = resolveMempoolApiBase('https://custom.example.com', 'https://mempool.space/api');
    expect(withApi).toBe(withoutApi);
    expect(withApi).toBe('https://custom.example.com/api');
  });
});

describe('resolveMempoolHostBase (for consumers that append /api/... themselves)', () => {
  it('falls back verbatim when unset', () => {
    expect(resolveMempoolHostBase(undefined, 'https://mempool.space')).toBe('https://mempool.space');
  });

  it('returns a bare host unchanged when the operator set one', () => {
    expect(resolveMempoolHostBase('https://custom.example.com', 'https://mempool.space')).toBe(
      'https://custom.example.com',
    );
  });

  it('strips a trailing /api when the operator included it (the actual incident, other direction)', () => {
    expect(resolveMempoolHostBase('https://custom.example.com/api', 'https://mempool.space')).toBe(
      'https://custom.example.com',
    );
  });

  it('produces the SAME result regardless of which of the two conventions the operator used', () => {
    const withApi = resolveMempoolHostBase('https://custom.example.com/api', 'https://mempool.space');
    const withoutApi = resolveMempoolHostBase('https://custom.example.com', 'https://mempool.space');
    expect(withApi).toBe(withoutApi);
    expect(withApi).toBe('https://custom.example.com');
  });
});

/**
 * BUG-2026-08-11 — per-network base selection.
 *
 * SCRUM-3016 unified the /api CONVENTION across consumers but left each one
 * owning its own DEFAULT. `chain/utxo-provider.ts` selected that default
 * per-network from a private MEMPOOL_URLS map; `jobs/treasury-cache.ts`
 * hardcoded the mainnet base. On a signet deployment the treasury job asked
 * the mainnet explorer about a signet address, got HTTP 400, and silently
 * booked a zero balance — which made treasury-alert fire continuously.
 *
 * The map now lives here, so "which base for this network" has exactly one
 * answer for every consumer.
 */
describe('mempoolApiBaseForNetwork', () => {
  it.each([
    ['signet', 'https://mempool.space/signet/api'],
    ['testnet4', 'https://mempool.space/testnet4/api'],
    ['testnet', 'https://mempool.space/testnet/api'],
    ['mainnet', 'https://mempool.space/api'],
  ])('maps %s to its own explorer base', (network, expected) => {
    expect(mempoolApiBaseForNetwork(network)).toBe(expected);
  });

  it('every base already carries the /api segment this convention requires', () => {
    for (const base of Object.values(MEMPOOL_API_BASES)) {
      expect(base.endsWith('/api')).toBe(true);
    }
  });

  it('only mainnet maps to the bare mainnet base', () => {
    const mainnetBases = Object.entries(MEMPOOL_API_BASES)
      .filter(([, base]) => base === 'https://mempool.space/api')
      .map(([network]) => network);
    expect(mainnetBases).toEqual(['mainnet']);
  });

  it('falls back to mainnet for an unrecognised network', () => {
    // config.bitcoinNetwork is a 4-value zod enum, so this is unreachable in
    // practice; pinned so the fallback can't silently become something else.
    expect(mempoolApiBaseForNetwork('regtest')).toBe('https://mempool.space/api');
    expect(mempoolApiBaseForNetwork(undefined)).toBe('https://mempool.space/api');
  });

  it('round-trips through resolveMempoolApiBase unchanged', () => {
    // The helper output is itself a valid input to the /api normalizer, so a
    // consumer can pass it as the fallback without double-appending.
    for (const base of Object.values(MEMPOOL_API_BASES)) {
      expect(resolveMempoolApiBase(base, 'https://mempool.space/api')).toBe(base);
    }
  });
});

/**
 * The ratchet. A human census of "who builds a mempool URL" is what missed
 * this bug for the life of the job; this asserts the invariant behaviourally
 * instead — for every network, the base this module hands out must be the one
 * the real `createUtxoProvider` actually requests against. If either side
 * changes its map alone, this fails.
 */
describe('parity with the real createUtxoProvider (BUG-2026-08-11 ratchet)', () => {
  it.each(['signet', 'testnet4', 'testnet', 'mainnet'])(
    'createUtxoProvider requests the shared %s base',
    async (network) => {
      const seen: string[] = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (url: string) => {
        seen.push(String(url));
        return { ok: true, json: async () => [] };
      }) as unknown as typeof fetch;

      try {
        const provider = createUtxoProvider({ type: 'mempool', network });
        await provider.listUnspent('tb1qexampleaddress');
      } finally {
        globalThis.fetch = originalFetch;
      }

      expect(seen).toHaveLength(1);
      expect(seen[0]).toBe(
        `${mempoolApiBaseForNetwork(network)}/address/tb1qexampleaddress/utxo`,
      );
    },
  );
});

/**
 * The same ratchet for the fee path. `createFeeEstimator` was the last
 * consumer still resolving against a private hardcoded mainnet constant with
 * no `network` input at all (BUG-2026-08-11, second half), so a signet
 * deployment on `strategy: 'mempool'` read MAINNET fee rates. Asserting it
 * behaviourally here — rather than trusting a reading of the factory — is
 * what keeps the two maps from drifting apart again.
 */
describe('parity with the real createFeeEstimator (BUG-2026-08-11 ratchet)', () => {
  it.each(['signet', 'testnet4', 'testnet', 'mainnet'])(
    'createFeeEstimator requests the shared %s base',
    async (network) => {
      const seen: string[] = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (url: string) => {
        seen.push(String(url));
        return { ok: true, json: async () => ({ halfHourFee: 7 }) };
      }) as unknown as typeof fetch;

      try {
        const estimator = createFeeEstimator({ strategy: 'mempool', network });
        await estimator.estimateFee();
      } finally {
        globalThis.fetch = originalFetch;
      }

      expect(seen).toHaveLength(1);
      expect(seen[0]).toBe(
        `${mempoolApiBaseForNetwork(network)}/v1/fees/recommended`,
      );
    },
  );
});

/**
 * The ratchet that was missing, and the reason four call sites survived the
 * first pass of this fix.
 *
 * Both ratchets above drive FACTORIES. But `MempoolFeeEstimator` is also
 * constructed directly — `jobs/anchor.ts` (ECON-1 fee ceiling),
 * `jobs/feeAwareScheduler.ts` (submit/defer gate, x2) and
 * `middleware/x402PaymentGate.ts` (anchor pricing) all do it. Fixing only
 * `createFeeEstimator` left every one of those pinned to mainnet while the
 * factory ratchet stayed green, which is exactly the false assurance a
 * ratchet is supposed to prevent.
 *
 * So: assert the CLASS default too, not just the factory's.
 */
describe('parity with a directly-constructed MempoolFeeEstimator (BUG-2026-08-11)', () => {
  it.each(['signet', 'testnet4', 'testnet', 'mainnet'])(
    'new MempoolFeeEstimator({ network: %s }) requests the shared base',
    async (network) => {
      const seen: string[] = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (url: string) => {
        seen.push(String(url));
        return { ok: true, json: async () => ({ halfHourFee: 7 }) };
      }) as unknown as typeof fetch;

      try {
        await new MempoolFeeEstimator({ network }).estimateFee();
      } finally {
        globalThis.fetch = originalFetch;
      }

      expect(seen).toHaveLength(1);
      expect(seen[0]).toBe(
        `${mempoolApiBaseForNetwork(network)}/v1/fees/recommended`,
      );
    },
  );
});

/**
 * Guard the shared map itself: it is exported and reachable from several
 * modules, so an accidental write would silently repoint every consumer at
 * once. Frozen at the source; this pins that.
 */
describe('MEMPOOL_API_BASES is immutable', () => {
  it('cannot be repointed by a consumer', () => {
    expect(Object.isFrozen(MEMPOOL_API_BASES)).toBe(true);

    const before = MEMPOOL_API_BASES.signet;
    try {
      (MEMPOOL_API_BASES as Record<string, string>).signet = 'https://evil.test/api';
    } catch {
      // strict-mode TypeError is an acceptable outcome; silent no-op is too.
    }
    expect(MEMPOOL_API_BASES.signet).toBe(before);
  });
});
