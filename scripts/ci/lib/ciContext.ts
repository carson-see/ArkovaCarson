/**
 * Shared CI context (SCRUM-1253 / R0-7).
 *
 * Single source of truth for the env vars + git helpers that every
 * scripts/ci/* check reads. Replaces the 5-way duplication where each
 * rule re-declared `BASE_REF`, `PR_LABELS`, `PR_BODY`, etc.
 *
 * Override labels live here too so the names cannot drift between
 * documentation (memory/README.md) and the actual checks.
 */

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';

export const REPO = resolve(import.meta.dirname, '..', '..', '..');

// Resolve the `gh` CLI to a FIXED absolute path instead of letting the OS
// search `$PATH` (Sonar typescript:S4036 — a writable/attacker-controlled PATH
// entry could shadow the real binary). `/usr/bin/gh` is where GitHub-hosted
// Ubuntu runners install it; an explicit `GH_BIN` override covers self-hosted
// runners and local dev (e.g. Homebrew's `/opt/homebrew/bin/gh`). Mirrors the
// `GIT_BIN` convention in check-duplicate-artifacts.ts / check-dep-pinning.ts.
export const GH_BIN = process.env.GH_BIN ?? '/usr/bin/gh';

/**
 * True when a module is being run directly (not imported). Uses fileURLToPath
 * so a checkout path containing a space or `%` is URL-decoded correctly —
 * `new URL(metaUrl).pathname` does NOT decode and would silently no-op the
 * CLI. Mirrors the helper in check-api-contract-drift.ts / staging-honesty-preflight.ts.
 */
export function isMainModule(metaUrl: string, argvPath: string | undefined): boolean {
  return argvPath !== undefined && resolve(fileURLToPath(metaUrl)) === resolve(argvPath);
}

// Code-review issue #N (PR #563): on push events ci.yml passes the literal
// string 'HEAD~1' as BASE_REF_SHA. On a single-commit branch or shallow
// checkout HEAD~1 doesn't exist; git diff/grep against the literal string
// silently fails and downstream try/catches return [] / 0, no-op'ing the
// gates. Fail closed instead — resolve to a real SHA via git rev-parse,
// or exit 1 with a clear actionable message.
export function resolveCommitOrFail(ref: string, label = 'CI base ref'): string {
  try {
    const sha = execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (!/^[0-9a-f]{40}$/i.test(sha)) {
      throw new Error(`git rev-parse returned non-SHA: ${sha}`);
    }
    return sha;
  } catch (err) {
    console.error(`::error::Cannot resolve ${label} '${ref}' (R0 / SCRUM-1246).`);
    console.error('  This usually means a shallow checkout. Use `actions/checkout@v4 with: fetch-depth: 0`.');
    console.error(`  Underlying error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

const RAW_BASE_REF = process.env.BASE_REF_SHA || process.env.BASE_REF || 'origin/main';
export const baseRef = resolveCommitOrFail(RAW_BASE_REF);

/**
 * Derive the PR number from the CI environment.
 *
 * On `pull_request` events GitHub sets `GITHUB_REF` to `refs/pull/<N>/merge`
 * (or `.../head`). We parse that first, then fall back to an explicit
 * `PR_NUMBER` env (e.g. staging-evidence.yml already passes one). Returns
 * `null` on push/main and any non-PR context — callers must treat that as
 * "no live labels available" and fall back to env-only behavior.
 */
export function parsePrNumber(env: NodeJS.ProcessEnv = process.env): number | null {
  const ref = env.GITHUB_REF ?? '';
  const m = /^refs\/pull\/(\d+)\/(?:merge|head)$/.exec(ref);
  if (m) return Number(m[1]);
  const explicit = (env.PR_NUMBER ?? '').trim();
  if (/^\d+$/.test(explicit)) return Number(explicit);
  return null;
}

const ENV_LABELS_SPLIT = (raw: string | undefined): string[] =>
  (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/**
 * Fetch the PR's labels LIVE from the GitHub API via `gh`.
 *
 * Why this exists: ci.yml seeds `PR_LABELS` from the FROZEN `pull_request`
 * event payload, and the `pull_request` trigger does not fire on `labeled`.
 * Adding an override label after a run + `gh run rerun` replays the frozen
 * payload WITHOUT the label, so every label-gated override is structurally
 * non-functional on re-runs. Reading labels live closes that hole.
 *
 * Synchronous (matches the module's existing execFileSync style), short
 * timeout, and swallows ALL errors to an empty list so a missing `gh`, an
 * API error, or a non-PR context degrades gracefully to env-only behavior.
 * Requires `pull-requests: read` on the calling job.
 */
export function fetchLiveLabels(env: NodeJS.ProcessEnv = process.env): string[] {
  const prNumber = parsePrNumber(env);
  const repo = env.GITHUB_REPOSITORY ?? '';
  if (prNumber === null || !repo) return [];
  try {
    const out = execFileSync(
      GH_BIN,
      ['api', `repos/${repo}/issues/${prNumber}/labels`, '--jq', '.[].name'],
      { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 },
    );
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * The effective PR label set: the env-seeded (frozen-payload) labels UNIONed
 * with the live labels fetched from the API, deduped. On any non-PR context
 * or fetch failure this is exactly the env-only set (unchanged behavior).
 */
export function resolvePrLabels(env: NodeJS.ProcessEnv = process.env): string[] {
  return [...new Set([...ENV_LABELS_SPLIT(env.PR_LABELS), ...fetchLiveLabels(env)])];
}

export const prLabels = resolvePrLabels();
export const prTitle = process.env.PR_TITLE ?? '';
export const prBody = process.env.PR_BODY ?? '';
export const prCommitsMsgs = process.env.PR_COMMITS_MSGS ?? '';
export const headRef = process.env.GITHUB_HEAD_REF ?? process.env.GITHUB_REF_NAME ?? '';
export const repository = process.env.GITHUB_REPOSITORY ?? '';
export const scanAll = process.env.FEEDBACK_RULES_SCAN_ALL === '1';

export const LABELS = {
  postBetaQuotaRollout: 'post-beta-quota-rollout',
  awsIntentional: 'aws-intentional',
  handoffNarrativeOnly: 'handoff-narrative-only',
  countExactAllowed: 'count-exact-allowed',
  coverageDropAllowed: 'coverage-drop-allowed',
  ciConfigChange: 'ci-config-change',
  confluenceDriftSkip: 'confluence-drift-skip',
} as const;

/**
 * Atlassian Basic-auth header builder. Reused by check-confluence-coverage
 * (CI gate) and the healthcheck Atlassian probes — same env var contract
 * on both sides.
 */
export function atlassianBasicAuthHeader(email: string, token: string): string {
  return `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
}

export function hasLabel(label: string): boolean {
  // Resolve live at call time so a label added after the frozen pull_request
  // payload (then `gh run rerun`) is honored — the whole point of the fix.
  return resolvePrLabels().includes(label);
}

/**
 * Files changed vs `baseRef` (or all matching `pathspec` when scanAll=true).
 * Uses execFileSync to avoid shell-quoting issues with glob patterns.
 */
export function changedFiles(pathspec?: string): string[] {
  if (scanAll) {
    try {
      const args = pathspec ? ['ls-files', pathspec] : ['ls-files'];
      return execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }
  try {
    const args = ['diff', '--name-only', '--diff-filter=AMR', `${baseRef}...HEAD`];
    if (pathspec) args.push('--', pathspec);
    return execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch {
    return [];
  }
}
