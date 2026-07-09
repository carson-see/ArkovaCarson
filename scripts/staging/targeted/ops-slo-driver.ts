#!/usr/bin/env -S npx tsx
/**
 * scripts/staging/targeted/ops-slo-driver.ts  (PR #1441 — ops-slo)
 *
 * TARGETED soak driver for GET /api/admin/ops-slo-stats. Drives the three auth
 * branches and, on the admin-200 path, captures the response body so the
 * evidence proves the per-surface `available:false` failure cases #1441 adds:
 *
 *   - admin-ok             platform-admin JWT   → 200 (surfaces{available})
 *   - non-admin-forbidden  ORG_ADMIN/user JWT   → 403
 *   - unauthenticated      no bearer token      → 401
 *
 * Auth for `/api/admin/*` is a Supabase JWT resolved to a userId, then gated by
 * `isPlatformAdmin`. The driver takes those JWTs from env (they are minted by
 * the isolated-rig standup, mirroring STAGING_API_KEY). The 401 branch always
 * runs; admin-ok / non-admin only run when their JWT is provided.
 *
 * `available:false` is exercised by pointing the SLO reader at a surface with no
 * recent samples on the fresh isolated rig — an empty rig makes several surfaces
 * report unavailable, which is exactly the branch under test.
 *
 * Env:
 *   STAGING_API_BASE           REQUIRED per-PR tag URL
 *   STAGING_ADMIN_JWT          platform-admin Supabase JWT (admin-ok path)
 *   STAGING_NON_ADMIN_JWT      non-admin JWT (403 path)
 *   STAGING_GCP_IDENTITY       optional pre-fetched Cloud Run IAM token
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

export const OPS_SLO_DRIVER = { driver: 'ops-slo', pr: '#1441' } as const;

const ENDPOINT = '/api/admin/ops-slo-stats';

// ─── Pure plan (unit-tested) ────────────────────────────────────────────────

export interface OpsSloRequestSpec {
  label: string;
  method: 'GET';
  endpoint: string;
  url: string;
  headers?: Record<string, string>;
  allowedStatuses: number[];
  capture: true;
}

export interface OpsSloPlanArgs {
  adminJwt?: string;
  nonAdminJwt?: string;
}

export function planOpsSloRequests(apiBase: string, args: OpsSloPlanArgs): OpsSloRequestSpec[] {
  const url = `${apiBase}${ENDPOINT}`;
  const plan: OpsSloRequestSpec[] = [];

  if (args.adminJwt) {
    plan.push({
      label: 'admin-ok',
      method: 'GET',
      endpoint: ENDPOINT,
      url,
      headers: { Authorization: `Bearer ${args.adminJwt}` },
      allowedStatuses: [200],
      capture: true,
    });
  }

  if (args.nonAdminJwt) {
    plan.push({
      label: 'non-admin-forbidden',
      method: 'GET',
      endpoint: ENDPOINT,
      url,
      headers: { Authorization: `Bearer ${args.nonAdminJwt}` },
      allowedStatuses: [403],
      capture: true,
    });
  }

  // Always exercise the unauthenticated branch — no app-layer bearer token.
  plan.push({
    label: 'unauthenticated',
    method: 'GET',
    endpoint: ENDPOINT,
    url,
    allowedStatuses: [401],
    capture: true,
  });

  return plan;
}

/** Extract the per-surface `available` map from the #1441 stats body. */
export function summarizeSurfaceAvailability(body: JsonBody): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const surfaces = (body as Record<string, unknown>).surfaces;
    if (surfaces && typeof surfaces === 'object' && !Array.isArray(surfaces)) {
      for (const [name, val] of Object.entries(surfaces as Record<string, unknown>)) {
        if (val && typeof val === 'object' && 'available' in val) {
          out[name] = Boolean((val as Record<string, unknown>).available);
        }
      }
    }
  }
  return out;
}

// ─── Runtime ────────────────────────────────────────────────────────────────

async function fireOnce(ctx: DriverContext, stats: DriverStats, plan: OpsSloRequestSpec[]): Promise<void> {
  for (const spec of plan) {
    // The unauthenticated case must NOT carry the IAM header's app-layer role;
    // but Cloud Run itself still requires the IAM token for network ingress.
    // The app auth is the Supabase bearer (spec.headers), NOT the IAM token, so
    // we attach IAM for ingress and let the app-layer Supabase JWT (or its
    // absence) drive the 200/401/403 outcome.
    const headers = iamAuthHeaders(spec.headers ?? {});
    // For 'unauthenticated', ensure no Supabase bearer overrides ingress IAM.
    const outcome = await fireLabeled({ stats, ...spec, headers });
    if (spec.label === 'admin-ok') {
      const avail = summarizeSurfaceAvailability(outcome.capturedBody ?? null);
      ctx.log(`admin-ok: status=${outcome.status} surfaces=${JSON.stringify(avail)}`);
    } else {
      ctx.log(`${spec.label}: status=${outcome.status}`);
    }
  }
}

// istanbul ignore next — exercised only against a live rig
async function main(): Promise<void> {
  const args = parseDriverArgs(process.argv.slice(2));
  const apiBase = resolveStagingApiBase(process.env);
  const stats = newDriverStats();
  const planArgs: OpsSloPlanArgs = {
    adminJwt: process.env.STAGING_ADMIN_JWT,
    nonAdminJwt: process.env.STAGING_NON_ADMIN_JWT,
  };

  await runDriver({
    apiBase,
    args,
    label: OPS_SLO_DRIVER.driver,
    stats,
    plan: async (ctx) => {
      if (!planArgs.adminJwt) ctx.log('STAGING_ADMIN_JWT unset — admin-ok (200) branch will be skipped.');
      return planOpsSloRequests(apiBase, planArgs);
    },
    fireOnce: (ctx, plan) => fireOnce(ctx, stats, plan as OpsSloRequestSpec[]),
  });

  const evidence = summarizeEvidence(stats, { ...OPS_SLO_DRIVER, apiBase });
  writeEvidenceFile(args.evidenceOut, evidence);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`::error::ops-slo driver failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
