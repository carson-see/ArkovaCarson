/**
 * 0428 — the three admin profile RPCs must not run DDL on the hot `profiles` table.
 *
 * Compensating migration:
 *   supabase/migrations/0428_admin_profile_rpcs_remove_hot_table_trigger_ddl.sql
 *
 * THE DEFECT. `admin_change_user_role`, `admin_set_platform_admin` and
 * `admin_set_user_org` each wrapped their UPDATE in
 * `ALTER TABLE profiles DISABLE/ENABLE TRIGGER ...` with no bounded
 * `lock_timeout`. All three are reachable from the admin console via
 * services/worker/src/api/admin-actions.ts, so every platform-admin role
 * change ran DDL against a table on the auth hot path.
 *
 * That DDL takes ShareRowExclusiveLock (measured — NOT AccessExclusiveLock, so
 * this is not the 2026-08-11 `/api/v1/verify` P0 mechanism and readers were
 * never affected). It does block every WRITE to `profiles`, and because
 * Postgres lock queues are FIFO, a queued request barriers later writes to
 * unrelated rows whose locks would otherwise have been granted instantly:
 * measured 4.95 s vs 0.04 s for an innocent unrelated write.
 *
 * WHY A CONTENT GUARD IS THE RIGHT RATCHET HERE.
 * `scripts/ci/check-hot-table-ddl-lock-timeout.ts` already detects all twelve of
 * these statements — they are suppressed only because the entire squashed
 * baseline migration is grandfathered in
 * `scripts/ci/snapshots/hot-table-ddl-lock-timeout-baseline.json`. That
 * grandfathering is per-FILE and permanent, and it cannot notice that 0428
 * fixed the runtime behaviour, because the linter reads migration text rather
 * than live definitions. So the baseline file will keep reporting its 204
 * grandfathered violations forever, and nothing in that gate stops a future
 * author from copying a body out of the baseline and reintroducing the DDL in
 * a NEW migration.
 *
 * This test closes that specific gap with a LATEST-DEFINITION invariant (the
 * `public-anchor-pii-projection.contract.test.ts` pattern): whichever migration
 * defines these five routines LAST must define them without hot-table DDL.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MIGRATIONS_DIR = path.join(process.cwd(), 'supabase/migrations');
const MIGRATION_NAME = '0428_admin_profile_rpcs_remove_hot_table_trigger_ddl.sql';

/** The routines whose bodies must stay free of DDL on `profiles`. */
const GUARDED_ROUTINES = [
  'admin_change_user_role',
  'admin_set_platform_admin',
  'admin_set_user_org',
] as const;

/** Every trigger the three RPCs used to disable. */
const FORMERLY_DISABLED_TRIGGERS = [
  'enforce_role_immutability',
  'protect_privileged_fields',
  'trg_protect_platform_admin',
] as const;

function migrationFiles(): { name: string; body: string }[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((n) => n.endsWith('.sql'))
    .sort()
    .map((n) => ({ name: n, body: fs.readFileSync(path.join(MIGRATIONS_DIR, n), 'utf8') }));
}

/** Strip `--` line comments so a ROLLBACK block quoting the old body never counts. */
function stripComments(sql: string): string {
  return sql
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n');
}

/**
 * Body of the LAST `CREATE [OR REPLACE] FUNCTION <name>` in the migration
 * sequence, comments removed. Null when no migration defines it (the routine
 * then lives only in the squashed baseline).
 */
function latestBody(routine: string): { file: string; body: string } | null {
  let found: { file: string; body: string } | null = null;
  for (const { name, body } of migrationFiles()) {
    const src = stripComments(body);
    const re = new RegExp(
      `CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:public\\.)?${routine}\\s*\\(`,
      'gi',
    );
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      // Take everything to the end of the dollar-quoted body.
      const rest = src.slice(m.index);
      const tagMatch = /AS\s+(\$[A-Za-z_]*\$)/.exec(rest);
      if (!tagMatch) continue;
      const tag = tagMatch[1];
      const start = rest.indexOf(tag) + tag.length;
      const end = rest.indexOf(tag, start);
      if (end === -1) continue;
      found = { file: name, body: rest.slice(start, end) };
    }
  }
  return found;
}

describe('0428 — admin profile RPCs run no DDL on the hot `profiles` table', () => {
  it('ships the compensating migration', () => {
    expect(fs.existsSync(path.join(MIGRATIONS_DIR, MIGRATION_NAME))).toBe(true);
  });

  describe.each(GUARDED_ROUTINES)('%s', (routine) => {
    it('is (re)defined by a migration, so the latest definition is knowable', () => {
      expect(latestBody(routine)).not.toBeNull();
    });

    it('has no ALTER TABLE in its latest definition', () => {
      const latest = latestBody(routine);
      expect(latest).not.toBeNull();
      expect(latest!.body).not.toMatch(/\bALTER\s+TABLE\b/i);
    });

    it('does not disable or re-enable any protective trigger', () => {
      const latest = latestBody(routine);
      expect(latest).not.toBeNull();
      expect(latest!.body).not.toMatch(/\b(?:DISABLE|ENABLE)\s+TRIGGER\b/i);
      for (const trg of FORMERLY_DISABLED_TRIGGERS) {
        expect(latest!.body).not.toContain(trg);
      }
    });

    it('keeps its service_role authorization guard', () => {
      const latest = latestBody(routine);
      expect(latest!.body).toMatch(/get_caller_role\(\)\s+IS\s+DISTINCT\s+FROM\s+'service_role'/i);
    });

    it('still raises when the target user does not exist', () => {
      const body = latestBody(routine)!.body;
      // admin_change_user_role checks ROW_COUNT instead of FOUND (a trailing
      // set_config PERFORM would clobber FOUND); the other two still use FOUND.
      expect(body).toMatch(/IF\s+NOT\s+FOUND\s+THEN|GET\s+DIAGNOSTICS\s+\w+\s*=\s*ROW_COUNT/i);
      expect(body).toMatch(/RAISE\s+EXCEPTION\s+'User not found/i);
    });
  });

  describe('check_role_immutability', () => {
    /**
     * The exemption MUST be keyed on the transaction-local flag that
     * admin_change_user_role sets around its own UPDATE — not on the caller's
     * role alone, and not on current_user.
     *
     * Keying it on `get_caller_role() = 'service_role'` would silently unblock
     * the worker's DIRECT service_role writes to profiles.role in
     * services/worker/src/api/invitations.ts and admin-org-members.ts. Those
     * backfill `{ org_id, role }` guarded only by `.is('org_id', null)`, and
     * `org_id IS NULL` does not imply `role IS NULL` — prod holds 16 such
     * profiles, whose roles would start being rewritten on invite acceptance.
     * `current_user = 'postgres'` is no narrower: four other postgres-owned
     * SECURITY DEFINER functions also update profiles.
     */
    it('exempts via the transaction-local flag, not the caller role alone', () => {
      const body = latestBody('check_role_immutability')!.body;
      expect(body).toMatch(/current_setting\('arkova\.allow_role_change',\s*true\)/i);
    });

    it('requires BOTH the flag and a service_role caller', () => {
      const body = latestBody('check_role_immutability')!.body;
      expect(body).toMatch(/get_caller_role\(\)\s+IS\s+DISTINCT\s+FROM\s+'service_role'/i);
      // The two conditions are OR-ed inside the RAISE guard, i.e. either one
      // failing raises. Both must appear in the same condition.
      expect(body).toMatch(
        /current_setting\('arkova\.allow_role_change',\s*true\)\s+IS\s+DISTINCT\s+FROM\s+'on'\s*\n?\s*OR\s+get_caller_role\(\)\s+IS\s+DISTINCT\s+FROM\s+'service_role'/i,
      );
    });

    it('does not exempt on current_user, which would cover 4 unrelated SECDEF fns', () => {
      const body = latestBody('check_role_immutability')!.body;
      const code = body
        .split('\n')
        .filter((l) => !l.trimStart().startsWith('--'))
        .join('\n');
      expect(code).not.toMatch(/current_user/i);
    });

    it('still stamps role_set_at OUTSIDE the exemption, for every caller', () => {
      const body = latestBody('check_role_immutability')!.body;
      // The stamping branch must not be nested inside a service_role test:
      // it is guarded only by `OLD.role IS NULL`.
      const stamp = /IF\s+OLD\.role\s+IS\s+NULL\s+AND\s+NEW\.role\s+IS\s+NOT\s+NULL\s+THEN\s+NEW\.role_set_at/i;
      expect(body).toMatch(stamp);
      const beforeStamp = body.slice(0, body.search(stamp));
      // Every IF opened before the stamp must already be closed by an END IF.
      // Count END IF first and remove it, so its own `IF` is not counted as an open.
      const closes = (beforeStamp.match(/\bEND\s+IF\b/gi) ?? []).length;
      const opens = (beforeStamp.replace(/\bEND\s+IF\b/gi, '').match(/\bIF\b/gi) ?? []).length;
      expect(closes).toBe(opens);
    });

    it('still raises for a non-service_role caller (fails closed on NULL claims)', () => {
      const body = latestBody('check_role_immutability')!.body;
      expect(body).toMatch(/RAISE\s+EXCEPTION\s+'Role cannot be changed once set/i);
      // `IS DISTINCT FROM` (not `!=`) is what makes a NULL caller role fail closed.
      expect(body).not.toMatch(/get_caller_role\(\)\s*(?:!=|<>)\s*'service_role'/i);
    });
  });

  describe('admin_change_user_role flag scoping', () => {
    it('sets the flag transaction-locally and clears it right after the UPDATE', () => {
      const body = latestBody('admin_change_user_role')!.body;
      expect(body).toMatch(/set_config\('arkova\.allow_role_change',\s*'on',\s*true\)/i);
      expect(body).toMatch(/set_config\('arkova\.allow_role_change',\s*'off',\s*true\)/i);
      // is_local => true, so the flag cannot outlive the transaction.
      expect(body).not.toMatch(/set_config\('arkova\.allow_role_change',\s*'on',\s*false\)/i);
    });

    it('uses ROW_COUNT, because the trailing set_config PERFORM clobbers FOUND', () => {
      const body = latestBody('admin_change_user_role')!.body;
      expect(body).toMatch(/GET\s+DIAGNOSTICS\s+\w+\s*=\s*ROW_COUNT/i);
      expect(body).not.toMatch(/IF\s+NOT\s+FOUND\s+THEN/i);
    });
  });

  describe('admin_set_platform_admin read-back assertion', () => {
    it('re-reads the flag and raises if a trigger silently reverted the write', () => {
      const body = latestBody('admin_set_platform_admin')!.body;
      expect(body).toMatch(/RETURNING\s+is_platform_admin\s+INTO/i);
      // One statement, not UPDATE + a second SELECT on a hot table.
      expect(body).not.toMatch(/SELECT\s+is_platform_admin\s+INTO\s+\w+\s+FROM\s+profiles/i);
      expect(body).toMatch(/IS\s+DISTINCT\s+FROM\s+p_is_admin/i);
      expect(body).toMatch(/RAISE\s+EXCEPTION\s+'Platform admin flag was not applied/i);
    });
  });

  describe('protect_platform_admin_flag', () => {
    it('accepts either the role GUC or the JWT-claims signal', () => {
      const body = latestBody('protect_platform_admin_flag')!.body;
      expect(body).toMatch(/current_setting\('role',\s*true\)/i);
      expect(body).toMatch(/get_caller_role\(\)/i);
    });

    it('still reverts the flag for every other caller', () => {
      const body = latestBody('protect_platform_admin_flag')!.body;
      expect(body).toMatch(/NEW\.is_platform_admin\s*:=\s*OLD\.is_platform_admin/i);
    });
  });

  it('the migration needs no lock_timeout because it alters no table', () => {
    const body = fs.readFileSync(path.join(MIGRATIONS_DIR, MIGRATION_NAME), 'utf8');
    expect(stripComments(body)).not.toMatch(/\bALTER\s+TABLE\b/i);
  });

  it('reloads the PostgREST schema cache after redefining functions', () => {
    const body = fs.readFileSync(path.join(MIGRATIONS_DIR, MIGRATION_NAME), 'utf8');
    expect(body).toMatch(/NOTIFY\s+pgrst,\s*'reload schema'/i);
  });
});
