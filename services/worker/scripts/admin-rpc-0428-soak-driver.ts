#!/usr/bin/env -S npx tsx
/**
 * 0428 soak driver — admin profile RPCs, hot-table DDL removal.
 *
 * WHY THIS EXISTS (CLAUDE.md §1.12): "Soak evidence must exercise the PR's
 * changed behavior; generic synthetic load is supporting worker-health evidence
 * only." Nothing in the generic soak drivers ever calls the three RPCs 0428
 * changes, so a green worker-health soak would be fully compatible with 0428
 * being broken. Every assertion below targets behaviour that can only regress
 * BECAUSE of 0428.
 *
 * C1–C3 invoke the RPCs over PostgREST with the service-role key — the exact
 * path services/worker/src/api/admin-actions.ts uses (its `db` client is
 * service_role over PostgREST), so the trigger-visible session state
 * (`request.jwt.claims`, the `role` GUC) is identical to production. C4–C8
 * use SQL sessions with explicit service-role claims; C10–C11 use independent
 * persistent PostgreSQL connections to establish controlled overlap.
 *
 * Per cycle:
 *   C1  admin_change_user_role   flips a role, and the DB reflects it
 *   C2  admin_set_platform_admin flips the flag, and the DB reflects it
 *   C3  admin_set_user_org       assigns/clears an org + org_members row
 *   C4  REGRESSION GUARD: worker-shaped direct backfill of an INDIVIDUAL
 *       (invitations.ts / admin-org-members.ts shape) must STILL be rejected
 *   C5  REGRESSION GUARD: same shape where role IS NULL must still succeed
 *       and must still stamp role_set_at
 *   C6  FLAG-LEAK PROBE: a direct role change on a SEPARATE request, issued
 *       right after the RPC, must still be rejected (proves the
 *       transaction-local flag cannot escape the RPC's own transaction)
 *   C7  no trigger on `profiles` is left with tgenabled <> 'O'
 *   C8  no ShareRowExclusiveLock is ever observed on `profiles`
 *   C9  worker /health (supporting evidence only)
 *   C10 CONCURRENT flag isolation — while one session holds the flag inside a
 *       live transaction, a DIFFERENT session must still be refused a direct
 *       role change. This is the invariant the flag design introduces, and a
 *       sequential probe cannot establish it.
 *   C11 the REAL controlled lock experiment — hold a conflicting writer open,
 *       fire each changed RPC, then time an innocent write to a THIRD row
 *       inside PostgreSQL and observe pg_locks/pg_blocking_pids. The old
 *       functions queue a table-wide barrier; the replacement must not.
 *
 * Writes one JSON line per cycle. Any assertion failure sets ok=false and is
 * a soak kill criterion (see docs/staging/admin-rpc-ddl-0428/PRE-MORTEM.md).
 */

import { runFlagIsolation, runLockExperiment, validateProbeTarget } from './admin-rpc-0428-lock-probe.js';

const REF = process.env.RIG_PROJECT_REF ?? '';
const MGMT = process.env.SUPABASE_ACCESS_TOKEN ?? '';
const SERVICE_KEY = process.env.RIG_SERVICE_ROLE_KEY ?? '';
const MAX_CYCLES = Number(process.env.MAX_CYCLES ?? 0);
const DB_ENV = { PGHOST: process.env.RIG_DB_HOST, PGPORT: process.env.RIG_DB_PORT ?? '5432', PGUSER: process.env.RIG_DB_USER ?? 'postgres', PGPASSWORD: process.env.RIG_DB_PASSWORD, PGDATABASE: 'postgres', PGSSLMODE: 'verify-full', PGSSLROOTCERT: process.env.RIG_DB_SSLROOTCERT ?? 'system' };
const WORKER = process.env.RIG_WORKER_URL ?? '';
const WORKER_ID_TOKEN = process.env.RIG_WORKER_ID_TOKEN ?? '';
const CYCLE_MS = Number(process.env.CYCLE_MS ?? 15 * 60 * 1000);
const LOCK_EXPERIMENT_EVERY = Number(process.env.LOCK_EXPERIMENT_EVERY ?? 4);
const MANAGEMENT_API_TIMEOUT_MS = Number(process.env.MANAGEMENT_API_TIMEOUT_MS ?? 60_000);

if (!REF || !MGMT || !SERVICE_KEY) {
  console.error('RIG_PROJECT_REF, SUPABASE_ACCESS_TOKEN and RIG_SERVICE_ROLE_KEY are required');
  process.exit(2);
}

validateProbeTarget(REF, DB_ENV);
if (!Number.isSafeInteger(MAX_CYCLES) || MAX_CYCLES < 0 || !Number.isSafeInteger(LOCK_EXPERIMENT_EVERY) || LOCK_EXPERIMENT_EVERY < 1 || !Number.isFinite(CYCLE_MS) || CYCLE_MS < 1) throw new Error('Invalid bounded cycle settings');

const TARGET = '0428a11d-0000-4000-8000-000000000002';
const INDIV = '0428a11d-0000-4000-8000-000000000003';
const INNOCENT = '0428a11d-0000-4000-8000-000000000004';
const ORG = '0428a11d-0000-4000-8000-0000000000ff';

/** Privileged fixture SQL over the Management API, scoped to the admitted isolated rig. */
async function sql(query: string): Promise<{ rows: unknown[]; error?: string }> {
  // Bounded: this driver is unattended for 48 h and its whole output contract
  // is one JSON line per cycle. A hung Management API call with no timeout
  // stalls the cycle indefinitely and emits nothing, which reads as "the soak
  // stopped" rather than "one request hung".
  let res: Response;
  try {
    res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${MGMT}`, 'Content-Type': 'application/json', 'User-Agent': 'Arkova-release-review/1.0' },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(MANAGEMENT_API_TIMEOUT_MS),
    });
  } catch (e) {
    return { rows: [], error: `request failed: ${(e as Error).message}` };
  }
  const text = await res.text();
  if (!res.ok) return { rows: [], error: `${res.status} ${text.slice(0, 400)}` };
  try {
    return { rows: JSON.parse(text) as unknown[] };
  } catch {
    return { rows: [], error: `unparseable: ${text.slice(0, 200)}` };
  }
}

/** Exercise the actual PostgREST RPC transport used by the worker. */
async function postgrestRpc(name: string, args: Record<string, unknown>): Promise<void> {
  const response = await fetch(`https://${REF}.supabase.co/rest/v1/rpc/${name}`, {
    method: 'POST', headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args), signal: AbortSignal.timeout(MANAGEMENT_API_TIMEOUT_MS),
  });
  await response.arrayBuffer();
  if (!response.ok) throw new Error(`${name}: PostgREST returned ${response.status}`);
}

/**
 * Run a statement the way PostgREST would: as service_role, with service_role
 * JWT claims set, in its own transaction. This is what makes the trigger see
 * exactly what it sees in production.
 */
function asServiceRole(body: string): string {
  return `BEGIN;
SET LOCAL ROLE service_role;
SET LOCAL request.jwt.claims = '{"role":"service_role"}';
${body}
COMMIT;`;
}

async function expectOk(label: string, query: string) {
  const r = await sql(query);
  if (r.error) throw new Error(`${label}: expected success, got ${r.error}`);
  return r.rows;
}

async function expectRejected(label: string, query: string, needle: string) {
  const r = await sql(query);
  if (!r.error) throw new Error(`${label}: expected rejection, but it SUCCEEDED — kill criterion`);
  if (!r.error.includes(needle)) {
    throw new Error(`${label}: rejected for the wrong reason (want ${needle}): ${r.error.slice(0, 200)}`);
  }
}

async function scalar(label: string, query: string): Promise<string> {
  const rows = await expectOk(label, query);
  const row = (rows[0] ?? {}) as Record<string, unknown>;
  return String(Object.values(row)[0]);
}

/**
 * Reset the fixture to a known state at the top of every cycle.
 *
 * Deliberately does NOT reset roles with a direct UPDATE: `role` is immutable
 * once set, so a direct reset is (correctly) rejected by the very trigger under
 * test. The reset therefore goes through the authorized RPC, which is also a
 * free extra exercise of the changed path. INDIV is never mutated — C4's UPDATE
 * raises and rolls its own transaction back — so it needs no reset.
 */
async function resetFixture() {
  await expectOk(
    'fixture reset (org/member/flag)',
    asServiceRole(
      `SELECT admin_set_user_org('${TARGET}', NULL);
       SELECT admin_set_platform_admin('${TARGET}', false);`,
    ),
  );
  await expectOk('fixture reset (role via RPC)', asServiceRole(`SELECT admin_change_user_role('${TARGET}','INDIVIDUAL');`));
}

/**
 * The `role IS NULL` backfill case needs a profile whose role has never been
 * set, and nothing may legitimately reset a role back to NULL. So each cycle
 * mints its own throwaway user and drops it again.
 */
async function withFreshProfile<T>(n: number, fn: (id: string) => Promise<T>): Promise<T> {
  const id = `0428f00d-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const email = `soak-0428-fresh-${n}@arkova-soak.invalid`;
  // The supervisor restarts the driver at n=1, so this slot may still hold a
  // row from an earlier run whose `finally` cleanup was cut short by the kill.
  // That row already has a role set, which would make C5 fail spuriously —
  // a phantom kill-criterion hit. Clear the slot first; this is idempotent.
  const purge = `DELETE FROM public.org_members WHERE user_id='${id}';
     DELETE FROM public.profiles WHERE id='${id}';
     DELETE FROM auth.users WHERE id='${id}';`;
  await expectOk('fresh profile slot clear', purge);
  await expectOk(
    'fresh profile create',
    `INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
     VALUES ('${id}','00000000-0000-0000-0000-000000000000','authenticated','authenticated','${email}',
             crypt('soak-0428-not-a-real-login', gen_salt('bf')), now(), now(), now(),
             '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb)
     ON CONFLICT (id) DO NOTHING;
     INSERT INTO public.profiles (id, email, role, org_id, is_platform_admin, role_set_at)
     VALUES ('${id}','${email}',NULL,NULL,false,NULL)
     ON CONFLICT (id) DO UPDATE SET org_id=NULL;`,
  );
  try {
    return await fn(id);
  } finally {
    await expectOk('fresh profile cleanup', purge);
  }
}

async function cycle(n: number): Promise<Record<string, unknown>> {
  const rec: Record<string, unknown> = { cycle: n, at: new Date().toISOString() };
  await resetFixture();

  // C1 — the RPC changes a role, with no DDL.
  await postgrestRpc('admin_change_user_role', { p_user_id: TARGET, p_new_role: 'ORG_ADMIN' });
  const role = await scalar('C1 role readback', `SELECT role::text FROM public.profiles WHERE id='${TARGET}'`);
  if (role !== 'ORG_ADMIN') throw new Error(`C1: role did not land, got ${role}`);
  rec.c1_role = role;

  // C2 — the flag flips, and the read-back assertion did not spuriously fire.
  await postgrestRpc('admin_set_platform_admin', { p_user_id: TARGET, p_is_admin: true });
  const flag = await scalar('C2 flag readback', `SELECT is_platform_admin::text FROM public.profiles WHERE id='${TARGET}'`);
  if (flag !== 'true') throw new Error(`C2: flag did not land, got ${flag}`);
  rec.c2_flag = flag;

  // C3 — org assignment + org_members upsert.
  await postgrestRpc('admin_set_user_org', { p_user_id: TARGET, p_org_id: ORG, p_org_role: 'admin' });
  const orgId = await scalar('C3 org readback', `SELECT coalesce(org_id::text,'<null>') FROM public.profiles WHERE id='${TARGET}'`);
  if (orgId !== ORG) throw new Error(`C3: org_id did not land, got ${orgId}`);
  const memberRole = await scalar('C3 member readback', `SELECT role::text FROM public.org_members WHERE user_id='${TARGET}' AND org_id='${ORG}'`);
  if (memberRole !== 'admin') throw new Error('C3: org_members admin role did not land');
  rec.c3_org = orgId;
  rec.c3_member_role = memberRole;

  // C4 — REGRESSION GUARD. The worker's DIRECT backfill (invitations.ts:210,
  // admin-org-members.ts:297) on an INDIVIDUAL with no org must STILL raise.
  // If this ever succeeds, the exemption has widened past the RPC and real
  // users' roles are being silently rewritten. Kill criterion.
  await expectRejected(
    'C4 worker backfill on INDIVIDUAL',
    asServiceRole(
      `UPDATE public.profiles SET org_id='${ORG}', role='ORG_MEMBER' WHERE id='${INDIV}' AND org_id IS NULL;`,
    ),
    'Role cannot be changed once set',
  );
  rec.c4_backfill_still_blocked = true;

  // C5 — the same shape where role IS NULL must still work, and still stamp.
  await withFreshProfile(n, async (freshId) => {
    await expectOk(
      'C5 worker backfill on fresh profile',
      asServiceRole(`UPDATE public.profiles SET org_id='${ORG}', role='ORG_MEMBER' WHERE id='${freshId}' AND org_id IS NULL;`),
    );
    const stamped = await scalar('C5 stamp readback', `SELECT (role_set_at IS NOT NULL)::text FROM public.profiles WHERE id='${freshId}'`);
    if (stamped !== 'true') throw new Error('C5: role_set_at was not stamped');
  });
  rec.c5_fresh_backfill_ok = true;

  // C6 — FLAG-LEAK PROBE. A separate request issued right after the RPC must
  // still be rejected; the transaction-local flag must not have escaped.
  await expectOk('C6 setup', asServiceRole(`SELECT admin_change_user_role('${TARGET}','ORG_MEMBER');`));
  await expectRejected(
    'C6 flag-leak probe',
    asServiceRole(`UPDATE public.profiles SET role='INDIVIDUAL' WHERE id='${TARGET}';`),
    'Role cannot be changed once set',
  );
  rec.c6_no_flag_leak = true;

  // C7 — no trigger left disabled by anything.
  const disabled = await scalar('C7 disabled triggers', `SELECT count(*)::text FROM pg_trigger WHERE tgrelid='public.profiles'::regclass AND NOT tgisinternal AND tgenabled <> 'O'`,
  );
  if (disabled !== '0') throw new Error(`C7: ${disabled} trigger(s) on profiles are not enabled — kill criterion`);
  rec.c7_triggers_all_enabled = true;

  // C8 — the lock this migration exists to remove must never appear.
  const srx = await scalar('C8 barrier locks', `SELECT count(*)::text FROM pg_locks WHERE relation='public.profiles'::regclass AND mode='ShareRowExclusiveLock'`,
  );
  rec.c8_share_row_exclusive_locks = Number(srx);
  if (Number(srx) > 0) throw new Error('C8: ShareRowExclusiveLock observed on profiles — kill criterion');

  // C9 — supporting worker health, fail visibly. A MAX_CYCLES=1 supervisor can
  // supply a freshly minted identity token each invocation; a stale token must fail.
  if (WORKER) {
    const headers: Record<string, string> = {};
    if (WORKER_ID_TOKEN) headers.Authorization = `Bearer ${WORKER_ID_TOKEN}`;
    const h = await fetch(`${WORKER}/health`, { headers, signal: AbortSignal.timeout(MANAGEMENT_API_TIMEOUT_MS) });
    await h.arrayBuffer();
    rec.c9_worker_health = h.status;
    if (h.status !== 200) throw new Error(`C9 worker health returned ${h.status}`);
  }

  // C10 — the holder's query has completed and its transaction stays open
  // until the independent backend's rejection is observed. No fixed sleep.
  await runFlagIsolation(REF, DB_ENV, INDIV);
  rec.c10_concurrent_flag_isolated = true;

  // C11 — separate holder/RPC/innocent rows, persistent backends and actual
  // lock-manager observations. Clock starts inside PostgreSQL BEFORE UPDATE.
  // Each of the three changed RPCs must pass while both other sessions are held.
  if (n === 1 || n % LOCK_EXPERIMENT_EVERY === 0) {
    rec.c11_lock_experiments = await runLockExperiment(REF, DB_ENV, INDIV, TARGET, INNOCENT);
  }

  rec.ok = true;
  return rec;
}

async function main() {
  console.log(JSON.stringify({ event: 'driver_start', ref: REF, at: new Date().toISOString(), cycle_ms: CYCLE_MS }));
  let n = 0;
  for (;;) {
    n += 1;
    try {
      console.log(JSON.stringify(await cycle(n)));
    } catch (e) {
      console.log(JSON.stringify({ cycle: n, at: new Date().toISOString(), ok: false, error: (e as Error).message }));
      process.exitCode = 1;
      return; // A failed sample terminates this window; never silently continue.
    }
    if (MAX_CYCLES > 0 && n >= MAX_CYCLES) return;
    await new Promise((r) => setTimeout(r, CYCLE_MS));
  }
}

void main().catch(error => { console.error(error instanceof Error ? error.message : 'Driver failed'); process.exitCode = 1; });
