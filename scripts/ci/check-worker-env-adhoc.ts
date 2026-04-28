#!/usr/bin/env -S npx tsx
/**
 * SCRUM-1258 (R1-4) — block NEW ad-hoc `process.env.X` reads in the worker.
 *
 * Why: a typo in a Cloud Run binding silently disables the feature instead of
 * failing loud at boot. SCRUM-538 was the bitcoin-rpc-url:placeholder version
 * of this. The 56 ad-hoc reads we have today should migrate into
 * `services/worker/src/config.ts` (Zod-validated) over time. This script's
 * job is to hold the line: no NEW ad-hoc reads land in PRs.
 *
 * Strategy: snapshot of currently-allowed (file, identifier) pairs in
 *   `scripts/ci/snapshots/worker-env-adhoc-baseline.json`.
 * Each PR re-runs the scan and fails if a (file, identifier) pair appears
 * that isn't in the baseline. Adding entries requires an explicit baseline
 * update + the override label `worker-env-adhoc-baseline-update`.
 */

import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { type EnvReference, refKey, scanWorkerEnv } from './lib/workerEnvScan.js';

const OVERRIDE_LABEL = 'worker-env-adhoc-baseline-update';
const REPO = process.env.WORKER_ENV_ADHOC_REPO_ROOT ?? resolve(import.meta.dirname, '..', '..');
const BASELINE_PATH = join(REPO, 'scripts', 'ci', 'snapshots', 'worker-env-adhoc-baseline.json');

const prLabels = (process.env.PR_LABELS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

interface Baseline {
  /** Identifiers we allow to be read ad-hoc anywhere in the worker. */
  identifiers: string[];
  /** Known-OK dynamic `process.env[someVar]` snippets (file::snippet). */
  dynamic: string[];
}

function loadBaseline(): { ids: Set<string>; dyn: Set<string> } {
  const raw = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline | EnvReference[];
  if (Array.isArray(raw)) {
    // Legacy shape: array of EnvReference. Identifier-only key.
    return { ids: new Set(raw.map((r) => r.identifier)), dyn: new Set() };
  }
  return {
    ids: new Set(raw.identifiers),
    dyn: new Set(raw.dynamic),
  };
}

function dynKey(file: string, snippet: string): string {
  return `${file}::${snippet}`;
}

function main(): void {
  const baseline = loadBaseline();
  const { refs, dynamic } = scanWorkerEnv(REPO);

  const novel: EnvReference[] = [];
  const seen = new Set<string>();
  for (const r of refs) {
    const k = refKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    if (!baseline.ids.has(k)) novel.push(r);
  }

  const dynamicViolations = dynamic.filter((d) => !baseline.dyn.has(dynKey(d.file, d.snippet)));

  if (novel.length === 0 && dynamicViolations.length === 0) {
    console.log(
      `✅ No new ad-hoc process.env reads in services/worker/src/ ` +
        `(baseline: ${baseline.ids.size} ids + ${baseline.dyn.size} dynamic).`,
    );
    return;
  }

  if (prLabels.includes(OVERRIDE_LABEL)) {
    console.log(`⚠️  PR labeled \`${OVERRIDE_LABEL}\` — allowing the following:`);
    for (const r of novel) console.log(`  ${r.file} → process.env.${r.identifier}`);
    for (const d of dynamicViolations) console.log(`  ${d.file} → ${d.snippet} (dynamic)`);
    console.log('');
    console.log('Update scripts/ci/snapshots/worker-env-adhoc-baseline.json before next merge.');
    return;
  }

  if (novel.length > 0) {
    console.error(`::error::SCRUM-1258: ${novel.length} new ad-hoc process.env read(s) in worker:`);
    for (const r of novel) {
      console.error(`  ${r.file} → process.env.${r.identifier}`);
    }
  }
  if (dynamicViolations.length > 0) {
    console.error(`::error::SCRUM-1258: ${dynamicViolations.length} dynamic process.env[...] use(s):`);
    for (const d of dynamicViolations) {
      console.error(`  ${d.file} → ${d.snippet}`);
    }
  }
  console.error('');
  console.error('Move the variable into services/worker/src/config.ts ConfigSchema (Zod-validated)');
  console.error('and read it via the typed `config` export. Direct process.env reads outside config.ts');
  console.error('silently disable features on a Cloud Run typo (SCRUM-538 archetype).');
  console.error('');
  console.error(`If intentional, label the PR with \`${OVERRIDE_LABEL}\` and update`);
  console.error('  scripts/ci/snapshots/worker-env-adhoc-baseline.json');
  console.error('with the new entries.');
  process.exit(1);
}

main();
