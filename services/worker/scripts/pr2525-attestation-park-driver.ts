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
  + '(well-formed id) / 400 (malformed id) from middleware mounted ahead of '
  + 'apiKeyAuth and usageTracking, never 5xx, and never asserts a corpus lookup';

const WELL_FORMED = 'ARK-ATT-SOAK000000';
const MALFORMED = 'INVALID!!!';

export interface Probe { status: number; body: string; }

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

/** Pure classifier — the whole verdict, so it is testable without a network. */
export function classify(wellFormed: Probe, malformed: Probe): {
  status: 'pass' | 'fail';
  counts: Record<string, number | boolean>;
  blockers: string[];
} {
  const blockers: string[] = [];

  const wfInfra = isInfraAbort(wellFormed);
  const mfInfra = isInfraAbort(malformed);
  const notFoundLeak = wellFormed.body.toLowerCase().includes('not found');
  // Only APPLICATION 5xx counts. An infra abort is capacity, not behavior.
  const anyFivexx = (wellFormed.status >= 500 && !wfInfra) || (malformed.status >= 500 && !mfInfra);

  if (!wfInfra && wellFormed.status !== 404) blockers.push(`well-formed id returned ${wellFormed.status}, expected 404`);
  if (!mfInfra && malformed.status !== 400) blockers.push(`malformed id returned ${malformed.status}, expected 400`);
  if (anyFivexx) blockers.push('endpoint answered an APPLICATION 5xx — this pages the on-call CRITICAL');
  if (notFoundLeak) blockers.push('404 body still claims "not found" — implies a corpus lookup');
  if (!malformed.body.includes('ARK-ATT')) blockers.push('400 body lost the ARK-ATT routing hint');

  return {
    status: blockers.length === 0 ? 'pass' : 'fail',
    counts: {
      wellFormedStatus: wellFormed.status,
      malformedStatus: malformed.status,
      anyFivexx,
      infraAborts: (wfInfra ? 1 : 0) + (mfInfra ? 1 : 0),
      notFoundLeak,
      routingHintPresent: !mfInfra && malformed.body.includes('ARK-ATT'),
    },
    blockers,
  };
}

async function probe(base: string, id: string, token?: string): Promise<Probe> {
  const res = await fetch(`${base}/api/v1/verify/attestation/${id}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, body: await res.text().catch(() => '') };
}

export async function runLive(args: Required<Pick<DriverArgs, 'targetUrl'>> & DriverArgs): Promise<DriverRow> {
  const base = args.targetUrl.replace(/\/$/, '');
  const burst = args.burst ?? 8;

  // Burst first: concurrency is where a 5xx regression would surface.
  const bursts = await Promise.all(
    Array.from({ length: burst }, (_, i) => probe(base, `${WELL_FORMED}${i}`, args.bearerToken)),
  );
  const wellFormed = bursts[0];
  const malformed = await probe(base, MALFORMED, args.bearerToken);

  const verdict = classify(wellFormed, malformed);
  const burstInfra = bursts.filter(isInfraAbort).length;
  const burst5xx = bursts.filter((b) => b.status >= 500 && !isInfraAbort(b)).length;
  if (burst5xx > 0) {
    verdict.blockers.push(`${burst5xx}/${burst} burst requests answered an APPLICATION 5xx`);
    verdict.status = 'fail';
  }
  // A burst that was ENTIRELY refused carries no signal about the endpoint.
  // Say so rather than recording a silent pass over zero observations.
  if (burstInfra === bursts.length) {
    verdict.blockers.push(`all ${burst} burst requests were refused by Cloud Run (no available instance) — cycle observed nothing`);
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
      burstObserved: bursts.length - burstInfra,
      burstAll404: bursts.filter((b) => !isInfraAbort(b)).every((b) => b.status === 404),
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
    const ok = classify({ status: 404, body: '{"verified":false,"error":"…not implemented…"}' },
                        { status: 400, body: '{"error":"Invalid attestation ID format — expected ARK-ATT-* prefix"}' });
    const bad = classify({ status: 501, body: '{"error":"Attestation not found"}' },
                         { status: 501, body: '{}' });
    // An infra abort must NOT be scored as the application regression.
    const infra = classify({ status: 500, body: 'The request was aborted because there was no available instance.' },
                           { status: 400, body: 'expected ARK-ATT-* prefix' });
    const row: DriverRow = {
      utc: new Date().toISOString(), pr: 2525, tier: 'T2', mode: 'self-test',
      evidenceForSoak: false, changedBehavior: CHANGED_BEHAVIOR,
      status: ok.status === 'pass' && bad.status === 'fail' && infra.counts.anyFivexx === false ? 'pass' : 'fail',
      counts: {
        classifierAcceptsCorrect: ok.status === 'pass',
        classifierRejectsRegression: bad.status === 'fail',
        classifierIgnoresInfraAbort: infra.counts.anyFivexx === false && infra.counts.infraAborts === 1,
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
