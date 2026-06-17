import { describe, expect, it } from 'vitest';
import {
  compareRuntimeConfigs,
  type RuntimeConfig,
} from './runtimeParity.js';

const WORKER: RuntimeConfig = {
  runtime: 'worker',
  origin: 'https://arkova-worker-270018525501.us-central1.run.app',
  flags: { ENABLE_AI_FALLBACK: false, MAINTENANCE_MODE: false },
  bitcoinUtxoProvider: 'getblock',
};

const EDGE: RuntimeConfig = {
  runtime: 'edge',
  origin: 'https://edge.arkova.ai',
  flags: { ENABLE_AI_FALLBACK: false },
};

const CSP = [WORKER.origin, EDGE.origin];

describe('compareRuntimeConfigs', () => {
  it('reports no parity findings when the runtimes agree and CSP covers both', () => {
    expect(compareRuntimeConfigs(WORKER, EDGE, CSP)).toEqual([]);
  });

  it('catches a shared flag the two runtimes disagree on', () => {
    const edge = structuredClone(EDGE);
    edge.flags.ENABLE_AI_FALLBACK = true; // worker says false
    const findings = compareRuntimeConfigs(WORKER, edge, CSP);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('flag-disagreement');
    expect(findings[0].message).toContain('ENABLE_AI_FALLBACK');
  });

  it('catches a runtime origin missing from the CSP connect-src allowlist', () => {
    const findings = compareRuntimeConfigs(WORKER, EDGE, [WORKER.origin]); // edge origin absent
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('csp-unreachable-runtime');
    expect(findings[0].message).toContain(EDGE.origin);
  });

  it('does not flag flags that only one runtime declares', () => {
    // MAINTENANCE_MODE is worker-only; not a shared key => not compared.
    const findings = compareRuntimeConfigs(WORKER, EDGE, CSP);
    expect(findings.filter((f) => f.message.includes('MAINTENANCE_MODE'))).toEqual([]);
  });
});
