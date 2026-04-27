#!/usr/bin/env -S npx tsx
/**
 * SCRUM-1250 (R0-4) — drift check: deploy-worker.yml lint command must
 * equal ci.yml lint command for the worker (both invocations of `npm run lint`
 * in the same `services/worker` working directory).
 *
 * Why: the 2026-04-25 outage was caused by the deploy gate using
 * `npx eslint src/ --max-warnings 0` while ci.yml's lint job used a different
 * invocation entirely. The two drifted, every push failed deploy on
 * pre-existing warnings, and 12+ commits never reached prod for ~12h.
 *
 * This check fails CI if either workflow's worker-lint step is anything other
 * than `npm run lint`. Override: PR labeled `ci-config-change` (manual signoff).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..', '..');
const DEPLOY_WORKFLOW = resolve(REPO, '.github/workflows/deploy-worker.yml');
const CI_WORKFLOW = resolve(REPO, '.github/workflows/ci.yml');

interface LintStep {
  workflow: string;
  workingDir: string;
  command: string;
  marker: string;
}

function findWorkerLintSteps(): LintStep[] {
  const steps: LintStep[] = [];
  for (const wf of [DEPLOY_WORKFLOW, CI_WORKFLOW]) {
    const yaml = readFileSync(wf, 'utf8');
    const lines = yaml.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Look for lint steps inside services/worker working dir.
      if (!/working-directory:\s*services\/worker/.test(line)) continue;
      // Walk forward to find the run: line for a step containing "lint" in name
      // (within ~10 lines — handles inline + multi-line block scalars).
      let nameLine = '';
      for (let j = Math.max(0, i - 6); j < i; j++) {
        if (/^\s*-?\s*name:.*[lL]int/.test(lines[j])) {
          nameLine = lines[j];
          break;
        }
      }
      if (!nameLine) continue;
      let command = '';
      // Walk forward up to 30 lines (handles multi-line block-scalar comments).
      for (let k = i; k < Math.min(lines.length, i + 30); k++) {
        const m = /^\s*run:\s*(.+)$/.exec(lines[k]);
        if (m) {
          command = m[1].trim();
          break;
        }
      }
      if (command) {
        steps.push({
          workflow: wf.replace(REPO + '/', ''),
          workingDir: 'services/worker',
          command,
          marker: nameLine.trim(),
        });
      }
    }
  }
  return steps;
}

function main(): void {
  const steps = findWorkerLintSteps();
  if (steps.length === 0) {
    console.error('::error::No worker-lint steps found in deploy-worker.yml or ci.yml. Did you delete one?');
    process.exit(1);
  }
  const expected = 'npm run lint';
  const drift = steps.filter((s) => s.command !== expected);
  if (drift.length > 0) {
    console.error('::error::Worker lint commands have drifted from `npm run lint` (R0-4 / SCRUM-1250):');
    for (const s of drift) {
      console.error(`  ${s.workflow} → ${s.marker}`);
      console.error(`    expected: ${expected}`);
      console.error(`    actual:   ${s.command}`);
    }
    console.error('Fix: change all worker lint steps to `npm run lint` so the deploy gate ≡ CI lint job.');
    console.error('If intentional, label the PR with `ci-config-change` and update this check.');
    process.exit(1);
  }
  console.log(`✅ All ${steps.length} worker-lint steps invoke \`${expected}\` — deploy gate ≡ CI lint job.`);
  for (const s of steps) {
    console.log(`  ${s.workflow} → ${s.marker}`);
  }
}

main();
