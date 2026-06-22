/**
 * S1 hardening of the config↔reality drift gate — the **provider-SPOF check**
 * (config-drift/README.md "SPIKE boundary → Sprint 1" item #6; CHAIN-RESIL slice,
 * Lane 1).
 *
 * The worker's `BITCOIN_UTXO_PROVIDER` code default (`services/worker/src/config.ts`)
 * is `'mempool'`, while prod is intended to run `'getblock'` (the asserted provider),
 * set explicitly by `deploy-worker.yml --set-env-vars`. If that one env line is ever
 * dropped, the worker silently falls back to `'mempool'` — the exact mempool↔GetBlock
 * drift class (R-4 / PM-L-DRIFT / the 2026-05-30 prod audit finding).
 *
 * Unlike `diffConfigState` (which compares two committed JSON snapshots), this parses
 * the REAL source files — the Sprint-1 source-parse the SPIKE deferred — so a dropped
 * or wrong deploy override fails CI, and a latent code-default divergence is surfaced
 * as a warning even while the deploy currently masks it.
 *
 * DETECTION ONLY. This never edits `config.ts` or `deploy-worker.yml`; changing the
 * actual provider is a chain-touching T3 change gated to Carson (CLAUDE.md §1.11A/§1.12).
 */
import { readFileSync } from 'node:fs';

export type ProviderSpofSeverity = 'error' | 'warn';
export type ProviderSpofCode =
  | 'deploy-omits-override'
  | 'deploy-mismatch'
  | 'code-default-divergence';

export interface ProviderSpofFinding {
  severity: ProviderSpofSeverity;
  code: ProviderSpofCode;
  message: string;
}

export interface ProviderSpofInputs {
  /** The intended prod provider (from expected-prod-config.json `bitcoinUtxoProvider`). */
  assertedProvider: string;
  /** The `.default(...)` provider parsed from `config.ts` — the silent fallback. */
  codeDefaultProvider: string;
  /** The value the deploy sets, or `null` if the deploy omits the env var. */
  deployedProvider: string | null;
}

/**
 * Pure SPOF classifier. Exactly one finding per state:
 *  - deploy omits the override AND code-default != asserted → ERROR (the SPOF is ACTIVE).
 *  - deploy sets a value != asserted                        → ERROR (drift).
 *  - deploy correct but code-default != asserted            → WARN  (the SPOF is LATENT;
 *      the deploy masks it, but a dropped env line would fail to the WRONG provider).
 *  - otherwise                                              → no finding (fails safe).
 */
export function checkProviderSpof(input: ProviderSpofInputs): ProviderSpofFinding[] {
  const { assertedProvider, codeDefaultProvider, deployedProvider } = input;
  const findings: ProviderSpofFinding[] = [];

  if (deployedProvider === null) {
    if (codeDefaultProvider !== assertedProvider) {
      findings.push({
        severity: 'error',
        code: 'deploy-omits-override',
        message:
          `deploy-worker.yml omits BITCOIN_UTXO_PROVIDER; the worker falls back to the ` +
          `config.ts default '${codeDefaultProvider}', but the asserted prod provider is ` +
          `'${assertedProvider}' — a silent mempool↔GetBlock SPOF (R-4 / PM-L-DRIFT). ` +
          `Set BITCOIN_UTXO_PROVIDER='${assertedProvider}' in deploy-worker.yml.`,
      });
    }
    // else: omitting is SAFE — the code default already equals the asserted provider.
  } else if (deployedProvider !== assertedProvider) {
    findings.push({
      severity: 'error',
      code: 'deploy-mismatch',
      message:
        `deploy-worker.yml sets BITCOIN_UTXO_PROVIDER='${deployedProvider}' but the asserted ` +
        `prod provider is '${assertedProvider}'.`,
    });
  } else if (codeDefaultProvider !== assertedProvider) {
    findings.push({
      severity: 'warn',
      code: 'code-default-divergence',
      message:
        `config.ts defaults BITCOIN_UTXO_PROVIDER to '${codeDefaultProvider}' while prod asserts ` +
        `'${assertedProvider}'. The deploy currently masks this, but a dropped env line would fail ` +
        `to the WRONG provider. Recommend aligning the config.ts default to '${assertedProvider}' ` +
        `so a dropped override fails safe.`,
    });
  }

  return findings;
}

// Tolerates whitespace/newlines inside the z.enum([...]) and around the default arg.
const CODE_DEFAULT_RE =
  /bitcoinUtxoProvider\s*:\s*z\.enum\([\s\S]*?\)\s*\.default\(\s*['"]([^'"]+)['"]\s*\)/;

/** Parse the `bitcoinUtxoProvider: z.enum([...]).default('X')` default. Throws (fail closed) if absent. */
export function parseCodeDefaultProvider(configTsSource: string): string {
  const m = CODE_DEFAULT_RE.exec(configTsSource);
  if (!m) {
    throw new Error(
      'provider-SPOF: could not parse bitcoinUtxoProvider .default(...) from config.ts (fail closed)',
    );
  }
  return m[1];
}

const DEPLOY_RE = /BITCOIN_UTXO_PROVIDER=([A-Za-z0-9_-]+)/;

/** Parse `BITCOIN_UTXO_PROVIDER=<value>` from the deploy --set-env-vars line; null if omitted. */
export function parseDeployedProvider(deployYmlSource: string): string | null {
  const m = DEPLOY_RE.exec(deployYmlSource);
  return m ? m[1] : null;
}

export interface ProviderSpofSources {
  configTsPath: string;
  deployYmlPath: string;
}

/** Read the real source files, parse, and classify. Used by the gate's main(). */
export function runProviderSpofCheck(
  assertedProvider: string,
  sources: ProviderSpofSources,
): ProviderSpofFinding[] {
  const codeDefaultProvider = parseCodeDefaultProvider(readFileSync(sources.configTsPath, 'utf8'));
  const deployedProvider = parseDeployedProvider(readFileSync(sources.deployYmlPath, 'utf8'));
  return checkProviderSpof({ assertedProvider, codeDefaultProvider, deployedProvider });
}
