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

function main(): void {
  const decision = decideMainPushFromGit(process.env.PUSH_BEFORE ?? '', process.env.PUSH_AFTER ?? '');
  const output = process.env.GITHUB_OUTPUT;
  if (!output) throw new Error('GITHUB_OUTPUT is required');
  appendFileSync(output, `run_full=${decision.runFull}\nrun_focused=${decision.runFocused}\n`);
  console.log(`Protected-main admission: ${decision.runFull ? 'full' : 'focused'} (${decision.reason})`);
  console.log(`Changed files (${decision.files.length}): ${decision.files.join(', ')}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
