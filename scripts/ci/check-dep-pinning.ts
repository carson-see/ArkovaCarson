#!/usr/bin/env -S npx tsx
/**
 * SCRUM-1005 (DEP-15) — Dependency pinning enforcement.
 *
 * Scans all package.json files in the repo (root, services/worker/,
 * services/edge/ if present) and fails if any dependency or devDependency
 * version starts with `^` or `~` (caret or tilde ranges).
 *
 * Why: unpinned dependencies cause non-reproducible builds and introduce
 * supply-chain risk. Lockfiles pin *resolved* versions, but caret/tilde
 * ranges in package.json still allow `npm install` on a fresh checkout
 * to pull newer semver-compatible versions, which may introduce breaking
 * changes or vulnerabilities.
 *
 * Override: PR labeled `dep-range-intentional`.
 */

import { readFileSync, existsSync, statSync, realpathSync } from 'node:fs';
import { resolve, sep, join } from 'node:path';
import { tmpdir } from 'node:os';

const OVERRIDE_LABEL = 'dep-range-intentional';

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
  section: string;
  name: string;
  version: string;
}

/** Package.json paths to scan, relative to repo root. */
const PACKAGE_JSONS = [
  'package.json',
  'services/worker/package.json',
  'services/edge/package.json',
];

function scanPackageJson(repo: string, relPath: string): Violation[] {
  const absPath = resolve(repo, relPath);
  if (!existsSync(absPath)) return [];

  const pkg = JSON.parse(readFileSync(absPath, 'utf8'));
  const violations: Violation[] = [];

  for (const section of ['dependencies', 'devDependencies'] as const) {
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

  const allViolations: Violation[] = [];
  for (const rel of PACKAGE_JSONS) {
    allViolations.push(...scanPackageJson(repo, rel));
  }

  if (allViolations.length === 0) {
    console.log('✅ All dependency versions are pinned (no ^ or ~ ranges).');
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
  console.error('Fix: remove the ^ or ~ prefix from each version to pin it exactly.');
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
