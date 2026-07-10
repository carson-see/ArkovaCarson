#!/usr/bin/env -S npx tsx
/**
 * scripts/staging/ai-eval-gate-runner.ts — run the SCRUM-2382 (AI-02) eval gate
 * LIVE and CONTINUOUSLY during an AI T3 soak.
 *
 * Each sampling round drives the 48-entry AI-01 golden GATE split through the
 * LIVE worker `POST /api/v1/ai/extract` endpoint, scores field-level F1 against
 * ground truth using the vendored scorer (behaviour-equivalent to the SCRUM-2382
 * merge gate), and enforces:
 *   - aggregate weighted F1 >= 0.80
 *   - per-field floors: creditHours >= 0.85, issuedDate >= 0.80, credentialType >= 0.80
 *   - 48-entry coverage
 * Fail-closed: a coverage / field / aggregate miss fails the round.
 *
 * It appends one structured record per round (timestamp, gate verdict, weighted
 * F1, per-field precision/recall/F1, sample misclassifications, extraction-error
 * count) to a JSONL evidence file — the rolling proof that F1 held >= 0.80 across
 * the whole 48h window WHILE the load harness drove >= 5k req/hr.
 *
 * ── real-vs-mock (READ THIS) ─────────────────────────────────────────────────
 * The eval is only meaningful if the rig runs REAL Gemini inference. The worker
 * selects the provider by env: GEMINI_API_KEY set → real GeminiProvider; unset →
 * MockAIProvider (deterministic, worthless as an eval). This runner records the
 * server-reported `provider` from each /extract response and REFUSES to certify
 * a round as merge-grade if the provider is `mock`/`fast-fallback` (see
 * --require-live). Set GEMINI_API_KEY (or AI_PROVIDER=gemini + key) on the rig.
 *
 * Auth + rate limits: same as ai-soak-harness (Supabase JWT; 30/min/user). The
 * eval samples 48 entries/round; with a per-user pace under 30/min a single JWT
 * completes one round in ~2 min. Sharding across the STAGING_AI_JWTS pool keeps
 * eval sampling from colliding with the load harness's own rate budget.
 *
 * Env: STAGING_API_BASE (tag-routed rig), STAGING_AI_JWTS (Supabase user JWTs).
 *
 * Usage:
 *   # one round, human-readable, fail-closed exit code (CI smoke / spot check)
 *   STAGING_API_BASE=… STAGING_AI_JWTS=… npx tsx scripts/staging/ai-eval-gate-runner.ts --rounds 1
 *
 *   # continuous 48h: sample every 30 min, append JSONL, require live provider
 *   STAGING_API_BASE=… STAGING_AI_JWTS=… npx tsx scripts/staging/ai-eval-gate-runner.ts \
 *     --duration 2880 --interval 30 --require-live \
 *     --evidence-out docs/staging/ai-eval-pr1413.jsonl
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';

import { resolveStagingApiBase } from './load-harness-env.js';
import {
  callAiEndpoint,
  parseIdentities,
  randomForwardedFor,
  type FetchLike,
  type WorkerIdentity,
} from './ai-eval/ai-client.js';
import { PER_USER_LIMIT_PER_MIN, pickIdentity } from './ai-eval/rate.js';
import { gateGoldenEntries, goldenProvenance } from './ai-eval/golden.js';
import { resolveEvidenceOutputPath } from './ai-eval/evidence-path.js';
import {
  buildExtractPayload,
  fieldsFromExtractResponse,
  scoreEntry,
  buildEvalRecord,
  certifyRound,
  providerFromBody,
  LIVE_PROVIDERS,
  type EvalRecord,
} from './ai-eval/eval-core.js';
import type { EntryEvalResult } from './ai-eval/scoring.js';
import {
  newReliabilityStats,
  recordReliability,
  reliabilityReport,
} from './ai-eval/reliability.js';

const { values: args } = parseArgs({
  options: {
    rounds: { type: 'string' }, // fixed round count (overrides duration)
    duration: { type: 'string', default: '2880' }, // minutes (48h)
    interval: { type: 'string', default: '30' }, // minutes between rounds
    'timeout-ms': { type: 'string', default: '10000' }, // client request deadline
    'evidence-out': { type: 'string' },
    'fingerprint-salt': { type: 'string' },
    'require-live': { type: 'boolean', default: false },
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

const realFetch: FetchLike = fetch as unknown as FetchLike;
const EVAL_PER_USER_HEADROOM = 0.8;

interface RunnerConfig {
  apiBase: string;
  identities: WorkerIdentity[];
  evidencePath?: string;
  requireLive: boolean;
  intervalMin: number;
  timeoutMs: number;
  fingerprintSalt: string;
  fixedRounds?: number;
  endAt: number;
}

interface RunnerSummary {
  rounds: number;
  meritedRounds: number;
  anyFailure: boolean;
}

function evalRequestIntervalMs(identityCount: number): number {
  const aggregatePerMinute = Math.max(1, identityCount) * PER_USER_LIMIT_PER_MIN * EVAL_PER_USER_HEADROOM;
  return Math.ceil(60_000 / aggregatePerMinute);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveRunnerConfig(startedAt: number): RunnerConfig {
  const apiBase = resolveStagingApiBase(process.env);
  const identities = parseIdentities(process.env.STAGING_AI_JWTS);
  const evidencePath = args['evidence-out'] ? resolveEvidenceOutputPath(args['evidence-out']) : undefined;
  const intervalMin = parsePositiveInt(args.interval, 30, 'interval');
  const timeoutMs = parsePositiveInt(args['timeout-ms'], 10_000, 'timeout-ms');
  const fingerprintSalt = args['fingerprint-salt'] ?? process.env.AI_EVAL_FINGERPRINT_SALT ?? '';
  const fixedRounds = args.rounds ? parsePositiveInt(args.rounds, 1, 'rounds') : undefined;
  const durationMin = parsePositiveInt(args.duration, 2880, 'duration');

  return {
    apiBase,
    identities,
    evidencePath,
    requireLive: Boolean(args['require-live']),
    intervalMin,
    timeoutMs,
    fingerprintSalt,
    fixedRounds,
    endAt: startedAt + durationMin * 60_000,
  };
}

function ensureRunnable(config: RunnerConfig): void {
  if (config.identities.length === 0) {
    console.error('::error::STAGING_AI_JWTS is required — /api/v1/ai/extract rejects unauthenticated calls (401).');
    process.exit(1);
  }
}

function shouldRunNextRound(round: number, config: RunnerConfig): boolean {
  if (config.fixedRounds !== undefined) return round < config.fixedRounds;
  return Date.now() < config.endAt;
}

function recordFailureState(record: EvalRecord, merited: boolean, requireLive: boolean): boolean {
  return !record.gate.passed || (requireLive && !merited);
}

function writeRoundEvidence(
  evidencePath: string | undefined,
  round: number,
  merited: boolean,
  notes: string[],
  providersSeen: Set<string>,
  record: EvalRecord,
): void {
  if (!evidencePath) return;
  appendFileSync(evidencePath, JSON.stringify({ round, merited, notes, providersSeen: [...providersSeen], ...record }) + '\n'); // NOSONAR S8707 — resolveEvidenceOutputPath confines writes to docs/staging.
}

async function sleepUntilNextRound(config: RunnerConfig): Promise<void> {
  if (config.fixedRounds !== undefined) return;
  const sleepMs = Math.min(config.intervalMin * 60_000, Math.max(0, config.endAt - Date.now()));
  if (sleepMs > 0) await sleep(sleepMs);
}

/**
 * Sample the full 48-entry gate split through the LIVE /extract endpoint and
 * build one eval record. `providersSeen` reflects what the server actually ran.
 */
async function runRound(
  apiBase: string,
  identities: WorkerIdentity[],
  timeoutMs: number,
  fingerprintSalt: string,
): Promise<{ record: EvalRecord; providersSeen: Set<string> }> {
  const entries = gateGoldenEntries();
  const scored: EntryEvalResult[] = [];
  const providersSeen = new Set<string>();
  const reliability = newReliabilityStats();
  const requestIntervalMs = evalRequestIntervalMs(identities.length);

  let i = 0;
  for (const entry of entries) {
    const identity = pickIdentity(identities, i++);
    const outcome = await callAiEndpoint(
      apiBase,
      'extract',
      buildExtractPayload(entry, fingerprintSalt),
      identity,
      realFetch,
      { timeoutMs, forwardedFor: randomForwardedFor() },
    );
    providersSeen.add(providerFromBody(outcome.body));
    const klass = recordReliability(reliability, outcome);
    const falseReading = klass === 'false_reading';
    if (outcome.ok && klass !== 'false_reading') {
      // A clean 2xx from a real provider — score it against ground truth.
      scored.push(scoreEntry(entry, fieldsFromExtractResponse(outcome.body)));
    } else if (falseReading) {
      // A degraded/fast-fallback 2xx: score its (degraded) fields so its poor F1
      // shows up, AND flag it as a false reading for the reliability tally.
      scored.push(scoreEntry(entry, fieldsFromExtractResponse(outcome.body), 'false_reading (degraded/fast-fallback)', true));
    } else {
      // 429 / 5xx / timeout / transport — no fields; visible as an extraction error.
      const reason = outcome.transportError ?? `HTTP ${outcome.status}`;
      scored.push(scoreEntry(entry, {}, reason));
    }
    if (i < entries.length) await sleep(requestIntervalMs);
  }

  const dominantProvider = [...providersSeen].find((p) => LIVE_PROVIDERS.has(p)) ?? [...providersSeen][0] ?? 'unknown';
  const record = buildEvalRecord({
    sampledAt: new Date().toISOString(),
    apiBase,
    provider: dominantProvider,
    scored,
    reliability: reliabilityReport(reliability),
  });
  return { record, providersSeen };
}

function summarizeRoundLine(round: number, record: EvalRecord, merited: boolean): string {
  const g = record.gate;
  const fields = Object.entries(record.perField)
    .map(([f, m]) => `${f}=${m.f1.toFixed(3)}${m.passed ? '' : '✗'}`)
    .join(' ');
  const rel = record.reliability;
  const relStr = rel
    ? ` 429=${(rel.rate429 * 100).toFixed(0)}% timeout=${(rel.timeoutRate * 100).toFixed(0)}% false=${(rel.falseReadingRate * 100).toFixed(0)}%`
    : '';
  return (
    `[round ${round}] provider=${record.provider} gate=${g.passed ? 'PASS' : 'FAIL'}(${g.reason}) ` +
    `weightedF1=${g.weightedF1.toFixed(4)} entries=${g.matchingEntries}/${g.minimumEntries} ` +
    `fields[${fields}] errors=${record.extractionErrorCount} falseReadings=${record.falseReadingCount}${relStr} merit=${merited ? 'YES' : 'NO'}`
  );
}

async function runEvalRounds(config: RunnerConfig): Promise<RunnerSummary> {
  let round = 0;
  let anyFailure = false;
  let meritedRounds = 0;

  while (shouldRunNextRound(round, config)) {
    round++;
    const { record, providersSeen } = await runRound(
      config.apiBase,
      config.identities,
      config.timeoutMs,
      config.fingerprintSalt,
    );
    const { merited, notes } = certifyRound(record, providersSeen, config.requireLive);
    if (merited) meritedRounds++;
    if (recordFailureState(record, merited, config.requireLive)) anyFailure = true;

    console.log(summarizeRoundLine(round, record, merited));
    for (const note of notes) console.log(`    note: ${note}`);

    writeRoundEvidence(config.evidencePath, round, merited, notes, providersSeen, record);

    if (!shouldRunNextRound(round, config)) break;
    await sleepUntilNextRound(config);
  }

  return { rounds: round, meritedRounds, anyFailure };
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const config = resolveRunnerConfig(startedAt);
  const prov = goldenProvenance();
  console.log(`▶ ai-eval-gate-runner (SCRUM-2382) at ${new Date().toISOString()}`);
  console.log(`  api_base=${config.apiBase}`);
  console.log(`  golden=${prov.gateEntries} gate + ${prov.heldOutEntries} held-out (source ${prov.sourceRef} @ ${prov.sourceCommit.slice(0, 8)})`);
  console.log(`  identities=${config.identities.length}  require_live=${config.requireLive}  interval=${config.intervalMin}min  client_timeout=${config.timeoutMs}ms`);
  console.log(`  fingerprint_salt=${config.fingerprintSalt ? '<set>' : '<empty>'}  x_forwarded_for_rotation=true`);

  ensureRunnable(config);
  if (args['dry-run']) {
    console.log('  --dry-run: config validated; exiting without sampling.');
    return;
  }

  if (config.evidencePath) mkdirSync(dirname(config.evidencePath), { recursive: true }); // NOSONAR S8707 — resolveEvidenceOutputPath confines writes to docs/staging.

  const { rounds, meritedRounds, anyFailure } = await runEvalRounds(config);

  console.log(`\n=== EVAL-GATE SUMMARY ===`);
  console.log(`  rounds=${rounds}  merited=${meritedRounds}  any_gate_failure=${anyFailure}`);
  if (config.evidencePath) console.log(`  evidence (JSONL) → ${config.evidencePath}`);

  // Fail-closed exit: non-zero if any round failed the gate, so CI / the soak
  // operator treats a mid-soak F1 regression as a hard block.
  process.exit(anyFailure ? 1 : 0);
}

main().catch((err) => {
  console.error(`::error::AI eval-gate runner failed: ${err instanceof Error ? err.message : err}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
