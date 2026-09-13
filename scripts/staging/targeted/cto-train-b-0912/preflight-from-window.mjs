#!/usr/bin/env node
// Build an anti-hollow-soak preflight (AntiHollowSoakInput) from a REAL soak
// window — CTO decision 2026-09-12 (Confluence 146440221, SCRUM-5054): every
// T2/T3 soak commits its preflight JSON under docs/staging/soak-preflight/ so
// the fail-closed `anti-hollow-soak` CI job evaluates something instead of
// being green by vacuum over an empty directory.
//
// Every number here is derived from artifacts written by train-cycle.mjs and
// from the RC manifest. Nothing is hand-typed, and the two anchoring-specific
// checks are marked N/A with a written reason rather than fabricated — the
// guard itself refuses that N/A unless the change set proves it irrelevant
// (see scripts/ci/anti-hollow-soak/guards.ts, notApplicableAccepted).
//
// Usage:
//   node preflight-from-window.mjs \
//     --window   <dir with cycle-*.json> \
//     --manifest <docs/staging/rc-manifests/rc-*.json> \
//     --deploy-log <json array of staging_deploy_log rows>   (optional) \
//     --base     main \
//     --out      docs/staging/soak-preflight/<name>.json
//
// Verify the result with:
//   npx tsx scripts/ci/anti-hollow-soak/guards.ts --input <out>

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

function die(msg) {
  console.error(`preflight-from-window: ${msg}`);
  process.exit(2);
}

function arg(name, { required = true, fallback = undefined } = {}) {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) {
    return process.argv[i + 1];
  }
  if (required) die(`missing --${name}`);
  return fallback;
}

function readJson(path, what) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    die(`could not read/parse ${what} "${path}": ${e.message}`);
  }
}

// --- inputs ----------------------------------------------------------------

const windowDir = resolve(arg('window'));
const manifestPath = resolve(arg('manifest'));
const deployLogPath = arg('deploy-log', { required: false });
const baseRefName = arg('base', { required: false, fallback: 'main' });
const outPath = resolve(arg('out'));

const manifest = readJson(manifestPath, 'manifest');
const service = manifest?.environment?.cloud_run_service;
const trainLaunchSha = manifest?.train_launch_sha;
if (!service) die(`manifest has no environment.cloud_run_service`);
if (!trainLaunchSha) die(`manifest has no train_launch_sha`);

const includedPrs = Array.isArray(manifest.included_prs) ? manifest.included_prs : [];
if (includedPrs.length === 0) die(`manifest has no included_prs`);

// --- PR -> probe module id -------------------------------------------------
// The drain-path identifier for a PR is its probe module, the same unit
// train-cycle.mjs loads and attributes results to. "2841-api-keys.mjs" for PR
// #2841 becomes the path "pr-2841-api-keys".

const probeDir = resolve(HERE, 'probes');
if (!existsSync(probeDir)) die(`no probes/ directory next to this script (${probeDir})`);

const moduleIdByPrNumber = new Map();
for (const f of readdirSync(probeDir).filter((f) => f.endsWith('.mjs')).sort()) {
  const id = basename(f, '.mjs'); // e.g. "2841-api-keys"
  const num = id.split('-')[0];
  if (/^\d+$/.test(num)) moduleIdByPrNumber.set(num, `pr-${id}`);
}

const pathByPrKey = new Map(); // "#2841" -> "pr-2841-api-keys"
for (const pr of includedPrs) {
  const num = String(pr.number);
  const path = moduleIdByPrNumber.get(num);
  if (!path) die(`PR #${num} is in the manifest but has no probes/${num}-*.mjs module — the soak cannot have exercised it`);
  pathByPrKey.set(`#${num}`, path);
}

// --- window: one drain entry per cycle per PR ------------------------------

const cycleFiles = readdirSync(windowDir)
  .filter((f) => f.startsWith('cycle-') && f.endsWith('.json'))
  .sort();
if (cycleFiles.length === 0) die(`no cycle-*.json files in ${windowDir}`);

const drainLog = [];
const perPrTotals = {};
let cyclesWithPerPr = 0;
let cyclesPassed = 0;
const erroredCycles = [];

for (const f of cycleFiles) {
  const cycle = readJson(resolve(windowDir, f), `cycle file`);
  if (!cycle.per_pr || typeof cycle.per_pr !== 'object') {
    erroredCycles.push(f);
    continue;
  }
  cyclesWithPerPr += 1;
  if (cycle.cycle_pass === true) cyclesPassed += 1;

  for (const [prKey, path] of pathByPrKey) {
    const entry = cycle.per_pr[prKey];
    if (!entry) continue; // PR not in this cycle's TRAIN_PROBES set
    const passed = Number(entry.passed ?? 0);
    const probes = Number(entry.probes ?? 0);
    drainLog.push({
      processed: passed,
      skipped: false,
      path,
      reason: `cycle ${cycle.cycle_id}: ${passed}/${probes} probes passed`,
    });
    const t = (perPrTotals[prKey] ??= { path, cycles: 0, probes: 0, passed: 0 });
    t.cycles += 1;
    t.probes += probes;
    t.passed += passed;
  }
}

if (drainLog.length === 0) die(`no per-PR probe results found across ${cycleFiles.length} cycle file(s)`);

// changedPaths = the probe module ids the window actually exercised. These are
// the SAME identifiers carried on each drain entry, which is what lets the G-4
// attribution check tie the work to the PRs under test.
const changedPaths = [...new Set(drainLog.map((d) => d.path))].sort();

// --- deploy provenance -----------------------------------------------------

let deployLogRows;
let deployLogSource;
if (deployLogPath && existsSync(resolve(deployLogPath))) {
  const rows = readJson(resolve(deployLogPath), 'deploy log');
  if (!Array.isArray(rows)) die(`deploy log "${deployLogPath}" is not a JSON array of staging_deploy_log rows`);
  deployLogRows = rows.map((r) => ({
    head_sha: r.build_sha,
    service: r.service ?? service,
    at: r.deployed_at,
    revision_name: r.revision_name,
  }));
  deployLogSource = `exported staging_deploy_log rows: ${resolve(deployLogPath)}`;
} else {
  // STUB: no exported deploy-log rows available to this generator. Built from
  // the manifest's own environment block, which is the same revision the
  // window's worker_identity_matches_candidate probe asserted each cycle.
  deployLogRows = [
    {
      head_sha: trainLaunchSha,
      service,
      at: manifest?.soak?.start ?? null,
      revision_name: manifest?.environment?.revision ?? null,
    },
  ];
  deployLogSource =
    `STUB (no deploy-log file at "${deployLogPath ?? '<not supplied>'}"): one row synthesized from ` +
    `manifest train_launch_sha + environment.revision (${manifest?.environment?.revision ?? 'unknown'}), ` +
    `at = manifest soak.start. Replace with exported staging_deploy_log rows ` +
    `(deploy_log_id ${manifest?.environment?.deploy_log_id ?? 'unknown'}) when available.`;
}

// --- assemble --------------------------------------------------------------

const preflight = {
  // The two anchoring-specific checks have NO honest value on this rig, so
  // they are declared null and claimed N/A rather than fabricated. The guard
  // refuses the claim unless changedPaths proves the checks irrelevant.
  schedulerJob: null,
  treasury: null,
  notApplicable: {
    schedulerJob:
      'Train changes no anchoring/scheduler path; no forced-flush job exists on this rig (mock profile)',
    treasury: 'USE_MOCKS=true rig; no chain path in the train',
  },
  changedPaths,
  drainLog,
  deployProvenance: {
    deployLogRows,
    prHeadSha: trainLaunchSha,
    service,
  },
  base: { baseRefName },
  _meta: {
    decision: 'CTO 2026-09-12 — Confluence 146440221 / SCRUM-5054',
    generator: 'scripts/staging/targeted/cto-train-b-0912/preflight-from-window.mjs',
    generated_at: new Date().toISOString(),
    rc_id: manifest.rc_id ?? null,
    manifest: manifestPath,
    window: windowDir,
    cycle_files: cycleFiles.length,
    cycles_with_per_pr: cyclesWithPerPr,
    cycles_passed: cyclesPassed,
    errored_cycles: erroredCycles,
    per_pr_totals: perPrTotals,
    deploy_log_source: deployLogSource,
    supabase_project_ref: manifest?.environment?.supabase_project_ref ?? null,
    preflight_result: manifest?.environment?.preflight_result ?? null,
  },
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(preflight, null, 2)}\n`);

console.log(
  `preflight-from-window: wrote ${outPath}\n` +
    `  cycles: ${cyclesWithPerPr}/${cycleFiles.length} with per-PR results (${cyclesPassed} cycle_pass=true)\n` +
    `  drain entries: ${drainLog.length} across changed paths [${changedPaths.join(', ')}]\n` +
    `  deploy provenance: ${deployLogRows.length} row(s), head ${trainLaunchSha} on ${service}\n` +
    `  deploy log source: ${deployLogSource}`,
);
