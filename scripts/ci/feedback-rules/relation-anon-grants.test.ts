import { describe, it, expect } from 'vitest';
import {
  REPLAY_PARITY_REVOKES,
  definesRelation,
  findMissingRelationRevokes,
  grantsBlockedRole,
  hasTerminalRelationRevoke,
  normalize,
  realMigrations,
  revokesRequiredRoles,
  run,
  type FileSql,
} from './relation-anon-grants.ts';

const BASELINE = '00000000000000_baseline_at_main_HEAD.sql';

/** The baseline's shape for a relation: created, granted to service_role, never revoked. */
function baselineFile(rel = 'v_slow_queries'): FileSql {
  return {
    file: BASELINE,
    sql: `CREATE OR REPLACE VIEW "public"."${rel}" AS SELECT 1;
          ALTER VIEW "public"."${rel}" OWNER TO "postgres";
          GRANT ALL ON TABLE "public"."${rel}" TO "service_role";`,
  };
}

function revokeFile(name: string, rel = 'v_slow_queries'): FileSql {
  return {
    file: name,
    sql: `REVOKE ALL ON TABLE public.${rel} FROM PUBLIC, anon, authenticated;
          GRANT ALL ON TABLE public.${rel} TO service_role;`,
  };
}

describe('relation-anon-grants — the live repo (this is the ratchet)', () => {
  it('every pinned relation survives an ordered replay of supabase/migrations/', () => {
    const missing = findMissingRelationRevokes(realMigrations());
    expect(missing).toEqual([]);
  });

  it('run() passes on the repo as committed', () => {
    const r = run();
    expect(r.ok, r.message).toBe(true);
  });

  it('pins public.v_slow_queries — 0419 is what closes it', () => {
    expect(REPLAY_PARITY_REVOKES.map((p) => p.relation)).toContain('public.v_slow_queries');
  });

  // The point of the whole rule: dropping the compensating migration must FAIL,
  // not quietly pass. Simulated by replaying the corpus with 0419 removed.
  it('FAILS when the 0419 revoke is removed from the corpus', () => {
    const without = realMigrations().filter((f) => !f.file.startsWith('0419_'));
    const missing = findMissingRelationRevokes(without);
    expect(missing.map((m) => m.relation)).toContain('public.v_slow_queries');
  });
});

describe('comment and dollar-quote stripping', () => {
  // 0419's own header quotes its ROLLBACK verbatim, which contains a literal
  // `GRANT ALL ON TABLE public.v_slow_queries TO anon, authenticated;`. If that
  // were read as live SQL the rule would flag the migration that fixes the bug.
  it('does not read a GRANT inside a line comment as a re-grant', () => {
    const files: FileSql[] = [
      baselineFile(),
      {
        file: '0419_x.sql',
        sql: `-- ROLLBACK:
              --   GRANT ALL ON TABLE public.v_slow_queries TO anon, authenticated;
              REVOKE ALL ON TABLE public.v_slow_queries FROM PUBLIC, anon, authenticated;
              GRANT ALL ON TABLE public.v_slow_queries TO service_role;`,
      },
    ];
    expect(hasTerminalRelationRevoke(files, 'public', 'v_slow_queries')).toBe(true);
  });

  it('does not read a REVOKE inside a comment as satisfying the rule', () => {
    const files: FileSql[] = [
      baselineFile(),
      {
        file: '0500_notes.sql',
        sql: `-- REVOKE ALL ON TABLE public.v_slow_queries FROM anon, authenticated;
              SELECT 1;`,
      },
    ];
    expect(hasTerminalRelationRevoke(files, 'public', 'v_slow_queries')).toBe(false);
  });

  it('strips block comments and dollar-quoted bodies', () => {
    expect(normalize('/* GRANT ALL ON TABLE public.x TO anon; */ SELECT 1;')).not.toMatch(/GRANT/i);
    expect(normalize("CREATE FUNCTION f() AS $$ GRANT ALL ON TABLE public.x TO anon; $$;")).not.toMatch(
      /GRANT ALL/i,
    );
    expect(normalize('$tag$ REVOKE ALL ON TABLE public.x FROM anon; $tag$')).not.toMatch(/REVOKE/i);
  });
});

describe('terminal-state semantics', () => {
  it('an unrevoked baseline relation is open', () => {
    expect(hasTerminalRelationRevoke([baselineFile()], 'public', 'v_slow_queries')).toBe(false);
  });

  it('a later compensating revoke closes it', () => {
    expect(
      hasTerminalRelationRevoke([baselineFile(), revokeFile('0419_a.sql')], 'public', 'v_slow_queries'),
    ).toBe(true);
  });

  it('a re-grant in a LATER file reopens it', () => {
    const files = [
      baselineFile(),
      revokeFile('0419_a.sql'),
      { file: '0420_b.sql', sql: 'GRANT SELECT ON TABLE public.v_slow_queries TO anon;' },
    ];
    expect(hasTerminalRelationRevoke(files, 'public', 'v_slow_queries')).toBe(false);
  });

  it('a re-definition AFTER the revoke is not credited (conservative)', () => {
    const files = [baselineFile(), revokeFile('0419_a.sql'), baselineFile()];
    files[2] = { ...files[2], file: '0420_redefine.sql' };
    expect(hasTerminalRelationRevoke(files, 'public', 'v_slow_queries')).toBe(false);
  });

  it('a revoke naming only PUBLIC does not count — ADP grants anon DIRECTLY', () => {
    const files = [
      baselineFile(),
      { file: '0419_a.sql', sql: 'REVOKE ALL ON TABLE public.v_slow_queries FROM PUBLIC;' },
    ];
    expect(hasTerminalRelationRevoke(files, 'public', 'v_slow_queries')).toBe(false);
  });

  it('anonAxisOnly accepts an anon-only revoke and ignores an authenticated grant', () => {
    const files = [
      baselineFile(),
      {
        file: '0419_a.sql',
        sql: `REVOKE ALL ON TABLE public.v_slow_queries FROM PUBLIC, anon;
              GRANT SELECT ON TABLE public.v_slow_queries TO authenticated;`,
      },
    ];
    expect(hasTerminalRelationRevoke(files, 'public', 'v_slow_queries', true)).toBe(true);
    expect(hasTerminalRelationRevoke(files, 'public', 'v_slow_queries', false)).toBe(false);
  });
});

describe('identifier matching', () => {
  it('does not let a revoke on a PREFIXED sibling credit the shorter name', () => {
    const files = [
      baselineFile(),
      { file: '0419_a.sql', sql: 'REVOKE ALL ON TABLE public.v_slow_queries_archive FROM anon, authenticated;' },
    ];
    expect(hasTerminalRelationRevoke(files, 'public', 'v_slow_queries')).toBe(false);
  });

  it('matches quoted identifiers as the baseline emits them', () => {
    const sql = normalize('REVOKE ALL ON TABLE "public"."v_slow_queries" FROM anon, authenticated;');
    expect(revokesRequiredRoles(sql, 'public', 'v_slow_queries', false)).toBe(true);
  });

  it('matches an unqualified relation name', () => {
    const sql = normalize('REVOKE ALL ON v_slow_queries FROM anon, authenticated;');
    expect(revokesRequiredRoles(sql, 'public', 'v_slow_queries', false)).toBe(true);
  });

  it('ignores ON FUNCTION statements for a same-named function', () => {
    const sql = normalize('REVOKE ALL ON FUNCTION public.v_slow_queries() FROM anon, authenticated;');
    expect(revokesRequiredRoles(sql, 'public', 'v_slow_queries', false)).toBe(false);
  });

  it('detects CREATE TABLE / VIEW / MATERIALIZED VIEW / SEQUENCE definitions', () => {
    expect(definesRelation(normalize('CREATE TABLE IF NOT EXISTS public.t (id int);'), 'public', 't')).toBe(true);
    expect(definesRelation(normalize('CREATE OR REPLACE VIEW "public"."v" AS SELECT 1;'), 'public', 'v')).toBe(true);
    expect(definesRelation(normalize('CREATE MATERIALIZED VIEW public.m AS SELECT 1;'), 'public', 'm')).toBe(true);
    expect(definesRelation(normalize('CREATE SEQUENCE IF NOT EXISTS public.s;'), 'public', 's')).toBe(true);
    expect(definesRelation(normalize('CREATE TABLE public.t_other (id int);'), 'public', 't')).toBe(false);
  });

  it('grantsBlockedRole ignores a service_role-only grant', () => {
    const sql = normalize('GRANT ALL ON TABLE public.v_slow_queries TO service_role;');
    expect(grantsBlockedRole(sql, 'public', 'v_slow_queries', false)).toBe(false);
  });
});
