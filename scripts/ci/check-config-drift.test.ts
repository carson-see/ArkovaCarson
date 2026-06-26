import { describe, expect, it } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyFlagSpofFindings,
  diffConfigState,
  loadConfigFile,
  runConfigDriftCheck,
  type ConfigState,
} from './check-config-drift.js';
import { runFlagSpofCheck, type FlagSpofFinding } from './config-drift/flagSpof.js';

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

// S1 Lane-2: the gate's two-tier acknowledgment of flag-SPOF findings. This is the seam
// main() uses to decide blocking vs non-blocking — the env↔DB fail-open regression guard.
describe('classifyFlagSpofFindings (Lane-2 two-tier)', () => {
  const failOpen = (flag: string): FlagSpofFinding => ({
    severity: 'error',
    code: 'fail-open-flag',
    flag,
    message: `${flag} env on / asserted off / DB-backed`,
  });
  const launchOff: FlagSpofFinding = {
    severity: 'error',
    code: 'launch-flag-off',
    flag: 'ENABLE_AI_EXTRACTION',
    message: 'launch flag off',
  };
  const noGuard: FlagSpofFinding = {
    severity: 'error',
    code: 'env-flag-on-no-db-guard',
    flag: 'ENABLE_DEMO_INJECTOR',
    message: 'no db guard',
  };

  it('treats an ACKNOWLEDGED fail-open flag as a non-blocking warning (the known DB-guarded hazard)', () => {
    const { errors, warnings } = classifyFlagSpofFindings(
      [failOpen('ENABLE_SEMANTIC_SEARCH'), failOpen('ENABLE_AI_FRAUD')],
      ['ENABLE_SEMANTIC_SEARCH', 'ENABLE_AI_FRAUD'],
    );
    expect(errors).toEqual([]);
    expect(warnings).toHaveLength(2);
  });

  it('FAILS CLOSED on a NEW, unacknowledged fail-open flag (the regression guard)', () => {
    const { errors, warnings } = classifyFlagSpofFindings(
      [failOpen('ENABLE_SEMANTIC_SEARCH'), failOpen('ENABLE_AI_REPORTS')], // 2nd not acknowledged
      ['ENABLE_SEMANTIC_SEARCH'],
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: 'fail-open-flag', flag: 'ENABLE_AI_REPORTS' });
    expect(warnings.map((w) => w.flag)).toEqual(['ENABLE_SEMANTIC_SEARCH']);
  });

  it('NEVER lets an acknowledgment downgrade a launch-flag-off or env-flag-on-no-db-guard finding', () => {
    // Even if someone (wrongly) lists these flags as acknowledged, only fail-open-flag is
    // downgradable — a launch flag being off / an env-on flag with no DB guard always blocks.
    const { errors, warnings } = classifyFlagSpofFindings(
      [launchOff, noGuard],
      ['ENABLE_AI_EXTRACTION', 'ENABLE_DEMO_INJECTOR'],
    );
    expect(warnings).toEqual([]);
    expect(errors).toHaveLength(2);
    expect(new Set(errors.map((e) => e.code))).toEqual(
      new Set(['launch-flag-off', 'env-flag-on-no-db-guard']),
    );
  });

  it('is empty/empty when there are no findings (clean config passes)', () => {
    expect(classifyFlagSpofFindings([], ['ENABLE_SEMANTIC_SEARCH'])).toEqual({
      errors: [],
      warnings: [],
    });
  });
});

// End-to-end: the REAL flag-SPOF source parse (deploy-worker.yml + flagRegistry.ts) fed
// through the REAL two-tier classifier — the exact path main() runs. Proves the wiring,
// not just the helper: with the live acknowledgment the gate is GREEN; drop it and the
// live env↔DB fail-open hazard FAILS CLOSED.
describe('flag-SPOF wiring end-to-end (real tree)', () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const sources = {
    deployYmlPath: resolve(repoRoot, '.github/workflows/deploy-worker.yml'),
    flagRegistryPath: resolve(repoRoot, 'services/worker/src/middleware/flagRegistry.ts'),
  };
  // The asserted EFFECTIVE state (mirrors expected-prod-config.json `flags`).
  const assertedFlags = {
    ENABLE_PROD_NETWORK_ANCHORING: true,
    ENABLE_AI_EXTRACTION: true,
    ENABLE_VERIFICATION_API: true,
    ENABLE_SEMANTIC_SEARCH: false,
    ENABLE_AI_FRAUD: false,
  };

  it('passes (no blocking errors) with the live acknowledgment list — the known hazards are warnings', () => {
    const findings = runFlagSpofCheck(assertedFlags, sources);
    const { errors, warnings } = classifyFlagSpofFindings(findings, [
      'ENABLE_SEMANTIC_SEARCH',
      'ENABLE_AI_FRAUD',
    ]);
    expect(errors).toEqual([]);
    expect(warnings.length).toBeGreaterThanOrEqual(2); // the two live fail-open flags
  });

  it('FAILS CLOSED on the live env↔DB fail-open hazard when nothing is acknowledged', () => {
    const findings = runFlagSpofCheck(assertedFlags, sources);
    const { errors } = classifyFlagSpofFindings(findings, []); // acknowledge nothing
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(new Set(errors.map((e) => e.flag))).toEqual(
      new Set(['ENABLE_SEMANTIC_SEARCH', 'ENABLE_AI_FRAUD']),
    );
    for (const e of errors) expect(e.code).toBe('fail-open-flag');
  });
});
