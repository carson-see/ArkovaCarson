#!/usr/bin/env -S npx tsx
/**
 * S0-5.2 (Lane 1) — config↔reality drift gate (SPIKE). SCAFFOLDS the R-5
 * mitigation — it does NOT yet retire R-5 (live source-parse + /health capture
 * is Sprint 1; see config-drift/README.md "Known SPIKE limitations").
 *
 * Diffs the ASSERTED prod config (what the repo says prod should be:
 * `services/worker/src/config.ts` defaults + `deploy-worker.yml` --set-env-vars
 * + `vercel.json` CSP) against the RUNNING prod config (a read-only snapshot of
 * `GET /health` + the flag registry). Fails CLOSED on any drift across
 * flags / provider / fee-strategy / CSP, and runs the cross-runtime parity
 * harness (worker vs edge).
 *
 * SPIKE scope: asserted + running are read from committed JSON under
 * `scripts/ci/config-drift/`. The mechanism + tests are the deliverable.
 * Sprint 1 (S0-E5 → VIS-01 / CHAIN-RESIL) wires:
 *   - `loadAssertedConfig` to PARSE config.ts / deploy-worker.yml / vercel.json
 *     directly (no hand-maintained JSON), and
 *   - `loadRunningSnapshot` to a read-only cron capture of `GET /health`
 *     (never a write; never embeds secrets).
 *
 * Companion: ./lib/runtimeParity.ts. Pattern mirrors check-api-contract-drift.ts.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  compareRuntimeConfigs,
  type RuntimeConfig,
  type ParityFinding,
} from './lib/runtimeParity.js';
import { runProviderSpofCheck } from './config-drift/providerSpof.js';
import { runFlagSpofCheck, type FlagSpofFinding } from './config-drift/flagSpof.js';

export interface ConfigState {
  /** Feature-flag name → expected/observed enabled state. */
  flags: Record<string, boolean>;
  /** Chain UTXO provider: 'getblock' | 'mempool' | 'rpc'. */
  bitcoinUtxoProvider: string;
  /** Optional fee strategy: 'static' | 'mempool'. */
  bitcoinFeeStrategy?: string;
  /** CSP connect-src allowlist (origins the frontend may reach). */
  cspConnectSrc: string[];
}

export interface ConfigDrift {
  dimension: 'flag' | 'provider' | 'fee-strategy' | 'csp';
  key: string;
  asserted: string;
  running: string;
  message: string;
}

/**
 * Pure differ: asserted (repo) vs running (prod snapshot). Fails closed —
 * an asserted flag that is ABSENT from the running snapshot is drift (we
 * could not confirm it). CSP is compared both ways (missing + creep).
 */
export function diffConfigState(asserted: ConfigState, running: ConfigState): ConfigDrift[] {
  const drift: ConfigDrift[] = [];

  // Flags.
  for (const [key, want] of Object.entries(asserted.flags)) {
    const have = running.flags[key];
    if (have === undefined) {
      drift.push({
        dimension: 'flag',
        key,
        asserted: String(want),
        running: 'absent',
        message: `flag ${key} asserted ${want} but absent from running config (cannot confirm — fail closed)`,
      });
    } else if (have !== want) {
      drift.push({
        dimension: 'flag',
        key,
        asserted: String(want),
        running: String(have),
        message: `flag ${key} asserted ${want} but running ${have}`,
      });
    }
  }

  // Reverse flags: a flag ENABLED in running but NOT pinned in asserted is an
  // unexpected enablement (the fail-open / silent re-enable class — the headline
  // R-5 risk). Mirrors the bidirectional CSP check. Benign when disabled.
  for (const [key, have] of Object.entries(running.flags)) {
    if (have === true && !(key in asserted.flags)) {
      drift.push({
        dimension: 'flag',
        key,
        asserted: 'unpinned',
        running: 'true',
        message: `flag ${key} enabled in running but not pinned in asserted (unexpected enablement — pin it or investigate)`,
      });
    }
  }

  // Provider.
  if (asserted.bitcoinUtxoProvider !== running.bitcoinUtxoProvider) {
    drift.push({
      dimension: 'provider',
      key: 'bitcoinUtxoProvider',
      asserted: asserted.bitcoinUtxoProvider,
      running: running.bitcoinUtxoProvider,
      message: `bitcoinUtxoProvider asserted ${asserted.bitcoinUtxoProvider} but running ${running.bitcoinUtxoProvider}`,
    });
  }

  // Fee strategy (only when asserted).
  if (
    asserted.bitcoinFeeStrategy !== undefined &&
    asserted.bitcoinFeeStrategy !== running.bitcoinFeeStrategy
  ) {
    drift.push({
      dimension: 'fee-strategy',
      key: 'bitcoinFeeStrategy',
      asserted: String(asserted.bitcoinFeeStrategy),
      running: String(running.bitcoinFeeStrategy),
      message: `bitcoinFeeStrategy asserted ${asserted.bitcoinFeeStrategy} but running ${running.bitcoinFeeStrategy}`,
    });
  }

  // CSP connect-src — both directions.
  const assertedCsp = new Set(asserted.cspConnectSrc);
  const runningCsp = new Set(running.cspConnectSrc);
  for (const origin of assertedCsp) {
    if (!runningCsp.has(origin)) {
      drift.push({
        dimension: 'csp',
        key: origin,
        asserted: 'present',
        running: 'absent',
        message: `CSP connect-src ${origin} asserted but absent from running (a runtime may be unreachable)`,
      });
    }
  }
  for (const origin of runningCsp) {
    if (!assertedCsp.has(origin)) {
      drift.push({
        dimension: 'csp',
        key: origin,
        asserted: 'absent',
        running: 'present',
        message: `CSP connect-src ${origin} present in running but not asserted (allowlist creep)`,
      });
    }
  }

  return drift;
}

// ─── Loaders (SPIKE: committed JSON; Sprint 1 → source parse + live capture) ──

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = resolve(HERE, 'config-drift');

interface SnapshotFile extends ConfigState {
  runtimes?: { worker: RuntimeConfig; edge: RuntimeConfig };
  /**
   * S1 Lane-2 flag-SPOF (asserted manifest only). Flags whose intended EFFECTIVE prod
   * value is ON (`true`); the gate hard-fails if the deploy sets one false or omits it.
   */
  launchRequiredFlags?: string[];
  /**
   * S1 Lane-2 flag-SPOF (asserted manifest only). Flags KNOWN to be env=true while
   * asserted effective=false — held OFF today only by a live switchboard_flags row (the
   * deploy edit is a T3/Carson chain-adjacent change). These surface as a loud WARN; a
   * NEW, unacknowledged fail-open flag is a hard ERROR (the regression guard).
   */
  acknowledgedFailOpenFlags?: string[];
}

// Fail CLOSED on a malformed/degraded config file: a degraded asserted file
// (e.g. empty `flags`) must NOT silently pass as "no drift". Zod throws on a
// bad shape → caught in main() → exit 1. `.passthrough()` tolerates `_note`.
const RuntimeConfigSchema = z.object({
  runtime: z.enum(['worker', 'edge']),
  origin: z.string().min(1),
  flags: z.record(z.string(), z.boolean()),
  bitcoinUtxoProvider: z.string().min(1).optional(),
});
const SnapshotFileSchema = z
  .object({
    flags: z
      .record(z.string(), z.boolean())
      .refine((f) => Object.keys(f).length > 0, { message: 'flags must be a non-empty object' }),
    bitcoinUtxoProvider: z.string().min(1),
    bitcoinFeeStrategy: z.string().min(1).optional(),
    cspConnectSrc: z.array(z.string().min(1)).min(1),
    runtimes: z.object({ worker: RuntimeConfigSchema, edge: RuntimeConfigSchema }).optional(),
    launchRequiredFlags: z.array(z.string().min(1)).optional(),
    acknowledgedFailOpenFlags: z.array(z.string().min(1)).optional(),
  })
  .passthrough();

export function loadConfigFile(path: string): SnapshotFile {
  return SnapshotFileSchema.parse(JSON.parse(readFileSync(path, 'utf8'))) as SnapshotFile;
}

export function loadAssertedConfig(): SnapshotFile {
  return loadConfigFile(resolve(CONFIG_DIR, 'expected-prod-config.json'));
}

export function loadRunningSnapshot(): SnapshotFile {
  return loadConfigFile(resolve(CONFIG_DIR, 'prod-config-snapshot.json'));
}

export function runConfigDriftCheck(
  asserted: SnapshotFile,
  running: SnapshotFile,
): { drift: ConfigDrift[]; parity: ParityFinding[] } {
  const drift = diffConfigState(asserted, running);
  // Parity compares the two RUNNING runtimes (worker vs edge as observed) against
  // the running CSP. SPIKE: running.runtimes is a committed reference snapshot;
  // Sprint 1 captures both runtimes + CSP from live GET /health. Falls back to the
  // asserted declaration only if the running snapshot omits runtimes.
  const rt = running.runtimes ?? asserted.runtimes;
  const parity = rt ? compareRuntimeConfigs(rt.worker, rt.edge, running.cspConnectSrc) : [];
  return { drift, parity };
}

/**
 * Two-tier split of flag-SPOF findings (Lane-2). `launch-flag-off` and
 * `env-flag-on-no-db-guard` are ALWAYS blocking. A `fail-open-flag` is blocking UNLESS
 * its flag is acknowledged (a known, DB-guarded-today hazard whose deploy fix is
 * T3/Carson) — those are non-blocking warnings. A NEW, unacknowledged fail-open flag is
 * the regression we guard against and goes to `errors`.
 */
export function classifyFlagSpofFindings(
  findings: FlagSpofFinding[],
  acknowledgedFailOpenFlags: Iterable<string>,
): { errors: FlagSpofFinding[]; warnings: FlagSpofFinding[] } {
  const acknowledged = new Set(acknowledgedFailOpenFlags);
  const isAcknowledgedFailOpen = (f: FlagSpofFinding) =>
    f.code === 'fail-open-flag' && acknowledged.has(f.flag);
  return {
    errors: findings.filter((f) => !isAcknowledgedFailOpen(f)),
    warnings: findings.filter(isAcknowledgedFailOpen),
  };
}

function isMainModule(metaUrl: string, argvPath: string | undefined): boolean {
  return argvPath !== undefined && resolve(fileURLToPath(metaUrl)) === resolve(argvPath);
}

function main(): void {
  const asserted = loadAssertedConfig();
  const running = loadRunningSnapshot();
  const { drift, parity } = runConfigDriftCheck(asserted, running);

  // S1 hardening (README item #6): provider-SPOF — parse the REAL config.ts default
  // + deploy-worker.yml override so a dropped/wrong BITCOIN_UTXO_PROVIDER fails CI, not
  // prod. repoRoot = scripts/ci/../.. (HERE = scripts/ci).
  const repoRoot = resolve(HERE, '..', '..');
  const spof = runProviderSpofCheck(asserted.bitcoinUtxoProvider, {
    configTsPath: resolve(repoRoot, 'services/worker/src/config.ts'),
    deployYmlPath: resolve(repoRoot, '.github/workflows/deploy-worker.yml'),
  });
  const spofErrors = spof.filter((f) => f.severity === 'error');
  const spofWarnings = spof.filter((f) => f.severity === 'warn');

  // Warnings never fail the gate but always surface (e.g. the latent code-default SPOF
  // that the deploy currently masks — a defense-in-depth signal, not a blocker).
  for (const w of spofWarnings) {
    console.warn(`::warning::S1 provider-SPOF [${w.code}] ${w.message}`);
  }

  // S1 hardening (README item #5 — Lane-2): flag-SPOF — parse the REAL deploy-worker.yml
  // env flags + the REAL flagRegistry.ts DB_FLAGS list so the env↔DB fail-open hazard
  // (a DB-gated flag asserted OFF but env=true → fails OPEN when the switchboard row is
  // absent — the 2026-05-30 class) and a launch-required flag set OFF/omitted fail CI.
  // The asserted manifest's `flags` are the intended EFFECTIVE values; a launch-required
  // flag is asserted ON, everything else asserted here is the effective value.
  const assertedFlagsForSpof: Record<string, boolean> = { ...asserted.flags };
  for (const f of asserted.launchRequiredFlags ?? []) assertedFlagsForSpof[f] = true;
  const flagSpof = runFlagSpofCheck(assertedFlagsForSpof, {
    deployYmlPath: resolve(repoRoot, '.github/workflows/deploy-worker.yml'),
    flagRegistryPath: resolve(repoRoot, 'services/worker/src/middleware/flagRegistry.ts'),
  });
  // Two-tier calibration (mirrors providerSpof's masked-latent precedent):
  //  - launch-flag-off / env-flag-on-no-db-guard → always blocking (no DB kill switch can
  //    save a launch flag that is off, nor an env-on flag that has no DB guard at all);
  //  - fail-open-flag → blocking UNLESS the flag is in `acknowledgedFailOpenFlags` (a known,
  //    DB-guarded-today hazard whose deploy fix is a T3/Carson chain-adjacent change). An
  //    acknowledged one is a loud WARN; a NEW, unacknowledged one is a hard ERROR.
  const { errors: flagSpofErrors, warnings: flagSpofWarnings } = classifyFlagSpofFindings(
    flagSpof,
    asserted.acknowledgedFailOpenFlags ?? [],
  );
  for (const w of flagSpofWarnings) {
    console.warn(`::warning::S1 flag-SPOF [${w.code}] (acknowledged) ${w.message}`);
  }

  if (
    drift.length === 0 &&
    parity.length === 0 &&
    spofErrors.length === 0 &&
    flagSpofErrors.length === 0
  ) {
    console.log(
      '✅ config↔reality: no drift; cross-runtime parity intact; provider-SPOF + flag-SPOF clear.',
    );
    return;
  }

  if (drift.length > 0) {
    console.error(
      `::error::S0-5.2 config drift: ${drift.length} issue(s) (asserted repo config vs running prod snapshot):`,
    );
    for (const d of drift) console.error(`  [${d.dimension}] ${d.message}`);
  }
  if (parity.length > 0) {
    console.error(`::error::S0-5.2 cross-runtime parity: ${parity.length} finding(s):`);
    for (const p of parity) console.error(`  [${p.kind}] ${p.message}`);
  }
  if (spofErrors.length > 0) {
    console.error(`::error::S1 provider-SPOF: ${spofErrors.length} issue(s):`);
    for (const s of spofErrors) console.error(`  [${s.code}] ${s.message}`);
  }
  if (flagSpofErrors.length > 0) {
    console.error(`::error::S1 flag-SPOF (env↔DB fail-open): ${flagSpofErrors.length} issue(s):`);
    for (const s of flagSpofErrors) console.error(`  [${s.code}] ${s.flag}: ${s.message}`);
  }
  process.exit(1);
}

if (isMainModule(import.meta.url, process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error('::error::S0-5.2 config-drift check failed to run.');
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  }
}
