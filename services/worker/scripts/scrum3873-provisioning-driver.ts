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
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export interface DriverArgs {
  mode: 'self-test' | 'live';
  targetUrl?: string;
  bearerToken?: string;
  nonAdminToken?: string;
  evidenceJsonl?: string;
  /** Domain claimed by a pre-seeded org, used to force the F2 collision. */
  collisionDomain?: string;
  supabaseUrl?: string;
  serviceRoleKey?: string;
  anonKey?: string;
  expectedHead?: string;
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
  + 'atomic initial ledger grant and stable replay with existing credits, real persisted quota/balance, '
  + 'explicit account placement verified through authenticated RLS, and honest activation delivery';

export function parseDriverArgs(argv: string[]): DriverArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const mode = argv.includes('--live') ? 'live' : 'self-test';
  return {
    mode,
    targetUrl: get('--target-url'),
    bearerToken: process.env.ADMIN_TOKEN ?? get('--bearer-token'),
    nonAdminToken: process.env.NONADMIN_TOKEN ?? get('--non-admin-token'),
    evidenceJsonl: get('--evidence-jsonl'),
    collisionDomain: get('--collision-domain'),
    supabaseUrl: process.env.SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    anonKey: process.env.SUPABASE_ANON_KEY,
    expectedHead: process.env.EXPECTED_SOURCE_HEAD,
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
  if (args.targetUrl && !args.targetUrl.startsWith('https://')) {
    blockers.push('--target-url must be https');
  }
  if (args.targetUrl && /vzwyaatejekddvltxyye|app\.arkova\.ai/.test(args.targetUrl)) {
    blockers.push('--target-url points at production; this driver creates orgs and accounts');
  }
  if (!args.collisionDomain) {
    // Without this the run never exercises the auto-association trigger, which
    // is the single mechanism the whole design is built around. A soak that
    // skips it is not evidence for this PR.
    blockers.push('--collision-domain is required in live mode: without it F2 is never exercised');
  }
  if (!args.supabaseUrl || !args.serviceRoleKey || !args.anonKey) {
    blockers.push('SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY are required for persisted-state and RLS checks');
  }
  if (args.supabaseUrl && (!/^https:\/\/[a-z]{20}\.supabase\.co$/.test(args.supabaseUrl)
      || /vzwyaatejekddvltxyye|fizyjojbebyalirtjjht/.test(args.supabaseUrl))) {
    blockers.push('SUPABASE_URL must identify an isolated project, not production/shared staging');
  }
  if (!args.expectedHead || !/^[0-9a-f]{40}$/.test(args.expectedHead)) {
    blockers.push('EXPECTED_SOURCE_HEAD is required to bind the live runtime to the reviewed source');
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
type LiveArgs = Required<Omit<DriverArgs, 'mode' | 'evidenceJsonl'>>;
interface ProbeContext {
  args: LiveArgs;
  db: SupabaseClient;
  counts: Record<string, number | boolean>;
  checks: Record<string, string>;
  stamp: string;
  orgName: string;
  createKey: string;
}

async function checkOrganizationCreation(ctx: ProbeContext): Promise<string | undefined> {
  const { args, checks, counts, stamp, orgName, createKey } = ctx;
  const { targetUrl, bearerToken, nonAdminToken } = args;
  // F1 — the platform-admin gate. Highest-value assertion: this endpoint mints
  // accounts, so an unauthorized 2xx here is a P0, not a test failure.
  const forbidden = await call(targetUrl, '/api/admin/organizations', nonAdminToken, {
    display_name: `Should Not Exist ${stamp}`, idempotency_key: randomUUID(),
  });
  checks.non_admin_blocked = forbidden.status === 403 ? 'pass' : `FAIL got ${forbidden.status}`;
  counts.non_admin_blocked = forbidden.status === 403;

  // Happy path — org with an explicit quota and starting credits.
  const created = await call(targetUrl, '/api/admin/organizations', bearerToken, {
    display_name: orgName, anchor_quota: 10, credits: 2, is_test: true,
    idempotency_key: createKey,
  });
  const org = (created.json.organization ?? {}) as Record<string, unknown>;
  checks.org_created = created.status === 201 ? 'pass' : `FAIL got ${created.status}`;
  counts.org_created = created.status === 201;
  // F8 — the resolved credit state must be what we asked for, not the seed
  // trigger's default.
  checks.quota_echoed = org.anchor_quota === 10 ? 'pass' : `FAIL got ${String(org.anchor_quota)}`;
  checks.credits_echoed = org.credits_balance === 2 ? 'pass' : `FAIL got ${String(org.credits_balance)}`;

  // F3 — a second submit of the same name must 409, not create a twin.
  const dup = await call(targetUrl, '/api/admin/organizations', bearerToken, {
    display_name: orgName, idempotency_key: randomUUID(),
  });
  checks.duplicate_rejected = dup.status === 409 && dup.json.code === 'org_exists' ? 'pass' : `FAIL got ${dup.status}`;
  counts.duplicate_rejected = dup.status === 409;

  // ...and the explicit override must still work, or the 409 is a dead end.
  const dupOk = await call(targetUrl, '/api/admin/organizations', bearerToken, {
    display_name: orgName, allow_duplicate_name: true, idempotency_key: randomUUID(),
  });
  checks.duplicate_override = dupOk.status === 201 ? 'pass' : `FAIL got ${dupOk.status}`;

  return typeof org.org_id === 'string' ? org.org_id : undefined;

}

async function checkAccountContracts(ctx: ProbeContext, orgId: string): Promise<Record<string, unknown>> {
  const { args, checks, counts, stamp } = ctx;
  const { targetUrl, bearerToken } = args;
  // Account creation, emailed path. On a mock rig no mail leaves, so
  // invite_email_sent is expected false and the link MUST come back — that is
  // exactly the F6 fallback and the thing most likely to regress silently.
  const acct = await call(targetUrl, '/api/admin/users', bearerToken, {
    email: `soak-${stamp}@arkova-soak.test`, full_name: 'Soak Account',
    role: 'ORG_ADMIN', org_id: orgId, org_role: 'owner', send_invite_email: true,
  });
  const account = (acct.json.account ?? {}) as Record<string, unknown>;
  checks.account_created = acct.status === 201 ? 'pass' : `FAIL got HTTP ${acct.status}`;
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

  return escAccount;
}

async function checkDomainCollision(ctx: ProbeContext, orgId: string): Promise<Record<string, unknown>> {
  const { args, checks, counts, stamp } = ctx;
  const { targetUrl, bearerToken, collisionDomain } = args;
  // ── F2: the email-domain collision. THE case this design exists for. ──
  // A pre-seeded org claims `collisionDomain`, so creating an account at that
  // domain drives auto_associate_profile_to_org_by_email_domain. The product
  // must either land the requested role or refuse with role_conflict — what it
  // must NEVER do is silently return 201 with a different, now-frozen role.
  const collide = await call(targetUrl, '/api/admin/users', bearerToken, {
    email: `collide-${stamp}@${collisionDomain}`, full_name: 'Collision Probe',
    role: 'ORG_ADMIN', org_id: orgId, org_role: 'owner', send_invite_email: false,
  });
  const collideAccount = (collide.json.account ?? {}) as Record<string, unknown>;
  if (collide.status === 201) {
    const roleOk = collideAccount.role === 'ORG_ADMIN';
    const orgOk = collideAccount.org_id === orgId;
    checks.collision_role_intact = roleOk
      ? 'pass'
      : `FAIL silently created with role ${String(collideAccount.role)} instead of ORG_ADMIN`;
    // Per-org isolation: the account must belong to the org we asked for, not
    // the domain-claiming one.
    checks.collision_org_isolation = orgOk
      ? 'pass'
      : `FAIL landed in org ${String(collideAccount.org_id)} instead of ${String(orgId)}`;
  } else if (collide.status === 409 && collide.json.code === 'role_conflict') {
    checks.collision_role_intact = 'pass';
    checks.collision_org_isolation = 'pass';
  } else {
    checks.collision_role_intact = `FAIL got HTTP ${collide.status}`;
    checks.collision_org_isolation = `FAIL got ${collide.status}`;
  }
  counts.collision_exercised = true;

  return collideAccount;
}

async function checkConcurrentCreation(ctx: ProbeContext): Promise<string | undefined> {
  const { args, checks, counts } = ctx;
  const { targetUrl, bearerToken } = args;
  const raceName = `Race Org ${randomUUID().slice(0, 8)}`;
  const raceKey = randomUUID();
  const [r1, r2] = await Promise.all([
    call(targetUrl, '/api/admin/organizations', bearerToken, { display_name: raceName, idempotency_key: raceKey, credits: 5 }),
    call(targetUrl, '/api/admin/organizations', bearerToken, { display_name: raceName, idempotency_key: raceKey, credits: 5 }),
  ]);
  const ids = new Set(
    [r1, r2]
      .filter((r) => r.status === 201)
      .map((r) => ((r.json.organization ?? {}) as Record<string, unknown>).org_id)
      .filter((id): id is string => typeof id === 'string'),
  );
  checks.concurrent_duplicate_guard = ids.size === 1 && r1.status === 201 && r2.status === 201
    ? 'pass'
    : `FAIL ${ids.size} distinct orgs from one double-submit (statuses ${r1.status}/${r2.status})`;
  counts.concurrent_distinct_orgs = ids.size;

  return [...ids][0];
}

async function checkPersistedCredits(ctx: ProbeContext, orgId: string, raceId: string | undefined): Promise<void> {
  const { args, db, checks, orgName, createKey } = ctx;
  const { targetUrl, bearerToken } = args;
  // Read persistence independently of the HTTP response. The old run3 driver
  // passed while replay reset balances and account confirmation granted B.
  const persisted = await db.from('org_credits').select('balance,anchor_quota').eq('org_id', orgId).single();
  checks.persisted_initial_credits_quota = !persisted.error && persisted.data?.balance === 2
    && persisted.data.anchor_quota === 10 ? 'pass' : 'FAIL persisted initial credit/quota mismatch';
  const raceCredits = await db.from('org_credits').select('balance').eq('org_id', raceId).single();
  const raceLedger = await db.from('org_credit_deductions').select('amount').eq('org_id', raceId);
  checks.concurrent_single_grant = !raceCredits.error && !raceLedger.error && raceCredits.data?.balance === 5
    && raceLedger.data?.length === 1 && raceLedger.data[0].amount === 5 ? 'pass' : 'FAIL repeated or missing concurrent grant';
  // Obtain the actor from the authenticated admin token, not a fixture label.
  const actor = await db.auth.getUser(bearerToken);
  const extraGrant = await db.rpc('admin_adjust_org_credit', { p_org_id: orgId, p_amount: 11,
    p_reason: 'Provisioning qualification existing-balance fixture', p_idempotency_key: randomUUID(), p_actor: actor.data.user?.id });
  const replay = await call(targetUrl, '/api/admin/organizations', bearerToken, {
    display_name: orgName, anchor_quota: 10, credits: 2, is_test: true, idempotency_key: createKey,
  });
  const afterReplay = await db.from('org_credits').select('balance').eq('org_id', orgId).single();
  const ledger = await db.from('org_credit_deductions').select('amount').eq('org_id', orgId);
  checks.replay_preserves_existing_balance = !extraGrant.error && extraGrant.data?.success === true
    && replay.status === 201 && !afterReplay.error && afterReplay.data?.balance === 13
    && !ledger.error && ledger.data?.length === 2 && ledger.data.reduce((sum, r) => sum + r.amount, 0) === 13
    ? 'pass' : 'FAIL replay changed persisted balance or ledger';
  const conflict = await call(targetUrl, '/api/admin/organizations', bearerToken, {
    display_name: orgName, anchor_quota: 10, credits: 3, is_test: true, idempotency_key: createKey,
  });
  checks.replay_payload_conflict = conflict.status === 409 && conflict.json.code === 'idempotency_key_conflict'
    ? 'pass' : 'FAIL conflicting replay was not rejected';
}

async function tenantCheck(
  ctx: ProbeContext, foreignIds: string[], userId: unknown, expectedOrg: string | null, name: string,
): Promise<void> {
    const { db, args, checks } = ctx;
    if (typeof userId !== 'string') { checks[name] = 'FAIL missing created account'; return; }
    const profile = await db.from('profiles').select('org_id,is_platform_admin').eq('id', userId).single();
    const memberships = await db.from('org_members').select('org_id').eq('user_id', userId);
    const memberIds = (memberships.data ?? []).map((r) => r.org_id);
    checks[name + '_persistence'] = !profile.error && !memberships.error && profile.data?.org_id === expectedOrg
      && profile.data.is_platform_admin === false && memberIds.length === Number(expectedOrg !== null)
      && (!expectedOrg || memberIds[0] === expectedOrg) ? 'pass' : 'FAIL explicit account placement not preserved';
    const password = randomUUID() + randomUUID();
    const updated = await db.auth.admin.updateUserById(userId, { password });
    const client = createClient(args.supabaseUrl, args.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const signed = await client.auth.signInWithPassword({ email: updated.data.user?.email ?? '', password });
    const visible = await client.from('organizations').select('id').in('id', foreignIds);
    checks[name + '_authenticated_rls'] = !updated.error && !signed.error && !visible.error
      && visible.data.length === 0 ? 'pass' : 'FAIL foreign tenant visible to created account';
    if (expectedOrg) {
      const own = await client.from('organizations').select('id').eq('id', expectedOrg);
      checks[name + '_own_org_visible'] = !own.error && own.data.length === 1 ? 'pass' : 'FAIL selected org missing';
    }
    await client.auth.signOut();
  }

async function checkTenantAuthority(ctx: ProbeContext, orgId: string, escAccount: Record<string, unknown>, collideAccount: Record<string, unknown>): Promise<void> {
  const { args, db, checks, stamp } = ctx;
  const { targetUrl, bearerToken, collisionDomain } = args;
  const domainOrgs = await db.from('organizations').select('id').ilike('domain', collisionDomain);
  const foreignIds = (domainOrgs.data ?? []).map((r) => r.id);
  checks.collision_fixture_exists = !domainOrgs.error && foreignIds.length > 0 ? 'pass' : 'FAIL collision fixture absent';
  await tenantCheck(ctx, foreignIds, collideAccount.user_id, orgId ?? null, 'selected_org');
  const individual = await call(targetUrl, '/api/admin/users', bearerToken, {
    email: `individual-${stamp}@${collisionDomain}`, role: 'INDIVIDUAL', send_invite_email: false,
  });
  await tenantCheck(ctx, foreignIds, (individual.json.account as Record<string, unknown> | undefined)?.user_id, null, 'individual');
  const privilege = await db.from('profiles').select('is_platform_admin').eq('id', escAccount.user_id).single();
  checks.no_persisted_admin_escalation = !privilege.error && privilege.data?.is_platform_admin === false ? 'pass' : 'FAIL admin escalation';
  // An ordinary verified domain signup must still join its domain organization.
  // Forging user_metadata.admin_provisioned must not activate the trusted guard.
  const ordinary = await db.auth.admin.createUser({ email: `ordinary-${stamp}@${collisionDomain}`,
    email_confirm: true, user_metadata: { admin_provisioned: true } });
  const ordinaryMembership = await db.from('org_members').select('org_id').eq('user_id', ordinary.data.user?.id);
  checks.ordinary_domain_signup_preserved = !ordinary.error && !ordinaryMembership.error
    && ordinaryMembership.data?.some((r) => foreignIds.includes(r.org_id)) ? 'pass' : 'FAIL ordinary signup or metadata authority';
}

export async function runCycle(args: LiveArgs): Promise<CycleResult> {
  const ctx: ProbeContext = {
    args,
    db: createClient(args.supabaseUrl, args.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } }),
    counts: {}, checks: {}, stamp: randomUUID().slice(0, 8), orgName: `Soak Org ${randomUUID()}`, createKey: randomUUID(),
  };
  const { checks, counts } = ctx;
  const healthResponse = await fetch(`${args.targetUrl}/health`);
  const health = await healthResponse.json() as { git_sha?: string };
  checks.exact_runtime_head = healthResponse.ok && health.git_sha === args.expectedHead ? 'pass' : 'FAIL runtime source identity mismatch';
  if (checks.exact_runtime_head !== 'pass') return { counts, checks, ok: false };
  const orgId = await checkOrganizationCreation(ctx);
  if (!orgId) return { counts, checks, ok: false };
  const escAccount = await checkAccountContracts(ctx, orgId);
  const collideAccount = await checkDomainCollision(ctx, orgId);
  const raceId = await checkConcurrentCreation(ctx);
  await checkPersistedCredits(ctx, orgId, raceId);
  await checkTenantAuthority(ctx, orgId, escAccount, collideAccount);
  if (Object.values(checks).some((value) => value.includes('429'))) {
    checks.rate_limited = 'FAIL admin rate limit exceeded; row is not qualification evidence';
  }
  const ok = Object.values(checks).every((value) => value === 'pass');
  counts.checks_total = Object.keys(checks).length;
  counts.checks_passed = Object.values(checks).filter((value) => value === 'pass').length;
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
    console.log('Provisioning probe complete:', row.status === 'pass' ? 'pass' : 'fail');
    return;
  }

  if (blockers.length > 0) {
    const row = buildRow('live', { counts: {}, checks: {}, ok: false }, args.targetUrl, blockers);
    if (args.evidenceJsonl) appendFileSync(args.evidenceJsonl, `${JSON.stringify(row)}\n`);
    console.error('Provisioning probe blocked: required isolated-runtime configuration is missing or unsafe.');
    process.exit(1);
  }

  const result = await runCycle({
    targetUrl: args.targetUrl!,
    bearerToken: args.bearerToken!,
    nonAdminToken: args.nonAdminToken!,
    collisionDomain: args.collisionDomain!,
    supabaseUrl: args.supabaseUrl!, serviceRoleKey: args.serviceRoleKey!, anonKey: args.anonKey!, expectedHead: args.expectedHead!,
  });
  const row = buildRow('live', result, args.targetUrl);
  if (args.evidenceJsonl) appendFileSync(args.evidenceJsonl, `${JSON.stringify(row)}\n`);
  console.log('Provisioning probe complete:', row.status === 'pass' ? 'pass' : 'fail');
  if (!result.ok) process.exit(1);
}

const invokedDirectly = process.argv[1]?.endsWith('scrum3873-provisioning-driver.ts');
if (invokedDirectly) {
  try {
    await main();
  } catch {
    console.error('Provisioning probe failed unexpectedly; qualification must stop.');
    process.exit(1);
  }
}
