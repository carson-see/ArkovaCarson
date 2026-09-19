#!/usr/bin/env -S npx tsx
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { requiredTierFor } from './check-staging-evidence.js';

const SHA_RE = /^[0-9a-f]{40}$/u;
const ZERO_SHA = '0'.repeat(40);

export interface MainPushDecision {
  runFull: boolean;
  runFocused: boolean;
  reason: string;
  files: string[];
}

interface WorkflowRun {
  head_sha?: unknown;
  head_branch?: unknown;
  event?: unknown;
  status?: unknown;
  conclusion?: unknown;
  path?: unknown;
  head_repository?: { full_name?: unknown } | null;
}

interface WorkflowRunsResponse {
  workflow_runs?: unknown;
}

const CI_WORKFLOW_PATH = '.github/workflows/ci.yml';
const MAX_RUN_PAGES = 3;
const API_TIMEOUT_MS = 10_000;

export interface BaselineLookupInput {
  repository: string;
  after: string;
  token: string;
  fetchImpl?: typeof fetch;
}

/**
 * Find the newest successful protected-main CI push which is an ancestor of
 * this push. GitHub can cancel a queued main run even with
 * cancel-in-progress=false, so event.before is not evidence that the previous
 * commit completed validation. Every field from the API is treated as
 * untrusted and a missing/invalid baseline fails closed in main().
 */
export async function resolveSuccessfulMainBaseline(input: BaselineLookupInput): Promise<string> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(input.repository)) {
    throw new Error('GITHUB_REPOSITORY is missing or malformed');
  }
  if (!SHA_RE.test(input.after) || input.after === ZERO_SHA) throw new Error('PUSH_AFTER is malformed');
  if (!input.token) throw new Error('GITHUB_TOKEN is required for successful-run lookup');
  const request = input.fetchImpl ?? fetch;
  const workflow = encodeURIComponent(CI_WORKFLOW_PATH);
  for (let page = 1; page <= MAX_RUN_PAGES; page += 1) {
    const url = `https://api.github.com/repos/${input.repository}/actions/workflows/${workflow}/runs?branch=main&event=push&status=success&per_page=100&page=${page}`;
    const response = await request(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${input.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!response.ok) throw new Error(`successful-run lookup returned HTTP ${response.status}`);
    const body = await response.json() as WorkflowRunsResponse;
    if (!Array.isArray(body.workflow_runs)) throw new Error('successful-run lookup returned malformed JSON');
    for (const value of body.workflow_runs) {
      if (!value || typeof value !== 'object') continue;
      const run = value as WorkflowRun;
      const sha = run.head_sha;
      if (typeof sha !== 'string' || !SHA_RE.test(sha) || sha === input.after) continue;
      if (run.head_branch !== 'main' || run.event !== 'push' || run.status !== 'completed'
        || run.conclusion !== 'success' || run.path !== CI_WORKFLOW_PATH
        || run.head_repository?.full_name !== input.repository) continue;
      try {
        git(['cat-file', '-e', `${sha}^{commit}`]);
        execFileSync('/usr/bin/git', ['merge-base', '--is-ancestor', sha, input.after], {
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        return sha;
      } catch {
        // A successful run on a replaced/non-ancestor history is not a valid
        // baseline for this push. Continue only within the bounded result set.
      }
    }
    if (body.workflow_runs.length < 100) break;
  }
  throw new Error('no successful reachable protected-main CI baseline found');
}

export function isFocusedRootTest(file: string): boolean {
  return /^(?:tests\/.*\.test\.ts|src\/.*\.test\.(?:ts|tsx)|scripts\/.*\.test\.ts)$/u.test(file)
    && !/^tests\/(?:rls|load|infra)\//u.test(file)
    && !/^src\/tests\/(?:rls|migrations)\//u.test(file)
    && !/\.integration\.test\.ts$/u.test(file);
}

export function isFocusedWorkerTest(file: string): boolean {
  return /^services\/worker\/(?:src|tests|scripts)\/.*\.test\.ts$/u.test(file)
    && file !== 'services/worker/src/api/admin-invitations.local.test.ts'
    && !/\.integration\.test\.ts$/u.test(file);
}

/** T0 surfaces whose relevant checks the focused runner can execute exactly. */
export function supportsFocusedValidation(file: string): boolean {
  // Deployment and environment workflows can change production behavior even
  // when the generic tier detector calls the YAML edit T0. Only this CI
  // workflow has a complete focused policy-contract suite.
  if (file.startsWith('.github/workflows/')
    && file !== '.github/workflows/ci.yml'
    && file !== '.github/workflows/agents.md') return false;
  // These suites require the local Supabase/seed harness used by the full test
  // job. A green focused runner must never mean "the selected test was skipped".
  const rootTest = isFocusedRootTest(file);
  const workerTest = isFocusedWorkerTest(file);
  return /^(?:docs\/|memory\/)/u.test(file)
    || /(?:^|\/)(?:agents|agents-changelog)\.md$/u.test(file)
    || /^(?:HANDOFF|CLAUDE|README|ARKOVA_WORKSPACE_README|WORKSPACE_STATUS)\.md$/u.test(file)
    || /^\.github\/(?:workflows\/(?:ci\.yml|agents\.md)$|ISSUE_TEMPLATE\/|pull_request_template\.md$|CONTRIBUTING\.md$|dependabot\.yml$)/u.test(file)
    || /^scripts\/ci\//u.test(file)
    || rootTest
    || workerTest
    || /^scripts\/.*\.test\.sh$/u.test(file);
}

export function decideMainPush(files: string[]): MainPushDecision {
  if (files.length === 0) {
    return { runFull: true, runFocused: false, reason: 'empty changed-file set', files };
  }
  const tier = requiredTierFor(files);
  if (tier.tier !== 'T0') {
    return { runFull: true, runFocused: false, reason: `${tier.tier}: ${tier.reason}`, files };
  }
  const unsupported = files.filter((file) => !supportsFocusedValidation(file));
  if (unsupported.length > 0) {
    return {
      runFull: true,
      runFocused: false,
      reason: `T0 surface lacks focused validation: ${unsupported.join(', ')}`,
      files,
    };
  }
  return { runFull: false, runFocused: true, reason: tier.reason, files };
}

function git(args: string[]): string {
  return execFileSync('/usr/bin/git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export function changedFilesForPush(before: string, after: string): string[] {
  if (!SHA_RE.test(before) || !SHA_RE.test(after) || before === ZERO_SHA || after === ZERO_SHA) {
    throw new Error('push SHAs are missing, malformed, or all-zero');
  }
  git(['cat-file', '-e', `${before}^{commit}`]);
  git(['cat-file', '-e', `${after}^{commit}`]);
  execFileSync('/usr/bin/git', ['merge-base', '--is-ancestor', before, after], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  // --no-renames makes a rename visible as delete+add, so both path authorities
  // are classified. NUL transport preserves every valid Git filename.
  return git(['diff', '--name-only', '-z', '--no-renames', before, after])
    .split('\0').filter(Boolean).sort();
}

export function deletedFilesForPush(before: string, after: string): string[] {
  // Reuse the full validation and ancestry checks before interpreting a
  // deletion-only diff. Deletions and rename-old-sides take the full matrix.
  changedFilesForPush(before, after);
  return git(['diff', '--name-only', '-z', '--no-renames', '--diff-filter=D', before, after])
    .split('\0').filter(Boolean).sort();
}

export function decideMainPushFromGit(before: string, after: string): MainPushDecision {
  try {
    const files = changedFilesForPush(before, after);
    const deleted = deletedFilesForPush(before, after);
    if (deleted.length > 0) {
      return {
        runFull: true,
        runFocused: false,
        reason: `deleted or renamed paths require full validation: ${deleted.join(', ')}`,
        files,
      };
    }
    return decideMainPush(files);
  } catch (error) {
    return {
      runFull: true,
      runFocused: false,
      reason: `fail-closed diff resolution: ${error instanceof Error ? error.message : String(error)}`,
      files: [],
    };
  }
}

async function main(): Promise<void> {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) throw new Error('GITHUB_OUTPUT is required');
  let baseline = '';
  let decision: MainPushDecision;
  try {
    if (process.env.GITHUB_EVENT_NAME !== 'push' || process.env.GITHUB_REF !== 'refs/heads/main') {
      throw new Error('successful-baseline admission only supports protected-main push events');
    }
    baseline = await resolveSuccessfulMainBaseline({
      repository: process.env.GITHUB_REPOSITORY ?? '',
      after: process.env.PUSH_AFTER ?? '',
      token: process.env.GITHUB_TOKEN ?? '',
    });
    decision = decideMainPushFromGit(baseline, process.env.PUSH_AFTER ?? '');
  } catch (error) {
    decision = {
      runFull: true,
      runFocused: false,
      reason: `fail-closed successful-baseline resolution: ${error instanceof Error ? error.message : String(error)}`,
      files: [],
    };
  }
  appendFileSync(output, `run_full=${decision.runFull}\nrun_focused=${decision.runFocused}\n`);
  appendFileSync(output, `baseline_sha=${baseline}\n`);
  console.log(`Protected-main admission: ${decision.runFull ? 'full' : 'focused'} (${decision.reason})`);
  console.log(`Successful protected-main baseline: ${baseline || 'unavailable (full matrix)'}`);
  console.log(`Changed files (${decision.files.length}): ${decision.files.join(', ')}`);
}

if (import.meta.url === `file://${process.argv[1]}`) void main();
