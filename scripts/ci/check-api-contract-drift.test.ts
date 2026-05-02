import { describe, expect, it } from 'vitest';

import { findApiContractDrift } from './check-api-contract-drift.js';

const canonicalPyproject = `
[project]
name = "arkova"
version = "0.1.0"
`;

function run(trackedFiles: string[], contents: Record<string, string> = {}) {
  return findApiContractDrift({
    trackedFiles,
    readFile: (path) => contents[path] ?? '',
  });
}

function runWithCanonical(trackedFiles: string[], contents: Record<string, string> = {}) {
  return run(trackedFiles, {
    'packages/arkova-py/pyproject.toml': canonicalPyproject,
    ...contents,
  });
}

function findingPaths(trackedFiles: string[]) {
  return runWithCanonical(trackedFiles).map((finding) => finding.path);
}

describe('check-api-contract-drift (SCRUM-1586)', () => {
  it('passes with one canonical Python SDK package and README-only deprecated paths', () => {
    const findings = runWithCanonical([
      'packages/arkova-py/pyproject.toml',
      'packages/python-sdk/README.md',
      'sdks/python/README.md',
    ]);

    expect(findings).toEqual([]);
  });

  it('flags duplicate Python packages named arkova', () => {
    const findings = runWithCanonical(
      ['packages/arkova-py/pyproject.toml', 'packages/other-python-sdk/pyproject.toml'],
      { 'packages/other-python-sdk/pyproject.toml': canonicalPyproject },
    );

    expect(findings).toContainEqual({
      path: 'packages/other-python-sdk/pyproject.toml',
      reason: 'duplicate Python package named "arkova"; canonical package is packages/arkova-py/pyproject.toml',
    });
  });

  it('flags the missing canonical Python SDK package even when another arkova package exists', () => {
    const findings = runWithCanonical(
      ['packages/other-python-sdk/pyproject.toml'],
      { 'packages/other-python-sdk/pyproject.toml': canonicalPyproject },
    );

    expect(findings).toContainEqual({
      path: 'packages/arkova-py/pyproject.toml',
      reason: 'canonical Python SDK package is missing',
    });
  });

  it('recognizes canonical Python package names with inline TOML comments', () => {
    const findings = run(
      ['packages/arkova-py/pyproject.toml'],
      {
        'packages/arkova-py/pyproject.toml': `
[project]
name = "arkova" # canonical SDK package
version = "0.1.0"
`,
      },
    );

    expect(findings).toEqual([]);
  });

  it('flags resurrected stale Python SDK source bodies', () => {
    expect(findingPaths([
      'packages/arkova-py/pyproject.toml',
      'packages/python-sdk/src/arkova/client.py',
      'sdks/python/arkova/client.py',
    ])).toEqual([
      'packages/python-sdk/src/arkova/client.py',
      'sdks/python/arkova/client.py',
    ]);
  });

  it('flags known generated launch planning artifacts', () => {
    expect(findingPaths([
      'packages/arkova-py/pyproject.toml',
      'docs/prds/Arkova_PRD_Story_Traceability_Audit.docx',
      'scripts/generate_launch_audit_docx.py',
    ])).toEqual([
      'docs/prds/Arkova_PRD_Story_Traceability_Audit.docx',
      'scripts/generate_launch_audit_docx.py',
    ]);
  });

  it('flags tracked generated output and cache directories', () => {
    expect(findingPaths([
      'packages/arkova-py/pyproject.toml',
      'services/worker/dist/index.js',
      'coverage/lcov.info',
      'packages/arkova-py/.pytest_cache/v/cache/nodeids',
    ])).toEqual([
      'coverage/lcov.info',
      'packages/arkova-py/.pytest_cache/v/cache/nodeids',
      'services/worker/dist/index.js',
    ]);
  });
});
