#!/usr/bin/env -S npx tsx
/**
 * SCRUM-1586 — API contract drift guard.
 *
 * The API audit found duplicate SDK package bodies and generated planning
 * artifacts sitting in normal source paths. This check keeps those from
 * quietly returning in future PRs.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_REPO = resolve(import.meta.dirname, '..', '..');
const CANONICAL_PYTHON_SDK = 'packages/arkova-py/pyproject.toml';

const DEPRECATED_PYTHON_SDK_PATHS = [
  'packages/python-sdk/.gitignore',
  'packages/python-sdk/pyproject.toml',
  'packages/python-sdk/src/',
  'packages/python-sdk/tests/',
  'sdks/python/arkova/',
  'sdks/python/pyproject.toml',
  'sdks/python/tests/',
];

const FORBIDDEN_GENERATED_ARTIFACTS = new Set([
  'docs/prds/Arkova_Feature_Flag_Audit.docx',
  'docs/prds/Arkova_Operational_Launch_Readiness_PRD_Packet.docx',
  'docs/prds/Arkova_PRD_Story_Traceability_Audit.docx',
  'scripts/generate_launch_audit_docx.py',
  'scripts/generate_launch_prd_docx.py',
]);

const GENERATED_PATH_SEGMENTS = new Set([
  '.pytest_cache',
  '.ruff_cache',
  '__pycache__',
  'coverage',
  'dist',
  'output',
]);

export interface DriftFinding {
  path: string;
  reason: string;
}

export interface DriftInput {
  trackedFiles: string[];
  readFile: (path: string) => string;
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/');
}

function isDeprecatedPythonSdkBody(path: string): boolean {
  const normalized = normalizePath(path);
  return DEPRECATED_PYTHON_SDK_PATHS.some((forbidden) =>
    forbidden.endsWith('/')
      ? normalized.startsWith(forbidden)
      : normalized === forbidden,
  );
}

function isGeneratedPath(path: string): boolean {
  return normalizePath(path)
    .split('/')
    .some((segment) => GENERATED_PATH_SEGMENTS.has(segment));
}

function projectNameFromPyproject(content: string): string | undefined {
  const lines = content.split(/\r?\n/);
  let inProject = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\[project\]\s*$/.test(trimmed)) {
      inProject = true;
      continue;
    }
    if (inProject && /^\[.+\]\s*$/.test(trimmed)) return undefined;
    if (!inProject) continue;

    const match = /^name\s*=\s*["']([^"']+)["']\s*$/.exec(trimmed);
    if (match) return match[1];
  }

  return undefined;
}

export function findApiContractDrift(input: DriftInput): DriftFinding[] {
  const findings: DriftFinding[] = [];
  const trackedFiles = input.trackedFiles.map(normalizePath).sort();
  const arkovaPythonPackages: string[] = [];

  for (const path of trackedFiles) {
    if (isDeprecatedPythonSdkBody(path)) {
      findings.push({
        path,
        reason: 'stale duplicate Python SDK package body; only README redirects may remain',
      });
    }

    if (FORBIDDEN_GENERATED_ARTIFACTS.has(path)) {
      findings.push({
        path,
        reason: 'generated planning artifact belongs in the artifact archive, not a code PR',
      });
    }

    if (isGeneratedPath(path)) {
      findings.push({
        path,
        reason: 'tracked generated output/cache directory',
      });
    }

    if (path.endsWith('pyproject.toml')) {
      const name = projectNameFromPyproject(input.readFile(path));
      if (name === 'arkova') arkovaPythonPackages.push(path);
    }
  }

  for (const path of arkovaPythonPackages) {
    if (path !== CANONICAL_PYTHON_SDK) {
      findings.push({
        path,
        reason: `duplicate Python package named "arkova"; canonical package is ${CANONICAL_PYTHON_SDK}`,
      });
    }
  }

  if (!arkovaPythonPackages.includes(CANONICAL_PYTHON_SDK)) {
    findings.push({
      path: CANONICAL_PYTHON_SDK,
      reason: 'canonical Python SDK package is missing',
    });
  }

  return findings;
}

function gitLsFiles(repo: string): string[] {
  return execSync('git ls-files', { cwd: repo, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function main(): void {
  const repo = process.env.API_CONTRACT_DRIFT_REPO_ROOT ?? DEFAULT_REPO;
  const findings = findApiContractDrift({
    trackedFiles: gitLsFiles(repo),
    readFile: (path) => {
      const fullPath = resolve(repo, path);
      return existsSync(fullPath) ? readFileSync(fullPath, 'utf8') : '';
    },
  });

  if (findings.length === 0) {
    console.log('✅ API contract drift guard passed.');
    return;
  }

  console.error(`::error::SCRUM-1586: ${findings.length} API contract drift finding(s):`);
  for (const finding of findings) {
    console.error(`  ${finding.path}: ${finding.reason}`);
  }
  console.error('');
  console.error('Fix by keeping one canonical SDK/source path and moving generated artifacts outside the repo.');
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
