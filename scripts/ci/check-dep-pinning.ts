#!/usr/bin/env -S npx tsx
/**
 * SCRUM-1005 (DEP-15) — Dependency pinning enforcement.
 *
 * Scans tracked package.json files in the repo and fails if any dependency,
 * devDependency, or peerDependency version starts with `^` or `~` (caret or
 * tilde ranges).
 *
 * Why: unpinned dependencies cause non-reproducible builds and introduce
 * supply-chain risk. Lockfiles pin *resolved* versions, but caret/tilde
 * ranges in package.json still allow `npm install` on a fresh checkout
 * to pull newer semver-compatible versions, which may introduce breaking
 * changes or vulnerabilities.
 *
 * Override: PR labeled `dep-range-intentional`.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync, realpathSync, readdirSync } from 'node:fs';
import { resolve, sep, join, relative } from 'node:path';
import { tmpdir } from 'node:os';

const OVERRIDE_LABEL = 'dep-range-intentional';
const DEPENDENCY_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies'] as const;
const SKIPPED_DIRS = new Set([
  '.git',
  '.next',
  '.turbo',
  '.vercel',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'playwright-report',
]);

/**
 * Resolve the repo root, validating any user-supplied DEP_PINNING_REPO_ROOT
 * to prevent the script from reading arbitrary files on disk.
 *
 * Security: SonarCloud flagged the previous unconstrained
 * `JSON.parse(readFileSync(resolve(REPO, relPath)))` as a path-traversal
 * hotspot — a malicious env var could point at /etc/, ~/.ssh/, etc.
 *
 * Allowed locations:
 *   1. The script's own repo (the default fallback)
 *   2. Anywhere under the OS temp dir (CI fixtures, vitest tmp dirs)
 *
 * The candidate must also contain a `package.json` — anything else is
 * not a plausible repo root and is rejected.
 */
export function resolveRepoRoot(): string {
  const fallback = resolve(import.meta.dirname, '..', '..');
  const envRoot = process.env.DEP_PINNING_REPO_ROOT;
  if (!envRoot) return fallback;

  const resolved = resolve(envRoot);

  // Resolve symlinks for both candidate and allowlist roots so a
  // symlinked /tmp -> /private/tmp (macOS) doesn't fool the prefix check.
  const realResolved = existsSync(resolved) ? realpathSync(resolved) : resolved;
  const realFallback = realpathSync(fallback);
  const realTmp = realpathSync(tmpdir());

  const isInRepo = realResolved === realFallback || realResolved.startsWith(realFallback + sep);
  const isInTmp = realResolved === realTmp || realResolved.startsWith(realTmp + sep);

  if (!isInRepo && !isInTmp) {
    throw new Error(
      `DEP_PINNING_REPO_ROOT=${envRoot} resolves to ${realResolved}, which is outside both the repo root (${realFallback}) and the OS temp dir (${realTmp}) — refusing for safety.`,
    );
  }

  // Sanity: must look like a repo (contain package.json) and be a directory.
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error(`DEP_PINNING_REPO_ROOT=${envRoot} is not an existing directory — refusing.`);
  }
  if (!existsSync(join(resolved, 'package.json'))) {
    throw new Error(
      `DEP_PINNING_REPO_ROOT=${envRoot} has no package.json — not a valid repo root.`,
    );
  }

  return resolved;
}

interface Violation {
  file: string;
  section: (typeof DEPENDENCY_SECTIONS)[number];
  name: string;
  version: string;
}

function normalizeRelPath(path: string): string {
  return path.split(sep).join('/');
}

function discoverPackageJsons(repo: string): string[] {
  const discovered: string[] = [];

  function walk(absDir: string): void {
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name)) continue;
        walk(join(absDir, entry.name));
        continue;
      }

      if (!entry.isFile() || entry.name !== 'package.json') continue;
      discovered.push(normalizeRelPath(relative(repo, join(absDir, entry.name))));
    }
  }

  walk(repo);
  return discovered.sort();
}

export function listPackageJsons(repo: string): string[] {
  try {
    const output = execFileSync('git', ['-C', repo, 'ls-files', '*package.json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const tracked = output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((path) => path === 'package.json' || path.endsWith('/package.json'))
      .filter((path) => !path.split('/').some((part) => SKIPPED_DIRS.has(part)))
      .sort();

    if (tracked.length > 0) return tracked;
  } catch {
    // Temp fixtures used by tests are not git repos; fall back to filesystem discovery.
  }

  return discoverPackageJsons(repo);
}

function scanPackageJson(repo: string, relPath: string): Violation[] {
  const absPath = resolve(repo, relPath);
  if (!existsSync(absPath)) return [];

  const pkg = JSON.parse(readFileSync(absPath, 'utf8'));
  const violations: Violation[] = [];

  for (const section of DEPENDENCY_SECTIONS) {
    const deps: Record<string, string> | undefined = pkg[section];
    if (!deps) continue;
    for (const [name, version] of Object.entries(deps)) {
      if (typeof version !== 'string') continue;
      if (version.startsWith('^') || version.startsWith('~')) {
        violations.push({ file: relPath, section, name, version });
      }
    }
  }

  return violations;
}

function main(): void {
  const repo = resolveRepoRoot();
  const prLabels = (process.env.PR_LABELS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const packageJsons = listPackageJsons(repo);

  const allViolations: Violation[] = [];
  for (const rel of packageJsons) {
    allViolations.push(...scanPackageJson(repo, rel));
  }

  if (allViolations.length === 0) {
    console.log(`✅ All dependency versions are pinned (${packageJsons.length} package.json file(s), no ^ or ~ ranges).`);
    return;
  }

  // Check override label
  if (prLabels.includes(OVERRIDE_LABEL)) {
    console.log(`⚠️  PR labeled \`${OVERRIDE_LABEL}\` — allowing ${allViolations.length} unpinned dependency version(s).`);
    for (const v of allViolations) {
      console.log(`  ${v.file} → ${v.section} → ${v.name}: ${v.version}`);
    }
    return;
  }

  console.error(`::error::Found ${allViolations.length} unpinned dependency version(s) (DEP-15 / SCRUM-1005):`);
  for (const v of allViolations) {
    console.error(`  ${v.file} → ${v.section} → ${v.name}: ${v.version}`);
  }
  console.error('');
  console.error('Fix: remove the ^ or ~ prefix from dependency, devDependency, or peerDependency versions to pin them exactly.');
  console.error(`If intentional, label the PR with \`${OVERRIDE_LABEL}\`.`);
  process.exit(1);
}

// Run main() only when executed directly (not when imported by tests).
// Compare realpath of argv[1] against this module's filename so /tmp -> /private/tmp
// symlink resolution (macOS) doesn't fool us.
function isDirectRun(): boolean {
  const argv = process.argv[1];
  if (!argv) return false;
  try {
    const argvReal = realpathSync(argv);
    const selfPath = join(import.meta.dirname, 'check-dep-pinning.ts');
    const selfReal = realpathSync(selfPath);
    return argvReal === selfReal;
  } catch {
    return false;
  }
}
if (isDirectRun()) {
  main();
}
