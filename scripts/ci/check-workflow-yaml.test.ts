import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { checkWorkflowYaml, parseWorkflowYaml } from './check-workflow-yaml.js';

describe('GitHub Actions workflow YAML parser', () => {
  it('parses every tracked workflow and requires the workflow root contract', () => {
    expect(checkWorkflowYaml()).toEqual([]);
  });

  it('rejects the plain-scalar :all: form that caused zero-job Actions runs', () => {
    const invalid = `name: CI\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: python -m pip install --only-binary=:all: --upgrade pip\n`;
    const errors = parseWorkflowYaml('.github/workflows/ci.yml', invalid);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/mapping values are not allowed|bad indentation/i);
  });

  it('accepts the same command in a folded scalar without changing its text', () => {
    const valid = `name: CI\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: >-\n          python -m pip install --only-binary=:all: --upgrade pip\n`;
    expect(parseWorkflowYaml('.github/workflows/ci.yml', valid)).toEqual([]);
  });

  it('runs its CLI entrypoint from a checkout path containing spaces', () => {
    const root = join(tmpdir(), `arkova workflow parser ${process.pid}`);
    rmSync(root, { recursive: true, force: true });
    mkdirSync(join(root, 'scripts', 'ci', 'lib'), { recursive: true });
    cpSync('scripts/ci/check-workflow-yaml.ts', join(root, 'scripts', 'ci', 'check-workflow-yaml.ts'));
    cpSync('scripts/ci/lib/ciContext.ts', join(root, 'scripts', 'ci', 'lib', 'ciContext.ts'));
    symlinkSync(resolve('.github'), join(root, '.github'));
    symlinkSync(resolve('node_modules'), join(root, 'node_modules'));
    const result = spawnSync(process.execPath, ['--preserve-symlinks-main', '--import', 'tsx', join(root, 'scripts', 'ci', 'check-workflow-yaml.ts')], {
      cwd: root,
      encoding: 'utf8',
    });
    rmSync(root, { recursive: true, force: true });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('All GitHub Actions workflow YAML files parse successfully.');
  });

  it('does not spend a migration-drift run on body-only edits', () => {
    const workflow = load(readFileSync('.github/workflows/migration-drift.yml', 'utf8')) as {
      on: { pull_request: { types: string[] } };
    };
    expect(workflow.on.pull_request.types).toEqual(['opened', 'synchronize', 'reopened']);
  });

  it('rejects duplicate mapping keys and hollow workflow documents', () => {
    expect(parseWorkflowYaml('duplicate.yml', 'name: A\nname: B\non: push\njobs: {}\n')).toHaveLength(1);
    expect(parseWorkflowYaml('hollow.yml', 'name: A\non: push\n')).toEqual([
      { path: 'hollow.yml', message: 'workflow must contain name, on, and a jobs mapping' },
    ]);
  });
});
