import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkFlagSpof,
  parseDeployedFlags,
  parseDbFlagNames,
  type FlagSpofInputs,
} from './flagSpof.js';

// S1 hardening — Lane-2 half of the config-drift gate (config-drift/README item #5 /
// VIS-01 fail-open class). The DB-backed flag registry (flagRegistry.ts) falls back to
// `process.env[KEY] === 'true'` whenever a switchboard_flags row is ABSENT. So a flag
// whose intended EFFECTIVE prod value is `false` (DB-gated OFF) but whose deploy env var
// is `true` fails OPEN to `true` the moment the DB row is missing — the exact 2026-05-30
// env↔DB fail-open hazard. This check parses the REAL deploy-worker.yml + the REAL
// flagRegistry DB-flag list so that hazard fails CI, not prod.
describe('checkFlagSpof (pure)', () => {
  // ENABLE_SEMANTIC_SEARCH / ENABLE_AI_FRAUD are DB-backed flags (kill-switch class).
  const dbFlags = new Set(['ENABLE_AI_EXTRACTION', 'ENABLE_SEMANTIC_SEARCH', 'ENABLE_AI_FRAUD']);

  function mk(over: Partial<FlagSpofInputs> = {}): FlagSpofInputs {
    return {
      assertedFlags: {
        ENABLE_AI_EXTRACTION: true, // launch-required (§1.6 default true in prod)
        ENABLE_SEMANTIC_SEARCH: false, // DB-gated OFF (fail-open hazard if env ON)
        ENABLE_AI_FRAUD: false, // DB-gated OFF (fail-open hazard if env ON)
      },
      deployedFlags: {
        ENABLE_AI_EXTRACTION: true,
        ENABLE_SEMANTIC_SEARCH: true, // env ON, asserted OFF → fail-open
        ENABLE_AI_FRAUD: true, // env ON, asserted OFF → fail-open
      },
      dbFlagNames: dbFlags,
      ...over,
    };
  }

  it('ERRORS (fail-open) when a DB-gated flag is asserted OFF but the deploy env sets it true', () => {
    // This is the LIVE deploy state: ENABLE_SEMANTIC_SEARCH=true && ENABLE_AI_FRAUD=true,
    // both asserted effective=false. Each depends on a DB row to stay OFF → fail-open.
    const f = checkFlagSpof(mk());
    const failOpen = f.filter((x) => x.code === 'fail-open-flag');
    expect(failOpen).toHaveLength(2);
    expect(new Set(failOpen.map((x) => x.flag))).toEqual(
      new Set(['ENABLE_SEMANTIC_SEARCH', 'ENABLE_AI_FRAUD']),
    );
    for (const x of failOpen) expect(x.severity).toBe('error');
  });

  it('is SAFE when a DB-gated flag is asserted OFF and the deploy env also sets it false', () => {
    const f = checkFlagSpof(
      mk({ deployedFlags: { ENABLE_AI_EXTRACTION: true, ENABLE_SEMANTIC_SEARCH: false, ENABLE_AI_FRAUD: false } }),
    );
    expect(f).toEqual([]);
  });

  it('ERRORS (launch-flag-off) when a launch-required flag is asserted ON but the deploy env sets it false', () => {
    const f = checkFlagSpof(
      mk({
        assertedFlags: { ENABLE_AI_EXTRACTION: true, ENABLE_SEMANTIC_SEARCH: false, ENABLE_AI_FRAUD: false },
        deployedFlags: { ENABLE_AI_EXTRACTION: false, ENABLE_SEMANTIC_SEARCH: false, ENABLE_AI_FRAUD: false },
      }),
    );
    const launch = f.filter((x) => x.code === 'launch-flag-off');
    expect(launch).toHaveLength(1);
    expect(launch[0]).toMatchObject({ severity: 'error', flag: 'ENABLE_AI_EXTRACTION' });
  });

  it('ERRORS (launch-flag-off) when a launch-required flag is asserted ON but the deploy env OMITS it', () => {
    const f = checkFlagSpof(
      mk({
        assertedFlags: { ENABLE_AI_EXTRACTION: true, ENABLE_SEMANTIC_SEARCH: false, ENABLE_AI_FRAUD: false },
        deployedFlags: { ENABLE_SEMANTIC_SEARCH: false, ENABLE_AI_FRAUD: false }, // AI_EXTRACTION absent
      }),
    );
    expect(f.filter((x) => x.code === 'launch-flag-off').map((x) => x.flag)).toContain(
      'ENABLE_AI_EXTRACTION',
    );
  });

  it('ERRORS (env-flag-on-no-db-guard) when a non-DB flag is asserted OFF but the deploy env sets it true (worse than fail-open — no kill switch)', () => {
    const f = checkFlagSpof({
      assertedFlags: {
        ENABLE_AI_EXTRACTION: true,
        ENABLE_SEMANTIC_SEARCH: false,
        ENABLE_AI_FRAUD: false,
        ENABLE_DEMO_INJECTOR: false, // asserted OFF, NOT a DB flag
      },
      deployedFlags: {
        ENABLE_AI_EXTRACTION: true,
        ENABLE_SEMANTIC_SEARCH: false,
        ENABLE_AI_FRAUD: false,
        ENABLE_DEMO_INJECTOR: true, // env ON, no DB kill switch can hold it OFF
      },
      dbFlagNames: dbFlags,
    });
    const noGuard = f.filter((x) => x.code === 'env-flag-on-no-db-guard');
    expect(noGuard).toHaveLength(1);
    expect(noGuard[0]).toMatchObject({ severity: 'error', flag: 'ENABLE_DEMO_INJECTOR' });
  });

  it('returns no findings on a fully aligned, fail-safe deploy', () => {
    const f = checkFlagSpof({
      assertedFlags: { ENABLE_AI_EXTRACTION: true },
      deployedFlags: { ENABLE_AI_EXTRACTION: true },
      dbFlagNames: dbFlags,
    });
    expect(f).toEqual([]);
  });
});

describe('parseDeployedFlags (deploy-worker.yml --set-env-vars)', () => {
  it('parses ENABLE_* boolean env vars out of the ^||^-delimited --set-env-vars line', () => {
    const yml =
      '--set-env-vars "^||^NODE_ENV=production||ENABLE_AI_EXTRACTION=true||ENABLE_SEMANTIC_SEARCH=true||ENABLE_AI_FRAUD=true||USE_MOCKS=false"';
    const flags = parseDeployedFlags(yml);
    expect(flags.ENABLE_AI_EXTRACTION).toBe(true);
    expect(flags.ENABLE_SEMANTIC_SEARCH).toBe(true);
    expect(flags.ENABLE_AI_FRAUD).toBe(true);
  });

  it('throws (fail closed) when the deploy has no parseable --set-env-vars ENABLE_ flags', () => {
    expect(() => parseDeployedFlags('--cpu 2 --memory 2Gi')).toThrow();
  });

  it('omits a flag the deploy does not set (absent ≠ false in the map)', () => {
    const yml = '--set-env-vars "^||^NODE_ENV=production||ENABLE_AI_EXTRACTION=true"';
    const flags = parseDeployedFlags(yml);
    expect('ENABLE_SEMANTIC_SEARCH' in flags).toBe(false);
  });
});

describe('parseDbFlagNames (flagRegistry.ts DB_FLAGS)', () => {
  it('parses the DB_FLAGS array from flagRegistry source', () => {
    const src = `const DB_FLAGS = [\n  'ENABLE_VERIFICATION_API',\n  'ENABLE_AI_EXTRACTION',\n  'ENABLE_SEMANTIC_SEARCH',\n  'ENABLE_AI_FRAUD',\n] as const;`;
    const names = parseDbFlagNames(src);
    expect(names.has('ENABLE_AI_EXTRACTION')).toBe(true);
    expect(names.has('ENABLE_SEMANTIC_SEARCH')).toBe(true);
    expect(names.has('ENABLE_AI_FRAUD')).toBe(true);
    expect(names.has('ENABLE_PROD_NETWORK_ANCHORING')).toBe(false); // env flag, not DB
  });

  it('throws (fail closed) when DB_FLAGS cannot be parsed', () => {
    expect(() => parseDbFlagNames('no db flags array here')).toThrow();
  });
});

// Smoke test against the REAL tree — documents the LIVE fail-open hazard:
// deploy-worker.yml sets ENABLE_SEMANTIC_SEARCH=true and ENABLE_AI_FRAUD=true, both of
// which the asserted manifest pins effective=false. flagRegistry.ts classifies both as
// DB-backed. This is exactly the env↔DB delta the gate must now catch.
describe('flag-SPOF on the real tree (current-state smoke)', () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

  it('deploy-worker.yml sets ENABLE_SEMANTIC_SEARCH=true and ENABLE_AI_FRAUD=true (the fail-open env state is live)', () => {
    const yml = readFileSync(resolve(repoRoot, '.github/workflows/deploy-worker.yml'), 'utf8');
    const flags = parseDeployedFlags(yml);
    expect(flags.ENABLE_SEMANTIC_SEARCH).toBe(true);
    expect(flags.ENABLE_AI_FRAUD).toBe(true);
    expect(flags.ENABLE_AI_EXTRACTION).toBe(true); // launch-required, correctly ON
  });

  it('flagRegistry.ts classifies ENABLE_SEMANTIC_SEARCH / ENABLE_AI_FRAUD / ENABLE_AI_EXTRACTION as DB-backed', () => {
    const src = readFileSync(
      resolve(repoRoot, 'services/worker/src/middleware/flagRegistry.ts'),
      'utf8',
    );
    const names = parseDbFlagNames(src);
    expect(names.has('ENABLE_SEMANTIC_SEARCH')).toBe(true);
    expect(names.has('ENABLE_AI_FRAUD')).toBe(true);
    expect(names.has('ENABLE_AI_EXTRACTION')).toBe(true);
  });
});
