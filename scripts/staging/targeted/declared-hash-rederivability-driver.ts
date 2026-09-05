#!/usr/bin/env -S npx tsx
/**
 * scripts/staging/targeted/declared-hash-rederivability-driver.ts  (PR #2499)
 *
 * TARGETED soak driver for the §1.5 / R-7 honesty gate on
 * `fingerprint_rederivability`. #2499 stops a merely connector-SOURCED anchor
 * from claiming Arkova MEASURED its fingerprint at fetch time; only an anchor
 * with proof that a server-side fetch happened (`metadata.connector_artifact_id`,
 * written solely by connector-artifact-drain) may carry the claim.
 *
 * The soak drives a CONTROLLED PAIR. Both rows carry
 * `metadata.connector_source='docusign'`; only the control row carries
 * `connector_artifact_id`. That isolates the changed predicate and nothing else:
 *
 *   declared-hash  ARK-P2499-DECLARED  connector_source, NO artifact id
 *                  -> fingerprint_rederivability MUST BE ABSENT      (the fix)
 *   measured       ARK-P2499-MEASURED  connector_source AND artifact id
 *                  -> fingerprint_rederivability MUST BE PRESENT     (control)
 *
 * Why the control is not optional: every assertion for the declared row is that
 * a field is ABSENT, and absence passes trivially against a 404, an error body,
 * or an unseeded rig. The `measured` row proves the emitter still works, so a
 * build that suppressed the claim for EVERYTHING cannot pass this driver.
 *
 * Proven failable: run against a pre-#2499 build and `declared-hash` answers
 * 200 with `fingerprint_rederivability: "fetch_time_snapshot"` and a note
 * beginning "Measured: ...". That is the assertion this driver exists to make.
 *
 * The `cached-declared` label re-requests the declared row inside the verify
 * cache TTL. That covers the review finding this PR shipped for: without the
 * `verify:v6:` -> `verify:v7:` prefix bump, a body cached by the pre-deploy
 * build is re-served verbatim for the full 300s TTL, still carrying the claim.
 *
 * Endpoints are PUBLIC (cross-tenant reads here are by design), so only the
 * Cloud Run IAM token is needed. `--dry-run` prints the plan without firing.
 *
 * Env:
 *   STAGING_API_BASE                   REQUIRED per-PR isolated tag URL
 *   STAGING_GCP_IDENTITY               optional pre-fetched IAM token
 */

import { resolveStagingApiBase } from '../load-harness-env';
import {
  newDriverStats,
  summarizeEvidence,
  fireLabeled,
  parseDriverArgs,
  type DriverStats,
  type JsonBody,
} from './driver-core';
import { runDriver, iamAuthHeaders, writeEvidenceFile, type DriverContext } from './runtime';

export const REDERIVABILITY_DRIVER = { driver: 'declared-hash-rederivability', pr: '#2499' } as const;

/** Seeded by scripts/staging/targeted/fixtures/pr2499-declared-vs-measured.sql. */
export const DECLARED_PUBLIC_ID = 'ARK-P2499-DECLARED';
export const MEASURED_PUBLIC_ID = 'ARK-P2499-MEASURED';

export interface RederivabilityRequestSpec {
  label: string;
  method: 'GET';
  endpoint: string;
  url: string;
  allowedStatuses: number[];
  capture: true;
}

/**
 * Deterministic request plan. `cached-declared` deliberately repeats
 * `declared-hash` so a stale-cache regression shows up as a DIFFERENCE between
 * two labels rather than as a single flaky sample.
 */
export function planRederivabilityRequests(apiBase: string): RederivabilityRequestSpec[] {
  const verify = (id: string): string => `/api/v1/verify/${id}`;
  const spec = (label: string, endpoint: string): RederivabilityRequestSpec => ({
    label,
    method: 'GET',
    endpoint,
    url: `${apiBase}${endpoint}`,
    allowedStatuses: [200],
    capture: true,
  });
  return [
    spec('declared-hash', verify(DECLARED_PUBLIC_ID)),
    spec('measured', verify(MEASURED_PUBLIC_ID)),
    spec('declared-proof-surface', `${verify(DECLARED_PUBLIC_ID)}/proof`),
    spec('cached-declared', verify(DECLARED_PUBLIC_ID)),
  ];
}

/** True when the body carries the fetch-time-measurement claim in any form. */
export function claimsFetchTimeMeasurement(body: JsonBody): boolean {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return false;
  const row = body as Record<string, unknown>;
  return 'fingerprint_rederivability' in row || 'fingerprint_rederivability_note' in row;
}

export interface RederivabilityVerdict {
  /** Labels whose body carried the claim. */
  claimed: string[];
  /** True when the row resolved at all — guards vacuous absence assertions. */
  declaredResolved: boolean;
  measuredResolved: boolean;
  deviations: string[];
}

/**
 * The evidence rule, pure and unit-tested. `declared`/`cached` must NOT claim;
 * `measured` MUST claim; and both rows must actually have resolved, otherwise
 * the absence assertions proved nothing.
 */
export function judgeRederivability(
  bodies: Record<string, { status: number; body: JsonBody }>,
): RederivabilityVerdict {
  const claimed: string[] = [];
  const deviations: string[] = [];
  const resolved = (label: string): boolean => {
    const o = bodies[label];
    if (o === undefined || o.status !== 200) return false;
    const b = o.body;
    if (b === null || typeof b !== 'object' || Array.isArray(b)) return false;
    const expectedId = label === 'measured' ? MEASURED_PUBLIC_ID : DECLARED_PUBLIC_ID;
    if ('error' in b) return false;
    if (label === 'declared-proof-surface') return b.public_id === expectedId;
    if (b.public_id === expectedId) return true;
    if (typeof b.record_uri !== 'string') return false;
    try {
      const uri = new URL(b.record_uri);
      return uri.protocol === 'https:' && ['app.arkova.ai', 'app.arkova.io'].includes(uri.hostname)
        && uri.pathname === `/verify/${expectedId}` && !uri.search && !uri.hash;
    } catch { return false; }
  };
  for (const [label, outcome] of Object.entries(bodies)) {
    if (claimsFetchTimeMeasurement(outcome.body)) claimed.push(label);
  }
  const declaredResolved = resolved('declared-hash');
  const measuredResolved = resolved('measured');

  if (!declaredResolved) {
    deviations.push(
      'POSITIVE CONTROL FAILED: declared-hash did not resolve to an object body, so every '
      + '"claim is absent" assertion below is vacuous.',
    );
  }
  if (!measuredResolved) {
    deviations.push(
      'POSITIVE CONTROL FAILED: measured did not resolve, so a build that suppressed the claim '
      + 'for every row would pass unnoticed.',
    );
  }
  for (const label of ['declared-hash', 'cached-declared', 'declared-proof-surface']) {
    if (!resolved(label)) deviations.push(`POSITIVE CONTROL FAILED: ${label} did not resolve the expected record.`);
    if (claimed.includes(label)) {
      deviations.push(
        `${label} carried fingerprint_rederivability — a DECLARED hash must not claim a measured `
        + 'fetch-time fingerprint (§1.5 / R-7). This is the regression #2499 fixes.',
      );
    }
  }
  const measuredBody = bodies.measured?.body;
  if (measuredResolved && (
    measuredBody === null || typeof measuredBody !== 'object' || Array.isArray(measuredBody)
    || measuredBody.fingerprint_rederivability !== 'fetch_time_snapshot'
    || typeof measuredBody.fingerprint_rederivability_note !== 'string'
    || measuredBody.fingerprint_rederivability_note.trim().length === 0
  )) {
    deviations.push('POSITIVE CONTROL FAILED: measured class/note must be the complete fetch_time_snapshot pair.');
  }
  if (measuredResolved && !claimed.includes('measured')) {
    deviations.push(
      'measured lost fingerprint_rederivability — over-suppression is its own regression: a '
      + 'genuinely fetched anchor must keep the claim.',
    );
  }
  if (declaredResolved && measuredResolved
    && claimed.includes('declared-hash') === claimed.includes('measured')) {
    deviations.push(
      'DISCRIMINATOR FAILED: the pair differs only by connector_artifact_id, so it must not '
      + 'classify identically.',
    );
  }
  return { claimed, declaredResolved, measuredResolved, deviations };
}

// ─── Runtime (thin; needs a live rig) ───────────────────────────────────────

async function fireOnce(
  ctx: DriverContext,
  stats: DriverStats,
  plan: RederivabilityRequestSpec[],
): Promise<string[]> {
  const headers = iamAuthHeaders();
  const bodies: Record<string, { status: number; body: JsonBody }> = {};
  for (const spec of plan) {
    const outcome = await fireLabeled({ stats, headers, ...spec });
    bodies[spec.label] = { status: outcome.status, body: outcome.capturedBody ?? null };
  }
  const verdict = judgeRederivability(bodies);
  ctx.log(
    `claimed=[${verdict.claimed.join(',')}] declaredResolved=${verdict.declaredResolved} `
    + `measuredResolved=${verdict.measuredResolved} deviations=${verdict.deviations.length}`,
  );
  for (const d of verdict.deviations) ctx.log(`::error::${d}`);
  return verdict.deviations;
}

// istanbul ignore next — exercised only against a live rig
export async function runRederivabilityDriver(): Promise<void> {
  const args = parseDriverArgs(process.argv.slice(2));
  const apiBase = resolveStagingApiBase(process.env);
  const stats = newDriverStats();
  const deviations: string[] = [];

  await runDriver({
    apiBase,
    args,
    label: REDERIVABILITY_DRIVER.driver,
    stats,
    plan: () => Promise.resolve(planRederivabilityRequests(apiBase)),
    fireOnce: async (ctx, plan) => {
      try {
        deviations.push(...await fireOnce(ctx, stats, plan as RederivabilityRequestSpec[]));
      } catch (err) {
        // runDriver logs and continues after exceptions: retain the failure here.
        deviations.push(`Pass failed: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    },
  });

  if (args.dryRun) return;
  const summary = summarizeEvidence(stats, { ...REDERIVABILITY_DRIVER, apiBase });
  const evidence = { ...summary, deviations, allExpected: summary.allExpected && deviations.length === 0 };
  writeEvidenceFile(args.evidenceOut, evidence);
  if (!evidence.allExpected) throw new Error('Soak failed: unexpected responses or assertion failures; see evidence.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runRederivabilityDriver().catch((err) => {
    console.error(
      `::error::declared-hash-rederivability driver failed: ${err instanceof Error ? err.message : err}`,
    );
    process.exit(1);
  });
}
