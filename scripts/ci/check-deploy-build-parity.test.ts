import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  auditDeployBuildParity,
  EXPECTED_BUILD_SCRIPT,
  EXPECTED_RUN,
  type ParitySources,
} from './check-deploy-build-parity.js';

const REPO = resolve(import.meta.dirname, '..', '..');

/** A package.json string whose scripts.build is `value`. */
function pkg(value: string): string {
  return JSON.stringify({ name: '@arkova/worker', scripts: { build: value, start: 'node dist/index.js' } });
}

/** A Dockerfile that does or does not invoke `npm run build`. */
function dockerfile(withBuild: boolean): string {
  return [
    'FROM node:20-alpine AS builder',
    'WORKDIR /app',
    'COPY package.json package-lock.json ./',
    'RUN npm ci --ignore-scripts',
    'COPY tsconfig.json tsconfig.build.json ./',
    'COPY src ./src',
    ...(withBuild ? ['RUN npm run build'] : ['RUN echo "no build"']),
    'FROM node:20-alpine',
    'COPY --from=builder /app/dist ./dist',
  ].join('\n');
}

/** A ci.yml fragment with a services/worker build step running `runCmd`. */
function ciWorkflow(runCmd: string | null): string {
  const buildStep = runCmd
    ? [
        '      - name: Worker Build (deploy-parity)',
        '        working-directory: services/worker',
        `        run: ${runCmd}`,
      ]
    : [];
  return [
    'name: CI',
    'on:',
    '  pull_request:',
    '    branches: [main]',
    'jobs:',
    '  worker-build:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v7',
    '      - name: Install worker deps',
    '        working-directory: services/worker',
    '        run: npm ci --ignore-scripts',
    ...buildStep,
    '',
  ].join('\n');
}

function sources(overrides: Partial<ParitySources> = {}): ParitySources {
  return {
    workerPackageJson: pkg(EXPECTED_BUILD_SCRIPT),
    dockerfile: dockerfile(true),
    ciWorkflow: ciWorkflow(EXPECTED_RUN),
    ...overrides,
  };
}

describe('check-deploy-build-parity — 3-way worker build parity', () => {
  it('passes when all three surfaces agree', () => {
    const r = auditDeployBuildParity(sources());
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('fails when package.json scripts.build drifts', () => {
    const r = auditDeployBuildParity(sources({ workerPackageJson: pkg('tsc') }));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('scripts.build'))).toBe(true);
  });

  it('fails when package.json scripts.build is missing', () => {
    const r = auditDeployBuildParity(
      sources({ workerPackageJson: JSON.stringify({ name: 'w', scripts: { start: 'node x' } }) }),
    );
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('<missing>'))).toBe(true);
  });

  it('fails when package.json is not valid JSON', () => {
    const r = auditDeployBuildParity(sources({ workerPackageJson: '{ not json' }));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('not valid JSON'))).toBe(true);
  });

  it('fails when the Dockerfile has no `RUN npm run build`', () => {
    const r = auditDeployBuildParity(sources({ dockerfile: dockerfile(false) }));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('Dockerfile'))).toBe(true);
  });

  it('fails when ci.yml has no services/worker build step', () => {
    const r = auditDeployBuildParity(sources({ ciWorkflow: ciWorkflow(null) }));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('compile gate'))).toBe(true);
  });

  it('fails when the ci.yml worker build step runs a different command', () => {
    const r = auditDeployBuildParity(sources({ ciWorkflow: ciWorkflow('npx tsc -p tsconfig.build.json') }));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('must be exactly'))).toBe(true);
  });

  it('is a pure file-reading invariant — no ciContext / git / process.env dependency', () => {
    // Regression guard: importing ciContext (which resolves a base ref via git
    // at module load) made this gate crash in the shallow-checkout typecheck-lint
    // job. Mirror check-deploy-lint-parity.ts — read tracked files only.
    // Strip comments first so prose mentions of these terms in the docstring
    // don't trip the scan; we only care about real code.
    const raw = readFileSync(resolve(REPO, 'scripts/ci/check-deploy-build-parity.ts'), 'utf8');
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
      .replace(/^\s*\/\/.*$/gm, '') // line comments
      .replace(/\/\/[^\n'"`]*$/gm, ''); // trailing line comments (best-effort)
    expect(code).not.toMatch(/from\s+['"]\.\/lib\/ciContext/);
    expect(code).not.toMatch(/process\.env/);
    expect(code).not.toMatch(/rev-parse/);
    expect(code).not.toMatch(/execFileSync|execSync|child_process/);
  });
});

describe('check-deploy-build-parity — against the REAL repo files', () => {
  it('the live worker package.json / Dockerfile / ci.yml are in parity', () => {
    const real: ParitySources = {
      workerPackageJson: readFileSync(resolve(REPO, 'services/worker/package.json'), 'utf8'),
      dockerfile: readFileSync(resolve(REPO, 'services/worker/Dockerfile'), 'utf8'),
      ciWorkflow: readFileSync(resolve(REPO, '.github/workflows/ci.yml'), 'utf8'),
    };
    const r = auditDeployBuildParity(real);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });
});
