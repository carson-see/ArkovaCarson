#!/usr/bin/env tsx
/**
 * SCRUM-3873 platform-admin provisioning admission driver.
 *
 * Exercises the behavior THIS PR changed, not generic worker health: §1.12
 * says synthetic load that does not cover the changed path is supporting
 * evidence only. Each cycle drives both new endpoints plus the negative paths
 * the pre-mortem identified, because those are the ones that fail silently.
 *
 * Self-test mode is local validation only; rows are marked
 * evidenceForSoak=false and must NOT be used as T3 soak evidence. Live mode
 * requires an admitted isolated rig and a platform-admin bearer token, and
 * writes countable JSONL rows.
 */

import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export interface DriverArgs {
  mode: 'self-test' | 'live';
  targetUrl?: string;
  bearerToken?: string;
  nonAdminToken?: string;
  evidenceJsonl?: string;
}

export interface DriverRow {
  utc: string;
  story: 'SCRUM-3873';
  tier: 'T3';
  mode: 'self-test' | 'live';
  evidenceForSoak: boolean;
  changedBehavior: string;
  status: 'pass' | 'fail';
  counts: Record<string, number | boolean>;
  checks: Record<string, string>;
  targetUrl?: string;
  blockers?: string[];
}

export const CHANGED_BEHAVIOR =
  'SCRUM-3873 platform-admin provisioning: create-organization and create-account endpoints, '
  + 'the platform-admin gate (per-handler and router-level), duplicate-name 409 + override, '
  + 'org_credits upsert with resolved quota/credit state, starting credits booked through the '
  + 'admin_adjust_org_credit ledger, and delivery reported on the ACTUAL send result';

export function parseDriverArgs(argv: string[]): DriverArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const mode = argv.includes('--live') ? 'live' : 'self-test';
  return {
    mode,
    targetUrl: get('--target-url'),
    bearerToken: get('--bearer-token'),
    nonAdminToken: get('--non-admin-token'),
    evidenceJsonl: get('--evidence-jsonl'),
  };
}

/** A live run without a target or admin token is not evidence — fail loudly. */
export function validateLiveArgs(args: DriverArgs): string[] {
  const blockers: string[] = [];
  if (args.mode !== 'live') return blockers;
  if (!args.targetUrl) blockers.push('--target-url is required in live mode');
  if (!args.bearerToken) blockers.push('--bearer-token (platform admin) is required in live mode');
  if (!args.nonAdminToken) {
    blockers.push('--non-admin-token is required in live mode: the 403 path is the highest-value assertion here');
  }
  if (args.targetUrl && !/^https:\/\//.test(args.targetUrl)) {
    blockers.push('--target-url must be https');
  }
  if (args.targetUrl && /vzwyaatejekddvltxyye|app\.arkova\.ai/.test(args.targetUrl)) {
    blockers.push('--target-url points at production; this driver creates orgs and accounts');
  }
  return blockers;
}

interface CycleResult {
  counts: Record<string, number | boolean>;
  checks: Record<string, string>;
  ok: boolean;
}

/**
 * The whole /admin router shares rateLimiters.checkout: 10 requests per
 * minute. A cycle makes 11 calls, so an unpaced driver trips a 429 on its last
 * assertion every time and reports a failing soak for a limit it is itself
 * breaching. Pacing is correct client behaviour, not a workaround — but note
 * that 10/min is shared with the console's own list endpoints, so a real admin
 * onboarding two partners in a sitting will hit this too.
 */
const CALL_SPACING_MS = 7000;
let lastCallAt = 0;

async function pace(): Promise<void> {
  const wait = CALL_SPACING_MS - (Date.now() - lastCallAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

async function call(
  targetUrl: string,
  path: string,
  token: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  await pace();
  const res = await fetch(`${targetUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  let json: Record<string, unknown> = {};
  try { json = (await res.json()) as Record<string, unknown>; } catch { /* empty body */ }
  return { status: res.status, json };
}

/**
 * One full cycle. Every assertion maps to a pre-mortem failure mode, so a
 * regression shows up as a named check rather than a generic 500 count.
 */
export async function runCycle(args: Required<Pick<DriverArgs, 'targetUrl' | 'bearerToken' | 'nonAdminToken'>>): Promise<CycleResult> {
  const { targetUrl, bearerToken, nonAdminToken } = args;
  const counts: Record<string, number | boolean> = {};
  const checks: Record<string, string> = {};
  const stamp = randomUUID().slice(0, 8);
  const orgName = `Soak Org ${stamp}`;

  // F1 — the platform-admin gate. Highest-value assertion: this endpoint mints
  // accounts, so an unauthorized 2xx here is a P0, not a test failure.
  const forbidden = await call(targetUrl, '/api/admin/organizations', nonAdminToken, { display_name: `Should Not Exist ${stamp}` });
  checks.non_admin_blocked = forbidden.status === 403 ? 'pass' : `FAIL got ${forbidden.status}`;
  counts.non_admin_blocked = forbidden.status === 403;

  // Happy path — org with an explicit quota and starting credits.
  const created = await call(targetUrl, '/api/admin/organizations', bearerToken, {
    display_name: orgName, anchor_quota: 10, credits: 2, is_test: true,
  });
  const org = (created.json.organization ?? {}) as Record<string, unknown>;
  checks.org_created = created.status === 201 ? 'pass' : `FAIL got ${created.status}`;
  counts.org_created = created.status === 201;
  // F8 — the resolved credit state must be what we asked for, not the seed
  // trigger's default.
  checks.quota_echoed = org.anchor_quota === 10 ? 'pass' : `FAIL got ${String(org.anchor_quota)}`;
  checks.credits_echoed = org.credits_balance === 2 ? 'pass' : `FAIL got ${String(org.credits_balance)}`;

  // F3 — a second submit of the same name must 409, not create a twin.
  const dup = await call(targetUrl, '/api/admin/organizations', bearerToken, { display_name: orgName });
  checks.duplicate_rejected = dup.status === 409 && dup.json.code === 'org_exists' ? 'pass' : `FAIL got ${dup.status}`;
  counts.duplicate_rejected = dup.status === 409;

  // ...and the explicit override must still work, or the 409 is a dead end.
  const dupOk = await call(targetUrl, '/api/admin/organizations', bearerToken, {
    display_name: orgName, allow_duplicate_name: true,
  });
  checks.duplicate_override = dupOk.status === 201 ? 'pass' : `FAIL got ${dupOk.status}`;

  const orgId = typeof org.org_id === 'string' ? org.org_id : undefined;

  // Account creation, emailed path. On a mock rig no mail leaves, so
  // invite_email_sent is expected false and the link MUST come back — that is
  // exactly the F6 fallback and the thing most likely to regress silently.
  const acct = await call(targetUrl, '/api/admin/users', bearerToken, {
    email: `soak-${stamp}@arkova-soak.test`, full_name: 'Soak Account',
    role: 'ORG_ADMIN', org_id: orgId, org_role: 'owner', send_invite_email: true,
  });
  const account = (acct.json.account ?? {}) as Record<string, unknown>;
  checks.account_created = acct.status === 201 ? 'pass' : `FAIL got ${acct.status} ${String(acct.json.error ?? '')}`;
  counts.account_created = acct.status === 201;
  const delivered = account.invite_email_sent === true || typeof account.activation_link === 'string';
  checks.delivery_reported_honestly = delivered ? 'pass' : 'FAIL neither a send nor a link was reported';

  // Same address twice must be account_exists, never a second auth user.
  const dupAcct = await call(targetUrl, '/api/admin/users', bearerToken, {
    email: `soak-${stamp}@arkova-soak.test`, role: 'INDIVIDUAL', send_invite_email: false,
  });
  checks.duplicate_account_rejected = dupAcct.status === 409 ? 'pass' : `FAIL got ${dupAcct.status}`;

  // Contract guards.
  const badShape = await call(targetUrl, '/api/admin/users', bearerToken, {
    email: `bad-${stamp}@arkova-soak.test`, role: 'INDIVIDUAL', org_id: orgId,
  });
  checks.individual_with_org_rejected = badShape.status === 400 ? 'pass' : `FAIL got ${badShape.status}`;

  // F1 again — is_platform_admin must not be honoured as an input.
  const escalate = await call(targetUrl, '/api/admin/users', bearerToken, {
    email: `esc-${stamp}@arkova-soak.test`, role: 'INDIVIDUAL',
    send_invite_email: false, is_platform_admin: true,
  });
  const escAccount = (escalate.json.account ?? {}) as Record<string, unknown>;
  checks.platform_admin_not_grantable =
    escalate.status === 201 && !('is_platform_admin' in escAccount) ? 'pass' : `FAIL ${escalate.status}`;

  // A 429 is the driver outrunning the shared admin rate limit, not the
  // feature misbehaving. Surface it distinctly so it can never be read as a
  // behavioural regression — or quietly counted as a pass.
  const rateLimited = Object.values(checks).some((v) => v.includes('429'));
  if (rateLimited) checks.rate_limited = 'FAIL driver exceeded the 10/min admin limit; row is not behavioural evidence';
  const ok = Object.values(checks).every((v) => v === 'pass');
  counts.checks_total = Object.keys(checks).length;
  counts.checks_passed = Object.values(checks).filter((v) => v === 'pass').length;
  return { counts, checks, ok };
}

export function buildRow(
  mode: 'self-test' | 'live',
  result: CycleResult,
  targetUrl?: string,
  blockers?: string[],
): DriverRow {
  return {
    utc: new Date().toISOString(),
    story: 'SCRUM-3873',
    tier: 'T3',
    mode,
    evidenceForSoak: mode === 'live' && (blockers?.length ?? 0) === 0,
    changedBehavior: CHANGED_BEHAVIOR,
    status: result.ok && (blockers?.length ?? 0) === 0 ? 'pass' : 'fail',
    counts: result.counts,
    checks: result.checks,
    targetUrl,
    ...(blockers && blockers.length > 0 ? { blockers } : {}),
  };
}

async function main(): Promise<void> {
  const args = parseDriverArgs(process.argv.slice(2));
  const blockers = validateLiveArgs(args);

  if (args.mode === 'self-test') {
    // Shape-only validation: proves the driver runs and its row schema is
    // well-formed. Deliberately NOT evidence.
    const row = buildRow('self-test', { counts: { checks_total: 0 }, checks: {}, ok: true });
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(row));
    return;
  }

  if (blockers.length > 0) {
    const row = buildRow('live', { counts: {}, checks: {}, ok: false }, args.targetUrl, blockers);
    // eslint-disable-next-line no-console
    console.error(JSON.stringify(row, null, 2));
    process.exit(1);
  }

  const result = await runCycle({
    targetUrl: args.targetUrl!,
    bearerToken: args.bearerToken!,
    nonAdminToken: args.nonAdminToken!,
  });
  const row = buildRow('live', result, args.targetUrl);
  if (args.evidenceJsonl) appendFileSync(args.evidenceJsonl, `${JSON.stringify(row)}\n`);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(row));
  if (!result.ok) process.exit(1);
}

const invokedDirectly = process.argv[1]?.endsWith('scrum3873-provisioning-driver.ts');
if (invokedDirectly) {
  main().catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
