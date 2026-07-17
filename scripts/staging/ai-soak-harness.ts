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
 * -- Auth + rate limits (see ai-eval/ai-client.ts header for the full note) ---
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
 *   STAGING_API_BASE=... STAGING_AI_JWTS=... \
 *     npx tsx scripts/staging/ai-soak-harness.ts --duration 15 --rate 5000 --evidence-out docs/staging/ai-dryrun.json
 *
 *   # 48-hour T3 AI soak at 5k req/hr, extract+template+tags
 *   STAGING_API_BASE=... STAGING_AI_JWTS=... \
 *     npx tsx scripts/staging/ai-soak-harness.ts --duration 2880 --rate 5000 \
 *       --endpoints extract,template,tags --evidence-out docs/staging/ai-soak-pr1413.json
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { resolveStagingApiBase } from './load-harness-env.js';
import {
  callAiEndpoint,
  parseIdentities,
  randomForwardedFor,
  type AiEndpoint,
  type ExtractRequestBody,
  type FetchLike,
  type WorkerIdentity,
} from './ai-eval/ai-client.js';
import { resolveEvidenceOutputPath } from './ai-eval/evidence-path.js';
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
import { fingerprintForEntry } from './ai-eval/eval-core.js';
import {
  buildVariantCorpus,
  parseDocVariants,
  isLoadOnlyVariant,
  type CorpusItem,
} from './ai-eval/corpus.js';

export interface AiSoakHarnessRunOptions {
  readonly apiBase: string;
  readonly identities: WorkerIdentity[];
  readonly durationMin: number;
  readonly ratePerHour: number;
  readonly endpoints: AiEndpoint[];
  readonly variants: ReturnType<typeof parseDocVariants>;
  readonly timeoutMs: number;
  readonly rotateIp: boolean;
  /**
   * Immutable run identity used with the monotonic dispatch sequence so a
   * release soak exercises real inference instead of the extraction cache.
   */
  readonly fingerprintNamespace?: string;
  readonly evidencePath?: string;
  readonly dryRun?: boolean;
  readonly allowUndersizedPool?: boolean;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: FetchLike;
  readonly onReady?: () => void;
}

function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  const n = Number.parseInt(raw ?? String(fallback), 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`--${name}=${raw} must be a positive integer.`);
  }
  return n;
}

function parseEndpoints(raw: string): AiEndpoint[] {
  const known: AiEndpoint[] = ['extract', 'template', 'tags'];
  const requested = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const selected = requested.filter((r): r is AiEndpoint => (known as string[]).includes(r));
  if (selected.length === 0) {
    throw new Error(`--endpoints must be a comma-list of extract|template|tags; got \`${raw}\``);
  }
  return known.filter((k) => selected.includes(k));
}

/**
 * Extract carries the VARIANT text (pdf/scan/docx/large/oversized/malformed) so
 * the load exercises real document diversity + size limits. Template/tags take
 * metadata FIELDS only (no text/bytes) — variant doesn't apply, so they always
 * use the entry's clean ground-truth metadata.
 */
function payloadFor(
  endpoint: AiEndpoint,
  item: CorpusItem,
  fingerprintNamespace?: string,
  sequence?: number,
): unknown {
  switch (endpoint) {
    case 'extract': {
      const payload: ExtractRequestBody = {
        strippedText: item.strippedText,
        credentialType: item.entry.credentialTypeHint,
        fingerprint: fingerprintForEntry(
          fingerprintNamespace === undefined || sequence === undefined
            ? `${item.entry.id}:${item.variant}`
            : `${item.entry.id}:${item.variant}:${fingerprintNamespace}:${sequence}`,
        ),
      };
      if (item.entry.issuerHint) payload.issuerHint = item.entry.issuerHint;
      return payload;
    }
    case 'template':
      return buildTemplatePayload(item.entry);
    case 'tags':
      return buildTagsPayload(item.entry);
  }
}

function boundedSleep(ms: number, endAt: number, signal?: AbortSignal): Promise<void> {
  const remaining = endAt - Date.now();
  if (remaining <= 0 || signal?.aborted === true) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, Math.min(ms, remaining));
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

const realFetch: FetchLike = fetch as unknown as FetchLike;

function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

function trackPendingRequest(pending: Set<Promise<void>>, request: Promise<void>): void {
  pending.add(request);
  void request.finally(() => pending.delete(request));
}

function recordHarnessFailure(stats: ReturnType<typeof newAiStats>, endpoint: AiEndpoint, err: unknown, variant: string): void {
  recordAiOutcome(stats, {
    endpoint,
    status: 0,
    ok: false,
    latencyMs: 0,
    transportError: err instanceof Error ? err.message : String(err),
  }, variant);
}

export async function runAiSoakHarness(
  options: AiSoakHarnessRunOptions,
): Promise<ReturnType<typeof summarizeAiRun> | null> {
  const {
    apiBase,
    identities,
    durationMin,
    ratePerHour,
    endpoints,
    variants,
    timeoutMs,
    rotateIp,
    evidencePath,
    signal,
  } = options;
  const corpus = buildVariantCorpus(allGoldenEntries(), variants);

  const plan = planRate(ratePerHour, identities);
  const mode = `ai-${endpoints.join('+')}`;

  console.log(`> ai-soak-harness ${mode} at ${new Date().toISOString()}`);
  console.log(`  api_base=${apiBase}`);
  console.log(`  duration=${durationMin}min  target=${ratePerHour} req/hr  interval=${plan.intervalMs}ms  client_timeout=${timeoutMs}ms  rotate_ip=${rotateIp}`);
  console.log(`  identities=${identities.length} (min ${plan.minUsers})  per_user~${plan.perUserPerMin.toFixed(1)}/min (limit 30)`);
  console.log(`  corpus=${corpus.length} items (${allGoldenEntries().length} fixtures x ${variants.length} variants: ${variants.join(',')})`);
  console.log(`  endpoints=${endpoints.join(',')}`);
  if (plan.warning) console.warn(`  WARN ${plan.warning}`);

  if (identities.length === 0) {
    throw new Error('STAGING_AI_JWTS is required — /api/v1/ai/* rejects unauthenticated calls (401).');
  }
  if (!plan.sufficient && !options.allowUndersizedPool) {
    throw new Error(`${plan.warning} Aborting — an undersized JWT pool would self-inflict 429s that masquerade as ` +
      'Gemini reliability failures in the soak evidence. Add JWTs, lower --rate, or pass ' +
      '--allow-undersized-pool to force a run (not merge-grade for reliability evidence).');
  }
  if (options.dryRun) {
    console.log('  --dry-run: plan validated; exiting without firing.');
    return null;
  }
  if (isAborted(signal)) throw new Error('AI soak start was aborted before the clock began.');

  const stats = newAiStats();
  const endAt = stats.startedAt + durationMin * 60_000;
  const intervalMs = intervalMsForRatePerHour(ratePerHour);
  options.onReady?.();

  const summaryTimer = setInterval(() => {
    if (Date.now() >= endAt) return;
    const elapsedSec = (Date.now() - stats.startedAt) / 1000;
    const r = stats.reliability.counts;
    console.log(
      `[t+${elapsedSec.toFixed(0)}s] total=${stats.total} 429=${r.rate_limited} ` +
      `timeout=${r.client_timeout + r.server_unavailable} false=${r.false_reading} ` +
      `achieved~${((stats.total / Math.max(elapsedSec, 1)) * 3600).toFixed(0)}/hr`,
    );
  }, 60_000);

  let seq = 0;
  const pendingRequests = new Set<Promise<void>>();
  const fetchImpl = options.fetchImpl ?? realFetch;
  try {
    while (Date.now() < endAt && !isAborted(signal)) {
      const endpoint = selectEndpointForSequence(seq, endpoints);
      const item = corpus[seq % corpus.length];
      const effectiveEndpoint = isLoadOnlyVariant(item.variant) ? 'extract' : endpoint;
      const identity = pickIdentity(identities, seq);
      const forwardedFor = rotateIp ? randomForwardedFor() : undefined;
      const request = callAiEndpoint(
        apiBase,
        effectiveEndpoint,
        payloadFor(effectiveEndpoint, item, options.fingerprintNamespace, seq),
        identity,
        fetchImpl,
        { timeoutMs, forwardedFor },
      )
        .then((outcome) => recordAiOutcome(stats, outcome, item.variant))
        .catch((err: unknown) => recordHarnessFailure(stats, effectiveEndpoint, err, item.variant));
      trackPendingRequest(pendingRequests, request);
      seq++;
      await boundedSleep(intervalMs, endAt, signal);
    }
  } finally {
    clearInterval(summaryTimer);
  }

  await Promise.allSettled([...pendingRequests]);

  const durationSec = (Date.now() - stats.startedAt) / 1000;
  const summary = summarizeAiRun(stats, mode, apiBase, durationSec);
  console.log(`\n=== AI SOAK SUMMARY (${durationMin}min ${mode}) ===`);
  const rel = summary.reliability;
  console.log(
    `RELIABILITY: 429=${(rel.rate429 * 100).toFixed(1)}%  timeout=${(rel.timeoutRate * 100).toFixed(1)}%  ` +
    `false_reading=${(rel.falseReadingRate * 100).toFixed(1)}%  server_error=${(rel.serverErrorRate * 100).toFixed(1)}%  ` +
    `unreliable=${(rel.unreliableRate * 100).toFixed(1)}%  achieved=${summary.achievedRequestsPerHour.toFixed(0)}/hr`,
  );
  console.log(JSON.stringify(summary, null, 2));

  if (evidencePath) {
    mkdirSync(dirname(evidencePath), { recursive: true }); // NOSONAR S8707 — resolveEvidenceOutputPath confines writes to docs/staging.
    writeFileSync(evidencePath, JSON.stringify(summary, null, 2) + '\n'); // NOSONAR S8707 — resolveEvidenceOutputPath confines writes to docs/staging.
    console.log(`\nEvidence written: ${evidencePath}`);
  }
  return summary;
}

export async function runAiSoakHarnessCli(): Promise<void> {
  const { values: args } = parseArgs({
    options: {
      duration: { type: 'string', default: '15' },
      rate: { type: 'string', default: '5000' },
      endpoints: { type: 'string', default: 'extract,template,tags' },
      'doc-variants': { type: 'string' },
      'timeout-ms': { type: 'string', default: '10000' },
      'no-rotate-ip': { type: 'boolean', default: false },
      'evidence-out': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'allow-undersized-pool': { type: 'boolean', default: false },
    },
  });
  await runAiSoakHarness({
    apiBase: resolveStagingApiBase(process.env),
    identities: parseIdentities(process.env.STAGING_AI_JWTS),
    durationMin: parsePositiveInt(args.duration, 15, 'duration'),
    ratePerHour: parsePositiveInt(args.rate, 5000, 'rate'),
    endpoints: parseEndpoints(args.endpoints ?? 'extract,template,tags'),
    variants: parseDocVariants(args['doc-variants']),
    timeoutMs: parsePositiveInt(args['timeout-ms'], 10_000, 'timeout-ms'),
    rotateIp: !args['no-rotate-ip'],
    evidencePath: args['evidence-out'] ? resolveEvidenceOutputPath(args['evidence-out']) : undefined,
    dryRun: args['dry-run'],
    allowUndersizedPool: args['allow-undersized-pool'],
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAiSoakHarnessCli().catch((err) => {
    console.error(`::error::AI soak harness failed: ${err instanceof Error ? err.message : err}`);
    if (err instanceof Error && err.stack) console.error(err.stack);
    process.exitCode = 1;
  });
}
