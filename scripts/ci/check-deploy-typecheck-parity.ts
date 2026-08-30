#!/usr/bin/env -S npx tsx
/**
 * SCRUM-1811 — drift check: the worker TYPECHECK gate must run at PR time on a
 * REQUIRED check, with the exact command the deploy gate runs.
 *
 * Third sibling of `check-deploy-lint-parity.ts` (R0-4 / SCRUM-1250, the *lint*
 * path) and `check-deploy-build-parity.ts` (CONDITIONAL-GO sub-decision B, the
 * *build* path). Those two left one hole open, and it is the expensive one:
 *
 *   - The root tsconfigs `exclude` `services/`, so root `npm run typecheck`
 *     never sees worker source at all.
 *   - `deploy-worker.yml` DOES run `node_modules/.bin/tsc --noEmit` in
 *     `services/worker` — against the PLAIN `tsconfig.json`, which INCLUDES
 *     `src/**\/*.test.ts`.
 *   - `worker-build-parity` runs `npm run build` == `tsc -p tsconfig.build.json`,
 *     and that config excludes `src/**\/*.test.ts` / `*.spec.ts`. It is also
 *     NON-REQUIRED and in-job path-gated.
 *
 * So a TypeScript error in any worker TEST file passed every PR check and only
 * failed post-merge in the deploy gate — blacking out ALL prod worker deploys
 * while `main` kept merging (`memory/project_deploy_typecheck_blackout.md`;
 * SCRUM-1810 was exactly this, SCRUM-3130 recorded main running ~20 merged PRs
 * ahead of production).
 *
 * This gate asserts, fail-closed:
 *   1. `deploy-worker.yml` has a `services/worker` step named `*Typecheck*`
 *      whose `run:` is exactly `node_modules/.bin/tsc --noEmit`.
 *   2. `ci.yml` has the same step INSIDE the `typecheck-lint` job — the job that
 *      is already `check-success = TypeCheck & Lint` in `.mergify.yml`. Hosting
 *      it anywhere else (e.g. `worker-build-parity`) would not block a merge.
 *   3. That ci.yml step carries NO `if:` guard, so a test-only edit cannot slip
 *      past a path filter.
 *
 * Deliberately NOT done here: flipping `Worker Build (deploy-parity)` into
 * branch protection / `.mergify.yml merge_conditions`. Adding a NEW required
 * check is a Carson/admin branch-protection change, and
 * `.github/workflows/agents.md` explicitly reserves that flip. Adding a STEP to
 * an ALREADY-required job closes the same gap without touching that surface —
 * the same reasoning the edge-worker test steps used.
 *
 * HARD INVARIANT, mirroring its two siblings: no in-script override, no label /
 * env / git dependency — it imports only `readFileSync`/`resolve` and reads two
 * tracked files, so it runs cleanly in the shallow-checkout `typecheck-lint`
 * job. Signoff for a deliberate change lives at the workflow level
 * (`ci-config-change`), not here.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The exact worker typecheck invocation. The locally-installed compiler (not
 * `npx`) so no package is fetched on-demand at deploy time (SonarCloud
 * githubactions:S6505 / S8543), and NO `-p tsconfig.build.json` so the PLAIN
 * tsconfig.json applies and test files are compiled.
 */
export const EXPECTED_TYPECHECK_RUN = 'node_modules/.bin/tsc --noEmit';

/** The ci.yml job that is already a required check (`TypeCheck & Lint`). */
export const REQUIRED_CI_JOB = 'typecheck-lint';

const REPO = resolve(import.meta.dirname, '..', '..');

export interface TypecheckParitySources {
  /** Raw contents of .github/workflows/deploy-worker.yml */
  deployWorkflow: string;
  /** Raw contents of .github/workflows/ci.yml */
  ciWorkflow: string;
}

export interface ParityResult {
  ok: boolean;
  errors: string[];
}

interface WorkerTypecheckStep {
  /** Trimmed `- name: ...` line, for error messages. */
  nameLine: string;
  /** The step's `run:` command, trimmed. */
  command: string;
  /** Whether the step carries an `if:` guard anywhere in its key block. */
  hasIf: boolean;
}

/**
 * Whether the step anchored at `nameIdx` carries a step-level `if:` guard —
 * ANYWHERE in its key block. GitHub Actions step keys are an unordered YAML
 * mapping, so `if:` placed after `run:` (or opening the item as `- if:`,
 * ahead of the `name:`) guards the step exactly as well as one between the
 * name and the run. The original scan stopped at the `run:` line and missed
 * both orderings — a path-filter guard could ride back in by key order alone
 * (post-merge audit finding on PR #2427).
 *
 * A YAML mapping's keys all sit at the column of its first key, so the
 * `name:` line fixes the step's key column. The scan runs from the item's
 * `- ` line to the first dedent past that column (the next step, the next
 * job, or the end of the block), and matches `if:` only at the key column —
 * an `if:`-shaped line inside a nested block or a `run: |` script sits
 * deeper and does not false-positive.
 */
function stepHasIfGuard(lines: string[], nameIdx: number): boolean {
  const keyCol = lines[nameIdx].indexOf('name:');

  // The item's `- ` line: the name line itself, or the nearest one above it
  // when another key (e.g. `- if:`) opens the item.
  let start = nameIdx;
  while (start > 0 && !/^\s*-\s/.test(lines[start])) start--;

  for (let k = start; k < lines.length; k++) {
    const line = lines[k];
    if (line.trim() === '') continue;
    // YAML ignores comments at ANY indentation — a dedented comment between
    // step keys does not end the step, so it must not end the scan either.
    if (line.trimStart().startsWith('#')) continue;
    if (k === start) {
      if (/^\s*-\s+if:\s*\S/.test(line)) return true;
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (indent < keyCol) break; // dedent: next step / next job / end of block
    if (indent === keyCol && /^if:\s*\S/.test(line.trimStart())) return true;
  }
  return false;
}

/**
 * Find every step whose `working-directory:` is `services/worker` AND whose own
 * name carries the `typecheck` marker, then capture its `run:` command.
 *
 * Unlike the backward scan in check-deploy-lint-parity.ts, this walks BACKWARD
 * from the working-directory line to the NEAREST preceding `name:` and then
 * tests that name. Taking the nearest name (rather than the first name in the
 * window that happens to match) is what stops a neighbouring step's name from
 * being mis-attributed to this step — the exact failure mode that would let a
 * `Lint worker` name capture a `tsc` command.
 */
function findWorkerTypecheckSteps(yaml: string): WorkerTypecheckStep[] {
  const steps: WorkerTypecheckStep[] = [];
  const lines = yaml.split('\n');

  for (let i = 0; i < lines.length; i++) {
    if (!/working-directory:\s*services\/worker\b/.test(lines[i])) continue;

    // Nearest preceding `name:` within the step (6 lines is ample — `name:`,
    // an optional `if:`, and the working-directory line itself).
    let nameIdx = -1;
    for (let j = i - 1; j >= Math.max(0, i - 6); j--) {
      if (/^\s*-?\s*name:/.test(lines[j])) {
        nameIdx = j;
        break;
      }
    }
    if (nameIdx === -1) continue;
    if (!/name:.*typecheck/i.test(lines[nameIdx])) continue;

    // Forward to the `run:` (up to 30 lines — handles long block comments).
    let runIdx = -1;
    let command = '';
    for (let k = i; k < Math.min(lines.length, i + 30); k++) {
      const m = /^\s*run:\s*(.+)$/.exec(lines[k]);
      if (m) {
        runIdx = k;
        command = m[1].trim();
        break;
      }
    }
    if (runIdx === -1) continue;

    steps.push({ nameLine: lines[nameIdx].trim(), command, hasIf: stepHasIfGuard(lines, nameIdx) });
  }

  return steps;
}

/**
 * Slice out a single top-level job block from a workflow: from `  <jobId>:` to
 * the next 2-space-indented job key.
 */
function jobBlock(yaml: string, jobId: string): string | null {
  const lines = yaml.split('\n');
  const header = new RegExp(`^  ${jobId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*$`);
  const start = lines.findIndex((l) => header.test(l));
  if (start === -1) return null;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

/**
 * The two sibling gates scan the SAME `working-directory: services/worker`
 * lines this one does, and decide what a step is purely from its `name:`:
 *
 *   - `check-deploy-lint-parity.ts` matches `name:.*[lL]int` (both workflows)
 *     and then demands the captured `run:` be `npm run lint`.
 *   - `check-deploy-build-parity.ts` matches `name:.*deploy-parity`
 *     (case-insensitive, ci.yml only) and then demands `npm run build`.
 *
 * So renaming the worker typecheck step into either marker makes a SIBLING gate
 * capture `tsc --noEmit` and fail — pointing at the wrong file, for the wrong
 * reason. "Typecheck worker (deploy-parity)" is the obvious trap: it mirrors the
 * sibling JOB's own name, `Worker Build (deploy-parity)`. Reject it here, where
 * the message can name the real constraint, instead of leaving the naming rule
 * as prose in agents.md that nothing enforces.
 */
function siblingMarkerCollisions(step: WorkerTypecheckStep, workflow: string): string[] {
  const errors: string[] = [];
  if (/lint/i.test(step.nameLine)) {
    errors.push(
      `${workflow} ${step.nameLine} carries the \`lint\` marker in its name — check-deploy-lint-parity.ts would capture this step and demand \`npm run lint\`. Rename it so the name contains no "lint".`,
    );
  }
  if (workflow === 'ci.yml' && /deploy-parity/i.test(step.nameLine)) {
    errors.push(
      `${workflow} ${step.nameLine} carries the \`deploy-parity\` marker in its name — check-deploy-build-parity.ts would capture this step and demand \`npm run build\`. Use a distinct name (e.g. "deploy-gate parity").`,
    );
  }
  return errors;
}

export function auditDeployTypecheckParity(sources: TypecheckParitySources): ParityResult {
  const errors: string[] = [];

  // (1) The deploy gate's worker typecheck.
  const deploySteps = findWorkerTypecheckSteps(sources.deployWorkflow);
  if (deploySteps.length === 0) {
    errors.push(
      'deploy-worker.yml has no services/worker step named "*Typecheck*" — the pre-deploy worker compile gate is missing.',
    );
  }
  for (const s of deploySteps) {
    errors.push(...siblingMarkerCollisions(s, 'deploy-worker.yml'));
    if (s.command !== EXPECTED_TYPECHECK_RUN) {
      errors.push(
        `deploy-worker.yml ${s.nameLine} runs \`${s.command}\` — must be exactly \`${EXPECTED_TYPECHECK_RUN}\` so the PR-time gate compiles what the deploy gate compiles.`,
      );
    }
  }

  // (2) + (3) The PR-time worker typecheck, inside the already-required job.
  const block = jobBlock(sources.ciWorkflow, REQUIRED_CI_JOB);
  if (block === null) {
    errors.push(
      `ci.yml has no \`${REQUIRED_CI_JOB}:\` job — that job is the required \`TypeCheck & Lint\` check and must host the PR-time worker typecheck.`,
    );
  } else {
    const ciSteps = findWorkerTypecheckSteps(block);
    if (ciSteps.length === 0) {
      errors.push(
        `ci.yml job \`${REQUIRED_CI_JOB}\` has no services/worker step named "*Typecheck*" — worker type errors (including in test files) would pass PR CI and only fail post-merge in deploy-worker.yml, blacking out every prod worker deploy.`,
      );
    }
    for (const s of ciSteps) {
      errors.push(...siblingMarkerCollisions(s, 'ci.yml'));
      if (s.command !== EXPECTED_TYPECHECK_RUN) {
        errors.push(
          `ci.yml ${s.nameLine} runs \`${s.command}\` — must be exactly \`${EXPECTED_TYPECHECK_RUN}\`, i.e. the plain tsconfig.json, which INCLUDES test files. \`-p tsconfig.build.json\` excludes src/**/*.test.ts and would reopen the deploy-typecheck blackout.`,
        );
      }
      if (s.hasIf) {
        errors.push(
          `ci.yml ${s.nameLine} carries an \`if:\` guard — the worker typecheck must run unconditionally, or a test-only edit slips past the path filter and reaches main uncompiled.`,
        );
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

function main(): void {
  const sources: TypecheckParitySources = {
    deployWorkflow: readFileSync(resolve(REPO, '.github/workflows/deploy-worker.yml'), 'utf8'),
    ciWorkflow: readFileSync(resolve(REPO, '.github/workflows/ci.yml'), 'utf8'),
  };

  const { ok, errors } = auditDeployTypecheckParity(sources);

  if (ok) {
    console.log(
      `✅ Worker typecheck parity holds: deploy-worker.yml ≡ ci.yml \`${REQUIRED_CI_JOB}\` both run \`${EXPECTED_TYPECHECK_RUN}\` (plain tsconfig.json — test files included).`,
    );
    return;
  }

  console.error('::error::Worker TYPECHECK-command parity drift (deploy gate ≢ PR-time gate):');
  for (const e of errors) console.error(`  - ${e}`);
  console.error(
    `Fix: keep a services/worker step named "*Typecheck*" running \`${EXPECTED_TYPECHECK_RUN}\` in BOTH deploy-worker.yml and the ci.yml \`${REQUIRED_CI_JOB}\` job, unconditionally.`,
  );
  console.error('If intentional, label the PR `ci-config-change` and update this check.');
  process.exit(1);
}

// Only run when invoked directly (not when imported by the test).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
