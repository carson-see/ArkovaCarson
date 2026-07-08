#!/usr/bin/env -S npx tsx
/**
 * scripts/staging/targeted/verify-proof-driver.ts  (PR #1439 — fe-proof)
 *
 * TARGETED soak driver for GET /api/v1/verify/:public_id/proof. Unlike
 * `load-harness --mode mixed`, this hits the EXACT surface #1439 changes and
 * drives BOTH documented 404 branches, capturing the response body that proves
 * the new `proof_error_code` discriminator:
 *
 *   - record-not-found  → unknown public_id            → 404 RECORD_NOT_FOUND
 *   - no-batch-proof    → SECURED-but-unbatched anchor → 404 NO_BATCH_PROOF
 *   - invalid-public-id → <3-char id                   → 400 guard
 *
 * The `no-batch-proof` case needs a seeded SECURED anchor that has an on-chain
 * receipt but no anchor_proofs row (see fixtures.buildSecuredUnbatchedAnchor).
 *
 * Endpoint is PUBLIC (no payment / no API key), so only the Cloud Run IAM token
 * is needed. `--dry-run` prints the plan without firing or seeding.
 *
 * Env:
 *   STAGING_API_BASE                      REQUIRED per-PR tag URL
 *   STAGING_SUPABASE_URL                  REQUIRED to seed the unbatched anchor
 *   STAGING_SUPABASE_SERVICE_ROLE_KEY     REQUIRED to seed the unbatched anchor
 *   STAGING_FIXTURE_ORG_ID / _USER_ID     REQUIRED FK targets on the isolated rig
 *   STAGING_GCP_IDENTITY                  optional pre-fetched IAM token
 */

import { resolveStagingApiBase } from '../load-harness-env';
import {
  newDriverStats,
  summarizeEvidence,
  fireLabeled,
  captureProofErrorCode,
  parseDriverArgs,
  type DriverStats,
  type JsonBody,
} from './driver-core';
import {
  runDriver,
  iamAuthHeaders,
  seedViaServiceRole,
  writeEvidenceFile,
  type DriverContext,
} from './runtime';
import { buildSecuredUnbatchedAnchor } from './fixtures';

export const PROOF_DRIVER = { driver: 'verify-proof', pr: '#1439' } as const;

// ─── Pure plan (unit-tested) ────────────────────────────────────────────────

export interface ProofRequestSpec {
  label: string;
  method: 'GET';
  endpoint: string;
  url: string;
  allowedStatuses: number[];
  capture: true;
}

export interface ProofPlanArgs {
  /** public_id of the seeded SECURED-but-unbatched anchor. */
  unbatchedPublicId: string;
}

/**
 * Deterministic request plan hitting every changed branch. An unknown id for
 * RECORD_NOT_FOUND is generated distinct from the seeded unbatched id.
 */
export function planProofRequests(apiBase: string, args: ProofPlanArgs): ProofRequestSpec[] {
  const unknownId = 'TSOAK-UNKNOWN-000000000000';
  const proof = (id: string): string => `/api/v1/verify/${id}/proof`;
  return [
    {
      label: 'record-not-found',
      method: 'GET',
      endpoint: proof(unknownId),
      url: `${apiBase}${proof(unknownId)}`,
      allowedStatuses: [404],
      capture: true,
    },
    {
      label: 'no-batch-proof',
      method: 'GET',
      endpoint: proof(args.unbatchedPublicId),
      url: `${apiBase}${proof(args.unbatchedPublicId)}`,
      allowedStatuses: [404],
      capture: true,
    },
    {
      label: 'invalid-public-id',
      method: 'GET',
      endpoint: proof('ab'),
      url: `${apiBase}${proof('ab')}`,
      allowedStatuses: [400],
      capture: true,
    },
  ];
}

/** Extract the #1439 discriminator from a captured body (null pre-#1439). */
export function interpretProofOutcome(body: JsonBody): string | null {
  return captureProofErrorCode(body);
}

// ─── Runtime (thin; not unit-tested — needs live rig) ───────────────────────

async function seedAndPlan(ctx: DriverContext): Promise<ProofRequestSpec[]> {
  const orgId = requireEnv('STAGING_FIXTURE_ORG_ID');
  const userId = requireEnv('STAGING_FIXTURE_USER_ID');
  const anchor = buildSecuredUnbatchedAnchor({ orgId, userId });
  await seedViaServiceRole('anchors', [anchor]);
  ctx.log(`seeded SECURED-but-unbatched anchor public_id=${anchor.public_id}`);
  return planProofRequests(ctx.apiBase, { unbatchedPublicId: anchor.public_id });
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required for the verify-proof driver.`);
  return v;
}

async function fireOnce(ctx: DriverContext, stats: DriverStats, plan: ProofRequestSpec[]): Promise<void> {
  const headers = iamAuthHeaders();
  for (const spec of plan) {
    const outcome = await fireLabeled({ stats, headers, ...spec });
    if (spec.label !== 'invalid-public-id') {
      const code = interpretProofOutcome(outcome.capturedBody ?? null);
      ctx.log(`${spec.label}: status=${outcome.status} proof_error_code=${code ?? 'null'}`);
    }
  }
}

// istanbul ignore next — exercised only against a live rig
async function main(): Promise<void> {
  const args = parseDriverArgs(process.argv.slice(2));
  const apiBase = resolveStagingApiBase(process.env);
  const stats = newDriverStats();

  await runDriver({
    apiBase,
    args,
    label: PROOF_DRIVER.driver,
    stats,
    plan: (ctx) => seedAndPlan(ctx),
    fireOnce: (ctx, plan) => fireOnce(ctx, stats, plan as ProofRequestSpec[]),
  });

  const evidence = summarizeEvidence(stats, { ...PROOF_DRIVER, apiBase });
  writeEvidenceFile(args.evidenceOut, evidence);
}

// Only auto-run when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`::error::verify-proof driver failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
