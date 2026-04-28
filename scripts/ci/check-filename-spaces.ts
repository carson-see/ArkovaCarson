#!/usr/bin/env -S npx tsx
/**
 * SCRUM-1294 (R4-9) — block tracked filenames containing literal spaces.
 *
 * macOS Finder duplicates files with names like `copy 2.ts`. Those drift
 * silently against the canonical `copy.ts` and waste future agents' time.
 * Catching them at PR time prevents the drift class.
 */

import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO = process.env.FILENAME_SPACES_REPO_ROOT ?? resolve(import.meta.dirname, '..', '..');

const files = execSync('git ls-files', { cwd: REPO, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  // Match any path segment containing a space.
  .filter((p) => /\s/.test(p));

if (files.length === 0) {
  console.log('✅ No tracked filenames contain spaces.');
  process.exit(0);
}

console.error(`::error::SCRUM-1294: ${files.length} tracked file(s) contain spaces in their path:`);
for (const f of files) console.error(`  ${f}`);
console.error('');
console.error('Spaces in paths cause macOS Finder duplicate drift (e.g. `copy 2.ts` vs `copy.ts`).');
console.error('Rename without the space, or move outside the repo.');
process.exit(1);
