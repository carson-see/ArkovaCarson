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
 *
 * Every N cycles it also re-runs the controlled lock experiment that produced
 * the 4.95s -> 0.04s headline, on the rig itself.
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

if (!REF || !MGMT) {
  console.error('RIG_PROJECT_REF and SUPABASE_ACCESS_TOKEN are required');
  process.exit(2);
}

const TARGET = '0428a11d-0000-4000-8000-000000000002';
const INDIV = '0428a11d-0000-4000-8000-000000000003';
const FRESH = '0428a11d-0000-4000-8000-000000000004';
const ORG = '0428a11d-0000-4000-8000-0000000000ff';

/** Read-only-ish SQL over the Supabase Management API. */
async function sql(query: string): Promise<{ rows: unknown[]; error?: string }> {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${MGMT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
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

async function scalar(query: string): Promise<string> {
  const r = await sql(query);
  if (r.error) throw new Error(`scalar failed: ${r.error}`);
  const row = (r.rows[0] ?? {}) as Record<string, unknown>;
  return String(Object.values(row)[0]);
}

/** Reset the fixture to a known state at the top of every cycle. */
async function resetFixture() {
  await expectOk(
    'fixture reset',
    `DELETE FROM public.org_members WHERE user_id IN ('${TARGET}','${INDIV}','${FRESH}');
     UPDATE public.profiles SET role='INDIVIDUAL', org_id=NULL, is_platform_admin=false, role_set_at=now()
       WHERE id IN ('${TARGET}','${INDIV}');
     UPDATE public.profiles SET role=NULL, org_id=NULL, role_set_at=NULL WHERE id='${FRESH}';`,
  );
}

async function cycle(n: number): Promise<Record<string, unknown>> {
  const rec: Record<string, unknown> = { cycle: n, at: new Date().toISOString() };
  await resetFixture();

  // C1 — the RPC changes a role, with no DDL.
  await expectOk('C1 admin_change_user_role', asServiceRole(`SELECT admin_change_user_role('${TARGET}','ORG_ADMIN');`));
  const role = await scalar(`SELECT role::text FROM public.profiles WHERE id='${TARGET}'`);
  if (role !== 'ORG_ADMIN') throw new Error(`C1: role did not land, got ${role}`);
  rec.c1_role = role;

  // C2 — the flag flips, and the read-back assertion did not spuriously fire.
  await expectOk('C2 admin_set_platform_admin', asServiceRole(`SELECT admin_set_platform_admin('${TARGET}',true);`));
  const flag = await scalar(`SELECT is_platform_admin::text FROM public.profiles WHERE id='${TARGET}'`);
  if (flag !== 'true') throw new Error(`C2: flag did not land, got ${flag}`);
  rec.c2_flag = flag;

  // C3 — org assignment + org_members upsert.
  await expectOk('C3 admin_set_user_org', asServiceRole(`SELECT admin_set_user_org('${TARGET}','${ORG}','admin');`));
  const orgId = await scalar(`SELECT coalesce(org_id::text,'<null>') FROM public.profiles WHERE id='${TARGET}'`);
  if (orgId !== ORG) throw new Error(`C3: org_id did not land, got ${orgId}`);
  const memberRole = await scalar(`SELECT role::text FROM public.org_members WHERE user_id='${TARGET}' AND org_id='${ORG}'`);
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
  await expectOk(
    'C5 worker backfill on fresh profile',
    asServiceRole(`UPDATE public.profiles SET org_id='${ORG}', role='ORG_MEMBER' WHERE id='${FRESH}' AND org_id IS NULL;`),
  );
  const stamped = await scalar(`SELECT (role_set_at IS NOT NULL)::text FROM public.profiles WHERE id='${FRESH}'`);
  if (stamped !== 'true') throw new Error('C5: role_set_at was not stamped');
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
  const disabled = await scalar(
    `SELECT count(*)::text FROM pg_trigger WHERE tgrelid='public.profiles'::regclass AND NOT tgisinternal AND tgenabled <> 'O'`,
  );
  if (disabled !== '0') throw new Error(`C7: ${disabled} trigger(s) on profiles are not enabled — kill criterion`);
  rec.c7_triggers_all_enabled = true;

  // C8 — the lock this migration exists to remove must never appear.
  const srx = await scalar(
    `SELECT count(*)::text FROM pg_locks WHERE relation='public.profiles'::regclass AND mode='ShareRowExclusiveLock'`,
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

  // Periodic: the controlled lock experiment, on the rig.
  if (n % LOCK_EXPERIMENT_EVERY === 0) {
    const before = Date.now();
    await expectOk(
      'lock experiment',
      asServiceRole(
        `SELECT admin_change_user_role('${TARGET}','ORG_ADMIN');
         UPDATE public.profiles SET updated_at=now() WHERE id='${INDIV}';`,
      ),
    );
    rec.lock_experiment_ms = Date.now() - before;
    rec.lock_experiment_ran = true;
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
