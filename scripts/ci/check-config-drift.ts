#!/usr/bin/env -S npx tsx
/**
 * S0-5.2 (Lane 1) — config↔reality drift gate (SPIKE). Retires risk R-5.
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
import {
  compareRuntimeConfigs,
  type RuntimeConfig,
  type ParityFinding,
} from './lib/runtimeParity.js';

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

export function loadConfigFile(path: string): SnapshotFile {
  return JSON.parse(readFileSync(path, 'utf8')) as SnapshotFile;
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
  const parity = asserted.runtimes
    ? compareRuntimeConfigs(asserted.runtimes.worker, asserted.runtimes.edge, asserted.cspConnectSrc)
    : [];
  return { drift, parity };
}

function isMainModule(metaUrl: string, argvPath: string | undefined): boolean {
  return argvPath !== undefined && resolve(fileURLToPath(metaUrl)) === resolve(argvPath);
}

function main(): void {
  const asserted = loadAssertedConfig();
  const running = loadRunningSnapshot();
  const { drift, parity } = runConfigDriftCheck(asserted, running);

  if (drift.length === 0 && parity.length === 0) {
    console.log('✅ config↔reality: no drift; cross-runtime parity intact.');
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
