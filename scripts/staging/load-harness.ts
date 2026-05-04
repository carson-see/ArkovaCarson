#!/usr/bin/env -S npx tsx
/**
 * scripts/staging/load-harness.ts — fire synthetic anchors at the
 * staging worker at controllable rates.
 *
 * Used to exercise the queue triggers during a soak window:
 *   - Trigger A (size: 10k) — burst mode pumps 12k anchors in <5min.
 *   - Trigger B (3k threshold + 3h clock) — steady mode holds pending
 *     count just above 3k for 4h to verify the clock fires once and
 *     not twice.
 *   - Per-org isolation — multi-tenant mode interleaves N org keys.
 *
 * Modes (--mode):
 *   steady     — N anchors/min for D minutes, single org (default 100/60/1)
 *   burst      — pump M anchors as fast as possible, single org
 *   oscillate  — drive pending count up + down across the 3k threshold
 *   multitenant — round-robin across all configured org API keys
 *
 * Usage:
 *   STAGING_API_BASE=https://arkova-worker-staging-...run.app \
 *   STAGING_API_KEYS=ak_org1_xxx,ak_org2_yyy,ak_org3_zzz \
 *   npm run staging:load -- --mode burst --count 12000
 */

import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';

const API_BASE = requireEnv('STAGING_API_BASE');
const API_KEYS = requireEnv('STAGING_API_KEYS').split(',').map((k) => k.trim()).filter(Boolean);

if (API_KEYS.length === 0) {
  console.error('::error::STAGING_API_KEYS must contain at least one key.');
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    mode: { type: 'string', default: 'steady' },
    rate: { type: 'string', default: '100' }, // anchors/min for steady/oscillate
    duration: { type: 'string', default: '60' }, // minutes for steady/oscillate
    count: { type: 'string', default: '1000' }, // total anchors for burst
    concurrency: { type: 'string', default: '10' },
  },
});

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`::error::Required env var ${name} is not set.`);
    process.exit(1);
  }
  return v;
}

function fakeFingerprint(): string {
  return randomBytes(32).toString('hex');
}

interface AnchorResult {
  ok: boolean;
  status: number;
  body?: string;
  apiKeyIdx: number;
}

async function fireOne(apiKeyIdx: number): Promise<AnchorResult> {
  const key = API_KEYS[apiKeyIdx];
  const fingerprint = fakeFingerprint();
  try {
    const res = await fetch(`${API_BASE}/api/v1/anchor`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        fingerprint,
        credential_type: 'GENERIC',
        metadata: { source: 'staging-load-harness' },
      }),
    });
    return {
      ok: res.ok,
      status: res.status,
      body: res.ok ? undefined : await res.text(),
      apiKeyIdx,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: err instanceof Error ? err.message : String(err),
      apiKeyIdx,
    };
  }
}

interface RunStats {
  ok: number;
  fail: number;
  byStatus: Record<number, number>;
  byKey: Record<number, number>;
  startedAt: number;
}

function newStats(): RunStats {
  return { ok: 0, fail: 0, byStatus: {}, byKey: {}, startedAt: Date.now() };
}

function record(stats: RunStats, r: AnchorResult): void {
  if (r.ok) stats.ok++;
  else stats.fail++;
  stats.byStatus[r.status] = (stats.byStatus[r.status] ?? 0) + 1;
  stats.byKey[r.apiKeyIdx] = (stats.byKey[r.apiKeyIdx] ?? 0) + 1;
}

function printStats(stats: RunStats): void {
  const elapsedSec = (Date.now() - stats.startedAt) / 1000;
  const rate = (stats.ok + stats.fail) / Math.max(elapsedSec, 1);
  console.log(
    `  total=${stats.ok + stats.fail} ok=${stats.ok} fail=${stats.fail} `
    + `rate=${rate.toFixed(1)}/s elapsed=${elapsedSec.toFixed(0)}s`,
  );
  const failStatuses = Object.entries(stats.byStatus).filter(([s]) => s !== '200' && s !== '201' && s !== '202');
  if (failStatuses.length > 0) {
    console.log(`  failures by status: ${failStatuses.map(([s, n]) => `${s}=${n}`).join(' ')}`);
  }
}

async function runBurst(count: number, concurrency: number): Promise<void> {
  console.log(`▶ Burst: ${count} anchors at concurrency ${concurrency}`);
  const stats = newStats();
  const inflight = new Set<Promise<void>>();
  let dispatched = 0;
  let keyIdx = 0;
  while (dispatched < count) {
    while (inflight.size < concurrency && dispatched < count) {
      const p = fireOne(keyIdx % API_KEYS.length).then((r) => {
        record(stats, r);
        inflight.delete(p);
      });
      inflight.add(p);
      dispatched++;
      keyIdx++;
    }
    await Promise.race(inflight);
    if (dispatched % 1_000 === 0) printStats(stats);
  }
  await Promise.all(inflight);
  printStats(stats);
}

async function runSteady(ratePerMin: number, durationMin: number): Promise<void> {
  console.log(`▶ Steady: ${ratePerMin}/min for ${durationMin} min`);
  const stats = newStats();
  const intervalMs = 60_000 / ratePerMin;
  const endAt = Date.now() + durationMin * 60_000;
  let keyIdx = 0;
  while (Date.now() < endAt) {
    const tickStart = Date.now();
    fireOne(keyIdx % API_KEYS.length).then((r) => record(stats, r));
    keyIdx++;
    const drift = Date.now() - tickStart;
    const sleep = Math.max(0, intervalMs - drift);
    await new Promise((r) => setTimeout(r, sleep));
    if (keyIdx % 100 === 0) printStats(stats);
  }
  printStats(stats);
}

async function runOscillate(durationMin: number): Promise<void> {
  console.log(`▶ Oscillate: drive pending count across the 3k threshold for ${durationMin} min`);
  // Up-down sawtooth: 200/min for 20 min (builds to ~4k), then 0 for 10 min,
  // then 200/min for 20 min, repeating. Lets the 3-hour clock start, fire,
  // and restart across multiple cycles within a 4h window.
  const cycleMin = 30;
  const cycles = Math.ceil(durationMin / cycleMin);
  for (let c = 0; c < cycles; c++) {
    console.log(`  cycle ${c + 1}/${cycles}: ramping up`);
    await runSteady(200, 20);
    console.log(`  cycle ${c + 1}/${cycles}: cooling down`);
    await new Promise((r) => setTimeout(r, 10 * 60_000));
  }
}

async function main(): Promise<void> {
  const mode = values.mode ?? 'steady';
  const concurrency = Number.parseInt(values.concurrency ?? '10', 10);

  switch (mode) {
    case 'burst':
      await runBurst(Number.parseInt(values.count ?? '1000', 10), concurrency);
      break;
    case 'steady':
    case 'multitenant':
      await runSteady(
        Number.parseInt(values.rate ?? '100', 10),
        Number.parseInt(values.duration ?? '60', 10),
      );
      break;
    case 'oscillate':
      await runOscillate(Number.parseInt(values.duration ?? '60', 10));
      break;
    default:
      console.error(`::error::unknown mode: ${mode}`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`::error::Load harness failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
