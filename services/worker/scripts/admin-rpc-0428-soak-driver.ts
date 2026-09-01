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
 * The RPCs are invoked over PostgREST with the service-role key — the exact
 * path services/worker/src/api/admin-actions.ts uses (its `db` client is
 * service_role over PostgREST), so the trigger-visible session state
 * (`request.jwt.claims`, the `role` GUC) is identical to production.
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
 *       fire the RPC, then time an innocent write to an UNRELATED row and scan
 *       pg_locks. Before 0428 that write waited ~4.95 s; after, it is not
 *       blocked. (An earlier cut of this driver ran both in ONE sequential
 *       transaction with no writer held, which measured nothing.)
 *
 * Writes one JSON line per cycle. Any assertion failure sets ok=false and is
 * a soak kill criterion (see docs/staging/admin-rpc-ddl-0428/PRE-MORTEM.md).
 */

const REF = process.env.RIG_PROJECT_REF ?? '';
const MGMT = process.env.SUPABASE_ACCESS_TOKEN ?? '';
const WORKER = process.env.RIG_WORKER_URL ?? '';
const WORKER_ID_TOKEN = process.env.RIG_WORKER_ID_TOKEN ?? '';
const CYCLE_MS = Number(process.env.CYCLE_MS ?? 15 * 60 * 1000);
const LOCK_EXPERIMENT_EVERY = Number(process.env.LOCK_EXPERIMENT_EVERY ?? 4);
const MANAGEMENT_API_TIMEOUT_MS = Number(process.env.MANAGEMENT_API_TIMEOUT_MS ?? 60_000);

if (!REF || !MGMT) {
  console.error('RIG_PROJECT_REF and SUPABASE_ACCESS_TOKEN are required');
  process.exit(2);
}

const TARGET = '0428a11d-0000-4000-8000-000000000002';
const INDIV = '0428a11d-0000-4000-8000-000000000003';
const ORG = '0428a11d-0000-4000-8000-0000000000ff';

/** Read-only-ish SQL over the Supabase Management API. */
async function sql(query: string): Promise<{ rows: unknown[]; error?: string }> {
  // Bounded: this driver is unattended for 48 h and its whole output contract
  // is one JSON line per cycle. A hung Management API call with no timeout
  // stalls the cycle indefinitely and emits nothing, which reads as "the soak
  // stopped" rather than "one request hung".
  let res: Response;
  try {
    res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${MGMT}`, 'Content-Type': 'application/json' },
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
    await sql(purge);
  }
}

async function cycle(n: number): Promise<Record<string, unknown>> {
  const rec: Record<string, unknown> = { cycle: n, at: new Date().toISOString() };
  await resetFixture();

  // C1 — the RPC changes a role, with no DDL.
  await expectOk('C1 admin_change_user_role', asServiceRole(`SELECT admin_change_user_role('${TARGET}','ORG_ADMIN');`));
  const role = await scalar('C1 role readback', `SELECT role::text FROM public.profiles WHERE id='${TARGET}'`);
  if (role !== 'ORG_ADMIN') throw new Error(`C1: role did not land, got ${role}`);
  rec.c1_role = role;

  // C2 — the flag flips, and the read-back assertion did not spuriously fire.
  await expectOk('C2 admin_set_platform_admin', asServiceRole(`SELECT admin_set_platform_admin('${TARGET}',true);`));
  const flag = await scalar('C2 flag readback', `SELECT is_platform_admin::text FROM public.profiles WHERE id='${TARGET}'`);
  if (flag !== 'true') throw new Error(`C2: flag did not land, got ${flag}`);
  rec.c2_flag = flag;

  // C3 — org assignment + org_members upsert.
  await expectOk('C3 admin_set_user_org', asServiceRole(`SELECT admin_set_user_org('${TARGET}','${ORG}','admin');`));
  const orgId = await scalar('C3 org readback', `SELECT coalesce(org_id::text,'<null>') FROM public.profiles WHERE id='${TARGET}'`);
  if (orgId !== ORG) throw new Error(`C3: org_id did not land, got ${orgId}`);
  const memberRole = await scalar('C3 member readback', `SELECT role::text FROM public.org_members WHERE user_id='${TARGET}' AND org_id='${ORG}'`);
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

  // C9 — worker health (supporting evidence only).
  if (WORKER) {
    try {
      const headers: Record<string, string> = {};
      if (WORKER_ID_TOKEN) headers.Authorization = `Bearer ${WORKER_ID_TOKEN}`;
      const h = await fetch(`${WORKER}/health`, { headers });
      rec.c9_worker_health = h.status;
    } catch (e) {
      rec.c9_worker_health = `unreachable: ${(e as Error).message}`;
    }
  }

  // C10 — CONCURRENT flag isolation. This is the invariant the flag design
  // introduces and the one thing a sequential probe cannot establish: while one
  // session holds `arkova.allow_role_change='on'` inside a live transaction,
  // a DIFFERENT concurrent session must still be refused a direct role change.
  // If the flag were ever global rather than transaction-local, this is where
  // it would show, and every direct role write in the system would be exempt.
  {
    const holder = sql(
      asServiceRole(
        `SELECT set_config('arkova.allow_role_change','on',true);
         SELECT pg_sleep(6);
         SELECT admin_change_user_role('${TARGET}','ORG_ADMIN');`,
      ),
    );
    await new Promise((r) => setTimeout(r, 1500));
    await expectRejected(
      'C10 concurrent intruder while another session holds the flag',
      asServiceRole(`UPDATE public.profiles SET role='ORG_ADMIN' WHERE id='${INDIV}';`),
      'Role cannot be changed once set',
    );
    const held = await holder;
    if (held.error) throw new Error(`C10: flag holder failed: ${held.error.slice(0, 160)}`);
    rec.c10_concurrent_flag_isolated = true;
  }

  // C11 — the REAL controlled lock experiment. An earlier version of this
  // driver ran the RPC and an update in ONE sequential transaction with no
  // concurrent writer held, which measures nothing about a FIFO barrier. To
  // observe the barrier at all you must hold a conflicting writer open while
  // the RPC runs, then time an innocent write to an UNRELATED row.
  //   before 0428: that innocent write waited ~4.95 s (ShareRowExclusive queued)
  //   after  0428: it is not blocked at all
  if (n % LOCK_EXPERIMENT_EVERY === 0) {
    const holder = sql(
      asServiceRole(`UPDATE public.profiles SET updated_at=now() WHERE id='${INDIV}';
                     SELECT pg_sleep(5);`),
    );
    await new Promise((r) => setTimeout(r, 1500));
    const rpc = sql(asServiceRole(`SELECT admin_change_user_role('${TARGET}','ORG_MEMBER');`));
    await new Promise((r) => setTimeout(r, 1000));
    const modes = await sql(
      `SELECT mode, granted FROM pg_locks WHERE relation='public.profiles'::regclass ORDER BY granted DESC;`,
    );
    const sawBarrierLock = JSON.stringify(modes.rows).includes('ShareRowExclusiveLock');
    rec.c11_barrier_lock_seen = sawBarrierLock;
    const t0 = Date.now();
    const innocent = await sql(asServiceRole(`UPDATE public.profiles SET updated_at=now() WHERE id='${TARGET}';`));
    const waitedMs = Date.now() - t0;
    await Promise.all([holder, rpc]);
    if (sawBarrierLock) {
      throw new Error('C11: ShareRowExclusiveLock observed on profiles while the RPC ran — kill criterion');
    }
    if (innocent.error) throw new Error(`C11: innocent unrelated write failed: ${innocent.error.slice(0, 160)}`);
    rec.c11_innocent_unrelated_write_ms = waitedMs;
    // Generous ceiling: this is a network round trip, not a lock wait.
    if (waitedMs > 3000) {
      throw new Error(`C11: innocent unrelated write waited ${waitedMs}ms — barrier may have returned`);
    }
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
    }
    await new Promise((r) => setTimeout(r, CYCLE_MS));
  }
}

void main();
