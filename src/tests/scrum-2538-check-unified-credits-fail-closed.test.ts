/**
 * SCRUM-2538 / DI-380 — `check_unified_credits` fabricates a 50-credit balance
 * for an org or user that has NO `unified_credits` row.
 *
 * THE DEFECT
 *   The squashed baseline defines the function so that a missing balance row
 *   short-circuits to `RETURN QUERY SELECT 50, 0, 50, true` — monthly_allocation
 *   50, remaining 50, has_credits TRUE — for an owner the credit ledger has
 *   never heard of. That is fail-OPEN on a money path: entitlement invented by
 *   the absence of a record.
 *
 * WHY IT IS WORSE THAN "50 free calls"
 *   Its sibling `deduct_unified_credits` fails CLOSED on the same missing row
 *   (`IF NOT FOUND THEN RETURN false`). So the pair disagrees: `check` says
 *   "you have 50", `deduct` says "nothing debited", and the balance never moves.
 *   The phantom 50 does not decrement — it regenerates on every single call.
 *   Paired with the worker's Tier-1 path, which ignored that boolean, this was
 *   unbounded free service, not a 50-call trial.
 *
 * WHY THE BACKFILL IS PART OF THE FIX, NOT A NICETY
 *   Flipping the default to 0/false without materializing rows would convert a
 *   revenue leak into an outage: every org relying on the phantom 50 drops to
 *   zero the moment this applies. The migration therefore writes REAL rows
 *   carrying the SAME 50-credit entitlement first, so effective behavior for
 *   every existing owner is unchanged and only the fabrication goes away.
 *
 * TWO-LAYER CONVENTION (same as 0406 / 0408 / 0411):
 *   This half is static and runs in ordinary CI with no database. It also runs
 *   the REAL `secdef-function-grants` linter over the new file, because
 *   `CREATE OR REPLACE` re-triggers Supabase's `ALTER DEFAULT PRIVILEGES` and
 *   would silently re-open both functions to `anon` over PostgREST.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  findViolations,
  DELIBERATELY_PUBLIC,
  DELIBERATELY_AUTHENTICATED,
} from '../../scripts/ci/feedback-rules/secdef-function-grants';

const MIGRATION = 'supabase/migrations/0420_scrum2538_check_unified_credits_fail_closed.sql';
const BASELINE = 'supabase/migrations/00000000000000_baseline_at_main_HEAD.sql';

function read(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
}

/** Strip `--` line comments so prose about the bug is never matched as SQL. */
function sqlOnly(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

/**
 * Slice one `CREATE OR REPLACE FUNCTION ... $$ ... $$;` body out of a file.
 * Anchored on the CREATE specifically — the plain name also appears in the
 * REVOKE/GRANT statements that follow the definition, and those have no body.
 */
function routineBody(sql: string, fnName: string): string {
  const bare = sql.lastIndexOf(`CREATE OR REPLACE FUNCTION public.${fnName}(`);
  const quoted = sql.lastIndexOf(`CREATE OR REPLACE FUNCTION "public"."${fnName}"`);
  const at = Math.max(bare, quoted);
  expect(at, `definition header for ${fnName}`).toBeGreaterThan(-1);
  const bodyStart = sql.indexOf('AS $$', at);
  expect(bodyStart, `AS $$ for ${fnName}`).toBeGreaterThan(at);
  const bodyEnd = sql.indexOf('$$;', bodyStart);
  expect(bodyEnd, `closing $$; for ${fnName}`).toBeGreaterThan(bodyStart);
  return sql.slice(bodyStart, bodyEnd);
}

describe('SCRUM-2538: the fail-OPEN default this migration removes is real', () => {
  it('the baseline really does hand out 50 phantom credits on a missing row', () => {
    const body = routineBody(read(BASELINE), 'check_unified_credits');
    // Anchors the test to the actual defect. If someone "fixes" the baseline
    // instead of writing a compensating migration (§1.2 forbids that), this
    // fails and says so rather than silently passing.
    expect(body).toMatch(/IF NOT FOUND THEN\s+RETURN QUERY SELECT 50, 0, 50, true;/);
  });

  it('the sibling deduct_unified_credits already fails CLOSED on the same missing row', () => {
    const body = routineBody(read(BASELINE), 'deduct_unified_credits');
    expect(body).toMatch(/IF NOT FOUND THEN RETURN false; END IF;/);
  });
});

describe('SCRUM-2538: migration 0420 makes check_unified_credits fail CLOSED', () => {
  const raw = read(MIGRATION);
  const sql = sqlOnly(raw);

  it('carries a -- ROLLBACK: comment (§4 migration procedure)', () => {
    expect(raw).toContain('-- ROLLBACK:');
  });

  it('returns 0 credits and has_credits=false when no balance row exists', () => {
    const body = routineBody(sql, 'check_unified_credits');
    expect(body).toMatch(/IF NOT FOUND THEN\s+RETURN QUERY SELECT 0, 0, 0, false;/);
  });

  it('does not reintroduce the phantom 50 anywhere in the new function body', () => {
    const body = routineBody(sql, 'check_unified_credits');
    expect(body).not.toContain('50, 0, 50, true');
  });

  it('materializes a real row for every org that lacks one, at the same 50 credits', () => {
    // The backfill is what keeps the fix from becoming an outage: it encodes
    // the entitlement the fail-open branch was inventing, as data.
    expect(sql).toMatch(/INSERT INTO public\.unified_credits[\s\S]*?FROM public\.organizations/);
    expect(sql).toMatch(/NOT EXISTS[\s\S]*?FROM public\.unified_credits/);
  });

  it('materializes a row for org-less users too, so individual owners do not regress', () => {
    expect(sql).toMatch(/INSERT INTO public\.unified_credits[\s\S]*?FROM public\.profiles/);
  });

  it('bounds the lock wait — the backfill reads the hot organizations/profiles tables (§1.2)', () => {
    expect(sql).toMatch(/SET LOCAL lock_timeout = '5s';/);
  });

  it('reloads the PostgREST schema cache after redefining the functions (§6)', () => {
    expect(sql).toMatch(/NOTIFY pgrst, 'reload schema';/);
  });
});

describe('SCRUM-2538: the monthly rollover must not overstate `remaining` either', () => {
  // Second fabricated-balance path in the SAME function. The baseline writes
  //   carry_over = LEAST(alloc - used, 50)
  // to the row, then re-derives the in-memory copy AFTER `used := 0`, yielding
  // LEAST(alloc, 50). Persisted and returned values diverge by exactly last
  // month's usage, and the caller is told the LARGER one. Fixing the missing-row
  // fail-open while leaving this would still return credits nobody holds.
  const sql = sqlOnly(read(MIGRATION));

  it('computes carry_over once, before the used_this_month reset', () => {
    const body = routineBody(sql, 'check_unified_credits');
    const assign = body.indexOf('v_carry_over := LEAST(');
    const reset = body.indexOf('v_record.used_this_month := 0;');
    expect(assign, 'carry_over is computed into a local').toBeGreaterThan(-1);
    expect(reset, 'the in-memory reset still happens').toBeGreaterThan(-1);
    expect(assign).toBeLessThan(reset);
  });

  it('writes the SAME value to the row and to the returned record', () => {
    const body = routineBody(sql, 'check_unified_credits');
    expect(body).toMatch(/carry_over = v_carry_over,/);
    expect(body).toMatch(/v_record\.carry_over := v_carry_over;/);
    // The post-reset recomputation is what produced the divergence.
    expect(body).not.toMatch(
      /v_record\.carry_over := LEAST\(v_record\.monthly_allocation - v_record\.used_this_month, 50\);/,
    );
  });
});

describe('SCRUM-2538: the backfill must survive FORCE ROW LEVEL SECURITY', () => {
  // `unified_credits` carries FORCE RLS (baseline:9480), so the migration's own
  // role is subject to its policies. Both exclude it: `auth.role()` and
  // `auth.uid()` are NULL inside a migration, so
  // `service_role_manage_unified_credits` (FOR ALL, USING only — Postgres
  // reuses USING as the WITH CHECK) REJECTS the INSERTs outright, and the
  // `NOT EXISTS` idempotency guards read ZERO rows and report every owner as
  // uncovered. This is the 0404 failure mode, and it is SILENT in the read
  // direction — which is exactly why it is asserted statically here rather than
  // left for an apply that may never be rehearsed against a populated table.
  const raw = read(MIGRATION);
  const sql = sqlOnly(raw);

  it('the baseline really does put FORCE RLS on unified_credits', () => {
    expect(read(BASELINE)).toContain(
      'ALTER TABLE ONLY "public"."unified_credits" FORCE ROW LEVEL SECURITY;',
    );
  });

  it('suspends FORCE RLS before touching the table', () => {
    const suspend = sql.indexOf('ALTER TABLE public.unified_credits NO FORCE ROW LEVEL SECURITY;');
    const firstInsert = sql.indexOf('INSERT INTO public.unified_credits');
    expect(suspend, 'suspension present').toBeGreaterThan(-1);
    expect(firstInsert, 'backfill present').toBeGreaterThan(-1);
    // Strictly BEFORE — scanning first is the 0404 silent no-op.
    expect(suspend).toBeLessThan(firstInsert);
  });

  it('restores FORCE RLS on the success path AND on the error path', () => {
    const restores = sql.match(/ALTER TABLE public\.unified_credits FORCE ROW LEVEL SECURITY;/g) ?? [];
    expect(restores.length).toBeGreaterThanOrEqual(2);

    // The second restore must live inside an exception handler, not just be a
    // duplicate on the happy path.
    const handler = sql.indexOf('EXCEPTION WHEN others THEN');
    expect(handler, 'exception handler present').toBeGreaterThan(-1);
    expect(
      sql.indexOf('ALTER TABLE public.unified_credits FORCE ROW LEVEL SECURITY;', handler),
    ).toBeGreaterThan(handler);
  });

  it('refuses to commit a partial backfill', () => {
    // A fail-closed check over an incomplete backfill zeroes real customers, so
    // the migration re-checks its own work and raises rather than committing.
    expect(sql).toMatch(/RAISE EXCEPTION\s*\n?\s*'0420: backfill incomplete/);
  });
});

describe('SCRUM-2538: check and deduct must agree on WHICH row they act on', () => {
  const sql = sqlOnly(read(MIGRATION));

  // `unified_credits` has a PK on `id` and NO unique constraint on `org_id` or
  // `user_id` (baseline:9477/10276) — duplicates are representable, and the
  // OR-predicate can match an org row AND a user row for the same caller. The
  // baseline's bare `LIMIT 1` / unordered `SELECT INTO` therefore picks an
  // ARBITRARY row, and `check` and `deduct` can pick DIFFERENT ones: the
  // balance is read off one row and debited from another. The backfill adds
  // rows, so this must be made deterministic in the same migration.
  // `DESC NULLS LAST`, not a bare DESC: when `uc.org_id` is NULL the comparison
  // evaluates to NULL rather than false, and NULLs sort FIRST under a bare
  // DESC — which would rank a non-matching row ABOVE the org's own row.
  const ORDERING =
    /ORDER BY \(p_org_id IS NOT NULL AND uc\.org_id = p_org_id\) DESC NULLS LAST,\s*uc\.created_at,\s*uc\.id\s*LIMIT 1/;

  it('check_unified_credits selects its row deterministically', () => {
    expect(routineBody(sql, 'check_unified_credits')).toMatch(ORDERING);
  });

  it('deduct_unified_credits selects the SAME row, under FOR UPDATE', () => {
    const body = routineBody(sql, 'deduct_unified_credits');
    expect(body).toMatch(ORDERING);
    expect(body).toContain('FOR UPDATE');
  });

  it('deduct_unified_credits still fails closed on a missing row', () => {
    expect(routineBody(sql, 'deduct_unified_credits')).toMatch(/IF NOT FOUND THEN\s+RETURN false;/);
  });
});

describe('SCRUM-2538: CREATE OR REPLACE must not re-open these RPCs to anon', () => {
  // `ALTER DEFAULT PRIVILEGES` grants anon/authenticated EXECUTE **directly**
  // at CREATE time, and CREATE OR REPLACE re-triggers it. 0377/0378 already
  // revoked both functions; redefining them here undoes that unless the revoke
  // is re-asserted AFTER the definition. Both are SECURITY DEFINER, so the
  // failure mode is an RLS-bypassing, anon-callable billing RPC.
  const raw = read(MIGRATION);

  it('the real secdef-function-grants linter reports the migration clean', () => {
    const violations = findViolations([{ file: path.basename(MIGRATION), sql: raw }], {
      deliberatelyPublic: DELIBERATELY_PUBLIC,
      deliberatelyAuthenticated: DELIBERATELY_AUTHENTICATED,
    });
    expect(violations.map((v) => `${v.schema}.${v.name}`)).toEqual([]);
  });

  for (const fn of ['check_unified_credits', 'deduct_unified_credits']) {
    it(`re-asserts the revoke + service_role grant for ${fn}, unquoted`, () => {
      // Unquoted on purpose: the ratchet's statementTargets matcher does not
      // recognise `"public"."f"()`, so a quoted revoke reads as NO revoke.
      expect(raw).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([^)]*\\) FROM PUBLIC, anon, authenticated;`),
      );
      expect(raw).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([^)]*\\) TO service_role;`),
      );
    });
  }
});
