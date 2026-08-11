/**
 * S1 hardening of the config↔reality drift gate — the **flag-SPOF check** (Lane-2 half;
 * config-drift/README.md "SPIKE boundary → Sprint 1" item #5 / VIS-01 fail-open class).
 *
 * Companion to `providerSpof.ts` (Lane-1's chain dimension). Where that parses the real
 * `config.ts` provider default + `deploy-worker.yml` override, THIS parses the real
 * `deploy-worker.yml` feature-flag env vars + the real `flagRegistry.ts` DB-flag list,
 * and classifies the env↔DB fail-open hazard.
 *
 * THE HAZARD (2026-05-30 prod fail-open). `services/worker/src/middleware/flagRegistry.ts`
 * resolves DB-backed flags as:
 *     dbFlagMap.has(key) ? dbFlagMap.get(key) : (process.env[key] === 'true')
 * i.e. when a `switchboard_flags` row is ABSENT, the flag falls back to its deploy env var.
 * So a flag whose intended EFFECTIVE prod value is `false` (held OFF by a DB row) but whose
 * deploy env var is `true` fails OPEN to `true` the instant that DB row is missing/dropped.
 * Today `deploy-worker.yml` sets `ENABLE_SEMANTIC_SEARCH=true` AND `ENABLE_AI_FRAUD=true`
 * while the asserted effective state is `false` for both — two live fail-open flags whose
 * OFF-ness depends entirely on a DB row.
 *
 * Inversely, a launch-REQUIRED flag (e.g. `ENABLE_AI_EXTRACTION`, CLAUDE.md §1.6 default
 * true in prod) that the deploy env sets `false` or omits would silently break the launch
 * path under the same fallback.
 *
 * DETECTION ONLY. This never edits `deploy-worker.yml`, `config.ts`, `flagRegistry.ts`, nor
 * any flag value, and never touches the DB (the gate is read-only against config; flipping a
 * flag or a `switchboard_flags` row is a Carson-gated runtime change, CLAUDE.md §1.11A).
 */
import { readFileSync } from 'node:fs';

export type FlagSpofSeverity = 'error' | 'warn';
export type FlagSpofCode =
  | 'fail-open-flag' // asserted OFF, env ON, DB-backed → OFF depends on a DB row (fail-open)
  | 'env-flag-on-no-db-guard' // asserted OFF, env ON, NOT DB-backed → no kill switch at all
  | 'launch-flag-off'; // asserted ON (launch-required), env OFF/omitted → launch path broken

export interface FlagSpofFinding {
  severity: FlagSpofSeverity;
  code: FlagSpofCode;
  flag: string;
  message: string;
}

export interface FlagSpofInputs {
  /**
   * The intended EFFECTIVE prod flag values (from expected-prod-config.json `flags`).
   * For DB-gated kill-switch flags this is the DB-resolved value, NOT the raw deploy env.
   */
  assertedFlags: Record<string, boolean>;
  /**
   * The flag→value the deploy actually sets via `deploy-worker.yml --set-env-vars`.
   * A flag the deploy omits is simply absent from this map.
   */
  deployedFlags: Record<string, boolean>;
  /** The set of flag names `flagRegistry.ts` treats as DB-backed (its `DB_FLAGS` array). */
  dbFlagNames: Set<string>;
  /**
   * The flags that are genuinely LAUNCH-REQUIRED (the manifest's
   * `launchRequiredFlags`). Only these can produce `launch-flag-off`.
   *
   * WHY THIS EXISTS. The original model equated "asserted effective=true" with
   * "launch-required", so pinning ANY true flag whose value is held ON by a live
   * `switchboard_flags` row — rather than by a deploy env var — fired a spurious
   * `launch-flag-off` ERROR. That is the normal, correct configuration for a
   * DB-backed flag: the row wins and the deploy has no business restating it.
   * The gate therefore punished honest pinning, which is exactly why
   * `expected-prod-config.json` asserted only 6 flags out of a ~51-flag surface
   * and why its hand-written notes drifted. Omit this field to preserve the old
   * behaviour (every asserted-true flag is treated as launch-required).
   */
  launchRequiredFlags?: Set<string>;
}

/**
 * Pure flag-SPOF classifier. At most one finding per asserted flag:
 *  - asserted=false, env=true, DB-backed     → ERROR `fail-open-flag`
 *      (effective-OFF rests solely on a `switchboard_flags` row; a missing row fails OPEN).
 *  - asserted=false, env=true, NOT DB-backed → ERROR `env-flag-on-no-db-guard`
 *      (strictly worse: there is no DB kill switch that can hold it OFF).
 *  - asserted=true,  env=false OR omitted    → ERROR `launch-flag-off`
 *      (a launch-required flag is OFF/unset in the deploy; under the registry fallback the
 *       launch path breaks if the DB row is also absent).
 *  - otherwise                               → no finding (fails safe).
 *
 * Only flags present in `assertedFlags` are evaluated — the asserted manifest is the pin
 * list. (A deploy env flag that is NOT asserted is the "unpinned enablement" class already
 * caught by `diffConfigState`'s reverse-flag check; this module does not duplicate it.)
 */
export function checkFlagSpof(input: FlagSpofInputs): FlagSpofFinding[] {
  const { assertedFlags, deployedFlags, dbFlagNames, launchRequiredFlags } = input;
  const findings: FlagSpofFinding[] = [];
  // Omitted → every asserted-true flag is launch-required (legacy behaviour).
  const isLaunchRequired = (flag: string) =>
    launchRequiredFlags === undefined || launchRequiredFlags.has(flag);

  for (const [flag, assertedValue] of Object.entries(assertedFlags)) {
    const deployHasFlag = Object.prototype.hasOwnProperty.call(deployedFlags, flag);
    const deployValue = deployHasFlag ? deployedFlags[flag] : undefined;

    if (assertedValue === false) {
      // Asserted OFF. Danger is the deploy env being ON.
      if (deployValue === true) {
        if (dbFlagNames.has(flag)) {
          findings.push({
            severity: 'error',
            code: 'fail-open-flag',
            flag,
            message:
              `flag ${flag} is asserted effective=false but deploy-worker.yml sets ${flag}=true. ` +
              `flagRegistry.ts falls back to the env var when the switchboard_flags row is absent, ` +
              `so OFF depends entirely on that DB row — a dropped/missing row fails OPEN to true ` +
              `(the 2026-05-30 env↔DB fail-open class). Set ${flag}=false in deploy-worker.yml so ` +
              `it fails SAFE regardless of the DB row.`,
          });
        } else {
          findings.push({
            severity: 'error',
            code: 'env-flag-on-no-db-guard',
            flag,
            message:
              `flag ${flag} is asserted effective=false but deploy-worker.yml sets ${flag}=true, and ` +
              `${flag} is NOT a DB-backed flag in flagRegistry.ts — there is no switchboard_flags ` +
              `kill switch that can hold it OFF, so it is unconditionally ON in prod. Set ` +
              `${flag}=false in deploy-worker.yml.`,
          });
        }
      }
      // else: asserted OFF and the deploy env is false/omitted → fails safe.
    } else {
      // Asserted ON. Danger is the deploy env being OFF or omitted — but only
      // for a genuinely launch-required flag. A DB-backed flag held ON by its
      // switchboard row does not need (and should not have) a deploy env line.
      if (isLaunchRequired(flag) && (deployValue === false || !deployHasFlag)) {
        findings.push({
          severity: 'error',
          code: 'launch-flag-off',
          flag,
          message:
            `flag ${flag} is asserted effective=true (launch-required) but deploy-worker.yml ` +
            `${deployHasFlag ? `sets ${flag}=false` : `omits ${flag}`}. Under the flagRegistry.ts ` +
            `fallback the launch path breaks if the switchboard_flags row is also absent. Set ` +
            `${flag}=true in deploy-worker.yml.`,
        });
      }
    }
  }

  return findings;
}

// ─── Source parsers (fail closed) ───────────────────────────────────────────

/**
 * Parse `ENABLE_*=<true|false>` (and `MAINTENANCE_MODE=...`) boolean env vars out of the
 * `deploy-worker.yml --set-env-vars "^||^...||..."` line. A flag the deploy omits is simply
 * absent from the returned map. Throws (fail closed) if no flags parse at all — a deploy file
 * we cannot read must NOT silently pass as "all flags fail-safe".
 */
const DEPLOY_FLAG_RE = /\b((?:ENABLE_[A-Z0-9_]+)|MAINTENANCE_MODE)=(true|false)\b/g;

export function parseDeployedFlags(deployYmlSource: string): Record<string, boolean> {
  const flags: Record<string, boolean> = {};
  for (const m of deployYmlSource.matchAll(DEPLOY_FLAG_RE)) {
    flags[m[1]] = m[2] === 'true';
  }
  if (Object.keys(flags).length === 0) {
    throw new Error(
      'flag-SPOF: could not parse any ENABLE_*/MAINTENANCE_MODE env flags from deploy-worker.yml (fail closed)',
    );
  }
  return flags;
}

/**
 * Parse the `const DB_FLAGS = [ '...', ... ] as const;` array out of `flagRegistry.ts` — the
 * authoritative list of flags resolved against `switchboard_flags` (with env fallback).
 * Throws (fail closed) if the array cannot be located/parsed.
 */
const DB_FLAGS_BLOCK_RE = /const\s+DB_FLAGS\s*=\s*\[([\s\S]*?)\]\s*as\s+const\s*;/;
const FLAG_NAME_RE = /['"]([A-Z0-9_]+)['"]/g;

export function parseDbFlagNames(flagRegistrySource: string): Set<string> {
  const block = DB_FLAGS_BLOCK_RE.exec(flagRegistrySource);
  if (!block) {
    throw new Error(
      'flag-SPOF: could not parse the DB_FLAGS array from flagRegistry.ts (cannot confirm DB-backed flags → fail closed)',
    );
  }
  const names = new Set<string>();
  for (const m of block[1].matchAll(FLAG_NAME_RE)) names.add(m[1]);
  if (names.size === 0) {
    throw new Error('flag-SPOF: DB_FLAGS array parsed but contained no flag names (fail closed)');
  }
  return names;
}

export interface FlagSpofSources {
  deployYmlPath: string;
  flagRegistryPath: string;
}

/** Read the real source files, parse, and classify. Used by the gate's main(). */
export function runFlagSpofCheck(
  assertedFlags: Record<string, boolean>,
  sources: FlagSpofSources,
  launchRequiredFlags?: Set<string>,
): FlagSpofFinding[] {
  const deployedFlags = parseDeployedFlags(readFileSync(sources.deployYmlPath, 'utf8'));
  const dbFlagNames = parseDbFlagNames(readFileSync(sources.flagRegistryPath, 'utf8'));
  return checkFlagSpof({ assertedFlags, deployedFlags, dbFlagNames, launchRequiredFlags });
}
