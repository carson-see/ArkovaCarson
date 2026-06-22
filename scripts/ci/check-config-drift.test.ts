import { describe, expect, it } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  diffConfigState,
  loadConfigFile,
  runConfigDriftCheck,
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

  it('catches a flag ENABLED in running but not pinned in asserted (fail-open / creep)', () => {
    const running = structuredClone(ASSERTED);
    (running.flags as Record<string, boolean>).ENABLE_AI_FRAUD = true;
    const drift = diffConfigState(ASSERTED, running);
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({ dimension: 'flag', key: 'ENABLE_AI_FRAUD', running: 'true' });
  });

  it('does not flag an unpinned running flag that is disabled (benign)', () => {
    const running = structuredClone(ASSERTED);
    (running.flags as Record<string, boolean>).ENABLE_AI_FRAUD = false;
    expect(diffConfigState(ASSERTED, running)).toEqual([]);
  });
});

describe('loadConfigFile (fail-closed)', () => {
  it('throws on a degraded config (empty flags / provider / CSP)', () => {
    const bad = join(mkdtempSync(join(tmpdir(), 'cfgdrift-')), 'bad.json');
    writeFileSync(bad, JSON.stringify({ flags: {}, bitcoinUtxoProvider: '', cspConnectSrc: [] }));
    expect(() => loadConfigFile(bad)).toThrow();
  });

  it('throws on invalid JSON', () => {
    const bad = join(mkdtempSync(join(tmpdir(), 'cfgdrift-')), 'bad.json');
    writeFileSync(bad, '{ not json');
    expect(() => loadConfigFile(bad)).toThrow();
  });
});

describe('runConfigDriftCheck (parity off running runtimes)', () => {
  const mk = (edgeFlag: boolean) => ({
    flags: { ENABLE_PROD_NETWORK_ANCHORING: true },
    bitcoinUtxoProvider: 'getblock',
    cspConnectSrc: ['https://w', 'https://e'],
    runtimes: {
      worker: { runtime: 'worker' as const, origin: 'https://w', flags: { F: false }, bitcoinUtxoProvider: 'getblock' },
      edge: { runtime: 'edge' as const, origin: 'https://e', flags: { F: edgeFlag } },
    },
  });

  it('surfaces a parity finding when the running runtimes disagree on a shared flag', () => {
    const { drift, parity } = runConfigDriftCheck(mk(false), mk(true));
    expect(drift).toEqual([]);
    expect(parity.some((p) => p.kind === 'flag-disagreement')).toBe(true);
  });

  it('returns empty parity when neither asserted nor running declare runtimes', () => {
    const { parity } = runConfigDriftCheck(ASSERTED, structuredClone(ASSERTED));
    expect(parity).toEqual([]);
  });

  it('surfaces config drift end-to-end through runConfigDriftCheck (not just the pure differ)', () => {
    const asserted = mk(false);
    const running = mk(false);
    running.bitcoinUtxoProvider = 'mempool'; // inject the provider SPOF regression
    const { drift } = runConfigDriftCheck(asserted, running);
    expect(drift.some((d) => d.dimension === 'provider')).toBe(true);
  });
});
