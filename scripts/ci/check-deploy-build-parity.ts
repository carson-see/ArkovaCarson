#!/usr/bin/env -S npx tsx
/**
 * CONDITIONAL-GO sub-decision B (TWO-SURFACE) — 3-way BUILD-command parity guard.
 *
 * Sibling of `check-deploy-lint-parity.ts` (R0-4 / SCRUM-1250). That gate proved
 * the worker *lint* command never drifts across deploy gate ≡ CI. This gate
 * closes the parallel hole on the COMPILE path: CI historically never compiled
 * the worker source with `tsc`, so a worker TS error could pass every PR check
 * and only surface in the Dockerfile build at deploy time (the
 * "merged ≠ in prod" deploy-typecheck blackout class — see
 * memory/project_deploy_typecheck_blackout.md).
 *
 * It asserts the worker build command is identical across all three surfaces:
 *   1. services/worker/package.json  `scripts.build` === `tsc -p tsconfig.build.json`
 *   2. services/worker/Dockerfile     contains a `RUN npm run build` line (the
 *      EXACT command the deployed image runs)
 *   3. .github/workflows/ci.yml       has a services/worker step whose `run:` is
 *      exactly `npm run build` (the new PR-time compile gate)
 *
 * If any of the three is missing or differs, CI fails closed — the moment the
 * Dockerfile compiles something CI does not, this gate trips. This guarantees
 * the new ci.yml "Worker Build (deploy-parity)" job runs the SAME build the
 * Dockerfile runs, so it cannot drift into a weaker compile.
 *
 * This is a HARD INVARIANT — a build-command mismatch is never acceptable, so
 * (mirroring `check-deploy-lint-parity.ts`) the script has NO in-script override
 * and NO label / env / git dependency: it imports only `readFileSync`/`resolve`
 * and reads three tracked files. The `ci-config-change` / `build-parity-ack`
 * signoff lives at the workflow level (the ci.yml step's `if:` condition), not
 * here — so this gate runs cleanly in the shallow-checkout typecheck-lint job
 * (no `git rev-parse` of a base ref) and keeps SCRUM-1258 trivially satisfied
 * (zero `process.env` reads).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const EXPECTED_BUILD_SCRIPT = 'tsc -p tsconfig.build.json';
export const EXPECTED_RUN = 'npm run build';

const REPO = resolve(import.meta.dirname, '..', '..');

export interface ParitySources {
  /** Raw contents of services/worker/package.json */
  workerPackageJson: string;
  /** Raw contents of services/worker/Dockerfile */
  dockerfile: string;
  /** Raw contents of .github/workflows/ci.yml */
  ciWorkflow: string;
}

export interface ParityResult {
  ok: boolean;
  errors: string[];
}

/**
 * Find every step in ci.yml whose `working-directory:` is `services/worker`
 * AND whose step name carries the distinctive `deploy-parity` marker, then
 * capture its `run:` command. Mirrors the forward-walk scan in
 * check-deploy-lint-parity.ts.
 *
 * The `deploy-parity` marker is required so this gate isolates the dedicated
 * worker compile gate and is NOT confused by other worker-dir build steps that
 * legitimately run a different command (e.g. the `npm run build:circuit` zk
 * artifact build in the `test` job). The new ci.yml job MUST name its step with
 * `deploy-parity` (e.g. "Worker Build (deploy-parity)").
 */
function findWorkerBuildRuns(ciYaml: string): string[] {
  const runs: string[] = [];
  const lines = ciYaml.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/working-directory:\s*services\/worker\b/.test(lines[i])) continue;
    // Walk back up to 6 lines for a step name carrying the deploy-parity marker.
    let nameLine = '';
    for (let j = Math.max(0, i - 6); j < i; j++) {
      if (/^\s*-?\s*name:.*deploy-parity/i.test(lines[j])) {
        nameLine = lines[j];
        break;
      }
    }
    if (!nameLine) continue;
    // Walk forward up to 30 lines for the run: command.
    for (let k = i; k < Math.min(lines.length, i + 30); k++) {
      const m = /^\s*run:\s*(.+)$/.exec(lines[k]);
      if (m) {
        runs.push(m[1].trim());
        break;
      }
    }
  }
  return runs;
}

export function auditDeployBuildParity(sources: ParitySources): ParityResult {
  const errors: string[] = [];

  // (1) package.json scripts.build
  let scriptsBuild = '';
  try {
    const pkg = JSON.parse(sources.workerPackageJson) as { scripts?: Record<string, string> };
    scriptsBuild = pkg.scripts?.build ?? '';
  } catch (e) {
    errors.push(`services/worker/package.json is not valid JSON: ${(e as Error).message}`);
  }
  if (scriptsBuild !== EXPECTED_BUILD_SCRIPT) {
    errors.push(
      `services/worker/package.json scripts.build must be \`${EXPECTED_BUILD_SCRIPT}\` (the exact Dockerfile compile), got \`${scriptsBuild || '<missing>'}\`.`,
    );
  }

  // (2) Dockerfile RUN npm run build
  const hasDockerBuild = sources.dockerfile
    .split('\n')
    .some((l) => /^\s*RUN\s+npm\s+run\s+build\b/.test(l));
  if (!hasDockerBuild) {
    errors.push(
      'services/worker/Dockerfile must contain a `RUN npm run build` line — the deployed image build must invoke the same npm build script CI compiles.',
    );
  }

  // (3) ci.yml services/worker build step run: == `npm run build`
  const buildRuns = findWorkerBuildRuns(sources.ciWorkflow);
  if (buildRuns.length === 0) {
    errors.push(
      'ci.yml has no services/worker step named "*Build*" with a `run:` command — the PR-time worker compile gate (Worker Build (deploy-parity)) is missing.',
    );
  } else {
    const drift = buildRuns.filter((r) => r !== EXPECTED_RUN);
    if (drift.length > 0) {
      for (const r of drift) {
        errors.push(
          `ci.yml services/worker build step runs \`${r}\` — must be exactly \`${EXPECTED_RUN}\` so the CI compile == the Dockerfile compile.`,
        );
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

function main(): void {
  const sources: ParitySources = {
    workerPackageJson: readFileSync(resolve(REPO, 'services/worker/package.json'), 'utf8'),
    dockerfile: readFileSync(resolve(REPO, 'services/worker/Dockerfile'), 'utf8'),
    ciWorkflow: readFileSync(resolve(REPO, '.github/workflows/ci.yml'), 'utf8'),
  };

  const { ok, errors } = auditDeployBuildParity(sources);

  if (ok) {
    console.log(
      `✅ 3-way worker build parity holds: package.json \`${EXPECTED_BUILD_SCRIPT}\` ≡ Dockerfile \`RUN npm run build\` ≡ ci.yml \`${EXPECTED_RUN}\`.`,
    );
    return;
  }

  console.error('::error::Worker BUILD-command parity drift (deploy gate ≢ CI compile):');
  for (const e of errors) console.error(`  - ${e}`);
  console.error(
    `Fix: keep all three identical — services/worker/package.json scripts.build=\`${EXPECTED_BUILD_SCRIPT}\`, a Dockerfile \`RUN npm run build\`, and a ci.yml services/worker build step \`run: ${EXPECTED_RUN}\`.`,
  );
  console.error('If intentional, label the PR `ci-config-change` or `build-parity-ack` and update this check.');
  process.exit(1);
}

// Only run when invoked directly (not when imported by the test).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
