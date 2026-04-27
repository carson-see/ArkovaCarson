#!/usr/bin/env -S npx tsx
/**
 * SCRUM-1254 (R0-8) — `count: 'exact'` callsite baseline check.
 *
 * Counts non-test occurrences of `count: 'exact'` (and `count: "exact"`) in
 * services/worker/src and src. Compares against the count on origin/main.
 * Fails PR if the count INCREASED.
 *
 * Why: `count: 'exact'` against the 1.4M-row anchors table caused the
 * 60-second PostgREST timeouts that hid for weeks behind the smoke test's
 * old `count: 'exact'`-based rls-active check. R1 sweeps remaining
 * callsites; R0-8 makes sure new ones don't reappear.
 *
 * Override: PR labeled `count-exact-allowed`.
 */

import { execFileSync } from 'node:child_process';
import { REPO, baseRef as BASE_REF, hasLabel, LABELS } from './lib/ciContext.js';

const SCAN_PATHS = ['src/', 'services/worker/src/'];
// Match `count: 'exact'` or `count: "exact"` with optional whitespace.
const PATTERN = `count[[:space:]]*:[[:space:]]*['"]exact['"]`;

function countOccurrences(ref: 'HEAD' | string): number {
  let total = 0;
  for (const path of SCAN_PATHS) {
    try {
      const args = ['grep', '-E', '--count'];
      if (ref !== 'HEAD') args.push(PATTERN, ref, '--', path, ':!*test.ts', ':!*spec.ts');
      else args.push(PATTERN, '--', path, ':!*test.ts', ':!*spec.ts');
      const out = execFileSync('git', args, {
        cwd: REPO,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      total += out
        .split('\n')
        .filter(Boolean)
        .reduce((acc: number, line: string) => acc + Number.parseInt(line.split(':').pop() ?? '0', 10), 0);
    } catch {
      // No matches → exit 1 from grep; treat as zero.
    }
  }
  return total;
}

function main(): void {
  const baseline = countOccurrences(BASE_REF);
  const current = countOccurrences('HEAD');

  console.log(`count: 'exact' callsites (non-test):`);
  console.log(`  ${BASE_REF}: ${baseline}`);
  console.log(`  HEAD:        ${current}`);

  if (current <= baseline) {
    console.log('✅ No new count: \'exact\' callsites introduced.');
    return;
  }

  if (hasLabel(LABELS.countExactAllowed)) {
    console.log(`⚠️  PR labeled \`${LABELS.countExactAllowed}\` — allowing increase from ${baseline} to ${current}.`);
    return;
  }

  console.error(`::error::count: 'exact' callsite count increased ${baseline} → ${current} (R0-8 / SCRUM-1254).`);
  console.error('  count: \'exact\' triggers full table scans on PostgREST and hits 60s timeout');
  console.error('  on hot tables like anchors. Use get_anchor_status_counts_fast() or pg_class.reltuples.');
  console.error(`  To allow this change, label the PR \`${LABELS.countExactAllowed}\`.`);
  process.exit(1);
}

main();
