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
import { Buffer } from 'node:buffer';

export const REPO = resolve(import.meta.dirname, '..', '..', '..');

// Code-review issue #N (PR #563): on push events ci.yml passes the literal
// string 'HEAD~1' as BASE_REF_SHA. On a single-commit branch or shallow
// checkout HEAD~1 doesn't exist; git diff/grep against the literal string
// silently fails and downstream try/catches return [] / 0, no-op'ing the
// gates. Fail closed instead — resolve to a real SHA via git rev-parse,
// or exit 1 with a clear actionable message.
function resolveBaseRefOrFail(ref: string): string {
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
    console.error(`::error::Cannot resolve CI base ref '${ref}' (R0 / SCRUM-1246).`);
    console.error('  This usually means a shallow checkout. Use `actions/checkout@v4 with: fetch-depth: 0`.');
    console.error(`  Underlying error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

const RAW_BASE_REF = process.env.BASE_REF_SHA || process.env.BASE_REF || 'origin/main';
export const baseRef = resolveBaseRefOrFail(RAW_BASE_REF);
export const prLabels = (process.env.PR_LABELS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
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
  return prLabels.includes(label);
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
