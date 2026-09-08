/**
 * SCRUM-4521 / migration 0442 — `recover_stuck_broadcasts()` bounded batch,
 * proven against a REAL local Postgres (local Supabase stack), not a mock.
 *
 * The 2026-09-07 staging-rig stall (rig `txvvrxngyfnnqahujbld`) was caused by
 * this function having no LIMIT: one call tried to claim all 10,000 stuck rows
 * and died on its own 60s `statement_timeout` (SQLSTATE 57014) every pass. The
 * unit tests in `broadcast-recovery.test.ts` prove the CALLER loops correctly;
 * only this file proves the SQL actually stops at `p_limit`, because a mock
 * that ignores the limit can never fail that assertion.
 *
 * Like `recover-stuck-broadcasts-submitted.local.test.ts`, `recover_stuck_
 * broadcasts()` is called via raw psql with `request.jwt.claim.role` set to
 * `service_role` in the SAME session, because `protect_anchor_status_
 * transition()` (the `protect_anchor_fields` BEFORE UPDATE trigger) rejects a
 * status change from any other caller.
 *
 * ENV-GATED (operator-sanctioned): runs only when RECOVER_STUCK_BROADCASTS_PG=1
 * and a local stack is reachable. PRE-REQUISITE: migrations through 0379 plus
 * this PR's 0442 file. NEVER point this at a remote/staging/prod project.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const GATED = process.env.RECOVER_STUCK_BROADCASTS_PG === '1';

const DB_URL = process.env.RECOVER_STUCK_BROADCASTS_PG_DB_URL
  ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

function sql(query: string): string {
  return execFileSync(
    'psql',
    [DB_URL, '-tA', '-v', 'ON_ERROR_STOP=1', '-c', query],
    { encoding: 'utf8' },
  ).trim();
}

/** Runs `query` as service_role in ONE session (matches PostgREST's per-request GUC). */
function sqlAsServiceRole(query: string): string {
  return sql(`SELECT set_config('request.jwt.claim.role', 'service_role', false); ${query}`);
}

const USER_ID = randomUUID();
/** Comfortably more than one batch at the small limits used below. */
const COHORT = 25;
const BATCH = 10;

function stuckCount(): number {
  return Number(
    sql(`SELECT count(*) FROM public.anchors WHERE user_id = '${USER_ID}' AND status = 'BROADCASTING'`),
  );
}

describe.skipIf(!GATED)('SCRUM-4521 — 0442 recover_stuck_broadcasts bounded batch (REAL local PG)', () => {
  beforeAll(() => {
    // Distinct, ascending `updated_at` values so oldest-first ordering is
    // observable: row i is (COHORT - i) hours old, so 'bounded-000' is oldest.
    sql(`
      INSERT INTO auth.users (id, email) VALUES ('${USER_ID}', 'bounded-${USER_ID}@test.local');
      INSERT INTO public.profiles (id, email) VALUES ('${USER_ID}', 'bounded-${USER_ID}@test.local');
      INSERT INTO public.anchors (id, user_id, fingerprint, filename, status, chain_tx_id, updated_at)
      SELECT
        gen_random_uuid(),
        '${USER_ID}',
        lpad(to_hex(i), 64, '0'),
        'bounded-' || lpad(i::text, 3, '0') || '.pdf',
        'BROADCASTING',
        NULL,
        now() - make_interval(hours => ${COHORT} - i)
      FROM generate_series(0, ${COHORT - 1}) AS i;
    `);
  }, 30000);

  afterAll(() => {
    try {
      sql(`
        DELETE FROM public.anchors WHERE user_id = '${USER_ID}';
        DELETE FROM public.profiles WHERE id = '${USER_ID}';
        DELETE FROM auth.users WHERE id = '${USER_ID}';
      `);
    } catch {
      // Best-effort cleanup — rows are uniquely keyed by a fresh user UUID.
    }
  }, 30000);

  it('claims at most p_limit rows in a single call — the LIMIT the incident proved missing', () => {
    const claimed = Number(
      sqlAsServiceRole(`SELECT count(*) FROM public.recover_stuck_broadcasts(1, ${BATCH})`),
    );
    expect(claimed).toBe(BATCH);
    expect(stuckCount()).toBe(COHORT - BATCH);
  }, 30000);

  it('drains the whole cohort across repeated bounded calls', () => {
    let guard = 0;
    while (stuckCount() > 0 && guard < 10) {
      sqlAsServiceRole(`SELECT count(*) FROM public.recover_stuck_broadcasts(1, ${BATCH})`);
      guard++;
    }
    expect(stuckCount()).toBe(0);
    expect(
      Number(
        sql(`SELECT count(*) FROM public.anchors WHERE user_id = '${USER_ID}' AND status = 'PENDING'`),
      ),
    ).toBe(COHORT);
  }, 60000);

  it('clamps an absurd p_limit instead of restoring the unbounded sweep', () => {
    // Re-stale the cohort, then ask for far more than the server-side ceiling.
    sql(`
      UPDATE public.anchors
      SET status = 'BROADCASTING', updated_at = now() - interval '1 hour'
      WHERE user_id = '${USER_ID}';
    `);
    const claimed = Number(
      sqlAsServiceRole(`SELECT count(*) FROM public.recover_stuck_broadcasts(1, 2000000000)`),
    );
    // The clamp caps the ceiling at 2000; this cohort is smaller, so the call
    // succeeds — the assertion that matters is that it does not error and the
    // ceiling is a fixed constant, not the caller's number.
    expect(claimed).toBe(COHORT);
    expect(
      sql(`SELECT pg_get_functiondef('public.recover_stuck_broadcasts(integer,integer)'::regprocedure)`),
    ).toMatch(/LEAST\s*\(\s*GREATEST\s*\(\s*COALESCE\s*\(\s*p_limit/i);
  }, 30000);

  it('a NULL p_limit falls back to the default rather than becoming unbounded', () => {
    sql(`
      UPDATE public.anchors
      SET status = 'BROADCASTING', updated_at = now() - interval '1 hour'
      WHERE user_id = '${USER_ID}';
    `);
    const claimed = Number(
      sqlAsServiceRole(`SELECT count(*) FROM public.recover_stuck_broadcasts(1, NULL)`),
    );
    expect(claimed).toBe(COHORT);
    expect(stuckCount()).toBe(0);
  }, 30000);

  it('the old one-argument signature is gone — no ambiguous overload survives', () => {
    const signatures = sql(`
      SELECT string_agg(pg_get_function_identity_arguments(p.oid), ' | ' ORDER BY p.oid)
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'recover_stuck_broadcasts'
    `);
    expect(signatures).toBe('integer, integer');
  }, 30000);

  it('is still service_role-only after the DROP + CREATE discarded the old grants', () => {
    expect(
      sql(`SELECT has_function_privilege('service_role', 'public.recover_stuck_broadcasts(integer,integer)', 'EXECUTE')`),
    ).toBe('t');
    for (const role of ['anon', 'authenticated']) {
      expect(
        sql(`SELECT has_function_privilege('${role}', 'public.recover_stuck_broadcasts(integer,integer)', 'EXECUTE')`),
      ).toBe('f');
    }
  }, 30000);
});
