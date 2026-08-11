/**
 * Tests for the flag-reconciliation gate (`flagInventory.ts`).
 *
 * Red-first per CLAUDE.md §0 rule 1. Each finding code gets a drift-simulation
 * case (the detector must FAIL on the real historical bug shape), plus a
 * real-tree smoke test so the committed manifest cannot rot.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkFlagInventory,
  parseEnvFlagNames,
  parseFrontendFlagNames,
  loadFlagInventory,
  runFlagInventoryCheck,
  type FlagInventoryManifest,
  type FlagCodeSurface,
} from './flagInventory.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const FLAG_REGISTRY = resolve(REPO_ROOT, 'services/worker/src/middleware/flagRegistry.ts');
const FRONTEND_SWITCHBOARD = resolve(REPO_ROOT, 'src/lib/switchboard.ts');
const DEPLOY_YML = resolve(REPO_ROOT, '.github/workflows/deploy-worker.yml');
const MANIFEST = resolve(HERE, 'flag-inventory.json');

/** Minimal well-formed manifest + surface, so each test perturbs exactly one thing. */
function baseManifest(): FlagInventoryManifest {
  return {
    observedProd: {
      projectRef: 'vzwyaatejekddvltxyye',
      capturedAt: '2026-08-11',
      workerGitSha: 'deadbeef',
    },
    acknowledgedInertEnvFlags: [],
    flags: {
      ENABLE_THING: {
        sources: ['db'],
        resolvers: ['featureGate'],
        prodDbRow: true,
        prodResolved: true,
        customerReachable: true,
        soak: 'either',
        why: 'test fixture',
      },
    },
  };
}

function baseSurface(): FlagCodeSurface {
  return {
    deployedFlags: {},
    envFlagNames: new Set<string>(),
    dbFlagNames: new Set(['ENABLE_THING']),
    frontendFlagNames: new Set<string>(),
  };
}

describe('checkFlagInventory — clean baseline', () => {
  it('reports nothing when the manifest covers the code surface exactly', () => {
    expect(checkFlagInventory(baseManifest(), baseSurface())).toEqual([]);
  });
});

describe('unregistered-flag — the census ratchet', () => {
  it('fails when a deploy env flag is missing from the manifest', () => {
    const surface = baseSurface();
    surface.deployedFlags = { ENABLE_BRAND_NEW: true };
    const findings = checkFlagInventory(baseManifest(), surface);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      severity: 'error',
      code: 'unregistered-flag',
      flag: 'ENABLE_BRAND_NEW',
    });
  });

  it('fails when a new DB_FLAGS entry is missing from the manifest', () => {
    const surface = baseSurface();
    surface.dbFlagNames.add('ENABLE_UNDECLARED_DB');
    const findings = checkFlagInventory(baseManifest(), surface);
    expect(findings.map((f) => f.code)).toContain('unregistered-flag');
    expect(findings.find((f) => f.code === 'unregistered-flag')?.flag).toBe('ENABLE_UNDECLARED_DB');
  });

  it('fails when a new frontend FLAGS entry is missing from the manifest', () => {
    const surface = baseSurface();
    surface.frontendFlagNames.add('ENABLE_UNDECLARED_UI');
    const findings = checkFlagInventory(baseManifest(), surface);
    expect(findings.find((f) => f.code === 'unregistered-flag')?.flag).toBe('ENABLE_UNDECLARED_UI');
  });

  it('fails when a new ENV_FLAG_GETTERS entry is missing from the manifest', () => {
    const surface = baseSurface();
    surface.envFlagNames.add('ENABLE_UNDECLARED_ENV');
    const findings = checkFlagInventory(baseManifest(), surface);
    expect(findings.find((f) => f.code === 'unregistered-flag')?.flag).toBe('ENABLE_UNDECLARED_ENV');
  });
});

describe('stale-inventory-entry — the inverse ratchet', () => {
  it('fails on a manifest entry with no code surface and no prod DB row', () => {
    const manifest = baseManifest();
    manifest.flags.ENABLE_GHOST = {
      sources: ['db'],
      resolvers: [],
      prodDbRow: 'absent',
      prodResolved: false,
      customerReachable: false,
      soak: 'either',
      why: 'removed from code but left in the manifest',
    };
    const findings = checkFlagInventory(manifest, baseSurface());
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ code: 'stale-inventory-entry', flag: 'ENABLE_GHOST' });
  });

  it('does NOT flag an orphan prod DB row that has no code surface', () => {
    // ENABLE_ZK_PROOFS shape: a live switchboard row nothing in the tree reads.
    // It must stay declared (so it is visible) without tripping the stale check.
    const manifest = baseManifest();
    manifest.flags.ENABLE_ZK_PROOFS = {
      sources: ['db-orphan'],
      resolvers: [],
      prodDbRow: true,
      prodResolved: true,
      customerReachable: false,
      soak: 'either',
      why: 'orphan prod row, zero readers',
    };
    expect(checkFlagInventory(manifest, baseSurface())).toEqual([]);
  });
});

describe('inert-env-var / env-db-contradiction — the split-brain class', () => {
  /** Flag is DB-backed AND the deploy sets an env var for it AND a prod row exists. */
  function splitBrain(deployValue: boolean, dbRow: boolean): {
    manifest: FlagInventoryManifest;
    surface: FlagCodeSurface;
  } {
    const manifest = baseManifest();
    manifest.flags.ENABLE_THING.prodDbRow = dbRow;
    manifest.flags.ENABLE_THING.prodResolved = dbRow;
    const surface = baseSurface();
    surface.deployedFlags = { ENABLE_THING: deployValue };
    return { manifest, surface };
  }

  it('flags an inert env var even when env and DB agree', () => {
    // ENABLE_AI_REPORTS / ENABLE_VERIFICATION_API shape: env=true, DB=true.
    // Harmless today, but the env var is not what the worker reads — anyone
    // editing deploy-worker.yml to turn the feature off would be ignored.
    const { manifest, surface } = splitBrain(true, true);
    const findings = checkFlagInventory(manifest, surface);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      severity: 'warn',
      code: 'inert-env-var',
      flag: 'ENABLE_THING',
    });
  });

  it('ERRORS when the deploy env var states the OPPOSITE of the live DB row', () => {
    // ENABLE_SEMANTIC_SEARCH / ENABLE_AI_FRAUD shape: deploy says =true, the
    // switchboard row says false, the DB wins. The deploy file is a lie.
    const { manifest, surface } = splitBrain(true, false);
    const findings = checkFlagInventory(manifest, surface);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      severity: 'error',
      code: 'env-db-contradiction',
      flag: 'ENABLE_THING',
    });
    expect(findings[0].message).toMatch(/deploy-worker\.yml/);
  });

  it('downgrades an acknowledged contradiction to a warning', () => {
    const { manifest, surface } = splitBrain(true, false);
    manifest.acknowledgedInertEnvFlags = ['ENABLE_THING'];
    const findings = checkFlagInventory(manifest, surface);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('warn');
    expect(findings[0].code).toBe('env-db-contradiction');
  });

  it('does NOT fire when the flag has no prod DB row (env fallback is live)', () => {
    // With the row absent, flagRegistry genuinely falls back to the env var,
    // so the env var is NOT inert. That is the flagSpof fail-open case, not this one.
    const { manifest, surface } = splitBrain(true, true);
    manifest.flags.ENABLE_THING.prodDbRow = 'absent';
    manifest.flags.ENABLE_THING.prodResolved = true;
    expect(checkFlagInventory(manifest, surface)).toEqual([]);
  });

  it('does NOT fire for an env-only flag the deploy sets', () => {
    const manifest = baseManifest();
    manifest.flags.ENABLE_THING.sources = ['env'];
    manifest.flags.ENABLE_THING.prodDbRow = 'absent';
    const surface = baseSurface();
    surface.dbFlagNames = new Set();
    surface.envFlagNames = new Set(['ENABLE_THING']);
    surface.deployedFlags = { ENABLE_THING: true };
    expect(checkFlagInventory(manifest, surface)).toEqual([]);
  });
});

describe('decorative-db-row — worker reads env, frontend reads the row', () => {
  it('warns when an ENV-resolved flag carries a prod switchboard row', () => {
    const manifest = baseManifest();
    manifest.flags.ENABLE_THING.sources = ['env'];
    manifest.flags.ENABLE_THING.prodDbRow = true;
    manifest.flags.ENABLE_THING.prodResolved = false; // worker env default
    const surface = baseSurface();
    surface.dbFlagNames = new Set();
    surface.envFlagNames = new Set(['ENABLE_THING']);
    const findings = checkFlagInventory(manifest, surface);
    expect(findings.map((f) => f.code)).toContain('decorative-db-row');
  });
});

describe('claimed-capability-off — the R-7 claims gate, automated', () => {
  function claimed(prodResolved: boolean): FlagInventoryManifest {
    const manifest = baseManifest();
    manifest.flags.ENABLE_THING.prodResolved = prodResolved;
    manifest.flags.ENABLE_THING.prodDbRow = prodResolved;
    manifest.flags.ENABLE_THING.claimedBy = [
      {
        path: 'src/pages/DevelopersPage.tsx',
        surface: 'public-marketing',
        claim: 'priced commercial offer for the capability',
      },
    ];
    return manifest;
  }

  it('ERRORS when a flag is OFF but a public surface advertises the capability', () => {
    const findings = checkFlagInventory(claimed(false), baseSurface());
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      severity: 'error',
      code: 'claimed-capability-off',
      flag: 'ENABLE_THING',
    });
    expect(findings[0].message).toMatch(/DevelopersPage/);
  });

  it('names the compliance surface distinctly — an auditor claim is not marketing copy', () => {
    const manifest = claimed(false);
    manifest.flags.ENABLE_THING.claimedBy = [
      {
        path: 'docs/compliance/soc2-type2-evidence-matrix.md',
        surface: 'compliance',
        claim: 'asserted to a SOC 2 auditor as a Continuous control',
      },
    ];
    const findings = checkFlagInventory(manifest, baseSurface());
    expect(findings[0].code).toBe('claimed-capability-off');
    expect(findings[0].message).toMatch(/compliance/);
    expect(findings[0].message).toMatch(/soc2-type2-evidence-matrix/);
  });

  it('does NOT fire when the claimed capability is actually ON', () => {
    expect(checkFlagInventory(claimed(true), baseSurface())).toEqual([]);
  });

  it('does NOT fire for an OFF flag that nothing claims', () => {
    const manifest = baseManifest();
    manifest.flags.ENABLE_THING.prodResolved = false;
    manifest.flags.ENABLE_THING.prodDbRow = false;
    expect(checkFlagInventory(manifest, baseSurface())).toEqual([]);
  });

  it('downgrades an acknowledged contradiction to a warning but never drops it', () => {
    const manifest = claimed(false);
    manifest.acknowledgedClaimContradictions = ['ENABLE_THING'];
    const findings = checkFlagInventory(manifest, baseSurface());
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('warn');
    expect(findings[0].code).toBe('claimed-capability-off');
  });

  it('an acknowledgement for a DIFFERENT flag does not suppress this one', () => {
    const manifest = claimed(false);
    manifest.acknowledgedClaimContradictions = ['ENABLE_SOMETHING_ELSE'];
    expect(checkFlagInventory(manifest, baseSurface())[0].severity).toBe('error');
  });
});

describe('soak posture — the must-be-ON / must-be-OFF lists as code', () => {
  it('fails when a must-be-ON flag does not resolve ON in prod', () => {
    const manifest = baseManifest();
    manifest.flags.ENABLE_THING.soak = 'must-be-on';
    manifest.flags.ENABLE_THING.prodDbRow = false;
    manifest.flags.ENABLE_THING.prodResolved = false;
    const findings = checkFlagInventory(manifest, baseSurface());
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: 'error', code: 'soak-required-flag-off' });
  });

  it('fails when a must-be-OFF flag resolves ON in prod', () => {
    // Nessie shape: standing founder directive that it stays off.
    const manifest = baseManifest();
    manifest.flags.ENABLE_THING.soak = 'must-be-off';
    manifest.flags.ENABLE_THING.prodResolved = true;
    const findings = checkFlagInventory(manifest, baseSurface());
    expect(findings.map((f) => f.code)).toContain('soak-forbidden-flag-on');
    expect(findings.find((f) => f.code === 'soak-forbidden-flag-on')?.severity).toBe('error');
  });

  it('fails when a must-be-OFF flag is switched ON in deploy-worker.yml', () => {
    // ENABLE_DEMO_INJECTOR / ENABLE_SYNTHETIC_DATA shape: turning either on
    // would pollute soak evidence with fabricated rows.
    const manifest = baseManifest();
    manifest.flags.ENABLE_THING.sources = ['env'];
    manifest.flags.ENABLE_THING.soak = 'must-be-off';
    manifest.flags.ENABLE_THING.prodDbRow = 'absent';
    manifest.flags.ENABLE_THING.prodResolved = false;
    const surface = baseSurface();
    surface.dbFlagNames = new Set();
    surface.envFlagNames = new Set(['ENABLE_THING']);
    surface.deployedFlags = { ENABLE_THING: true };
    const findings = checkFlagInventory(manifest, surface);
    expect(findings.map((f) => f.code)).toContain('soak-forbidden-flag-on');
  });

  it('passes a must-be-ON flag that resolves ON', () => {
    const manifest = baseManifest();
    manifest.flags.ENABLE_THING.soak = 'must-be-on';
    expect(checkFlagInventory(manifest, baseSurface())).toEqual([]);
  });
});

describe('parsers fail CLOSED', () => {
  it('parses ENV_FLAG_GETTERS keys from the real flagRegistry.ts', () => {
    const names = parseEnvFlagNames(readFileSync(FLAG_REGISTRY, 'utf8'));
    expect(names.has('USE_MOCKS')).toBe(true);
    expect(names.has('ENABLE_PROD_NETWORK_ANCHORING')).toBe(true);
    expect(names.has('ENABLE_NESSIE_RAG_RECOMMENDATIONS')).toBe(true);
    // DB_FLAGS members must NOT leak into the env set.
    expect(names.has('ENABLE_VERIFICATION_API')).toBe(false);
  });

  it('throws when the ENV_FLAG_GETTERS block cannot be located', () => {
    expect(() => parseEnvFlagNames('export const NOTHING = {};')).toThrow(/ENV_FLAG_GETTERS/);
  });

  it('parses the frontend FLAGS block from the real switchboard.ts', () => {
    const names = parseFrontendFlagNames(readFileSync(FRONTEND_SWITCHBOARD, 'utf8'));
    expect(names.has('MAINTENANCE_MODE')).toBe(true);
    expect(names.has('ENABLE_ISSUE_CREDENTIAL_SPLIT')).toBe(true);
    // The type alias below the block must not be swept in.
    expect(names.has('FlagId')).toBe(false);
  });

  it('throws when the frontend FLAGS block cannot be located', () => {
    expect(() => parseFrontendFlagNames('const x = 1;')).toThrow(/FLAGS/);
  });

  it('throws on a manifest with an empty flags map (degraded file must not pass)', () => {
    expect(() => loadFlagInventory('/nonexistent/flag-inventory.json')).toThrow();
  });
});

describe('real-tree smoke — the committed manifest reconciles today', () => {
  it('produces no ERROR findings against the live repo surface', () => {
    const findings = runFlagInventoryCheck(loadFlagInventory(MANIFEST), {
      deployYmlPath: DEPLOY_YML,
      flagRegistryPath: FLAG_REGISTRY,
      frontendSwitchboardPath: FRONTEND_SWITCHBOARD,
    });
    const errors = findings.filter((f) => f.severity === 'error');
    expect(errors.map((e) => `${e.code}:${e.flag}`)).toEqual([]);
  });

  it('declares every flag the live code surface exposes', () => {
    const manifest = loadFlagInventory(MANIFEST);
    const declared = new Set(Object.keys(manifest.flags));
    for (const name of parseEnvFlagNames(readFileSync(FLAG_REGISTRY, 'utf8'))) {
      expect(declared.has(name), `ENV_FLAG_GETTERS flag ${name} undeclared`).toBe(true);
    }
    for (const name of parseFrontendFlagNames(readFileSync(FRONTEND_SWITCHBOARD, 'utf8'))) {
      expect(declared.has(name), `frontend FLAGS flag ${name} undeclared`).toBe(true);
    }
  });

  it('every claimedBy path in the committed manifest still exists on disk', () => {
    // The rot guard. `pendingLaunchFlags` went stale on 4 of 5 entries because
    // nothing checked its prose against reality; a claim annotation pointing at
    // a deleted file would rot the same way and silently stop protecting.
    const findings = runFlagInventoryCheck(loadFlagInventory(MANIFEST), {
      deployYmlPath: DEPLOY_YML,
      flagRegistryPath: FLAG_REGISTRY,
      frontendSwitchboardPath: FRONTEND_SWITCHBOARD,
      repoRoot: REPO_ROOT,
    });
    expect(findings.filter((f) => f.code === 'stale-claim-reference')).toEqual([]);
  });

  it('flags the live R-7 claims contradictions (semantic search + AI fraud)', () => {
    // ENABLE_SEMANTIC_SEARCH is OFF while /developers sells `/ai/search` at a
    // per-call price; ENABLE_AI_FRAUD is OFF while the SOC 2 evidence matrix
    // asserts fraud detection as a Continuous control. Both are acknowledged
    // (the fix is a copy/docs change owned outside this gate), so they warn
    // rather than block — but they can never silently disappear.
    const findings = runFlagInventoryCheck(loadFlagInventory(MANIFEST), {
      deployYmlPath: DEPLOY_YML,
      flagRegistryPath: FLAG_REGISTRY,
      frontendSwitchboardPath: FRONTEND_SWITCHBOARD,
      repoRoot: REPO_ROOT,
    });
    const claims = findings
      .filter((f) => f.code === 'claimed-capability-off')
      .map((f) => f.flag)
      .sort();
    expect(claims).toEqual(['ENABLE_AI_FRAUD', 'ENABLE_SEMANTIC_SEARCH']);
  });

  it('still reports the two known env↔DB contradictions as acknowledged warnings', () => {
    // Regression guard: if someone "fixes" this by deleting the acknowledgement
    // instead of the deploy line, the smoke test above goes red. If someone
    // fixes deploy-worker.yml properly, THIS test goes red and must be updated —
    // that is the intended ratchet direction.
    const findings = runFlagInventoryCheck(loadFlagInventory(MANIFEST), {
      deployYmlPath: DEPLOY_YML,
      flagRegistryPath: FLAG_REGISTRY,
      frontendSwitchboardPath: FRONTEND_SWITCHBOARD,
    });
    const contradictions = findings
      .filter((f) => f.code === 'env-db-contradiction')
      .map((f) => f.flag)
      .sort();
    expect(contradictions).toEqual(['ENABLE_AI_FRAUD', 'ENABLE_SEMANTIC_SEARCH']);
    for (const f of findings.filter((x) => x.code === 'env-db-contradiction')) {
      expect(f.severity).toBe('warn');
    }
  });
});
