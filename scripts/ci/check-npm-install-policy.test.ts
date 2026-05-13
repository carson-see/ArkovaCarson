import { describe, expect, it } from 'vitest';

import { scanTextForUnsafeNpmInstalls } from './check-npm-install-policy.js';

describe('check-npm-install-policy', () => {
  it('allows npm ci when lifecycle scripts are suppressed', () => {
    const hits = scanTextForUnsafeNpmInstalls('workflow.yml', 'run: npm ci --ignore-scripts');
    expect(hits).toEqual([]);
  });

  it('allows npm install when lifecycle scripts are explicitly suppressed', () => {
    const hits = scanTextForUnsafeNpmInstalls('deploy.sh', 'npm install --silent --ignore-scripts=true');
    expect(hits).toEqual([]);
  });

  it('flags plain npm ci', () => {
    const hits = scanTextForUnsafeNpmInstalls('workflow.yml', 'run: npm ci');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ file: 'workflow.yml', line: 1 });
  });

  it('flags quoted YAML run commands', () => {
    const hits = scanTextForUnsafeNpmInstalls('workflow.yml', 'run: "npm ci"');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ file: 'workflow.yml', line: 1 });
  });

  it('flags explicit lifecycle-script opt-in without a justification marker', () => {
    const hits = scanTextForUnsafeNpmInstalls('Dockerfile', 'RUN npm install --ignore-scripts=false');
    expect(hits).toHaveLength(1);
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
    const hits = scanTextForUnsafeNpmInstalls('README.sh', '# run npm install before hacking');
    expect(hits).toEqual([]);
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
    const hits = scanTextForUnsafeNpmInstalls('workflow.yml', 'run: echo "installing" && npm ci');
    expect(hits).toHaveLength(1);
  });
});
