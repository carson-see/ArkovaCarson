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

describe('check-api-contract-drift (SCRUM-1586)', () => {
  it('passes with one canonical Python SDK package and README-only deprecated paths', () => {
    const findings = run(
      [
        'packages/arkova-py/pyproject.toml',
        'packages/python-sdk/README.md',
        'sdks/python/README.md',
      ],
      {
        'packages/arkova-py/pyproject.toml': canonicalPyproject,
      },
    );

    expect(findings).toEqual([]);
  });

  it('flags duplicate Python packages named arkova', () => {
    const findings = run(
      [
        'packages/arkova-py/pyproject.toml',
        'packages/other-python-sdk/pyproject.toml',
      ],
      {
        'packages/arkova-py/pyproject.toml': canonicalPyproject,
        'packages/other-python-sdk/pyproject.toml': canonicalPyproject,
      },
    );

    expect(findings).toContainEqual({
      path: 'packages/other-python-sdk/pyproject.toml',
      reason: 'duplicate Python package named "arkova"; canonical package is packages/arkova-py/pyproject.toml',
    });
  });

  it('flags resurrected stale Python SDK source bodies', () => {
    const findings = run(
      [
        'packages/arkova-py/pyproject.toml',
        'packages/python-sdk/src/arkova/client.py',
        'sdks/python/arkova/client.py',
      ],
      {
        'packages/arkova-py/pyproject.toml': canonicalPyproject,
      },
    );

    expect(findings.map((f) => f.path)).toEqual([
      'packages/python-sdk/src/arkova/client.py',
      'sdks/python/arkova/client.py',
    ]);
  });

  it('flags known generated launch planning artifacts', () => {
    const findings = run(
      [
        'packages/arkova-py/pyproject.toml',
        'docs/prds/Arkova_PRD_Story_Traceability_Audit.docx',
        'scripts/generate_launch_audit_docx.py',
      ],
      {
        'packages/arkova-py/pyproject.toml': canonicalPyproject,
      },
    );

    expect(findings.map((f) => f.path)).toEqual([
      'docs/prds/Arkova_PRD_Story_Traceability_Audit.docx',
      'scripts/generate_launch_audit_docx.py',
    ]);
  });

  it('flags tracked generated output and cache directories', () => {
    const findings = run(
      [
        'packages/arkova-py/pyproject.toml',
        'services/worker/dist/index.js',
        'coverage/lcov.info',
        'packages/arkova-py/.pytest_cache/v/cache/nodeids',
      ],
      {
        'packages/arkova-py/pyproject.toml': canonicalPyproject,
      },
    );

    expect(findings.map((f) => f.path)).toEqual([
      'coverage/lcov.info',
      'packages/arkova-py/.pytest_cache/v/cache/nodeids',
      'services/worker/dist/index.js',
    ]);
  });
});
