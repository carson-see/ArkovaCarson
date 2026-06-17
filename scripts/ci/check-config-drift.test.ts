import { describe, expect, it } from 'vitest';
import {
  diffConfigState,
  type ConfigState,
} from './check-config-drift.js';

// Asserted = what the repo (config.ts defaults + deploy-worker.yml env + vercel.json CSP)
// SAYS prod should be. Running = what /health + a flag snapshot REPORTS prod actually is.
const ASSERTED: ConfigState = {
  flags: {
    ENABLE_PROD_NETWORK_ANCHORING: true,
    ENABLE_AI_EXTRACTION: true,
    ENABLE_VERIFICATION_API: true,
    ENABLE_SEMANTIC_SEARCH: false,
  },
  bitcoinUtxoProvider: 'getblock',
  bitcoinFeeStrategy: 'mempool',
  cspConnectSrc: [
    'https://arkova-worker-270018525501.us-central1.run.app',
    'https://edge.arkova.ai',
  ],
};

describe('diffConfigState', () => {
  it('reports no drift when running matches asserted', () => {
    const running: ConfigState = structuredClone(ASSERTED);
    expect(diffConfigState(ASSERTED, running)).toEqual([]);
  });

  it('catches a flipped provider (the mempool.space SPOF regression)', () => {
    const running = structuredClone(ASSERTED);
    running.bitcoinUtxoProvider = 'mempool';
    const drift = diffConfigState(ASSERTED, running);
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({
      dimension: 'provider',
      key: 'bitcoinUtxoProvider',
      asserted: 'getblock',
      running: 'mempool',
    });
  });

  it('catches a fail-open flag silently re-enabled (env-vs-DB divergence)', () => {
    const running = structuredClone(ASSERTED);
    running.flags.ENABLE_SEMANTIC_SEARCH = true; // asserted OFF, running ON
    const drift = diffConfigState(ASSERTED, running);
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({
      dimension: 'flag',
      key: 'ENABLE_SEMANTIC_SEARCH',
      asserted: 'false',
      running: 'true',
    });
  });

  it('catches a launch-critical flag turned off', () => {
    const running = structuredClone(ASSERTED);
    running.flags.ENABLE_PROD_NETWORK_ANCHORING = false;
    const drift = diffConfigState(ASSERTED, running);
    expect(drift.map((d) => d.key)).toContain('ENABLE_PROD_NETWORK_ANCHORING');
  });

  it('treats a missing running flag as drift (cannot confirm => fail closed)', () => {
    const running = structuredClone(ASSERTED);
    delete (running.flags as Record<string, boolean>).ENABLE_AI_EXTRACTION;
    const drift = diffConfigState(ASSERTED, running);
    expect(drift.map((d) => d.key)).toContain('ENABLE_AI_EXTRACTION');
  });

  it('catches a CSP connect-src origin missing from running (a runtime becomes unreachable)', () => {
    const running = structuredClone(ASSERTED);
    running.cspConnectSrc = running.cspConnectSrc.filter((o) => o !== 'https://edge.arkova.ai');
    const drift = diffConfigState(ASSERTED, running);
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({ dimension: 'csp', key: 'https://edge.arkova.ai' });
  });

  it('catches an unexpected CSP connect-src origin in running (allowlist creep)', () => {
    const running = structuredClone(ASSERTED);
    running.cspConnectSrc = [...running.cspConnectSrc, 'https://evil.example.com'];
    const drift = diffConfigState(ASSERTED, running);
    expect(drift.map((d) => d.key)).toContain('https://evil.example.com');
  });

  it('accumulates multiple drifts across dimensions', () => {
    const running = structuredClone(ASSERTED);
    running.bitcoinUtxoProvider = 'mempool';
    running.flags.ENABLE_SEMANTIC_SEARCH = true;
    const drift = diffConfigState(ASSERTED, running);
    expect(drift).toHaveLength(2);
    expect(new Set(drift.map((d) => d.dimension))).toEqual(new Set(['provider', 'flag']));
  });
});
