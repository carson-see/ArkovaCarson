#!/usr/bin/env tsx
/**
 * PR #2525 attestation-park admission driver.
 *
 * Drives the ONE behavior this PR changes: `GET /api/v1/verify/attestation/:id`
 * is parked upstream of auth/quota by `middleware/parkedAttestationVerify.ts`.
 *
 * What merge-grade evidence has to show, and why each check exists:
 *   1. A well-formed `ARK-ATT-*` id answers 404 — the published status is
 *      unchanged — and the body no longer says "not found", which asserted a
 *      corpus that cannot exist.
 *   2. A malformed id still answers 400 carrying the `ARK-ATT` routing hint.
 *      That path fires before any table read, so it was always reachable with
 *      an empty table; changing it would have been a §1.8 break.
 *   3. NOTHING ever answers 5xx. `PAGE — arkova-worker 5xx burst` is an enabled
 *      CRITICAL policy at >5 per 300s with no path dimension to exclude on, so
 *      a 5xx here pages the on-call for a route that cannot succeed. This is
 *      the regression the review caught; it is pinned under load, not just at
 *      one request.
 *   4. Concurrency: the checks above hold under a burst, so the evidence is not
 *      a single-request anecdote (feedback_soak_evidence_standard).
 *   5. The response still carries `X-RateLimit-*`. The park is on a PUBLIC
 *      endpoint; mounted above the rate limiters it answers with the right
 *      status and body while silently off its §1.10 budget, and no status-code
 *      check can see that. Observing the header is how the soak covers the
 *      middleware POSITION rather than only its output.
 *
 * Self-test mode is local validation only: rows are `evidenceForSoak=false` and
 * must never be cited as soak evidence.
 */

import { appendFileSync } from 'node:fs';

export interface DriverArgs {
  mode: 'self-test' | 'live';
  targetUrl?: string;
  evidenceJsonl?: string;
  bearerToken?: string;
  burst?: number;
}

export interface DriverRow {
  utc: string;
  pr: 2525;
  tier: 'T2';
  mode: 'self-test' | 'live';
  evidenceForSoak: boolean;
  changedBehavior: string;
  status: 'pass' | 'fail';
  counts: Record<string, number | boolean>;
  targetUrl?: string;
  blockers?: string[];
}

export const CHANGED_BEHAVIOR =
  'PR #2525 attestation park: GET /api/v1/verify/attestation/:id answers 404 '
  + '(well-formed id) / 400 (malformed id) from middleware mounted BELOW the '
  + 'rate limiters (§1.10 headers retained) and ABOVE usageTracking (no quota '
  + 'charged), never 5xx, and never asserts a corpus lookup';

const WELL_FORMED = 'ARK-ATT-SOAK000000';
const MALFORMED = 'INVALID!!!';

export interface Probe {
  status: number;
  body: string;
  /**
   * Did the response carry `X-RateLimit-Limit`? §1.10 requires the headers on
   * every response, and the park sits on a PUBLIC endpoint: mounted above the
   * rate limiters it answers correctly while silently off its budget, which no
   * status-code check can see. Captured so a live soak observes the middleware
   * POSITION, not just its body.
   */
  rateLimited: boolean;
}

/**
 * Cloud Run rejects a request with 500 and this body when it cannot place it on
 * an instance — the container never sees the request. On a rig at
 * min-instances=0 a concurrent burst reliably triggers it, and counting it as an
 * application 5xx makes the evidence wrong in BOTH directions: it fails a
 * correct build, and it would mask a real application 5xx behind infra noise.
 * Classified separately and reported, never silently dropped.
 */
export function isInfraAbort(p: Probe): boolean {
  return p.status >= 500 && /no available instance|The request was aborted/i.test(p.body);
}

/**
 * Did the APPLICATION answer this probe? Only then does its status/body say
 * anything about the behaviour under test. Two ways it did not:
 *   - `isInfraAbort` — Cloud Run refused the request at the edge (capacity).
 *   - `status === 0`  — `probe()` never got an HTTP response at all (transport).
 * Both used to be scored as application regressions, in one guard or another;
 * folding them into a single predicate is why the guards below cannot drift
 * apart again.
 */
export function isObserved(p: Probe): boolean {
  return !isInfraAbort(p) && p.status !== 0;
}

/** Pure classifier — the whole verdict, so it is testable without a network. */
export function classify(wellFormed: Probe, malformed: Probe): {
  status: 'pass' | 'fail';
  counts: Record<string, number | boolean>;
  blockers: string[];
} {
  const blockers: string[] = [];

  const wfSeen = isObserved(wellFormed);
  const mfSeen = isObserved(malformed);
  const notFoundLeak = wfSeen && wellFormed.body.toLowerCase().includes('not found');
  const routingHintPresent = mfSeen && malformed.body.includes('ARK-ATT');
  // Only APPLICATION 5xx counts. An infra abort is capacity, not behavior.
  const anyFivexx = (wfSeen && wellFormed.status >= 500) || (mfSeen && malformed.status >= 500);

  // Name a transport failure explicitly: an operator reading the JSONL should
  // see "the rig was unreachable", not diagnose a phantom application
  // regression from "expected 404, got 0".
  if (wellFormed.status === 0 || malformed.status === 0) {
    blockers.push('rig unreachable — transport failure before any HTTP response');
  }

  if (wfSeen && wellFormed.status !== 404) blockers.push(`well-formed id returned ${wellFormed.status}, expected 404`);
  if (mfSeen && malformed.status !== 400) blockers.push(`malformed id returned ${malformed.status}, expected 400`);
  if (anyFivexx) blockers.push('endpoint answered an APPLICATION 5xx — this pages the on-call CRITICAL');
  if (notFoundLeak) blockers.push('404 body still claims "not found" — implies a corpus lookup');
  if (mfSeen && !routingHintPresent) blockers.push('400 body lost the ARK-ATT routing hint');
  for (const [label, p] of [['well-formed', wellFormed], ['malformed', malformed]] as const) {
    if (isObserved(p) && !p.rateLimited) {
      blockers.push(`${label} response carried no X-RateLimit-* headers — the park is mounted above the rate limiters (§1.10)`);
    }
  }

  return {
    status: blockers.length === 0 ? 'pass' : 'fail',
    counts: {
      wellFormedStatus: wellFormed.status,
      malformedStatus: malformed.status,
      anyFivexx,
      infraAborts: (isInfraAbort(wellFormed) ? 1 : 0) + (isInfraAbort(malformed) ? 1 : 0),
      notFoundLeak,
      routingHintPresent,
      rateLimitHeadersPresent: (!wfSeen || wellFormed.rateLimited) && (!mfSeen || malformed.rateLimited),
    },
    blockers,
  };
}

/** Default burst width. */
export const DEFAULT_BURST = 8;

/**
 * `--burst` arrives via `Number(...)`, so a typo yields NaN and `--burst 0`
 * yields an empty burst — both produce `bursts[0] === undefined` and a
 * TypeError inside `classify`, i.e. a crashed cycle with no row, not a fail.
 */
export function resolveBurst(n: number | undefined): number {
  return Number.isInteger(n) && (n as number) >= 1 ? (n as number) : DEFAULT_BURST;
}

/**
 * A transport failure (DNS, connection refused, TLS) is a FAILED cycle, not an
 * absent one. Left to throw it escapes `Promise.all`, aborts `main()` before
 * the JSONL append, and a 12h loop against a dead rig silently records no rows
 * at all — which reads back as uninterrupted health. Surfaced as status 0,
 * which is neither a 2xx/4xx contract match nor an infra abort, so it lands as
 * a blocker.
 */
export async function probe(base: string, id: string, token?: string): Promise<Probe> {
  try {
    const res = await fetch(`${base}/api/v1/verify/attestation/${id}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    return {
      status: res.status,
      body: await res.text().catch(() => ''),
      rateLimited: res.headers.get('x-ratelimit-limit') !== null,
    };
  } catch (err) {
    return {
      status: 0,
      body: `transport failure — rig unreachable: ${(err as Error).message}`,
      rateLimited: false,
    };
  }
}

export async function runLive(args: Required<Pick<DriverArgs, 'targetUrl'>> & DriverArgs): Promise<DriverRow> {
  const base = args.targetUrl.replace(/\/$/, '');
  const burst = resolveBurst(args.burst);

  // Burst first: concurrency is where a 5xx regression would surface.
  const bursts = await Promise.all(
    Array.from({ length: burst }, (_, i) => probe(base, `${WELL_FORMED}${i}`, args.bearerToken)),
  );
  // Classify against the first OBSERVED probe, not whichever happened to be
  // first. If bursts[0] is an infra abort, every well-formed check in
  // `classify` short-circuits on `wfInfra` and the cycle records a pass having
  // verified nothing — even when the other seven probes were real. Falling
  // back to bursts[0] keeps the all-refused case, which the blocker below
  // fails explicitly.
  const wellFormed = bursts.find(isObserved) ?? bursts[0];
  const malformed = await probe(base, MALFORMED, args.bearerToken);

  const verdict = classify(wellFormed, malformed);
  const burstInfra = bursts.filter(isInfraAbort).length;
  const burstObserved = bursts.filter(isObserved).length;
  const burst5xx = bursts.filter((b) => isObserved(b) && b.status >= 500).length;
  if (burst5xx > 0) {
    verdict.blockers.push(`${burst5xx}/${burst} burst requests answered an APPLICATION 5xx`);
    verdict.status = 'fail';
  }
  // A burst the application never answered carries no signal about the
  // endpoint — whether it was refused at the edge or never connected at all.
  // Say so rather than recording a silent pass over zero observations.
  if (burstObserved === 0) {
    verdict.blockers.push(`all ${burst} burst requests went unanswered by the application (${burstInfra} refused by Cloud Run) — cycle observed nothing`);
    verdict.status = 'fail';
  }

  return {
    utc: new Date().toISOString(),
    pr: 2525,
    tier: 'T2',
    mode: 'live',
    evidenceForSoak: true,
    changedBehavior: CHANGED_BEHAVIOR,
    status: verdict.status,
    counts: {
      ...verdict.counts,
      burstSize: burst,
      burst5xx,
      burstInfraAborts: burstInfra,
      burstObserved,
      burstAll404: bursts.filter(isObserved).every((b) => b.status === 404),
    },
    targetUrl: base,
    blockers: verdict.blockers,
  };
}

function parseArgs(argv: string[]): DriverArgs {
  const get = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  return {
    mode: argv.includes('--live') ? 'live' : 'self-test',
    targetUrl: get('--target-url'),
    evidenceJsonl: get('--evidence-jsonl'),
    bearerToken: get('--bearer-token') ?? process.env.SOAK_BEARER_TOKEN,
    burst: get('--burst') ? Number(get('--burst')) : undefined,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.mode === 'self-test') {
    const ok = classify({ status: 404, body: '{"verified":false,"error":"…not implemented…"}', rateLimited: true },
                        { status: 400, body: '{"error":"Invalid attestation ID format — expected ARK-ATT-* prefix"}', rateLimited: true });
    const bad = classify({ status: 501, body: '{"error":"Attestation not found"}', rateLimited: true },
                         { status: 501, body: '{}', rateLimited: true });
    // An infra abort must NOT be scored as the application regression.
    const infra = classify({ status: 500, body: 'The request was aborted because there was no available instance.', rateLimited: false },
                           { status: 400, body: 'expected ARK-ATT-* prefix', rateLimited: true });
    // A correct body from a route that lost its §1.10 headers must still fail.
    const unlimited = classify({ status: 404, body: '{"verified":false,"error":"…not implemented…"}', rateLimited: false },
                               { status: 400, body: 'expected ARK-ATT-* prefix', rateLimited: true });
    const row: DriverRow = {
      utc: new Date().toISOString(), pr: 2525, tier: 'T2', mode: 'self-test',
      evidenceForSoak: false, changedBehavior: CHANGED_BEHAVIOR,
      status:
        ok.status === 'pass' && bad.status === 'fail'
        && infra.counts.anyFivexx === false && unlimited.status === 'fail'
          ? 'pass' : 'fail',
      counts: {
        classifierAcceptsCorrect: ok.status === 'pass',
        classifierRejectsRegression: bad.status === 'fail',
        classifierIgnoresInfraAbort: infra.counts.anyFivexx === false && infra.counts.infraAborts === 1,
        classifierRejectsMissingRateLimitHeaders: unlimited.status === 'fail',
      },
    };
    console.log(JSON.stringify(row));
    process.exit(row.status === 'pass' ? 0 : 1);
  }

  if (!args.targetUrl) { console.error('ERROR: --live requires --target-url'); process.exit(2); }
  const row = await runLive({ ...args, targetUrl: args.targetUrl });
  const line = JSON.stringify(row);
  console.log(line);
  if (args.evidenceJsonl) appendFileSync(args.evidenceJsonl, line + '\n');
  process.exit(row.status === 'pass' ? 0 : 1);
}

if (process.argv[1] && process.argv[1].endsWith('pr2525-attestation-park-driver.ts')) {
  void main();
}
