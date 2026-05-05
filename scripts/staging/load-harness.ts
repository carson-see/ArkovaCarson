#!/usr/bin/env -S npx tsx
/**
 * scripts/staging/load-harness.ts — drive sustained synthetic load
 * against arkova-worker-staging during a T2/T3 soak.
 *
 * Modes (--mode):
 *   anchor      POST /api/v1/anchor at a steady rate (existing soak target)
 *   burst       POST /api/v1/anchor as fast as concurrency allows
 *   oscillate   sawtooth across the 3k-pending threshold (Trigger B clock)
 *   webhooks    POST connector webhooks with synthetic HMAC payloads
 *               (drive / docusign / adobe-sign / checkr)
 *   events      POST /api/admin/inject-demo-event (rules-engine claim loop)
 *   cron        POST /jobs/{batch-anchors,check-confirmations,...}
 *   reads       GET /api/v1/verify/:publicId + /admin/pipeline-stats
 *   mixed       runs webhooks + events + cron + reads concurrently — the
 *               default mode for a T2/T3 soak window
 *
 * Auth:
 *   Cloud Run service is `--no-allow-unauthenticated`, so EVERY request
 *   carries an IAM bearer token in the Authorization header. The harness
 *   fetches one via `gcloud auth print-identity-token` at startup and
 *   refreshes every 30 minutes (tokens expire after 1 hour).
 *
 *   App-layer secrets ride in dedicated headers:
 *     X-Cron-Secret  for /jobs/* requests
 *     X-API-Key      for /api/v1/* requests (synthetic; returns 401 unless
 *                    STAGING_API_KEY is set to a real provisioned key)
 *
 *   401 / 403 from app-layer auth IS valid soak data — it exercises the
 *   middleware chain, rate limiter, and structured-logging path under load.
 *
 * Evidence:
 *   --evidence-out writes a JSON summary covering per-mode totals,
 *   latency p50/p95/p99, error rate, and per-HTTP-status counts. Used to
 *   fill the PR's `## Staging Soak Evidence` block.
 *
 * Env:
 *   STAGING_API_BASE       default https://arkova-worker-staging-kvojbeutfa-uc.a.run.app
 *   STAGING_CRON_SECRET    optional; without it, cron mode returns 401
 *   STAGING_API_KEY        optional; without it, anchor/reads return 401
 *   STAGING_GCP_IDENTITY   optional pre-fetched IAM token (skip gcloud)
 *
 * Usage:
 *   # 15-min mixed dry run with evidence file
 *   npm run staging:load -- --mode mixed --duration 15 --evidence-out docs/staging/dryrun.json
 *
 *   # 4-hour T2 soak
 *   npm run staging:load -- --mode mixed --duration 240 --evidence-out docs/staging/soak-pr-695.json
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, randomUUID, createHmac } from 'node:crypto';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    mode: { type: 'string', default: 'mixed' },
    duration: { type: 'string', default: '15' },        // minutes
    rate: { type: 'string', default: '100' },           // anchors/min for steady
    count: { type: 'string', default: '1000' },         // total for burst
    concurrency: { type: 'string', default: '10' },
    'evidence-out': { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
});

const API_BASE = process.env.STAGING_API_BASE
  ?? 'https://arkova-worker-staging-kvojbeutfa-uc.a.run.app';

// --- IAM token (refresh every 30 min — tokens expire after 1h) ---

let cachedIamToken = '';
let iamFetchedAt = 0;
const IAM_TTL_MS = 30 * 60_000;

// Sonar S4036: pin PATH to fixed system dirs so the gcloud lookup can't
// be redirected to a writeable directory injected at the front of PATH.
const SAFE_PATH = '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin';

function fetchIamToken(): string {
  const env = process.env.STAGING_GCP_IDENTITY;
  if (env) return env.trim();
  try {
    const out = execFileSync('gcloud', ['auth', 'print-identity-token'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: SAFE_PATH },
    });
    return out.trim();
  } catch (err) {
    console.error(`::error::Could not fetch IAM token via gcloud: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

function iamToken(): string {
  if (!cachedIamToken || Date.now() - iamFetchedAt > IAM_TTL_MS) {
    cachedIamToken = fetchIamToken();
    iamFetchedAt = Date.now();
  }
  return cachedIamToken;
}

// --- Helpers ---

function fakeFingerprint(): string {
  return randomBytes(32).toString('hex');
}

// Per-process random HMAC key for synthetic webhook signatures. The
// worker rejects them (real keys are per-tenant in Secret Manager) — the
// soak point is to exercise the validate-fail path under load. Random
// bytes per process avoids triggering Sonar's hardcoded-credential rule.
const SYNTHETIC_HMAC_KEY = randomBytes(32);
function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

// Sleep at most `ms`, but never past `endAt`. Lets long inter-iteration
// pauses (cron mode's 5-min cycle) wake up promptly when the duration ends.
function boundedSleep(ms: number, endAt: number): Promise<void> {
  const remaining = endAt - Date.now();
  if (remaining <= 0) return Promise.resolve();
  return new Promise((r) => setTimeout(r, Math.min(ms, remaining)));
}

interface RequestOutcome {
  mode: string;
  endpoint: string;
  status: number;
  latencyMs: number;
  ok: boolean;
}

interface RunStats {
  startedAt: number;
  outcomes: RequestOutcome[];
  byMode: Record<string, { ok: number; fail: number; latencyMs: number[]; byStatus: Record<number, number> }>;
}

function newStats(): RunStats {
  return { startedAt: Date.now(), outcomes: [], byMode: {} };
}

function record(stats: RunStats, o: RequestOutcome): void {
  stats.outcomes.push(o);
  const slot = stats.byMode[o.mode] ?? { ok: 0, fail: 0, latencyMs: [], byStatus: {} };
  if (o.ok) slot.ok++;
  else slot.fail++;
  slot.latencyMs.push(o.latencyMs);
  slot.byStatus[o.status] = (slot.byStatus[o.status] ?? 0) + 1;
  stats.byMode[o.mode] = slot;
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

function printPerMinute(stats: RunStats): void {
  const elapsedSec = (Date.now() - stats.startedAt) / 1000;
  const totalReqs = stats.outcomes.length;
  const overallRate = totalReqs / Math.max(elapsedSec, 1);
  console.log(`\n[t+${elapsedSec.toFixed(0)}s] total=${totalReqs} rate=${overallRate.toFixed(1)}/s`);
  for (const [mode, slot] of Object.entries(stats.byMode)) {
    const p50 = percentile(slot.latencyMs, 50);
    const p95 = percentile(slot.latencyMs, 95);
    const p99 = percentile(slot.latencyMs, 99);
    const errRate = slot.fail / Math.max(slot.ok + slot.fail, 1);
    const statusCounts = Object.entries(slot.byStatus).map(([s, n]) => `${s}=${n}`).join(' ');
    console.log(`  ${mode.padEnd(10)} ok=${slot.ok} fail=${slot.fail} err=${(errRate * 100).toFixed(1)}% p50=${p50}ms p95=${p95}ms p99=${p99}ms statuses[${statusCounts}]`);
  }
}

async function fire(
  stats: RunStats,
  mode: string,
  endpoint: string,
  init: RequestInit,
): Promise<void> {
  const url = `${API_BASE}${endpoint}`;
  const startedAt = Date.now();
  let status = 0;
  let ok = false;
  try {
    const headers = new Headers(init.headers ?? {});
    if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${iamToken()}`);
    const res = await fetch(url, { ...init, headers });
    status = res.status;
    ok = res.ok;
    // Drain body so the connection can be reused.
    await res.text();
  } catch (err) {
    status = 0;
    ok = false;
    void err; // surfaced via byStatus[0] count
  }
  record(stats, {
    mode,
    endpoint,
    status,
    latencyMs: Date.now() - startedAt,
    ok,
  });
}

// --- Mode runners ---

interface ModeOpts {
  endAt: number;
  stats: RunStats;
  concurrency: number;
}

async function runAnchorMode(opts: ModeOpts, ratePerMin: number): Promise<void> {
  const intervalMs = 60_000 / Math.max(ratePerMin, 1);
  while (Date.now() < opts.endAt) {
    void fire(opts.stats, 'anchor', '/api/v1/anchor', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': process.env.STAGING_API_KEY ?? `ak_synthetic_${randomBytes(4).toString('hex')}`,
      },
      body: JSON.stringify({
        fingerprint: fakeFingerprint(),
        credential_type: 'OTHER',
        filename: 'synthetic.pdf',
        metadata: { source: 'staging-load-harness' },
      }),
    });
    await boundedSleep(intervalMs, opts.endAt);
  }
}

async function runBurstMode(opts: ModeOpts, count: number): Promise<void> {
  let dispatched = 0;
  const inflight = new Set<Promise<void>>();
  while (dispatched < count) {
    while (inflight.size < opts.concurrency && dispatched < count) {
      const p = fire(opts.stats, 'burst', '/api/v1/anchor', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': process.env.STAGING_API_KEY ?? `ak_synthetic_${randomBytes(4).toString('hex')}`,
        },
        body: JSON.stringify({
          fingerprint: fakeFingerprint(),
          credential_type: 'OTHER',
          filename: 'synthetic-burst.pdf',
        }),
      }).then(() => { inflight.delete(p); });
      inflight.add(p);
      dispatched++;
    }
    await Promise.race(inflight);
  }
  await Promise.all(inflight);
}

async function runOscillateMode(opts: ModeOpts): Promise<void> {
  // 20 min ramp at 200/min ~= 4k anchors, 10 min cool-down, repeat until endAt.
  while (Date.now() < opts.endAt) {
    const rampEnd = Math.min(opts.endAt, Date.now() + 20 * 60_000);
    await runAnchorMode({ ...opts, endAt: rampEnd }, 200);
    if (Date.now() >= opts.endAt) break;
    const coolEnd = Math.min(opts.endAt, Date.now() + 10 * 60_000);
    while (Date.now() < coolEnd) await boundedSleep(5_000, opts.endAt);
  }
}

const WEBHOOK_PROVIDERS = [
  { provider: 'drive',       path: '/api/v1/webhooks/drive' },
  { provider: 'docusign',    path: '/webhooks/docusign' },
  { provider: 'adobe-sign',  path: '/webhooks/adobe-sign' },
  { provider: 'checkr',      path: '/webhooks/checkr' },
] as const;

function fakeWebhookBody(provider: string): string {
  const id = randomUUID();
  switch (provider) {
    case 'drive':
      // Google's Drive push notification headers are the trigger; body is empty.
      return '';
    case 'docusign':
      return JSON.stringify({
        event: 'envelope-completed',
        data: { envelopeId: `stg-env-${id}`, envelopeStatus: 'completed' },
        generatedDateTime: new Date().toISOString(),
      });
    case 'adobe-sign':
      return JSON.stringify({
        event: 'AGREEMENT_WORKFLOW_COMPLETED',
        agreement: { id: `stg-agr-${id}`, status: 'SIGNED' },
      });
    case 'checkr':
      return JSON.stringify({
        type: 'report.completed',
        data: { object: { id: `stg-rpt-${id}`, status: 'clear' } },
      });
    default:
      return '{}';
  }
}

function fakeWebhookHeaders(provider: string, body: string): HeadersInit {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  switch (provider) {
    case 'drive':
      headers['X-Goog-Channel-ID'] = `stg-channel-${randomUUID()}`;
      headers['X-Goog-Resource-ID'] = `stg-res-${randomBytes(6).toString('hex')}`;
      headers['X-Goog-Resource-State'] = 'change';
      headers['X-Goog-Message-Number'] = String(randomBytes(4).readUInt32BE(0) % 1_000_000);
      break;
    case 'docusign':
      // Real signature would be HMAC-SHA256 of body using the connect key.
      // Synthetic value -> worker rejects; that exercises the validate-fail path.
      headers['X-DocuSign-Signature-1'] = createHmac('sha256', SYNTHETIC_HMAC_KEY).update(body).digest('hex');
      break;
    case 'adobe-sign':
      headers['X-AdobeSign-ClientId'] = `stg-client-${randomBytes(4).toString('hex')}`;
      break;
    case 'checkr':
      headers['X-Checkr-Signature'] = createHmac('sha256', SYNTHETIC_HMAC_KEY).update(body).digest('hex');
      break;
  }
  return headers;
}

async function runWebhooksMode(opts: ModeOpts, ratePerMin: number): Promise<void> {
  const intervalMs = 60_000 / Math.max(ratePerMin, 1);
  let i = 0;
  while (Date.now() < opts.endAt) {
    const target = WEBHOOK_PROVIDERS[i % WEBHOOK_PROVIDERS.length];
    const body = fakeWebhookBody(target.provider);
    void fire(opts.stats, 'webhook', target.path, {
      method: 'POST',
      headers: fakeWebhookHeaders(target.provider, body),
      body: body || undefined,
    });
    i++;
    await boundedSleep(intervalMs, opts.endAt);
  }
}

async function runEventsMode(opts: ModeOpts, ratePerMin: number): Promise<void> {
  // Endpoint is admin-gated (requires user JWT). Without one, returns 401
  // which still exercises the auth middleware + rate limiter under load.
  const intervalMs = 60_000 / Math.max(ratePerMin, 1);
  while (Date.now() < opts.endAt) {
    void fire(opts.stats, 'events', '/api/rules/demo-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        trigger_type: 'CONNECTOR_DOCUMENT_RECEIVED',
        vendor: 'staging-synthetic',
        external_file_id: `stg-evt-${randomUUID()}`,
        filename: 'synthetic-event.pdf',
        payload: { synthetic: true },
      }),
    });
    await boundedSleep(intervalMs, opts.endAt);
  }
}

const CRON_ENDPOINTS = [
  '/jobs/process-anchors',
  '/jobs/batch-anchors',
  '/jobs/check-confirmations',
  '/jobs/process-revocations',
  '/jobs/rules-engine',
  '/jobs/rule-action-dispatcher',
] as const;

async function runCronMode(opts: ModeOpts, intervalSec: number): Promise<void> {
  const cronSecret = process.env.STAGING_CRON_SECRET;
  while (Date.now() < opts.endAt) {
    for (const path of CRON_ENDPOINTS) {
      if (Date.now() >= opts.endAt) break;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (cronSecret) headers['X-Cron-Secret'] = cronSecret;
      void fire(opts.stats, 'cron', path, { method: 'POST', headers });
    }
    await boundedSleep(intervalSec * 1000, opts.endAt);
  }
}

async function runReadsMode(opts: ModeOpts, ratePerMin: number): Promise<void> {
  const intervalMs = 60_000 / Math.max(ratePerMin, 1);
  let i = 0;
  while (Date.now() < opts.endAt) {
    // Mix of verify (public) and admin pipeline stats (auth-gated; will 401
    // without admin token, which is fine soak data).
    const path = i % 3 === 0
      ? '/api/admin/pipeline-stats'
      : i % 3 === 1
        ? '/api/v1/verify/STG-ANC-DEADBEEF'
        : '/api/v1/anchors/STG-ANC-DEADBEEF';
    void fire(opts.stats, 'reads', path, {
      method: 'GET',
      headers: process.env.STAGING_API_KEY
        ? { 'X-API-Key': process.env.STAGING_API_KEY }
        : { 'X-API-Key': `ak_synthetic_${randomBytes(4).toString('hex')}` },
    });
    i++;
    await boundedSleep(intervalMs, opts.endAt);
  }
}

async function runMixedMode(opts: ModeOpts): Promise<void> {
  // Concurrent runners with rates roughly matching the spec:
  //   webhooks 10/min sustained
  //   events   100/min
  //   cron     every 5 min
  //   reads    50/min
  await Promise.all([
    runWebhooksMode(opts, 10),
    runEventsMode(opts, 100),
    runCronMode(opts, 5 * 60),
    runReadsMode(opts, 50),
  ]);
}

// --- Per-minute summary loop ---

function startMinuteSummaryLoop(stats: RunStats, endAt: number): NodeJS.Timeout {
  return setInterval(() => {
    if (Date.now() < endAt) printPerMinute(stats);
  }, 60_000);
}

// --- Evidence file ---

interface EvidenceFile {
  startedAt: string;
  endedAt: string;
  durationSec: number;
  apiBase: string;
  mode: string;
  totalRequests: number;
  byMode: Record<string, {
    ok: number;
    fail: number;
    errorRate: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    byStatus: Record<number, number>;
  }>;
}

function summarize(stats: RunStats, mode: string): EvidenceFile {
  const startedAt = new Date(stats.startedAt).toISOString();
  const endedAt = new Date().toISOString();
  const durationSec = (Date.now() - stats.startedAt) / 1000;
  const byMode: EvidenceFile['byMode'] = {};
  for (const [m, slot] of Object.entries(stats.byMode)) {
    byMode[m] = {
      ok: slot.ok,
      fail: slot.fail,
      errorRate: slot.fail / Math.max(slot.ok + slot.fail, 1),
      p50Ms: percentile(slot.latencyMs, 50),
      p95Ms: percentile(slot.latencyMs, 95),
      p99Ms: percentile(slot.latencyMs, 99),
      byStatus: slot.byStatus,
    };
  }
  return {
    startedAt,
    endedAt,
    durationSec,
    apiBase: API_BASE,
    mode,
    totalRequests: stats.outcomes.length,
    byMode,
  };
}

function writeEvidence(path: string, evidence: EvidenceFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(evidence, null, 2) + '\n');
  console.log(`\n📄 Evidence written: ${path}`);
}

// --- main ---

async function main(): Promise<void> {
  const mode = args.mode ?? 'mixed';
  const durationMin = Number.parseInt(args.duration ?? '15', 10);
  const concurrency = Number.parseInt(args.concurrency ?? '10', 10);
  const evidencePath = args['evidence-out'];

  const stats = newStats();
  const startedHuman = new Date().toISOString();
  const endAt = stats.startedAt + durationMin * 60_000;

  console.log(`▶ load-harness ${mode} mode at ${startedHuman}`);
  console.log(`  api_base=${API_BASE}  duration=${durationMin}min  endAt=${new Date(endAt).toISOString()}`);
  console.log(`  cron_secret=${process.env.STAGING_CRON_SECRET ? 'set' : 'unset (cron 401)'}  api_key=${process.env.STAGING_API_KEY ? 'set' : 'synthetic (401)'}`);
  if (args['dry-run']) {
    console.log('  --dry-run: exiting without firing.');
    return;
  }

  // Warm IAM token before clock starts.
  iamToken();

  const summaryTimer = startMinuteSummaryLoop(stats, endAt);

  try {
    const opts: ModeOpts = { endAt, stats, concurrency };
    switch (mode) {
      case 'anchor':
        await runAnchorMode(opts, Number.parseInt(args.rate ?? '100', 10));
        break;
      case 'burst':
        await runBurstMode(opts, Number.parseInt(args.count ?? '1000', 10));
        break;
      case 'oscillate':
        await runOscillateMode(opts);
        break;
      case 'webhooks':
        await runWebhooksMode(opts, 10);
        break;
      case 'events':
        await runEventsMode(opts, 100);
        break;
      case 'cron':
        await runCronMode(opts, 5 * 60);
        break;
      case 'reads':
        await runReadsMode(opts, 50);
        break;
      case 'mixed':
        await runMixedMode(opts);
        break;
      default:
        console.error(`::error::unknown mode: ${mode}`);
        process.exit(1);
    }
  } finally {
    clearInterval(summaryTimer);
  }

  console.log(`\n=== FINAL SUMMARY (${pad2(durationMin)}min ${mode} mode) ===`);
  printPerMinute(stats);

  if (evidencePath) writeEvidence(evidencePath, summarize(stats, mode));
}

main().catch((err) => {
  console.error(`::error::Load harness failed: ${err instanceof Error ? err.message : err}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
