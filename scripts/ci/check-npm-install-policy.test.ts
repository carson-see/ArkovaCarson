import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { collectInstallPolicyFiles, scanTextForUnsafeNpmInstalls } from './check-npm-install-policy.js';

function expectNoViolations(file: string, text: string): void {
  expect(scanTextForUnsafeNpmInstalls(file, text)).toEqual([]);
}

function expectOneViolation(file: string, text: string): void {
  const hits = scanTextForUnsafeNpmInstalls(file, text);
  expect(hits).toHaveLength(1);
  expect(hits[0]).toMatchObject({ file, line: 1 });
}

describe('check-npm-install-policy', () => {
  it('allows npm ci when lifecycle scripts are suppressed', () => {
    expectNoViolations('workflow.yml', 'run: npm ci --ignore-scripts');
  });

  it('allows npm install when lifecycle scripts are explicitly suppressed', () => {
    expectNoViolations('deploy.sh', 'npm install --silent --ignore-scripts=true');
  });

  it.each([
    ['plain npm ci', 'run: npm ci'],
    ['quoted YAML run command', 'run: "npm ci"'],
    ['hash-commented ignore-scripts flag', 'run: npm ci # --ignore-scripts'],
    ['slash-commented ignore-scripts flag', 'run: npm install // --ignore-scripts'],
  ])('flags %s', (_name, command) => {
    expectOneViolation('workflow.yml', command);
  });

  it('does not treat URL slashes as inline comments', () => {
    expectNoViolations(
      'workflow.yml',
      'run: npm ci --registry=https://registry.npmjs.org --ignore-scripts',
    );
  });

  it('flags explicit lifecycle-script opt-in without a justification marker', () => {
    expectOneViolation('Dockerfile', 'RUN npm install --ignore-scripts=false');
  });

  it('allows explicit exceptions with a nearby reason', () => {
    const hits = scanTextForUnsafeNpmInstalls(
      'workflow.yml',
      [
        '# install-scripts-ok: required for a pinned audited native build fixture',
        'run: npm ci',
      ].join('\n'),
    );
    expect(hits).toEqual([]);
  });

  it('ignores commented examples', () => {
    expectNoViolations('README.sh', '# run npm install before hacking');
  });

  it('ignores workflow names and warning text that merely mention npm install commands', () => {
    const hits = scanTextForUnsafeNpmInstalls(
      'workflow.yml',
      [
        '- name: Enforce npm install script policy',
        'run: echo "::warning::Worker npm ci failed; retrying."',
      ].join('\n'),
    );
    expect(hits).toEqual([]);
  });

  it('does not let echo commands hide a follow-on install command', () => {
    expectOneViolation('workflow.yml', 'run: echo "installing" && npm ci');
  });

  it('scans Dockerfiles alongside workflows and shell deploy helpers', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'npm-install-policy-'));
    try {
      mkdirSync(join(tmp, '.github', 'workflows'), { recursive: true });
      mkdirSync(join(tmp, 'scripts'), { recursive: true });
      mkdirSync(join(tmp, 'services', 'worker'), { recursive: true });
      writeFileSync(join(tmp, '.github', 'workflows', 'ci.yml'), 'run: npm ci --ignore-scripts\n');
      writeFileSync(join(tmp, 'scripts', 'deploy.sh'), 'npm ci --ignore-scripts\n');
      writeFileSync(join(tmp, 'services', 'worker', 'Dockerfile'), 'RUN npm ci\n');

      expect(collectInstallPolicyFiles(tmp)).toEqual([
        '.github/workflows/ci.yml',
        'scripts/deploy.sh',
        'services/worker/Dockerfile',
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
