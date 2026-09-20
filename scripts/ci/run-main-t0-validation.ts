#!/usr/bin/env -S npx tsx
import { execFileSync } from 'node:child_process';
import {
  changedFilesForPush, decideMainPush, deletedFilesForPush,
  isFocusedRootTest, isFocusedWorkerTest,
} from './main-push-admission.js';

function run(command: string, args: string[], cwd?: string): void {
  console.log(`+ ${command} ${args.join(' ')}`);
  execFileSync(command, args, { cwd, stdio: 'inherit' });
}

const pinnedContracts = [
  'scripts/ci/main-push-admission.test.ts',
  'scripts/ci/main-push-workflow-shell.test.ts',
  'scripts/ci/ci-draft-admission.test.ts',
  'scripts/ci/ci-workflow-contract.test.ts',
  'scripts/ci/check-workflow-action-sha-pinning.test.ts',
];

export interface FocusedTestPlan {
  runCompleteCiSuite: boolean;
  selectedRootTests: string[];
  workerTests: string[];
  shellTests: string[];
}

export function focusedTestPlan(files: string[]): FocusedTestPlan {
  const runCompleteCiSuite = files.some((file) => file.startsWith('.github/') || file.startsWith('scripts/ci/'));
  const rootTests = files.filter(isFocusedRootTest);
  const workerTests = files.filter(isFocusedWorkerTest);
  const shellTests = files.filter((file) => /^scripts\/.*\.test\.sh$/u.test(file));
  const selectedRootTests = [...new Set([...pinnedContracts, ...rootTests])];
  return { runCompleteCiSuite, selectedRootTests, workerTests, shellTests };
}

function main(): void {
  const files = changedFilesForPush(process.env.PUSH_BEFORE ?? '', process.env.PUSH_AFTER ?? '');
  const deleted = deletedFilesForPush(process.env.PUSH_BEFORE ?? '', process.env.PUSH_AFTER ?? '');
  if (deleted.length > 0) throw new Error(`focused validation refuses deletions: ${deleted.join(', ')}`);
  const decision = decideMainPush(files);
  if (!decision.runFocused || decision.runFull) {
    throw new Error(`focused validation refused reclassified push: ${decision.reason}`);
  }

  run('node_modules/.bin/tsx', ['scripts/ci/check-workflow-yaml.ts']);
  run('node_modules/.bin/tsx', ['scripts/ci/check-doc-pointers.ts']);
  run('npm', ['run', 'typecheck']);
  run('npm', ['run', 'build']);
  run('npm', ['run', 'lint:copy']);

  const plan = focusedTestPlan(files);
  if (plan.runCompleteCiSuite) {
  // CI policy can affect any gate. Run its complete contract suite in one job;
  // this is still materially cheaper than starting the 28-job runtime matrix.
    run('node_modules/.bin/vitest', ['run', 'scripts/ci']);
  }
  const extraRootTests = plan.runCompleteCiSuite
    ? plan.selectedRootTests.filter((file) => !file.startsWith('scripts/ci/'))
    : plan.selectedRootTests;
  if (extraRootTests.length > 0) run('node_modules/.bin/vitest', ['run', ...extraRootTests]);

  if (plan.workerTests.length > 0) {
    run('npm', ['ci', '--ignore-scripts'], 'services/worker');
    run('npm', ['run', 'typecheck'], 'services/worker');
    run('npm', ['run', 'build'], 'services/worker');
    run('node_modules/.bin/vitest', ['run', ...plan.workerTests.map((file) => file.slice('services/worker/'.length))], 'services/worker');
  }
  for (const test of plan.shellTests) run('/usr/bin/bash', [test]);

  console.log(`Focused protected-main validation PASS (${files.length} changed files)`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
