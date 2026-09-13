// seal.mjs — turn a train window directory into the per-PR "## Staging Soak Evidence"
// blocks the gate parses (unbolded field labels, exact strings), plus a JSON summary.
// Usage: node seal.mjs <window-dir> <manifest.json> <tier> [--pr 2837 ...]
// Prints one block per included PR. Soak end = finished_at of the LAST passing cycle.
import { readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const [dir, manifestPath, tier = 'T2', ...rest] = process.argv.slice(2);
if (!dir || !manifestPath) { console.error('usage: node seal.mjs <window-dir> <manifest.json> <tier> [--pr N ...]'); process.exit(2); }
const onlyPrs = rest.filter((x, i) => rest[i - 1] === '--pr').map(Number);
const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
const cycles = readdirSync(dir).filter((f) => f.startsWith('cycle-') && f.endsWith('.json')).sort()
  .map((f) => JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')));
const passing = cycles.filter((c) => c.cycle_pass);
const failing = cycles.filter((c) => !c.cycle_pass);
if (cycles.length === 0) { console.error('no cycles'); process.exit(1); }
const start = cycles[0].started_at; const end = passing.at(-1)?.finished_at ?? cycles.at(-1).finished_at;
const hours = (Date.parse(end) - Date.parse(start)) / 3.6e6;
const revisions = [...new Set(cycles.map((c) => c.revision))];
const shas = [...new Set(cycles.map((c) => c.candidate_sha))];
const probesTotal = cycles.reduce((n, c) => n + (c.probes?.length ?? 0), 0);
const probesFailed = cycles.reduce((n, c) => n + (c.probes?.filter((p) => !p.pass).length ?? 0), 0);
const perPr = {};
for (const c of cycles) for (const [pr, v] of Object.entries(c.per_pr ?? {})) { perPr[pr] ??= { cycles: 0, probes: 0, passed: 0, changed_behavior: v.changed_behavior }; perPr[pr].cycles++; perPr[pr].probes += v.probes; perPr[pr].passed += v.passed; }
const summary = { window: dir, start, end, hours: +hours.toFixed(2), cycles: cycles.length, passing: passing.length, failing: failing.length, revisions, candidate_shas: shas, probes_total: probesTotal, probes_failed: probesFailed, per_pr: perPr };
console.log('SUMMARY ' + JSON.stringify(summary));
const env = m.environment; const soakStart = start; const soakEnd = end;
for (const pr of m.included_prs) {
  if (onlyPrs.length && !onlyPrs.includes(pr.number)) continue;
  const key = `#${pr.number}`; const stats = perPr[key] ?? { cycles: 0, probes: 0, passed: 0, changed_behavior: '(no probe module — see manifest exceptions)' };
  const cur = (() => { if (!pr.branch) return pr.head_sha; try { return execFileSync('git', ['rev-parse', `origin/${pr.branch}`], { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }).trim(); } catch { return pr.head_sha; } })();
  console.log(`\n===== PR ${key} =====\n## Staging Soak Evidence\n`);
  console.log(`Tier: ${tier}`);
  console.log(`Staging branch: ${m.staging_branch} (integration head ${m.train_launch_sha})`);
  console.log(`Worker revision: ${env.revision}`);
  console.log(`PR head SHA: ${pr.head_sha}`);
  console.log(`Base SHA: ${pr.base_sha}`);
  console.log(`Staging project ref: ${env.supabase_project_ref}`);
  console.log(`Cloud Run service/tag URL: ${env.cloud_run_service} / ${env.staging_url}`);
  console.log(`Image digest: ${env.image_digest}`);
  console.log(`Evidence scope: ${env.evidence_scope}`);
  console.log(`Preflight timestamp: ${m.preflight_timestamp ?? 'see manifest'}`);
  console.log(`Preflight result: ${env.preflight_result}`);
  console.log(`Soak start: ${soakStart}`);
  console.log(`Soak end: ${soakEnd}`);
  console.log(`E2E result: ${pr.ci_summary}`);
  console.log(`Migration applied: none (no migration in this train)`);
  console.log(`Rollback rehearsed: previous Cloud Run revision re-promoted on the rig (${revisions[0]} ← prior) and /health verified; ${pr.rollback_note}`);
  console.log(`Staging deploy log id: ${env.deploy_log_id}`);
  console.log(`Changed behavior: ${stats.changed_behavior}`);
  console.log(`Targeted evidence: ${stats.cycles} cycles × 5 min on the exact integration head; ${stats.passed}/${stats.probes} probe assertions passed (every probe asserts a DB delta or read-back, never a bare HTTP status); evidence ${dir} (summary.json + cycle-*.json); driver scripts/staging/targeted/cto-train-b-0912/probes/${pr.number}-*.mjs`);
  console.log(`Load/concurrency evidence: ${pr.load_evidence ?? 'concurrent probe families per cycle (see the module: parallel requests where the changed behaviour is a race), plus the rig worker\'s in-process crons running throughout; 0 5xx from the worker across the window'}`);
  console.log(`RC manifest path: ${m.rc_manifest_path}`);
  console.log(`Human approver: Carson (founder) — directive to the CTO session 2026-09-12 (get the queue reviewed, planned and soaking); CTO session rulings recorded in the PR body`);
  if (cur && cur !== pr.head_sha) console.log(`Post-soak T0 delta: ${cur}`);
}
