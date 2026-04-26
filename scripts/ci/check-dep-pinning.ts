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

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..', '..');
const prLabels = (process.env.PR_LABELS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const OVERRIDE_LABEL = 'dep-range-intentional';

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

function scanPackageJson(relPath: string): Violation[] {
  const absPath = resolve(REPO, relPath);
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
  const allViolations: Violation[] = [];
  for (const rel of PACKAGE_JSONS) {
    allViolations.push(...scanPackageJson(rel));
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

main();
