#!/usr/bin/env -S npx tsx
/**
 * scripts/staging/targeted/ops-slo-driver.ts  (PR #1441 — ops-slo)
 *
 * TARGETED soak driver for GET /api/admin/ops-slo-stats. Drives the three auth
 * branches and, on the admin-200 path, captures the response body so the
 * evidence proves the flat five-surface stats contract #1441 adds:
 *
 *   - admin-ok             platform-admin JWT   → 200 (surfaces{available})
 *   - non-admin-forbidden  ORG_ADMIN/user JWT   → 403
 *   - unauthenticated      no bearer token      → 401
 *
 * Auth for `/api/admin/*` is a Supabase JWT resolved to a userId, then gated by
 * `isPlatformAdmin`. The driver takes those JWTs from env (they are minted by
 * the isolated-rig standup, mirroring STAGING_API_KEY). For merge-grade T2
 * evidence the driver is fail-closed: all three branches must be present, so
 * missing JWTs block admission instead of producing hollow 401-only traffic.
 *
 * `available:false` is exercised by pointing the SLO reader at a surface with no
 * recent samples on the fresh isolated rig — an empty rig makes several surfaces
 * report unavailable, which is exactly the branch under test.
 *
 * Env:
 *   STAGING_API_BASE / WORKER_URL             REQUIRED per-PR tag URL
 *   STAGING_ADMIN_JWT / OPS_SLO_ADMIN_JWT     platform-admin Supabase JWT
 *   STAGING_NON_ADMIN_JWT / OPS_SLO_NON_ADMIN_JWT  non-admin JWT
 *   STAGING_GCP_IDENTITY / WORKER_IAM_TOKEN / CLOUD_RUN_IDENTITY_TOKEN
 *                                             REQUIRED Cloud Run IAM token
 */

import { resolveStagingApiBase } from '../load-harness-env.js';
import {
  newDriverStats,
  summarizeEvidence,
  fireLabeled,
  parseDriverArgs,
  type DriverStats,
  type JsonBody,
} from './driver-core.js';
import {
  runDriver,
  iamAuthHeaders,
  iamToken,
  bearerHeader,
  writeEvidenceFile,
  type DriverContext,
} from './runtime.js';

export const OPS_SLO_DRIVER = { driver: 'ops-slo', pr: '#1441' } as const;

const ENDPOINT = '/api/admin/ops-slo-stats';
const PASS_INTERVAL_MS = 75_000;

function firstEnv(names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

export function missingOpsSloAdmissionInputs(env: NodeJS.ProcessEnv = process.env): string[] {
  const missing: string[] = [];
  const hasAny = (names: string[]) => names.some((name) => Boolean(env[name]?.trim()));
  if (!hasAny(['STAGING_API_BASE', 'WORKER_URL'])) {
    missing.push('STAGING_API_BASE or WORKER_URL for the deployed PR #1441 tag URL');
  }
  if (!hasAny(['STAGING_ADMIN_JWT', 'OPS_SLO_ADMIN_JWT'])) {
    missing.push('STAGING_ADMIN_JWT or OPS_SLO_ADMIN_JWT for a platform-admin Supabase JWT');
  }
  if (!hasAny(['STAGING_NON_ADMIN_JWT', 'OPS_SLO_NON_ADMIN_JWT'])) {
    missing.push('STAGING_NON_ADMIN_JWT or OPS_SLO_NON_ADMIN_JWT for an authenticated non-admin Supabase JWT');
  }
  if (!hasAny(['STAGING_GCP_IDENTITY', 'WORKER_IAM_TOKEN', 'CLOUD_RUN_IDENTITY_TOKEN'])) {
    missing.push('STAGING_GCP_IDENTITY, WORKER_IAM_TOKEN, or CLOUD_RUN_IDENTITY_TOKEN for Cloud Run tag ingress');
  }
  return missing;
}

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
  if (!args.adminJwt) throw new Error('platform-admin Supabase JWT is required for OPS-SLO T2 evidence');
  if (!args.nonAdminJwt) throw new Error('non-admin Supabase JWT is required for OPS-SLO T2 evidence');

  const url = `${apiBase}${ENDPOINT}`;
  return [
    {
      label: 'admin-ok',
      method: 'GET',
      endpoint: ENDPOINT,
      url,
      headers: { Authorization: `Bearer ${args.adminJwt}` },
      allowedStatuses: [200],
      capture: true,
    },
    {
      label: 'non-admin-forbidden',
      method: 'GET',
      endpoint: ENDPOINT,
      url,
      headers: { Authorization: `Bearer ${args.nonAdminJwt}` },
      allowedStatuses: [403],
      capture: true,
    },
    {
      label: 'unauthenticated',
      method: 'GET',
      endpoint: ENDPOINT,
      url,
      allowedStatuses: [401],
      capture: true,
    },
  ];
}

/** Extract the per-surface `available` map from the #1441 stats body. */
export function summarizeSurfaceAvailability(body: JsonBody): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const record = body as Record<string, unknown>;
    for (const name of ['anchorSecuredRate', 'connectorQueue', 'creditConservation', 'webhookDelivery', 'apiErrors']) {
      const val = record[name];
      if (val && typeof val === 'object' && 'available' in val) {
        out[name] = Boolean((val as Record<string, unknown>).available);
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
    const headers = spec.label === 'unauthenticated'
      ? { 'X-Serverless-Authorization': bearerHeader(iamToken()).Authorization }
      : iamAuthHeaders(spec.headers ?? {});
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
  const missing = missingOpsSloAdmissionInputs();
  if (missing.length > 0) {
    console.error(`::error::ops-slo admission blocked: ${missing.join('; ')}`);
    process.exit(2);
  }

  const apiBase = resolveStagingApiBase({
    STAGING_API_BASE: firstEnv(['STAGING_API_BASE', 'WORKER_URL']),
  });
  process.env.STAGING_GCP_IDENTITY = firstEnv([
    'STAGING_GCP_IDENTITY',
    'WORKER_IAM_TOKEN',
    'CLOUD_RUN_IDENTITY_TOKEN',
  ]);
  const stats = newDriverStats();
  const planArgs: OpsSloPlanArgs = {
    adminJwt: firstEnv(['STAGING_ADMIN_JWT', 'OPS_SLO_ADMIN_JWT']),
    nonAdminJwt: firstEnv(['STAGING_NON_ADMIN_JWT', 'OPS_SLO_NON_ADMIN_JWT']),
  };

  await runDriver({
    apiBase,
    args,
    label: OPS_SLO_DRIVER.driver,
    stats,
    plan: async (ctx) => {
      return planOpsSloRequests(apiBase, planArgs);
    },
    fireOnce: (ctx, plan) => fireOnce(ctx, stats, plan as OpsSloRequestSpec[]),
    // The unauthenticated branch is intentionally rate-limited per IP around a
    // one-minute window. A 30s default cadence makes the driver manufacture
    // 429s instead of proving the route's 401/403/200 auth contract.
    passIntervalMs: PASS_INTERVAL_MS,
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
