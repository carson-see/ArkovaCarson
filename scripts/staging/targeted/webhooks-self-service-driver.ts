#!/usr/bin/env -S npx tsx
/**
 * scripts/staging/targeted/webhooks-self-service-driver.ts  (PR #1443, union with merged PR #1471)
 *
 * TARGETED soak driver for BOTH webhook admin surfaces present at the merged head:
 *
 * PR #1443 — ORG_ADMIN Supabase-JWT self-service surface (requireAuth):
 *   - test           POST /api/v1/webhooks/self-service/:id/test                  (WH-02)
 *   - replay         POST /api/v1/webhooks/self-service/deliveries/:id/replay     (WH-03)
 *   - dlq-list       GET  /api/v1/webhooks/self-service/dlq                       (WH-03)
 *   - dlq-resolve    POST /api/v1/webhooks/self-service/dlq/:id/resolve           (WH-03)
 *   plus an unauthenticated negative (401) proving the Supabase JWT gate.
 *
 * PR #1471 (merged to main 2026-07-10) — ORG_ADMIN API-key DLQ surface (apiKeyAuth):
 *   - api-dlq-list     GET  /api/v1/webhooks/dlq
 *   - api-dlq-resolve  POST /api/v1/webhooks/dlq/:id/resolve   (strict 200 — 404 was
 *                      #1471's false-return symptom and is NOT accepted)
 *   plus an unauthenticated negative (401) proving the API-key gate.
 *   This surface runs only when STAGING_ORG_ADMIN_KEY is set; otherwise it is
 *   skipped with an explicit log line (the #1443 isolated rig seeds no API key).
 *
 * JWT-authenticated calls carry the ORG_ADMIN Supabase JWT in Authorization, so
 * Cloud Run IAM auth rides in X-Serverless-Authorization via
 * runtime.iamAuthHeaders(). API-key calls carry X-API-Key with the IAM token in
 * Authorization (no app-layer bearer). Each pass seeds a FRESH unresolved DLQ
 * row per surface (fixtures.buildDlqFixtureRow) — #1471's per-pass reseed —
 * so dlq-list always returns ≥1 row and each dlq-resolve flips a live target.
 *
 * Env:
 *   STAGING_API_BASE                          REQUIRED per-PR tag URL
 *   STAGING_WEBHOOK_ORG_ADMIN_JWT             REQUIRED ORG_ADMIN Supabase JWT
 *   STAGING_WEBHOOK_ORG_ADMIN_REFRESH_TOKEN   optional; required for long soaks
 *   STAGING_WEBHOOK_ENDPOINT_ID               REQUIRED existing endpoint id for test/replay + DLQ rows
 *   STAGING_WEBHOOK_DELIVERY_ID               optional delivery id for replay; a seeded/known id
 *   STAGING_FIXTURE_ORG_ID                    REQUIRED org id owning the seeded DLQ rows
 *   STAGING_ORG_ADMIN_KEY                     optional ORG_ADMIN API key (X-API-Key) — enables the #1471 surface
 *   STAGING_GCP_IDENTITY                      optional pre-fetched Cloud Run IAM token
 */

import { resolveStagingApiBase } from '../load-harness-env';
import {
  newDriverStats,
  summarizeEvidence,
  fireLabeled,
  parseDriverArgs,
  type DriverStats,
} from './driver-core';
import {
  runDriver,
  iamAuthHeaders,
  iamOnlyHeaders,
  requireEnv,
  seedViaServiceRole,
  writeEvidenceFile,
  type DriverContext,
} from './runtime';
import { buildDlqFixtureRow } from './fixtures';

export const WEBHOOKS_DRIVER = { driver: 'webhooks-self-service', pr: '#1443' } as const;
// Eight probes max per pass across two independently rate-limited routers:
// 5 on the JWT self-service limiter, 3 on the API-key batch limiter
// (10 req/min budget → ~2.4 req/min at this cadence). 75s matches merged
// #1471's pacing and stays above #1443's soaked 65s floor.
export const WEBHOOKS_PASS_INTERVAL_MS = 75_000;

// ─── Pure plans (unit-tested) ───────────────────────────────────────────────

export interface WebhookRequestSpec {
  label: string;
  method: 'GET' | 'POST';
  endpoint: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  allowedStatuses: number[];
  capture: true;
}

export interface WebhookPlanArgs {
  orgAdminJwt: string;
  endpointId: string;
  deliveryId: string;
  dlqId: string;
}

export interface WebhookDlqApiKeyPlanArgs {
  orgAdminKey: string;
  dlqId: string;
}

interface WebhookAuthSession {
  accessToken: string;
  refreshToken?: string;
  expiresAtMs: number | null;
}

let webhookAuthSession: WebhookAuthSession | null = null;

export function jwtExpiresAtMs(jwt: string): number | null {
  const [, payload] = jwt.split('.');
  if (!payload) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof decoded.exp === 'number' ? decoded.exp * 1000 : null;
  } catch {
    return null;
  }
}

function initWebhookAuthSession(accessToken: string): WebhookAuthSession {
  webhookAuthSession = {
    accessToken,
    refreshToken: process.env.STAGING_WEBHOOK_ORG_ADMIN_REFRESH_TOKEN,
    expiresAtMs: jwtExpiresAtMs(accessToken),
  };
  return webhookAuthSession;
}

const REFRESH_ATTEMPTS = 3;
const REFRESH_BACKOFF_MS = 5_000;

async function refreshSessionWithBackoff(supabaseUrl: string, serviceRoleKey: string, refreshToken: string): Promise<{
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
}> {
  const { createClient } = await import('@supabase/supabase-js');
  const authClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  let lastError: unknown = new Error('Supabase refresh returned no access token');
  for (let attempt = 1; attempt <= REFRESH_ATTEMPTS; attempt++) {
    const { data, error } = await authClient.auth.refreshSession({ refresh_token: refreshToken });
    if (!error && data.session?.access_token) return data.session;
    lastError = error ?? lastError;
    if (attempt < REFRESH_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, REFRESH_BACKOFF_MS * attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function currentOrgAdminJwt(): Promise<string> {
  if (!webhookAuthSession) {
    return requireEnv('STAGING_WEBHOOK_ORG_ADMIN_JWT', 'webhooks self-service driver');
  }

  const refreshByMs = webhookAuthSession.expiresAtMs === null
    ? Number.POSITIVE_INFINITY
    : webhookAuthSession.expiresAtMs - 5 * 60_000;
  if (Date.now() < refreshByMs) return webhookAuthSession.accessToken;

  if (!webhookAuthSession.refreshToken) return webhookAuthSession.accessToken;

  const supabaseUrl = requireEnv('STAGING_SUPABASE_URL', 'webhooks self-service JWT refresh');
  const serviceRoleKey = requireEnv('STAGING_SUPABASE_SERVICE_ROLE_KEY', 'webhooks self-service JWT refresh');
  const session = await refreshSessionWithBackoff(supabaseUrl, serviceRoleKey, webhookAuthSession.refreshToken);

  webhookAuthSession = {
    accessToken: session.access_token,
    refreshToken: session.refresh_token ?? webhookAuthSession.refreshToken,
    expiresAtMs: session.expires_at ? session.expires_at * 1000 : jwtExpiresAtMs(session.access_token),
  };
  return webhookAuthSession.accessToken;
}

/** PR #1443 surface: JWT-gated /api/v1/webhooks/self-service/*. */
export function planWebhookSelfServiceRequests(
  apiBase: string,
  args: WebhookPlanArgs,
): WebhookRequestSpec[] {
  const jwt = { Authorization: `Bearer ${args.orgAdminJwt}`, 'Content-Type': 'application/json' };
  const p = (path: string): string => `/api/v1/webhooks/self-service${path}`;
  const mk = (
    label: string,
    method: 'GET' | 'POST',
    path: string,
    allowedStatuses: number[],
    body?: unknown,
    withKey = true,
  ): WebhookRequestSpec => ({
    label,
    method,
    endpoint: p(path),
    url: `${apiBase}${p(path)}`,
    headers: withKey ? jwt : undefined,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    allowedStatuses,
    capture: true,
  });

  return [
    // test → the endpoint may be inactive / unreachable localhost sink, so both
    // a 200 (delivered) and a 400 (endpoint_inactive / invalid_url) are valid
    // soak evidence exercising the handler under load.
    mk('test', 'POST', `/${args.endpointId}/test`, [200, 400, 404]),
    // replay → 200 replayed, 404 not-found, or 409 endpoint_inactive all exercise
    // the replay path; the driver records whichever the rig's fixture yields.
    mk('replay', 'POST', `/deliveries/${args.deliveryId}/replay`, [200, 404, 409]),
    // dlq list → ORG_ADMIN sees ≥1 seeded row.
    mk('dlq-list', 'GET', '/dlq', [200]),
    // dlq resolve → flips the per-pass freshly seeded row; strict 200 (per-pass
    // reseed means the target always exists — #1471's false-return lesson).
    mk('dlq-resolve', 'POST', `/dlq/${args.dlqId}/resolve`, [200]),
    // unauthenticated negative → Supabase JWT gate returns 401. A stray 429 from
    // the anonymous IP limiter is expected sharing behavior under parallel load
    // (#1441 lesson), not a driver failure.
    mk('unauthenticated', 'GET', '/dlq', [401, 429], undefined, false),
  ];
}

/** Merged PR #1471 surface: API-key-gated /api/v1/webhooks/dlq. */
export function planWebhookDlqApiKeyRequests(
  apiBase: string,
  args: WebhookDlqApiKeyPlanArgs,
): WebhookRequestSpec[] {
  const key = { 'X-API-Key': args.orgAdminKey, 'Content-Type': 'application/json' };
  const p = (path: string): string => `/api/v1/webhooks${path}`;
  const mk = (
    label: string,
    method: 'GET' | 'POST',
    path: string,
    allowedStatuses: number[],
    withKey = true,
  ): WebhookRequestSpec => ({
    label,
    method,
    endpoint: p(path),
    url: `${apiBase}${p(path)}`,
    headers: withKey ? key : undefined,
    allowedStatuses,
    capture: true,
  });

  return [
    // dlq list → ORG_ADMIN sees the fresh seeded row.
    mk('api-dlq-list', 'GET', '/dlq', [200]),
    // dlq resolve → must hit the deployed route and resolve the seeded row.
    // 404 is not accepted because that was #1471's false-return symptom.
    mk('api-dlq-resolve', 'POST', `/dlq/${args.dlqId}/resolve`, [200]),
    // unauthenticated negative → API-key gate returns 401 (429 tolerated as
    // expected anonymous-limiter sharing, per the #1441 lesson).
    mk('api-unauthenticated', 'GET', '/dlq', [401, 429], false),
  ];
}

// ─── Runtime ────────────────────────────────────────────────────────────────

export function dlqIdFromInsert(inserted: Array<Record<string, unknown>>): string {
  const seededId = inserted[0]?.id;
  if (seededId === undefined || seededId === null || seededId === '') {
    throw new Error('DLQ fixture seeding returned no row — cannot proceed with dlq-list/dlq-resolve evidence.');
  }
  return String(seededId);
}

interface WebhookRuntimeArgs {
  endpointId: string;
  orgId: string;
  deliveryId: string;
  orgAdminKey: string | null;
}

async function runtimeArgs(ctx: DriverContext): Promise<WebhookRuntimeArgs> {
  const orgAdminJwt = requireEnv('STAGING_WEBHOOK_ORG_ADMIN_JWT', 'webhooks self-service driver');
  initWebhookAuthSession(orgAdminJwt);
  const endpointId = requireEnv('STAGING_WEBHOOK_ENDPOINT_ID', 'webhooks self-service driver');
  const orgId = requireEnv('STAGING_FIXTURE_ORG_ID', 'webhooks self-service driver');
  const deliveryId = process.env.STAGING_WEBHOOK_DELIVERY_ID ?? 'TSOAK-DEL-000000000000';
  const orgAdminKey = process.env.STAGING_ORG_ADMIN_KEY?.trim() || null;
  if (!orgAdminKey) {
    ctx.log('STAGING_ORG_ADMIN_KEY unset — skipping the merged #1471 API-key /webhooks/dlq surface this run.');
  }

  return { endpointId, orgId, deliveryId, orgAdminKey };
}

async function seedDlqRow(ctx: DriverContext, args: WebhookRuntimeArgs, surface: string): Promise<string> {
  const dlqRow = buildDlqFixtureRow({ orgId: args.orgId, endpointId: args.endpointId });
  const inserted = await seedViaServiceRole('webhook_dead_letter_queue', [dlqRow]);
  const dlqId = dlqIdFromInsert(inserted);
  ctx.log(`seeded DLQ row id=${dlqId} org=${args.orgId} surface=${surface}`);
  return dlqId;
}

async function fireOnce(ctx: DriverContext, stats: DriverStats, args: WebhookRuntimeArgs): Promise<void> {
  // PR #1443 surface — fresh JWT (self-refreshing) + fresh DLQ row each pass.
  const orgAdminJwt = await currentOrgAdminJwt();
  const dlqId = await seedDlqRow(ctx, args, 'self-service');
  const plan = planWebhookSelfServiceRequests(ctx.apiBase, {
    orgAdminJwt,
    endpointId: args.endpointId,
    deliveryId: args.deliveryId,
    dlqId,
  });
  for (const spec of plan) {
    const headers = spec.headers
      ? iamAuthHeaders({ ...spec.headers, Authorization: `Bearer ${orgAdminJwt}` })
      : iamOnlyHeaders();
    const outcome = await fireLabeled({ stats, ...spec, headers });
    ctx.log(`${spec.label}: status=${outcome.status}`);
  }

  // Merged PR #1471 surface — API-key DLQ probes with their own fresh row.
  if (args.orgAdminKey) {
    const apiDlqId = await seedDlqRow(ctx, args, 'api-key-dlq');
    const apiPlan = planWebhookDlqApiKeyRequests(ctx.apiBase, {
      orgAdminKey: args.orgAdminKey,
      dlqId: apiDlqId,
    });
    for (const spec of apiPlan) {
      const headers = spec.headers ? iamAuthHeaders(spec.headers) : iamOnlyHeaders();
      const outcome = await fireLabeled({ stats, ...spec, headers });
      ctx.log(`${spec.label}: status=${outcome.status}`);
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
    label: WEBHOOKS_DRIVER.driver,
    stats,
    plan: (ctx) => runtimeArgs(ctx),
    fireOnce: (ctx, runtime) => fireOnce(ctx, stats, runtime as WebhookRuntimeArgs),
    // Keep the sustained soak below each router's rate budget and leave jitter
    // room for health checks / operator probes. Heavy-user testing belongs in
    // an explicit rate-limit scenario, not as accidental 429s in merge evidence.
    passIntervalMs: WEBHOOKS_PASS_INTERVAL_MS,
  });

  const evidence = summarizeEvidence(stats, { ...WEBHOOKS_DRIVER, apiBase });
  writeEvidenceFile(args.evidenceOut, evidence);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`::error::webhooks self-service driver failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
