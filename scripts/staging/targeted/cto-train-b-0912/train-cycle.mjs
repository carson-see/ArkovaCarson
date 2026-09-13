// cto-train-b-0912 train driver: ONE cycle. Loads every ./probes/*.mjs module
// (one per PR in the train; each exports { pr, changedBehavior, run(ctx) } and
// run() returns probe() results that assert DB deltas / read-backs, never a
// bare HTTP status). Exit 0 iff the revision identity matches the soaked head
// AND every probe passes; writes one evidence JSON per cycle.
import { createClient } from '@supabase/supabase-js';
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { SUPABASE_URL, TAG_URL, SERVICE, REGION, CANDIDATE_SHA, PREFIX, probe, workerFetch, restFetch, hashApiKey } from './common.mjs';

const OUT_DIR = process.argv[2];
if (!OUT_DIR) throw new Error('usage: node train-cycle.mjs <out-dir>');
mkdirSync(OUT_DIR, { recursive: true });
const STATE_PATH = process.env.FIXTURE_STATE ?? `/Volumes/Extreme/offload/cto-soak-2026-09-12/train-b/state/fixtures.json`;
const ANON_KEY = process.env.STAGING_SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.STAGING_SUPABASE_SERVICE_ROLE_KEY;
if (!ANON_KEY || !SERVICE_KEY || !CANDIDATE_SHA) throw new Error('STAGING_SUPABASE_ANON_KEY, STAGING_SUPABASE_SERVICE_ROLE_KEY, TRAIN_CANDIDATE_SHA required');

const startedAt = new Date();
const cycleId = startedAt.toISOString().replace(/[:.]/g, '-');
const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
let state = {};
try { state = JSON.parse(readFileSync(STATE_PATH, 'utf8')); } catch { /* setup not run yet */ }

async function main() {
  const probes = [];
  // Identity: clock = revision identity, not instance uptime (CTO rule 3).
  const health = await workerFetch('/health');
  let revision = null, imageDigest = null;
  try {
    const svc = JSON.parse(execFileSync('gcloud', ['run', 'services', 'describe', SERVICE, '--region', REGION, '--project', 'arkova1', '--format', 'json'], { encoding: 'utf8' }));
    revision = svc.status?.traffic?.find((t) => t.percent === 100)?.revisionName ?? svc.status?.latestReadyRevisionName ?? null;
    imageDigest = svc.spec?.template?.spec?.containers?.[0]?.image ?? null;
  } catch (e) { /* recorded below */ }
  const identityOk = health.status === 200 && health.body?.status === 'healthy' && health.body?.git_sha === CANDIDATE_SHA;
  probes.push(probe('worker_identity_matches_candidate', true, identityOk, { detail: { status: health.status, git_sha: health.body?.git_sha, uptime: health.body?.uptime, revision, imageDigest, checks: health.body?.checks } }));

  const ctx = { admin, state, ANON_KEY, SERVICE_KEY, workerFetch, restFetch, probe, hashApiKey, SUPABASE_URL, TAG_URL, PREFIX, cycleId, env: process.env };
  // TRAIN_PROBES="2837,2834" limits a window to the PRs in that train (default: every module).
  const only = (process.env.TRAIN_PROBES ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const modules = readdirSync(new URL('./probes/', import.meta.url))
    .filter((f) => f.endsWith('.mjs') && (only.length === 0 || only.some((n) => f.startsWith(`${n}-`))))
    .sort();
  const perPr = {};
  for (const f of modules) {
    const mod = await import(new URL(`./probes/${f}`, import.meta.url));
    const t0 = Date.now();
    let results = [];
    try { results = await mod.run(ctx); }
    catch (e) { results = [probe(`${mod.pr}_module_threw`, 'ok', 'threw', { pass: false, detail: String(e && e.stack || e) })]; }
    for (const r of results) r.pr = mod.pr;
    perPr[mod.pr] = { changed_behavior: mod.changedBehavior, probes: results.length, passed: results.filter((r) => r.pass).length, ms: Date.now() - t0 };
    probes.push(...results);
  }
  const cyclePass = identityOk && probes.every((p) => p.pass);
  const evidence = {
    rig: 'cto-train-b-0912', candidate_sha: CANDIDATE_SHA, tag_url: TAG_URL, revision, image: imageDigest,
    train: only.length ? only : 'all', cycle_id: cycleId, started_at: startedAt.toISOString(), finished_at: new Date().toISOString(),
    per_pr: perPr, probes, cycle_pass: cyclePass,
  };
  writeFileSync(`${OUT_DIR}/cycle-${cycleId}.json`, JSON.stringify(evidence, null, 2));
  console.log(`[cycle ${cycleId}] pass=${cyclePass} probes=${probes.length} failed=${probes.filter((p) => !p.pass).map((p) => p.name).join(',') || 'none'}`);
  process.exit(cyclePass ? 0 : 1);
}
main().catch((err) => {
  writeFileSync(`${OUT_DIR}/cycle-${cycleId}.json`, JSON.stringify({ rig: 'cto-train-b-0912', cycle_id: cycleId, cycle_pass: false, error: String(err && err.stack || err) }, null, 2));
  process.exit(1);
});
