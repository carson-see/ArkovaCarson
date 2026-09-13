#!/usr/bin/env -S npx tsx
/**
 * SCRUM-3907 — read-only drift check: is the LIVE arkova-edge Cloudflare
 * Worker (edge.arkova.ai) actually running the code on `origin/main`, or is
 * it the "merged-but-undeployed" state that let PR #2589's ES256 verifier
 * fix (and the SCRUM-3797 MCP audit-log fix) sit on `main` for months with
 * nothing to notice or complain?
 *
 * Queries the PUBLIC, unauthenticated `https://edge.arkova.ai/health`
 * endpoint (`services/edge/src/index.ts`) for `{ git_sha, built_at }` — see
 * `services/edge/src/build-info.ts` / `services/edge/scripts/
 * generate-build-info.mjs` for how that field is populated by
 * `.github/workflows/edge-deploy.yml` at deploy time — and compares it
 * against the current `origin/main` HEAD via plain `git` ancestry, no
 * network call to GitHub required.
 *
 * This performs exactly one read-only HTTPS GET against a public prod
 * endpoint. It never writes to Cloudflare, GCP, GitHub, or Supabase, and
 * needs no credentials.
 *
 * Modes:
 *   npx tsx scripts/ci/check-edge-deployed-version.ts             -> warn-only, always exit 0
 *   npx tsx scripts/ci/check-edge-deployed-version.ts --strict     -> exit 1 on any drift finding
 *   --url=<health URL>        point at a soak rig instead of production (default https://edge.arkova.ai/health)
 *   --expected-sha=<40-hex>   compare against this SHA instead of `origin/main` (rig standups deploy a PR head)
 * Defaults are unchanged; without --url a local run reads PRODUCTION's /health (read-only GET).
 *
 * Wired into ci.yml as a `continue-on-error: true` job (warn-only doubly —
 * belt-and-suspenders with the default no-`--strict` exit-0 behavior above)
 * so a currently-known-stale prod edge (see SCRUM-3797) does not block
 * unrelated PRs while this check is new.
 */

import { execFileSync } from 'node:child_process';

export interface HealthResponse {
  status?: string;
  service?: string;
  git_sha?: string;
  built_at?: string | null;
}

export type DriftStatus =
  | { kind: 'match'; sha: string }
  | { kind: 'behind'; deployedSha: string; mainSha: string; commitsBehind: number }
  | { kind: 'missing-field'; rawHealth: HealthResponse | null }
  | { kind: 'diverged'; deployedSha: string; mainSha: string }
  | { kind: 'fetch-error'; error: string };

/**
 * Pure classifier — no I/O. `isAncestor`/`commitsBehind` are injected so
 * this is unit-testable without a real git repo or network call.
 */
export function classifyDrift(params: {
  health: HealthResponse | null;
  fetchError: string | null;
  mainSha: string;
  isAncestor: (sha: string) => boolean;
  commitsBehind: (sha: string) => number;
}): DriftStatus {
  if (params.fetchError) return { kind: 'fetch-error', error: params.fetchError };

  const deployedSha = params.health?.git_sha;
  if (!deployedSha || typeof deployedSha !== 'string' || deployedSha === 'local-dev' || deployedSha === 'unknown') {
    // 'local-dev' / 'unknown' are the checked-in placeholder / unresolvable-SHA
    // sentinels from build-info.ts — a prod edge reporting either one was
    // never run through the generator, i.e. exactly the historical
    // pre-pipeline state (SCRUM-3797). Treat identically to a missing field.
    return { kind: 'missing-field', rawHealth: params.health };
  }
  if (deployedSha === params.mainSha) return { kind: 'match', sha: deployedSha };
  if (!params.isAncestor(deployedSha)) {
    return { kind: 'diverged', deployedSha, mainSha: params.mainSha };
  }
  return { kind: 'behind', deployedSha, mainSha: params.mainSha, commitsBehind: params.commitsBehind(deployedSha) };
}

/** Human/CI-readable report. `isDrift` decides `--strict` exit behavior. */
export function formatReport(drift: DriftStatus): { message: string; isDrift: boolean } {
  switch (drift.kind) {
    case 'match':
      return { message: `✅ edge.arkova.ai is serving origin/main HEAD (${drift.sha}). No drift.`, isDrift: false };
    case 'behind':
      return {
        message:
          `::warning::edge.arkova.ai is ${drift.commitsBehind} commit(s) behind origin/main ` +
          `(live=${drift.deployedSha}, main=${drift.mainSha}). A merged edge fix has not shipped — ` +
          'dispatch .github/workflows/edge-deploy.yml (workflow_dispatch) to deploy the current main.',
        isDrift: true,
      };
    case 'diverged':
      return {
        message:
          `::error::edge.arkova.ai reports git_sha=${drift.deployedSha}, which is NOT an ancestor of ` +
          `origin/main (${drift.mainSha}). The live edge is running code from a ref that is not on main — ` +
          'investigate before trusting this deploy pipeline further.',
        isDrift: true,
      };
    case 'missing-field':
      return {
        message:
          '::warning::edge.arkova.ai/health did not report a usable git_sha (missing, or the ' +
          "unresolved 'local-dev'/'unknown' placeholder). This is the pre-SCRUM-3907 state: the live " +
          'edge was never deployed through the generator, so its actual commit is unknown. Dispatch ' +
          '.github/workflows/edge-deploy.yml to establish a known-good baseline.',
        isDrift: true,
      };
    case 'fetch-error':
      return {
        message: `::warning::could not reach https://edge.arkova.ai/health: ${drift.error}. Drift status unknown.`,
        isDrift: true,
      };
  }
}

export function resolveMainSha(): string {
  return execFileSync('git', ['rev-parse', 'origin/main'], { encoding: 'utf8' }).trim();
}

export function gitIsAncestor(sha: string, of = 'origin/main'): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', sha, of], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function gitCommitsBehind(sha: string, of = 'origin/main'): number {
  const out = execFileSync('git', ['rev-list', '--count', `${sha}..${of}`], { encoding: 'utf8' }).trim();
  const n = Number(out);
  return Number.isFinite(n) ? n : 0;
}

export async function fetchEdgeHealth(
  url = 'https://edge.arkova.ai/health',
): Promise<{ health: HealthResponse | null; error: string | null }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { health: null, error: `HTTP ${res.status}` };
    const json = (await res.json()) as HealthResponse;
    return { health: json, error: null };
  } catch (err) {
    return { health: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface CliOptions {
  strict: boolean;
  url: string;
  /** 40-hex SHA to compare against; null means resolve `origin/main`. */
  expectedSha: string | null;
}

/**
 * Parse `--strict`, `--url=<...>` and `--expected-sha=<40-hex>`. Unknown flags
 * are ignored (CI passes none today). A malformed --expected-sha throws so a
 * typo can never silently compare against origin/main instead of the rig head.
 */
export function parseArgs(argv: readonly string[]): CliOptions {
  const opts: CliOptions = { strict: false, url: 'https://edge.arkova.ai/health', expectedSha: null };
  for (const arg of argv) {
    if (arg === '--strict') opts.strict = true;
    else if (arg.startsWith('--url=')) {
      const url = arg.slice('--url='.length);
      if (!/^https?:\/\//.test(url)) throw new Error(`--url must be an http(s) URL, got: ${url}`);
      opts.url = url;
    } else if (arg.startsWith('--expected-sha=')) {
      const sha = arg.slice('--expected-sha='.length).toLowerCase();
      if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('--expected-sha must be a 40-character hex SHA');
      opts.expectedSha = sha;
    }
  }
  return opts;
}

async function main(): Promise<void> {
  const { strict, url, expectedSha } = parseArgs(process.argv.slice(2));
  const ref = expectedSha ?? 'origin/main';
  const mainSha = expectedSha ?? resolveMainSha();
  const { health, error } = await fetchEdgeHealth(url);
  const drift = classifyDrift({
    health,
    fetchError: error,
    mainSha,
    isAncestor: (sha) => gitIsAncestor(sha, ref),
    commitsBehind: (sha) => gitCommitsBehind(sha, ref),
  });
  const { message, isDrift } = formatReport(drift);
  console.log(message);
  if (isDrift) {
    if (strict) {
      console.error('::error::check-edge-deployed-version: drift detected and --strict was passed. Failing.');
      process.exit(1);
    }
    console.log('::notice::check-edge-deployed-version: drift detected but running warn-only (pass --strict to fail CI on this).');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('::error::check-edge-deployed-version threw unexpectedly:', err);
    // Never hard-fail CI on an unexpected script error unless --strict was
    // explicitly requested — this script's whole purpose is out-of-band
    // observability, not a new way to redden unrelated PRs.
    process.exit(process.argv.includes('--strict') ? 1 : 0);
  });
}
