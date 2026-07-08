#!/usr/bin/env -S npx tsx
/**
 * scripts/staging/ai-soak-harness.ts — drive SUSTAINED load against the LIVE
 * worker AI extraction / template-review / tagging endpoints during an AI T3
 * soak. This is the AI-path load generator the generic `load-harness.ts` lacks
 * (its modes are anchor/webhooks/cron/reads — none hit `/api/v1/ai/*`).
 *
 * Targets (all metadata-only per Constitution §1.6 / §1.6A):
 *   POST /api/v1/ai/extract   PII-stripped golden text → structured fields
 *   POST /api/v1/ai/template  extracted fields → reconstructed template (AI-03)
 *   POST /api/v1/ai/tags      extracted fields → tags/classification
 *
 * It uses the vendored AI-01 golden set as a representative, PII-free corpus so
 * the load exercises real model inference on real document shapes.
 *
 * ── Auth + rate limits (see ai-eval/ai-client.ts header for the full note) ───
 *   /api/v1/ai/* require a Supabase user JWT (Authorization: Bearer <jwt>).
 *   aiRateLimiter = 30 req/min/user; anon per-IP = 100 req/min. To sustain
 *   >= 5k req/hr the harness shards across N JWTs (STAGING_AI_JWTS) and paces
 *   each user under 30/min. planRate() fails loud if the pool is undersized.
 *
 * Env:
 *   STAGING_API_BASE   REQUIRED tag-routed rig URL (resolveStagingApiBase refuses
 *                      shared/main staging to protect parallel soaks).
 *   STAGING_AI_JWTS    REQUIRED comma-list of `label:jwt` (or bare jwt) Supabase
 *                      user JWTs. >= 4 distinct users recommended for 5k/hr.
 *
 * Usage:
 *   # 15-min dry-run smoke with an evidence file
 *   STAGING_API_BASE=… STAGING_AI_JWTS=… \
 *     npx tsx scripts/staging/ai-soak-harness.ts --duration 15 --rate 5000 --evidence-out docs/staging/ai-dryrun.json
 *
 *   # 48-hour T3 AI soak at 5k req/hr, extract+template+tags
 *   STAGING_API_BASE=… STAGING_AI_JWTS=… \
 *     npx tsx scripts/staging/ai-soak-harness.ts --duration 2880 --rate 5000 \
 *       --endpoints extract,template,tags --evidence-out docs/staging/ai-soak-pr1413.json
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';

import { resolveStagingApiBase } from './load-harness-env.js';
import {
  callAiEndpoint,
  parseIdentities,
  type AiEndpoint,
  type FetchLike,
  type WorkerIdentity,
} from './ai-eval/ai-client.js';
import { planRate, pickIdentity, intervalMsForRatePerHour } from './ai-eval/rate.js';
import { allGoldenEntries } from './ai-eval/golden.js';
import {
  newAiStats,
  recordAiOutcome,
  summarizeAiRun,
  buildTemplatePayload,
  buildTagsPayload,
  selectEndpointForSequence,
} from './ai-eval/harness-core.js';
import { buildExtractPayload } from './ai-eval/eval-core.js';
import type { GoldenEntry } from './ai-eval/scoring.js';

const { values: args } = parseArgs({
  options: {
    duration: { type: 'string', default: '15' }, // minutes
    rate: { type: 'string', default: '5000' }, // requests/hour
    endpoints: { type: 'string', default: 'extract,template,tags' },
    'evidence-out': { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
});

function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  const n = Number.parseInt(raw ?? String(fallback), 10);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`::error::--${name}=${raw} must be a positive integer.`);
    process.exit(2);
  }
  return n;
}

function parseEndpoints(raw: string): AiEndpoint[] {
  const known: AiEndpoint[] = ['extract', 'template', 'tags'];
  const requested = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const selected = requested.filter((r): r is AiEndpoint => (known as string[]).includes(r));
  if (selected.length === 0) {
    console.error(`::error::--endpoints must be a comma-list of extract|template|tags; got \`${raw}\``);
    process.exit(2);
  }
  // Preserve canonical order so the weighted rotation in selectEndpointForSequence applies.
  return known.filter((k) => selected.includes(k));
}

function payloadFor(endpoint: AiEndpoint, entry: GoldenEntry): unknown {
  switch (endpoint) {
    case 'extract':
      return buildExtractPayload(entry);
    case 'template':
      return buildTemplatePayload(entry);
    case 'tags':
      return buildTagsPayload(entry);
  }
}

function boundedSleep(ms: number, endAt: number): Promise<void> {
  const remaining = endAt - Date.now();
  if (remaining <= 0) return Promise.resolve();
  return new Promise((r) => setTimeout(r, Math.min(ms, remaining)));
}

const realFetch: FetchLike = fetch as unknown as FetchLike;

async function main(): Promise<void> {
  const durationMin = parsePositiveInt(args.duration, 15, 'duration');
  const ratePerHour = parsePositiveInt(args.rate, 5000, 'rate');
  const endpoints = parseEndpoints(args.endpoints ?? 'extract,template,tags');
  const evidencePath = args['evidence-out'];

  const apiBase = resolveStagingApiBase(process.env);
  const identities: WorkerIdentity[] = parseIdentities(process.env.STAGING_AI_JWTS);
  const corpus = allGoldenEntries();

  const plan = planRate(ratePerHour, identities);
  const mode = `ai-${endpoints.join('+')}`;

  console.log(`▶ ai-soak-harness ${mode} at ${new Date().toISOString()}`);
  console.log(`  api_base=${apiBase}`);
  console.log(`  duration=${durationMin}min  target=${ratePerHour} req/hr  interval=${plan.intervalMs}ms`);
  console.log(`  identities=${identities.length} (min ${plan.minUsers})  per_user≈${plan.perUserPerMin.toFixed(1)}/min (limit 30)`);
  console.log(`  corpus=${corpus.length} golden fixtures  endpoints=${endpoints.join(',')}`);
  if (plan.warning) console.warn(`  ⚠ ${plan.warning}`);

  if (identities.length === 0) {
    console.error('::error::STAGING_AI_JWTS is required — /api/v1/ai/* rejects unauthenticated calls (401).');
    process.exit(1);
  }
  if (args['dry-run']) {
    console.log('  --dry-run: plan validated; exiting without firing.');
    return;
  }

  const stats = newAiStats();
  const endAt = stats.startedAt + durationMin * 60_000;
  const intervalMs = intervalMsForRatePerHour(ratePerHour);

  const summaryTimer = setInterval(() => {
    if (Date.now() >= endAt) return;
    const elapsedSec = (Date.now() - stats.startedAt) / 1000;
    console.log(`[t+${elapsedSec.toFixed(0)}s] total=${stats.total} 429=${stats.rateLimited429} transportErr=${stats.transportErrors} achieved≈${((stats.total / Math.max(elapsedSec, 1)) * 3600).toFixed(0)}/hr`);
  }, 60_000);

  let seq = 0;
  try {
    while (Date.now() < endAt) {
      const endpoint = selectEndpointForSequence(seq, endpoints);
      const entry = corpus[seq % corpus.length];
      const identity = pickIdentity(identities, seq);
      // Fire-and-forget within the pacing loop; the interval bounds the rate.
      void callAiEndpoint(apiBase, endpoint, payloadFor(endpoint, entry), identity, realFetch).then((outcome) =>
        recordAiOutcome(stats, outcome),
      );
      seq++;
      await boundedSleep(intervalMs, endAt);
    }
  } finally {
    clearInterval(summaryTimer);
  }

  // Give in-flight requests a moment to settle before summarizing.
  await new Promise((r) => setTimeout(r, 2_000));

  const durationSec = (Date.now() - stats.startedAt) / 1000;
  const summary = summarizeAiRun(stats, mode, apiBase, durationSec);
  console.log(`\n=== AI SOAK SUMMARY (${durationMin}min ${mode}) ===`);
  console.log(JSON.stringify(summary, null, 2));

  if (evidencePath) {
    mkdirSync(dirname(evidencePath), { recursive: true });
    writeFileSync(evidencePath, JSON.stringify(summary, null, 2) + '\n');
    console.log(`\n📄 Evidence written: ${evidencePath}`);
  }
}

main().catch((err) => {
  console.error(`::error::AI soak harness failed: ${err instanceof Error ? err.message : err}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
