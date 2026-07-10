#!/usr/bin/env -S npx tsx
/**
 * scripts/staging/targeted/classify-backcatalog-driver.ts  (PR #1410 — S3-A)
 *
 * TARGETED soak driver for POST /jobs/classify-proof-backcatalog — the EXACT
 * surface #1410 adds (back-catalogue proof-completeness CLASSIFIER census).
 * Unlike `load-harness --mode mixed` (which only proves the worker is up), this
 * drives each documented branch of the new endpoint + runBackCatalogClassifier
 * and captures the response body that proves the census ran honestly:
 *
 *   - census-dry-run        default (execute unset) -> 200, per-class plan
 *                           {direct_anchored, batch_provable, already_complete,
 *                            ambiguous} with ZERO proof-catalogue writes.
 *   - census-bounded        batch_size + max_batches bounded -> 200, exercises
 *                           the resumable cursor / checkpoint path.
 *   - census-restart        restart=true -> 200, starts a fresh census (new
 *                           job_queue checkpoint row) from cursor zero.
 *   - guard-bad-batch-size  batch_size below the 50 floor -> 400 param guard.
 *   - guard-bad-org         malformed org_id -> 400 uuid guard.
 *
 * The classifier is a CENSUS over whatever anchors/anchor_proofs already exist
 * on the rig -- it needs no bespoke fixture; the isolated-rig baseline fixture
 * (seed-baseline-fixture.sql) supplies the anchor rows it classifies. The 200
 * bodies carry the honest per-class counts, which is the merge-grade evidence
 * that the changed census logic actually executed against a real DB.
 *
 * AUTH: the endpoint is behind cronAuth (mounted at /jobs) (X-Cron-Secret) AND the Cloud Run
 * service is --no-allow-unauthenticated, so BOTH headers are sent:
 *   Authorization: Bearer <IAM identity token>   (reaches Cloud Run)
 *   X-Cron-Secret: <STAGING_CRON_SECRET>          (passes cronAuth)
 *
 * SAFETY: every request is DRY-RUN (execute is never set true, and the rig has
 * no PROOF_CLASSIFIER_CONFIRM=EXECUTE), so the census performs ZERO writes to
 * anchors/anchor_proofs. It DOES persist its own durable job_queue checkpoint
 * row (by design, both modes) -- that is the resumable-census state, not a
 * proof mutation, and is scoped to the isolated rig.
 *
 * Env:
 *   STAGING_API_BASE       REQUIRED per-PR tag URL (pr-1410---...run.app)
 *   STAGING_CRON_SECRET    REQUIRED -- the rig's CRON_SECRET (cronAuth)
 *   STAGING_GCP_IDENTITY   optional pre-fetched Cloud Run IAM token
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

export const CLASSIFY_DRIVER = { driver: 'classify-backcatalog', pr: '#1410' } as const;

// --- Pure plan (unit-tested) ------------------------------------------------

export interface ClassifyRequestSpec {
  label: string;
  method: 'POST';
  endpoint: string;
  url: string;
  allowedStatuses: number[];
  capture: true;
}

/** Path (+ query) for the classifier endpoint with the given params. */
export function classifyPath(query: Record<string, string | number> = {}): string {
  const base = '/jobs/classify-proof-backcatalog';
  const entries = Object.entries(query);
  if (entries.length === 0) return base;
  const qs = entries.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
  return `${base}?${qs}`;
}

/**
 * Deterministic request plan hitting every changed branch of the endpoint.
 * All census calls are DRY-RUN (execute never set). The two guard calls assert
 * the Zod param-boundary the PR added (batch floor 50; org_id uuid).
 */
export function planClassifyRequests(apiBase: string): ClassifyRequestSpec[] {
  const spec = (
    label: string,
    query: Record<string, string | number>,
    allowed: number[],
  ): ClassifyRequestSpec => {
    const path = classifyPath(query);
    return {
      label,
      method: 'POST',
      endpoint: path,
      url: `${apiBase}${path}`,
      allowedStatuses: allowed,
      capture: true,
    };
  };
  return [
    spec('census-dry-run', {}, [200]),
    spec('census-bounded', { batch_size: 50, max_batches: 2 }, [200]),
    spec('census-restart', { restart: 'true', batch_size: 50, max_batches: 1 }, [200]),
    spec('guard-bad-batch-size', { batch_size: 1 }, [400]),
    spec('guard-bad-org', { org_id: 'not-a-uuid' }, [400]),
  ];
}

/**
 * Read the honest per-class census counts from a 200 body. Returns null for a
 * non-object body or a body lacking the plan shape (e.g. a 400 guard body),
 * so the driver records a null summary rather than throwing.
 */
export function interpretCensusOutcome(body: JsonBody): Record<string, unknown> | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const keys = [
    'mode',
    'dryRun',
    'direct_anchored',
    'batch_provable',
    'already_complete',
    'ambiguous',
    'counts',
    'plan',
    'processed',
    'refused',
    'reason',
  ];
  const out: Record<string, unknown> = {};
  for (const k of keys) if (k in b) out[k] = b[k];
  return Object.keys(out).length > 0 ? out : null;
}

// --- Runtime (thin; not unit-tested -- needs live rig) ----------------------

function cronHeaders(): Record<string, string> {
  const secret = process.env.STAGING_CRON_SECRET;
  if (!secret) {
    throw new Error('STAGING_CRON_SECRET is required for the classify-backcatalog driver (cronAuth).');
  }
  return iamAuthHeaders({ 'X-Cron-Secret': secret, 'Content-Type': 'application/json' });
}

async function fireOnce(ctx: DriverContext, stats: DriverStats, plan: ClassifyRequestSpec[]): Promise<void> {
  const headers = cronHeaders();
  for (const spec of plan) {
    const outcome = await fireLabeled({ stats, headers, ...spec });
    if (spec.label.startsWith('census')) {
      const census = interpretCensusOutcome(outcome.capturedBody ?? null);
      ctx.log(`${spec.label}: status=${outcome.status} census=${census ? JSON.stringify(census) : 'null'}`);
    } else {
      ctx.log(`${spec.label}: status=${outcome.status} (guard)`);
    }
  }
}

// istanbul ignore next -- exercised only against a live rig
async function main(): Promise<void> {
  const args = parseDriverArgs(process.argv.slice(2));
  const apiBase = resolveStagingApiBase(process.env);
  const stats = newDriverStats();

  await runDriver({
    apiBase,
    args,
    label: CLASSIFY_DRIVER.driver,
    stats,
    plan: async (ctx) => {
      ctx.log('census is over existing rig anchors/anchor_proofs -- no bespoke fixture needed.');
      return planClassifyRequests(ctx.apiBase);
    },
    fireOnce: (ctx, plan) => fireOnce(ctx, stats, plan as ClassifyRequestSpec[]),
  });

  const evidence = summarizeEvidence(stats, { ...CLASSIFY_DRIVER, apiBase });
  writeEvidenceFile(args.evidenceOut, evidence);
}

// Only auto-run when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`::error::classify-backcatalog driver failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
