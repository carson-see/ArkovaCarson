#!/usr/bin/env -S npx tsx
/**
 * scripts/staging/targeted/cpe-cle-exports-driver.ts  (PR #1415 — cpe-cle)
 *
 * TARGETED soak driver for the three compliance-log export endpoints:
 *   - POST /api/v1/exports/cpe-log       (self CPE log; user_id must == caller)
 *   - POST /api/v1/exports/cle-log       (self CLE log; adds a jurisdiction)
 *   - POST /api/v1/exports/org/cpe-log   (ORG_ADMIN exports a MEMBER's CPE log)
 *
 * Drives, for each: pdf + json format (both artifacts are always generated),
 * the Zod edges (bad format enum, malformed date, inverted period), an explicit
 * cross-user 403 isolation case (caller exports a foreign user_id), and a 401
 * unauthenticated negative. All three are mounted behind `requireAuth`
 * (Supabase JWT → req.authUserId), so callers carry a Bearer JWT.
 *
 * Isolation matters: /exports/cpe-log 403s when user_id !== caller; /exports/org/cpe-log
 * derives org from the caller and 403s a non-member target — the driver proves the
 * self-export path rejects a foreign user_id under load.
 *
 * Env:
 *   STAGING_API_BASE           REQUIRED per-PR tag URL
 *   STAGING_EXPORT_CALLER_JWT  REQUIRED Supabase JWT for the self-export caller
 *   STAGING_EXPORT_CALLER_UID  REQUIRED the caller's own user id (self user_id)
 *   STAGING_EXPORT_OTHER_UID   REQUIRED a DIFFERENT org member's user id
 *   STAGING_EXPORT_ORG_ADMIN_JWT optional ORG_ADMIN JWT for /exports/org/cpe-log
 *   STAGING_GCP_IDENTITY       optional pre-fetched Cloud Run IAM token
 */

import { resolveStagingApiBase } from '../load-harness-env';
import {
  newDriverStats,
  summarizeEvidence,
  fireLabeled,
  parseDriverArgs,
  type DriverStats,
} from './driver-core';
import { runDriver, iamAuthHeaders, writeEvidenceFile, type DriverContext } from './runtime';

export const EXPORTS_DRIVER = { driver: 'cpe-cle-exports', pr: '#1415' } as const;

const CPE = '/api/v1/exports/cpe-log';
const CLE = '/api/v1/exports/cle-log';
const ORG_CPE = '/api/v1/exports/org/cpe-log';

// ─── Pure plan (unit-tested) ────────────────────────────────────────────────

export interface ExportRequestSpec {
  label: string;
  method: 'POST';
  endpoint: string;
  url: string;
  headers?: Record<string, string>;
  body: string;
  allowedStatuses: number[];
  capture: true;
}

export interface ExportPlanArgs {
  callerJwt: string;
  callerUserId: string;
  otherUserId: string;
  orgAdminJwt?: string;
  period: { start: string; end: string };
}

export function planExportRequests(apiBase: string, args: ExportPlanArgs): ExportRequestSpec[] {
  const { start, end } = args.period;
  const bearer = (jwt?: string): Record<string, string> => ({
    'Content-Type': 'application/json',
    ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
  });
  const mk = (
    label: string,
    endpoint: string,
    body: Record<string, unknown>,
    allowedStatuses: number[],
    jwt?: string,
  ): ExportRequestSpec => ({
    label,
    method: 'POST',
    endpoint,
    url: `${apiBase}${endpoint}`,
    headers: bearer(jwt),
    body: JSON.stringify(body),
    allowedStatuses,
    capture: true,
  });

  const selfBase = { user_id: args.callerUserId, period_start: start, period_end: end };
  const plan: ExportRequestSpec[] = [];

  // ── cpe-log happy path: both formats ──────────────────────────────────────
  for (const format of ['pdf', 'json'] as const) {
    plan.push(mk(`cpe-log-ok-${format}`, CPE, { ...selfBase, format }, [200], args.callerJwt));
  }

  // ── cle-log happy path: both formats, with a jurisdiction ─────────────────
  for (const format of ['pdf', 'json'] as const) {
    plan.push(
      mk(`cle-log-ok-${format}`, CLE, { ...selfBase, jurisdiction: 'CA', format }, [200], args.callerJwt),
    );
  }

  // ── org/cpe-log happy path: ORG_ADMIN exports a MEMBER ────────────────────
  if (args.orgAdminJwt) {
    for (const format of ['pdf', 'json'] as const) {
      plan.push(
        mk(
          `org-cpe-log-ok-${format}`,
          ORG_CPE,
          { user_id: args.otherUserId, period_start: start, period_end: end, format },
          [200],
          args.orgAdminJwt,
        ),
      );
    }
  }

  // ── cross-user 403 isolation: caller exports a FOREIGN user_id ────────────
  plan.push(
    mk(
      'cpe-log-cross-user-403',
      CPE,
      { user_id: args.otherUserId, period_start: start, period_end: end, format: 'json' },
      [403],
      args.callerJwt,
    ),
  );

  // ── Zod edges (all 400) ───────────────────────────────────────────────────
  plan.push(
    mk('cpe-log-bad-format-400', CPE, { ...selfBase, format: 'xml' }, [400], args.callerJwt),
  );
  plan.push(
    mk(
      'cpe-log-bad-date-400',
      CPE,
      { user_id: args.callerUserId, period_start: '2026/01/01', period_end: end, format: 'json' },
      [400],
      args.callerJwt,
    ),
  );
  plan.push(
    mk(
      'cpe-log-inverted-period-400',
      CPE,
      { user_id: args.callerUserId, period_start: end, period_end: start, format: 'json' },
      [400],
      args.callerJwt,
    ),
  );

  // ── unauthenticated 401 (no JWT) ──────────────────────────────────────────
  plan.push(mk('unauthenticated-401', CPE, { ...selfBase, format: 'json' }, [401]));

  return plan;
}

// ─── Runtime ────────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required for the cpe-cle exports driver.`);
  return v;
}

async function fireOnce(ctx: DriverContext, stats: DriverStats, plan: ExportRequestSpec[]): Promise<void> {
  for (const spec of plan) {
    const headers = iamAuthHeaders(spec.headers ?? {});
    const outcome = await fireLabeled({ stats, ...spec, headers });
    ctx.log(`${spec.label}: status=${outcome.status}`);
  }
}

// istanbul ignore next — exercised only against a live rig
async function main(): Promise<void> {
  const args = parseDriverArgs(process.argv.slice(2));
  const apiBase = resolveStagingApiBase(process.env);
  const stats = newDriverStats();

  const planArgs: ExportPlanArgs = {
    callerJwt: requireEnv('STAGING_EXPORT_CALLER_JWT'),
    callerUserId: requireEnv('STAGING_EXPORT_CALLER_UID'),
    otherUserId: requireEnv('STAGING_EXPORT_OTHER_UID'),
    orgAdminJwt: process.env.STAGING_EXPORT_ORG_ADMIN_JWT,
    period: { start: '2026-01-01', end: '2026-06-30' },
  };

  await runDriver({
    apiBase,
    args,
    label: EXPORTS_DRIVER.driver,
    stats,
    plan: async (ctx) => {
      if (!planArgs.orgAdminJwt) ctx.log('STAGING_EXPORT_ORG_ADMIN_JWT unset — org/cpe-log path skipped.');
      return planExportRequests(apiBase, planArgs);
    },
    fireOnce: (ctx, plan) => fireOnce(ctx, stats, plan as ExportRequestSpec[]),
  });

  const evidence = summarizeEvidence(stats, { ...EXPORTS_DRIVER, apiBase });
  writeEvidenceFile(args.evidenceOut, evidence);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`::error::cpe-cle exports driver failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
