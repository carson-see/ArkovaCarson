#!/usr/bin/env -S npx tsx
/**
 * scripts/staging/targeted/webhooks-self-service-driver.ts  (PR #1443 — webhooks)
 *
 * TARGETED soak driver for the ORG_ADMIN webhook self-service surface:
 *   - test         POST /api/v1/webhooks/self-service/:id/test                  (WH-02)
 *   - replay       POST /api/v1/webhooks/self-service/deliveries/:id/replay     (WH-03)
 *   - dlq-list     GET  /api/v1/webhooks/self-service/dlq                       (WH-03)
 *   - dlq-resolve  POST /api/v1/webhooks/self-service/dlq/:id/resolve           (WH-03)
 * plus an unauthenticated negative (401) proving the Supabase JWT gate.
 *
 * All authenticated calls carry an ORG_ADMIN Supabase JWT. Cloud Run IAM auth,
 * when needed, rides in X-Serverless-Authorization via runtime.iamAuthHeaders()
 * so the app Authorization header remains the Supabase session token used by
 * the dashboard. The driver seeds an unresolved DLQ row
 * (fixtures.buildDlqFixtureRow) so dlq-list returns ≥1 row and dlq-resolve has
 * a target to flip.
 *
 * Env:
 *   STAGING_API_BASE            REQUIRED per-PR tag URL
 *   STAGING_WEBHOOK_ORG_ADMIN_JWT REQUIRED ORG_ADMIN Supabase JWT
 *   STAGING_WEBHOOK_ORG_ADMIN_REFRESH_TOKEN optional; required for long soaks
 *   STAGING_WEBHOOK_ENDPOINT_ID REQUIRED existing endpoint id for test/replay
 *   STAGING_WEBHOOK_DELIVERY_ID  optional delivery id for replay; a seeded/known id
 *   STAGING_FIXTURE_ORG_ID       REQUIRED org id owning the seeded DLQ row
 *   STAGING_GCP_IDENTITY         optional pre-fetched Cloud Run IAM token
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
export const WEBHOOKS_PASS_INTERVAL_MS = 65_000;

// ─── Pure plan (unit-tested) ────────────────────────────────────────────────

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
  const { createClient } = await import('@supabase/supabase-js');
  const authClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await authClient.auth.refreshSession({
    refresh_token: webhookAuthSession.refreshToken,
  });
  if (error || !data.session?.access_token) {
    throw error ?? new Error('Supabase refresh returned no access token');
  }

  webhookAuthSession = {
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token ?? webhookAuthSession.refreshToken,
    expiresAtMs: data.session.expires_at ? data.session.expires_at * 1000 : jwtExpiresAtMs(data.session.access_token),
  };
  return webhookAuthSession.accessToken;
}

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
    // dlq resolve → flips the seeded row's resolved flag; 200 or 404 (already gone).
    mk('dlq-resolve', 'POST', `/dlq/${args.dlqId}/resolve`, [200, 404]),
    // unauthenticated negative → Supabase JWT gate returns 401.
    mk('unauthenticated', 'GET', '/dlq', [401], undefined, false),
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

async function seedAndPlan(ctx: DriverContext): Promise<WebhookRequestSpec[]> {
  const orgAdminJwt = requireEnv('STAGING_WEBHOOK_ORG_ADMIN_JWT', 'webhooks self-service driver');
  initWebhookAuthSession(orgAdminJwt);
  const endpointId = requireEnv('STAGING_WEBHOOK_ENDPOINT_ID', 'webhooks self-service driver');
  const orgId = requireEnv('STAGING_FIXTURE_ORG_ID', 'webhooks self-service driver');
  const deliveryId = process.env.STAGING_WEBHOOK_DELIVERY_ID ?? 'TSOAK-DEL-000000000000';

  const dlqRow = buildDlqFixtureRow({ orgId, endpointId });
  const inserted = await seedViaServiceRole('webhook_dead_letter_queue', [dlqRow]);
  const dlqId = dlqIdFromInsert(inserted);
  ctx.log(`seeded DLQ row id=${dlqId} org=${orgId}`);

  return planWebhookSelfServiceRequests(ctx.apiBase, { orgAdminJwt, endpointId, deliveryId, dlqId });
}

async function fireOnce(ctx: DriverContext, stats: DriverStats, plan: WebhookRequestSpec[]): Promise<void> {
  const orgAdminJwt = await currentOrgAdminJwt();
  for (const spec of plan) {
    const headers = spec.headers
      ? iamAuthHeaders({ ...spec.headers, Authorization: `Bearer ${orgAdminJwt}` })
      : iamOnlyHeaders();
    const outcome = await fireLabeled({ stats, ...spec, headers });
    ctx.log(`${spec.label}: status=${outcome.status}`);
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
    plan: (ctx) => seedAndPlan(ctx),
    fireOnce: (ctx, plan) => fireOnce(ctx, stats, plan as WebhookRequestSpec[]),
    // Five branch probes per pass behind the batch limiter: keep the sustained
    // soak below the 10 req/min route budget, and leave jitter room for health
    // checks / operator probes. Heavy-user testing belongs in an explicit
    // rate-limit scenario, not as accidental 429s in merge evidence.
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
