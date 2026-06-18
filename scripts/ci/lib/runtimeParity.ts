/**
 * S0-5.2 (Lane 1) — cross-runtime parity harness (SKELETON).
 *
 * Compares the Cloud Run worker (Node/Express, `services/worker`) against the
 * Cloudflare edge worker (`services/edge`) on the config dimensions that MUST
 * agree across runtimes: shared feature flags, the chain provider, and CSP
 * reachability. Precedent for cross-runtime drift guards:
 * `services/worker/src/nessie-embedding-drift.test.ts`.
 *
 * SKELETON: the three checks below are real and tested; the marked extension
 * points are where Sprint 1's parity net grows (shared route contracts,
 * per-route auth mode, rate-limit headers, embedding-model parity).
 */

export interface RuntimeConfig {
  runtime: 'worker' | 'edge';
  /** Public origin (used for the CSP reachability check). */
  origin: string;
  /** Feature flags this runtime declares. */
  flags: Record<string, boolean>;
  /** Chain UTXO provider, when the runtime declares one. */
  bitcoinUtxoProvider?: string;
}

export interface ParityFinding {
  kind: 'flag-disagreement' | 'provider-disagreement' | 'csp-unreachable-runtime';
  message: string;
}

/**
 * Compare two runtimes + the shared CSP connect-src allowlist.
 * Only flags declared by BOTH runtimes are compared (a runtime-specific flag
 * is not a disagreement). Returns one finding per divergence; [] when aligned.
 */
export function compareRuntimeConfigs(
  worker: RuntimeConfig,
  edge: RuntimeConfig,
  cspConnectSrc: string[],
): ParityFinding[] {
  const findings: ParityFinding[] = [];

  // 1. Shared flags must agree.
  const sharedKeys = Object.keys(worker.flags)
    .filter((key) => key in edge.flags)
    .sort((a, b) => a.localeCompare(b));
  for (const key of sharedKeys) {
    if (worker.flags[key] !== edge.flags[key]) {
      findings.push({
        kind: 'flag-disagreement',
        message: `flag ${key}: worker=${worker.flags[key]} edge=${edge.flags[key]}`,
      });
    }
  }

  // 2. If both runtimes declare a chain provider, it must match.
  if (
    worker.bitcoinUtxoProvider &&
    edge.bitcoinUtxoProvider &&
    worker.bitcoinUtxoProvider !== edge.bitcoinUtxoProvider
  ) {
    findings.push({
      kind: 'provider-disagreement',
      message: `bitcoinUtxoProvider: worker=${worker.bitcoinUtxoProvider} edge=${edge.bitcoinUtxoProvider}`,
    });
  }

  // 3. Each runtime origin must be reachable per the CSP connect-src allowlist.
  const csp = new Set(cspConnectSrc);
  for (const rt of [worker, edge]) {
    if (!csp.has(rt.origin)) {
      findings.push({
        kind: 'csp-unreachable-runtime',
        message: `${rt.runtime} origin ${rt.origin} is not in the CSP connect-src allowlist`,
      });
    }
  }

  // EXTENSION POINTS (Sprint 1 parity net): shared route contracts, per-route
  // auth mode (MCP api-key vs cron-secret vs public), rate-limit headers, and
  // embedding-model parity (worker gemini-embedding-001 vs edge bge-base).
  return findings;
}
