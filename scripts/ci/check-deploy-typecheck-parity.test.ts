import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  auditDeployTypecheckParity,
  EXPECTED_TYPECHECK_RUN,
  REQUIRED_CI_JOB,
  type TypecheckParitySources,
} from './check-deploy-typecheck-parity.js';

const REPO = resolve(import.meta.dirname, '..', '..');

/** A deploy-worker.yml fragment whose worker Typecheck step runs `runCmd`. */
function deployWorkflow(runCmd: string | null): string {
  const step = runCmd
    ? ['      - name: Typecheck', '        working-directory: services/worker', `        run: ${runCmd}`]
    : [];
  return [
    'name: Deploy Worker',
    'on:',
    '  push:',
    '    branches: [main]',
    'jobs:',
    '  deploy:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: Install worker dependencies',
    '        working-directory: services/worker',
    '        run: npm ci --ignore-scripts',
    ...step,
    '      - name: Lint',
    '        working-directory: services/worker',
    '        run: npm run lint',
    '',
  ].join('\n');
}

interface CiOpts {
  /** `run:` of the worker typecheck step; null omits the step entirely. */
  run?: string | null;
  /** Which ci.yml job hosts the step. */
  job?: string;
  /** An `if:` guard on the step, if any. */
  guard?: string | null;
  /** The step's `name:`. Must keep the `typecheck` marker to be found at all. */
  name?: string;
}

/** A ci.yml fragment with a services/worker typecheck step in job `job`. */
function ciWorkflow({
  run = EXPECTED_TYPECHECK_RUN,
  job = REQUIRED_CI_JOB,
  guard = null,
  name = 'Typecheck worker (deploy-gate parity)',
}: CiOpts = {}): string {
  const step = run
    ? [
        `      - name: ${name}`,
        ...(guard ? [`        if: ${guard}`] : []),
        '        working-directory: services/worker',
        `        run: ${run}`,
      ]
    : [];
  return [
    'name: CI',
    'on:',
    '  pull_request:',
    'jobs:',
    '  tdd-enforcement:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: Enforce TDD',
    '        run: bash scripts/enforce-tdd.sh',
    `  ${job}:`,
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: Install worker dependencies',
    '        working-directory: services/worker',
    '        run: npm ci --ignore-scripts',
    ...step,
    '      - name: Lint worker (deploy-gate parity)',
    '        working-directory: services/worker',
    '        run: npm run lint',
    '',
  ].join('\n');
}

function sources(overrides: Partial<TypecheckParitySources> = {}): TypecheckParitySources {
  return {
    deployWorkflow: deployWorkflow(EXPECTED_TYPECHECK_RUN),
    ciWorkflow: ciWorkflow(),
    ...overrides,
  };
}

describe('check-deploy-typecheck-parity — worker compile gate ≡ deploy gate', () => {
  it('passes when both surfaces run the same worker typecheck', () => {
    const r = auditDeployTypecheckParity(sources());
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('fails when ci.yml has no worker typecheck step at all (the SCRUM-1811 gap)', () => {
    const r = auditDeployTypecheckParity(sources({ ciWorkflow: ciWorkflow({ run: null }) }));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes(REQUIRED_CI_JOB))).toBe(true);
  });

  it('fails when the ci.yml step compiles tsconfig.build.json (test files skipped)', () => {
    // The whole point of the gate: tsconfig.build.json excludes src/**/*.test.ts,
    // so a TS error in a worker TEST file would still black out the deploy gate.
    const r = auditDeployTypecheckParity(
      sources({ ciWorkflow: ciWorkflow({ run: 'node_modules/.bin/tsc -p tsconfig.build.json --noEmit' }) }),
    );
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('INCLUDES test files'))).toBe(true);
  });

  it('fails when the worker typecheck lives in a job other than the required one', () => {
    // worker-build-parity is NON-REQUIRED and in-job path-gated, so hosting the
    // gate there would miss a test-only edit and never block a merge.
    const r = auditDeployTypecheckParity(sources({ ciWorkflow: ciWorkflow({ job: 'worker-build-parity' }) }));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes(REQUIRED_CI_JOB))).toBe(true);
  });

  it('fails when the ci.yml step is guarded by an `if:` (must be unconditional)', () => {
    const r = auditDeployTypecheckParity(
      sources({ ciWorkflow: ciWorkflow({ guard: "steps.changed.outputs.worker == 'true'" }) }),
    );
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('unconditionally'))).toBe(true);
  });

  it('fails when deploy-worker.yml loses its worker typecheck step', () => {
    const r = auditDeployTypecheckParity(sources({ deployWorkflow: deployWorkflow(null) }));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('deploy-worker.yml'))).toBe(true);
  });

  it('fails when the deploy gate typecheck drifts to a different command', () => {
    const r = auditDeployTypecheckParity(sources({ deployWorkflow: deployWorkflow('npx tsc --noEmit') }));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('deploy-worker.yml'))).toBe(true);
  });

  // The step's NAME is load-bearing: two sibling gates scan the same
  // `working-directory: services/worker` lines and key off the step name.
  // `check-deploy-lint-parity.ts` matches `name:.*[lL]int` and then demands
  // `npm run lint`; `check-deploy-build-parity.ts` matches
  // `name:.*deploy-parity` (case-insensitive) and then demands `npm run build`.
  // A rename of this step into either marker — e.g. the very natural
  // "Typecheck worker (deploy-parity)", matching the sibling JOB's own name —
  // makes a sibling gate capture `tsc --noEmit` and go red for a reason that
  // points at the wrong file. Pin it here so the rename is rejected with a
  // message that names the actual constraint.
  it('fails when the ci.yml step name carries the `lint` marker (collides with check-deploy-lint-parity)', () => {
    const r = auditDeployTypecheckParity(
      sources({ ciWorkflow: ciWorkflow({ name: 'Typecheck + Lint worker (deploy-gate parity)' }) }),
    );
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('check-deploy-lint-parity'))).toBe(true);
  });

  it('fails when the ci.yml step name carries the `deploy-parity` marker (collides with check-deploy-build-parity)', () => {
    const r = auditDeployTypecheckParity(
      sources({ ciWorkflow: ciWorkflow({ name: 'Typecheck worker (deploy-parity)' }) }),
    );
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('check-deploy-build-parity'))).toBe(true);
  });

  it('flags a deploy-worker.yml typecheck step renamed into the `lint` marker too', () => {
    // check-deploy-lint-parity.ts scans deploy-worker.yml as well as ci.yml.
    const deploy = deployWorkflow(EXPECTED_TYPECHECK_RUN).replace(
      '- name: Typecheck',
      '- name: Typecheck (lint-adjacent)',
    );
    const r = auditDeployTypecheckParity(sources({ deployWorkflow: deploy }));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('check-deploy-lint-parity'))).toBe(true);
  });

  it('is a pure file-reading invariant — no ciContext / git / process.env dependency', () => {
    // Same regression guard as check-deploy-build-parity: this gate runs in the
    // shallow-checkout typecheck-lint job, so it must not resolve a base ref.
    const raw = readFileSync(resolve(REPO, 'scripts/ci/check-deploy-typecheck-parity.ts'), 'utf8');
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/\/\/[^\n'"`]*$/gm, '');
    expect(code).not.toMatch(/from\s+['"]\.\/lib\/ciContext/);
    expect(code).not.toMatch(/process\.env/);
    expect(code).not.toMatch(/rev-parse/);
    expect(code).not.toMatch(/execFileSync|execSync|child_process/);
  });
});

describe('check-deploy-typecheck-parity — against the REAL repo files', () => {
  it('the live deploy-worker.yml and ci.yml are in typecheck parity', () => {
    const real: TypecheckParitySources = {
      deployWorkflow: readFileSync(resolve(REPO, '.github/workflows/deploy-worker.yml'), 'utf8'),
      ciWorkflow: readFileSync(resolve(REPO, '.github/workflows/ci.yml'), 'utf8'),
    };
    const r = auditDeployTypecheckParity(real);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });
});
