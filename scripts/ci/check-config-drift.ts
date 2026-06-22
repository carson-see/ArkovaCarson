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

  if (drift.length === 0 && parity.length === 0 && spofErrors.length === 0) {
    console.log('✅ config↔reality: no drift; cross-runtime parity intact; provider-SPOF clear.');
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
