#!/usr/bin/env tsx
/**
 * PR #2461 server-side PII redaction admission driver.
 *
 * The behaviour under soak is the quadratic `EMAIL_PATTERN` fix in the two
 * server-side redaction paths:
 *   - `ctdl/ctdl-pii-guard.ts` `containsHighConfidencePii`, reached by the public
 *     CTDL projection `GET /api/v1/credentials/:publicId/ctdl`.
 *   - `compliance/professional-education.ts` `stripProfessionalEducationPii`,
 *     reached by `POST /cron/professional-education-extraction` when it builds
 *     the CPE/CLE extraction prompt.
 *
 * Live mode drives BOTH deployed endpoints and records latency plus a
 * leak assertion on the CTDL body. `behaviour` checks additionally exercise the
 * redaction units in-process at the same committed head the image was built
 * from, so a cycle proves both "the deployed route is bounded" and "the
 * redaction invariant holds".
 *
 * Self-test mode is local validation only; rows are marked evidenceForSoak=false
 * and must not be used as soak evidence.
 */

import { appendFileSync } from 'node:fs';
import { containsHighConfidencePii } from '../src/ctdl/ctdl-pii-guard.js';
import { stripProfessionalEducationPii } from '../src/compliance/professional-education.js';

export interface DriverArgs {
  mode: 'self-test' | 'live';
  targetUrl?: string;
  admissionJson?: string;
  evidenceJsonl?: string;
  cronSecret?: string;
  bearerToken?: string;
  publicIds?: string[];
}

export interface DriverRow {
  utc: string;
  pr: 2461;
  tier: 'T2';
  mode: 'self-test' | 'live';
  evidenceForSoak: boolean;
  changedBehavior: string;
  status: 'pass' | 'fail';
  counts: Record<string, number | boolean>;
  targetUrl?: string;
  blockers?: string[];
}

const CHANGED_BEHAVIOR =
  'PR #2461 server-side EMAIL_PATTERN: bounded local-part (RFC 5321 64 octets) in the CTDL PII gate and an @-anchored linear scan in professional-education redaction, replacing a quadratic unanchored pattern (Sonar typescript:S8786)';

/** The pattern this PR replaced, used as the differential oracle. */
const LEGACY_EMAIL_PATTERN = () => /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

/** Adversarial shapes: dotted runs defeat the old pattern's leading `\b`. */
const REDOS_INPUTS: Array<[string, string]> = [
  ['dotted-local-part-40k', `${'a.'.repeat(40_000)}!`],
  ['ambiguous-dotted-domain-45k', `x@${'a.'.repeat(45_000)}1`],
  ['dashed-local-part-40k', `${'a-'.repeat(40_000)}!`],
  ['at-dense-40k', '@a.co'.repeat(40_000)],
];

const countChar = (value: string, char: string): number => {
  let n = 0;
  for (const c of value) if (c === char) n += 1;
  return n;
};

/**
 * True when an '@' the legacy pattern covered survives redaction. Every real
 * under-redaction leaves the address's '@' in the clear, so counting them is
 * exact for the direction that matters. Excess local-part beyond 64 octets is
 * allowed to survive (the one disclosed divergence) and carries no '@'.
 */
const leaksAddress = (value: string): boolean => {
  let covered = 0;
  for (const m of value.matchAll(LEGACY_EMAIL_PATTERN())) covered += countChar(m[0], '@');
  const stripped = stripProfessionalEducationPii(value) as string;
  return countChar(stripped, '@') > countChar(value, '@') - covered;
};

/** In-process invariants for the changed units. Returns countable results. */
export function runBehaviourChecks(): { counts: Record<string, number | boolean>; failures: string[] } {
  const failures: string[] = [];
  let worstRedactMs = 0;
  let worstDetectMs = 0;

  for (const [name, input] of REDOS_INPUTS) {
    const t0 = performance.now();
    stripProfessionalEducationPii(input);
    const redactMs = performance.now() - t0;
    worstRedactMs = Math.max(worstRedactMs, redactMs);
    if (redactMs > 2000) failures.push(`redact:${name}:${redactMs.toFixed(0)}ms`);

    const t1 = performance.now();
    containsHighConfidencePii(input);
    const detectMs = performance.now() - t1;
    worstDetectMs = Math.max(worstDetectMs, detectMs);
    if (detectMs > 2000) failures.push(`detect:${name}:${detectMs.toFixed(0)}ms`);
  }

  // Redaction correctness, including the >64 local-part case the old pattern
  // silently dropped on the fail-closed gate.
  let leaks = 0;
  const corpus = [
    'contact jane.doe@example.com or bob@mail.example.org.',
    `${'x'.repeat(80)}@mail.example.com`,
    `${'x'.repeat(300)}@mail.example.com`,
    `mail user@${'a'.repeat(400)}.example.com end`,
    '.@0zaZ00..AA@AA99Aaa90.aAA0AaAA.9aa.0.aZA',
  ];
  for (const input of corpus) if (leaksAddress(input)) leaks += 1;
  if (leaks > 0) failures.push(`under-redaction:${leaks}`);

  let detected = 0;
  for (const len of [64, 65, 80, 300, 3000]) {
    if (containsHighConfidencePii(`${'x'.repeat(len)}@mail.example.com`)) detected += 1;
  }
  if (detected !== 5) failures.push(`detection-miss:${5 - detected}`);

  return {
    counts: {
      redosShapes: REDOS_INPUTS.length,
      worstRedactMs: Number(worstRedactMs.toFixed(2)),
      worstDetectMs: Number(worstDetectMs.toFixed(2)),
      corpusChecked: corpus.length,
      underRedactions: leaks,
      longLocalPartDetected: detected,
    },
    failures,
  };
}

function parseArgs(argv: string[]): DriverArgs {
  const args: DriverArgs = { mode: 'self-test' };
  for (let i = 0; i < argv.length; i += 1) {
    const next = argv[i + 1];
    switch (argv[i]) {
      case '--mode': args.mode = next === 'live' ? 'live' : 'self-test'; i += 1; break;
      case '--target-url': args.targetUrl = next; i += 1; break;
      case '--admission-json': args.admissionJson = next; i += 1; break;
      case '--evidence-jsonl': args.evidenceJsonl = next; i += 1; break;
      case '--cron-secret': args.cronSecret = next; i += 1; break;
      case '--bearer-token': args.bearerToken = next; i += 1; break;
      case '--public-ids': args.publicIds = (next ?? '').split(',').filter(Boolean); i += 1; break;
      default: break;
    }
  }
  return args;
}

export async function runLive(args: DriverArgs): Promise<DriverRow> {
  const blockers: string[] = [];
  if (!args.targetUrl) blockers.push('missing --target-url');
  if (!args.evidenceJsonl) blockers.push('missing --evidence-jsonl');
  if (!args.cronSecret && !args.bearerToken) blockers.push('missing --cron-secret or --bearer-token');
  if (blockers.length > 0) {
    return {
      utc: new Date().toISOString(), pr: 2461, tier: 'T2', mode: 'live',
      evidenceForSoak: false, changedBehavior: CHANGED_BEHAVIOR, status: 'fail', counts: {}, blockers,
    };
  }

  const targetUrl = args.targetUrl!.replace(/\/+$/, '');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (args.bearerToken) headers.authorization = `Bearer ${args.bearerToken}`;
  const cronHeaders = { ...headers, ...(args.cronSecret ? { 'x-cron-secret': args.cronSecret } : {}) };

  const failures: string[] = [];

  // 1. Worker alive.
  const healthStart = performance.now();
  const health = await fetch(`${targetUrl}/health`, { headers });
  const healthMs = performance.now() - healthStart;
  if (!health.ok) failures.push(`health:${health.status}`);

  // 2. professional-education extraction drain -> stripProfessionalEducationPii.
  const peStart = performance.now();
  const pe = await fetch(`${targetUrl}/jobs/professional-education-extraction`, {
    method: 'POST', headers: cronHeaders,
  });
  const peMs = performance.now() - peStart;
  if (!pe.ok) failures.push(`prof-ed:${pe.status}`);
  if (peMs > 30_000) failures.push(`prof-ed-stall:${peMs.toFixed(0)}ms`);

  // 3. CTDL projection -> containsHighConfidencePii.
  //
  // Per-fixture expectations, and the LONGLP row is the one that matters: its
  // address has a >64-octet local part, which the OLD pattern did not detect, so
  // pre-fix its description PUBLISHES the address. Post-fix the gate suppresses
  // it. That makes this a direct deployed-side discriminator for the correctness
  // half of the change, not just a smoke check.
  //
  // REDOS carries no address and MUST still publish -- it pins that the gate
  // discriminates rather than blanket-suppressing, which would look identical in
  // a leak-only assertion.
  const EXPECT_SUPPRESSED = new Set(['ARK-SOAK-2461-PII', 'ARK-SOAK-2461-LONGLP']);
  const EXPECT_PUBLISHED = new Set(['ARK-SOAK-2461-REDOS']);

  let ctdlChecked = 0;
  let ctdlLeaks = 0;
  let ctdlSuppressionOk = 0;
  let ctdlPrecisionOk = 0;
  let worstCtdlMs = 0;
  for (const publicId of args.publicIds ?? []) {
    const t0 = performance.now();
    const res = await fetch(`${targetUrl}/api/v1/credentials/${encodeURIComponent(publicId)}/ctdl`, { headers });
    const ms = performance.now() - t0;
    worstCtdlMs = Math.max(worstCtdlMs, ms);
    ctdlChecked += 1;
    if (ms > 5000) failures.push(`ctdl-stall:${publicId}:${ms.toFixed(0)}ms`);

    if (res.ok) {
      const text = await res.text();
      if (LEGACY_EMAIL_PATTERN().test(text)) { ctdlLeaks += 1; failures.push(`ctdl-leak:${publicId}`); }

      let description: unknown;
      try { description = (JSON.parse(text) as Record<string, unknown>)['ceterms:description']; } catch { /* non-JSON body */ }

      if (EXPECT_SUPPRESSED.has(publicId)) {
        if (description === undefined || description === null) ctdlSuppressionOk += 1;
        else failures.push(`ctdl-not-suppressed:${publicId}`);
      }
      if (EXPECT_PUBLISHED.has(publicId)) {
        if (typeof description === 'string' && description.length > 0) ctdlPrecisionOk += 1;
        else failures.push(`ctdl-over-suppressed:${publicId}`);
      }
    } else if (res.status === 404 || res.status === 403) {
      // Fail-closed is an acceptable outcome for a PII-bearing row.
      if (EXPECT_SUPPRESSED.has(publicId)) ctdlSuppressionOk += 1;
      else failures.push(`ctdl:${publicId}:${res.status}`);
    } else {
      failures.push(`ctdl:${publicId}:${res.status}`);
    }
  }

  const behaviour = runBehaviourChecks();
  failures.push(...behaviour.failures);

  const status = failures.length === 0 ? 'pass' : 'fail';
  return {
    utc: new Date().toISOString(), pr: 2461, tier: 'T2', mode: 'live',
    evidenceForSoak: status === 'pass',
    changedBehavior: CHANGED_BEHAVIOR,
    status, targetUrl,
    counts: {
      healthOk: health.ok, healthMs: Number(healthMs.toFixed(1)),
      profEdOk: pe.ok, profEdMs: Number(peMs.toFixed(1)),
      ctdlChecked, ctdlLeaks, ctdlSuppressionOk, ctdlPrecisionOk,
      worstCtdlMs: Number(worstCtdlMs.toFixed(1)),
      ...behaviour.counts,
    },
    ...(failures.length > 0 ? { blockers: failures } : {}),
  };
}

export function runSelfTest(): DriverRow {
  const behaviour = runBehaviourChecks();
  return {
    utc: new Date().toISOString(), pr: 2461, tier: 'T2', mode: 'self-test',
    evidenceForSoak: false,
    changedBehavior: CHANGED_BEHAVIOR,
    status: behaviour.failures.length === 0 ? 'pass' : 'fail',
    counts: behaviour.counts,
    ...(behaviour.failures.length > 0 ? { blockers: behaviour.failures } : {}),
  };
}

export async function runDriver(args: DriverArgs): Promise<DriverRow> {
  return args.mode === 'live' ? runLive(args) : runSelfTest();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const row = await runDriver(args);
  const line = `${JSON.stringify(row)}\n`;
  if (args.evidenceJsonl) appendFileSync(args.evidenceJsonl, line);
  process.stdout.write(line);
  if (row.status !== 'pass') process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
