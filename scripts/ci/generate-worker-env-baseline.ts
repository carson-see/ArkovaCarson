#!/usr/bin/env -S npx tsx
/**
 * Run once (or after a baseline-update PR) to regenerate
 * `scripts/ci/snapshots/worker-env-adhoc-baseline.json` from the current
 * tree. SCRUM-1258 (R1-4).
 *
 * Baseline shape:
 *   {
 *     "identifiers": ["FOO", "BAR", ...],     // sorted, unique
 *     "dynamic": ["file::snippet", ...]        // sorted, unique
 *   }
 *
 * The lint enforces this whole set; rename-friendly because keys are
 * identifier-only (not file+identifier).
 */

import { writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { scanWorkerEnv } from './lib/workerEnvScan.js';

const REPO = resolve(import.meta.dirname, '..', '..');
const BASELINE_PATH = join(REPO, 'scripts', 'ci', 'snapshots', 'worker-env-adhoc-baseline.json');

const { refs, dynamic } = scanWorkerEnv(REPO);
const identifiers = [...new Set(refs.map((r) => r.identifier))].sort();
const dynamicKeys = [...new Set(dynamic.map((d) => `${d.file}::${d.snippet}`))].sort();

writeFileSync(
  BASELINE_PATH,
  JSON.stringify({ identifiers, dynamic: dynamicKeys }, null, 2) + '\n',
);
console.log(`Wrote ${identifiers.length} identifiers + ${dynamicKeys.length} dynamic entries to ${BASELINE_PATH}`);
