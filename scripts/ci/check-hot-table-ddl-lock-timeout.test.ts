/**
 * Coverage for the hot-table DDL `lock_timeout` linter.
 *
 * Incident this encodes (2026-08-11 P0, HANDOFF.md): an `ALTER TABLE
 * public.organizations` with no `lock_timeout` queued behind two long
 * `AccessShareLock` readers. Postgres lock queues are FIFO, so every later
 * lock request — including PostgREST's schema-cache introspection — queued
 * behind that ALTER. Introspection timed out, PostgREST entered a `PGRST002`
 * loop, and `/api/v1/verify` served `service_unavailable` for 11m39s.
 *
 * The asymmetry that made it persist: the readers had a `lock_timeout` and
 * died repeatedly; the DDL session had none and camped the queue 15+ minutes.
 * A bounded `lock_timeout` turns a barrier into a fast, retryable failure.
 */

import { describe, it, expect } from 'vitest';
import { scanFiles, HOT_TABLES, RUNTIME_DDL_TABLES } from './check-hot-table-ddl-lock-timeout';

function file(name: string, body: string) {
  return { name, body };
}

const GUARD = "SET LOCAL lock_timeout = '5s';\n";

function violations(files: ReturnType<typeof file>[]) {
  return scanFiles(files).map((v) => `${v.file}:${v.table}:${v.kind}`);
}

describe('HOT_TABLES', () => {
  it('covers the three tables named in the P0 postmortem', () => {
    expect([...HOT_TABLES].sort()).toEqual(['anchors', 'organizations', 'profiles']);
  });
});

describe('RUNTIME_DDL_TABLES', () => {
  it('is HOT_TABLES plus audit_events', () => {
    // BUG-019: `cleanup_expired_data()` DROPs and re-CREATEs a trigger on
    // `audit_events` on every retention run. `audit_events` is deliberately NOT
    // in HOT_TABLES — three already-merged migrations (0295 / 0309 / 0404) do
    // one-shot top-level DDL on it under operator supervision, and widening the
    // top-level set would only add baseline entries, which the baseline file
    // forbids ("Do NOT add entries to shrink a red build"). DDL executed at
    // RUNTIME from a function body is the different, worse case: it fires on a
    // cron clock, unsupervised, against a table every write path appends to.
    expect([...RUNTIME_DDL_TABLES].sort()).toEqual([
      'anchors',
      'audit_events',
      'organizations',
      'profiles',
    ]);
  });

  it('is a strict superset of HOT_TABLES', () => {
    for (const t of HOT_TABLES) expect(RUNTIME_DDL_TABLES).toContain(t);
  });
});

describe('check-hot-table-ddl-lock-timeout scanFiles', () => {
  it('flags an unguarded ALTER TABLE on a hot table (the 0407 shape)', () => {
    expect(
      violations([
        file(
          'supabase/migrations/0407_x.sql',
          'ALTER TABLE public.organizations ADD COLUMN foo text;\n',
        ),
      ]),
    ).toEqual(['supabase/migrations/0407_x.sql:organizations:ALTER TABLE']);
  });

  it('accepts the same ALTER when a bounded lock_timeout precedes it', () => {
    expect(
      violations([
        file(
          'supabase/migrations/0407_x.sql',
          GUARD + 'ALTER TABLE public.organizations ADD COLUMN foo text;\n',
        ),
      ]),
    ).toEqual([]);
  });

  it('rejects a lock_timeout of zero — 0 means WAIT FOREVER, the exact bug', () => {
    for (const zero of ["SET lock_timeout = 0;", "SET LOCAL lock_timeout = '0';", "SET lock_timeout = '0s';"]) {
      expect(
        violations([
          file('supabase/migrations/0407_x.sql', `${zero}\nALTER TABLE anchors ADD COLUMN b text;\n`),
        ]),
      ).toEqual(['supabase/migrations/0407_x.sql:anchors:ALTER TABLE']);
    }
  });

  it('does not accept a guard that appears AFTER the DDL', () => {
    expect(
      violations([
        file('supabase/migrations/0407_x.sql', 'ALTER TABLE profiles ADD COLUMN b text;\n' + GUARD),
      ]),
    ).toEqual(['supabase/migrations/0407_x.sql:profiles:ALTER TABLE']);
  });

  it('voids the guard when RESET lock_timeout intervenes', () => {
    expect(
      violations([
        file(
          'supabase/migrations/0407_x.sql',
          GUARD + 'RESET lock_timeout;\nALTER TABLE anchors ADD COLUMN b text;\n',
        ),
      ]),
    ).toEqual(['supabase/migrations/0407_x.sql:anchors:ALTER TABLE']);
  });

  it('does not count a lock_timeout that only appears inside a comment', () => {
    // 0359/0360 carry exactly this shape in their headers — prose describing a
    // preamble is not a preamble.
    expect(
      violations([
        file(
          'supabase/migrations/0407_x.sql',
          "-- (SET lock_timeout='5s' preamble; zero lock waits)\nALTER TABLE anchors ADD COLUMN b text;\n",
        ),
      ]),
    ).toEqual(['supabase/migrations/0407_x.sql:anchors:ALTER TABLE']);
  });

  it('ignores DDL that is itself commented out', () => {
    expect(
      violations([
        file(
          'supabase/migrations/0407_x.sql',
          '-- ROLLBACK: ALTER TABLE public.organizations DROP COLUMN foo;\n/* ALTER TABLE anchors ADD COLUMN c text; */\n',
        ),
      ]),
    ).toEqual([]);
  });

  it('ignores DDL on tables that are not hot', () => {
    expect(
      violations([
        file('supabase/migrations/0407_x.sql', 'ALTER TABLE job_queue ADD COLUMN foo text;\n'),
      ]),
    ).toEqual([]);
  });

  it.each([
    ['CREATE POLICY', 'CREATE POLICY p ON public.anchors FOR SELECT USING (true);'],
    ['ALTER POLICY', 'ALTER POLICY p ON anchors USING (true);'],
    ['DROP POLICY', 'DROP POLICY IF EXISTS p ON public.anchors;'],
    ['CREATE TRIGGER', 'CREATE TRIGGER t BEFORE INSERT ON public.anchors FOR EACH ROW EXECUTE FUNCTION f();'],
    ['DROP TRIGGER', 'DROP TRIGGER IF EXISTS t ON anchors;'],
    ['CREATE INDEX', 'CREATE UNIQUE INDEX idx_x ON public.anchors (id);'],
    ['TRUNCATE', 'TRUNCATE TABLE public.anchors;'],
    ['DROP TABLE', 'DROP TABLE IF EXISTS public.anchors;'],
    ['GRANT/REVOKE', 'REVOKE ALL ON TABLE public.anchors FROM anon;'],
  ])('flags unguarded %s on a hot table', (kind, sql) => {
    expect(violations([file('supabase/migrations/0407_x.sql', `${sql}\n`)])).toEqual([
      `supabase/migrations/0407_x.sql:anchors:${kind}`,
    ]);
    expect(violations([file('supabase/migrations/0407_x.sql', GUARD + sql + '\n')])).toEqual([]);
  });

  it('does not flag CREATE INDEX CONCURRENTLY — it takes no barrier-forming lock', () => {
    expect(
      violations([
        file(
          'supabase/migrations/0366_x.sql',
          'CREATE INDEX CONCURRENTLY idx_anchors_folder_id ON public.anchors (folder_id);\n',
        ),
      ]),
    ).toEqual([]);
  });

  it('does not flag REVOKE on a FUNCTION whose name contains a hot-table name', () => {
    expect(
      violations([
        file(
          'supabase/migrations/0407_x.sql',
          'REVOKE ALL ON FUNCTION public.get_organizations_for_user(uuid) FROM anon;\n',
        ),
      ]),
    ).toEqual([]);
  });

  it('reports every unguarded statement in a file, not just the first', () => {
    expect(
      violations([
        file(
          'supabase/migrations/0407_x.sql',
          'ALTER TABLE anchors ADD COLUMN a text;\nALTER TABLE profiles ADD COLUMN b text;\n',
        ),
      ]),
    ).toEqual([
      'supabase/migrations/0407_x.sql:anchors:ALTER TABLE',
      'supabase/migrations/0407_x.sql:profiles:ALTER TABLE',
    ]);
  });

  it('guards each statement independently once the timeout is set', () => {
    expect(
      violations([
        file(
          'supabase/migrations/0407_x.sql',
          'ALTER TABLE anchors ADD COLUMN a text;\n' + GUARD + 'ALTER TABLE profiles ADD COLUMN b text;\n',
        ),
      ]),
    ).toEqual(['supabase/migrations/0407_x.sql:anchors:ALTER TABLE']);
  });

  it('accepts a quoted-identifier hot table and still requires the guard', () => {
    expect(
      violations([
        file('supabase/migrations/0407_x.sql', 'ALTER TABLE "public"."organizations" ADD COLUMN a text;\n'),
      ]),
    ).toEqual(['supabase/migrations/0407_x.sql:organizations:ALTER TABLE']);
  });

  it('reports the 1-based line number of the offending statement', () => {
    const [v] = scanFiles([
      file('supabase/migrations/0407_x.sql', '-- header\n\nALTER TABLE anchors ADD COLUMN a text;\n'),
    ]);
    expect(v.line).toBe(3);
  });
});

/**
 * BUG-019 (2026-08 soak): the linter above reads a migration as a flat sequence
 * of statements, so a `SET LOCAL lock_timeout` anywhere earlier in the FILE
 * counted as a guard for everything after it. That is correct for statements
 * the migration itself runs, and wrong for a `CREATE FUNCTION` body: the body
 * is stored, not executed, at apply time. It executes later, in a cron's
 * session, where the migration's `SET LOCAL` is long gone — so a file-level
 * guard in front of a `CREATE FUNCTION` is a guard over the CREATE, never over
 * the DDL the function will run months later.
 *
 * `cleanup_expired_data()` is exactly that shape: SECURITY DEFINER, invoked by
 * `POST /cron/cleanup-retention`, doing DROP TRIGGER -> DELETE -> CREATE TRIGGER
 * on `audit_events` with no bounded timeout anywhere. It is the 2026-08-11 P0
 * mechanism (CLAUDE.md §1.2) hidden one level down from where the linter looked.
 *
 * A `DO $$ ... $$` block is deliberately NOT treated as deferred: it runs during
 * the migration, in the migration's own transaction, so a file-level `SET LOCAL`
 * genuinely does cover it.
 */
describe('deferred function bodies (BUG-019)', () => {
  const fnWith = (body: string, setClause = '') =>
    `CREATE OR REPLACE FUNCTION public.f() RETURNS void\n` +
    `    LANGUAGE plpgsql SECURITY DEFINER\n` +
    `    SET search_path TO 'public'\n` +
    (setClause ? `    ${setClause}\n` : '') +
    `    AS $$\nBEGIN\n${body}\nEND;\n$$;\n`;

  it('flags in-function DDL on a hot table with no timeout anywhere', () => {
    expect(
      violations([
        file('supabase/migrations/0500_x.sql', fnWith('  ALTER TABLE anchors ADD COLUMN a text;')),
      ]),
    ).toEqual(['supabase/migrations/0500_x.sql:anchors:ALTER TABLE']);
  });

  it('flags in-function DDL even when the FILE sets a lock_timeout first', () => {
    // The regression this whole suite exists for: the pre-BUG-019 linter passed
    // this file. The SET LOCAL applies to the CREATE FUNCTION statement, not to
    // the body, which runs in an entirely different session.
    const v = scanFiles([
      file('supabase/migrations/0500_x.sql', GUARD + fnWith('  ALTER TABLE anchors ADD COLUMN a text;')),
    ]);
    expect(v.map((x) => `${x.table}:${x.kind}:${x.context}`)).toEqual([
      'anchors:ALTER TABLE:function-body',
    ]);
  });

  it('accepts in-function DDL guarded by SET LOCAL inside the same body', () => {
    expect(
      violations([
        file(
          'supabase/migrations/0500_x.sql',
          fnWith("  SET LOCAL lock_timeout = '5s';\n  ALTER TABLE anchors ADD COLUMN a text;"),
        ),
      ]),
    ).toEqual([]);
  });

  it('accepts in-function DDL guarded by the function-level SET clause', () => {
    expect(
      violations([
        file(
          'supabase/migrations/0500_x.sql',
          fnWith('  ALTER TABLE anchors ADD COLUMN a text;', "SET lock_timeout TO '5s'"),
        ),
      ]),
    ).toEqual([]);
  });

  it('rejects a function-level SET clause of zero — still wait-forever', () => {
    expect(
      violations([
        file(
          'supabase/migrations/0500_x.sql',
          fnWith('  ALTER TABLE anchors ADD COLUMN a text;', "SET lock_timeout TO '0'"),
        ),
      ]),
    ).toEqual(['supabase/migrations/0500_x.sql:anchors:ALTER TABLE']);
  });

  it('does not let an in-body guard leak forward to a LATER top-level statement', () => {
    // The body never executes at apply time, so nothing it sets can protect the
    // migration's own next statement.
    expect(
      violations([
        file(
          'supabase/migrations/0500_x.sql',
          fnWith("  SET LOCAL lock_timeout = '5s';\n  PERFORM 1;") +
            'ALTER TABLE anchors ADD COLUMN a text;\n',
        ),
      ]),
    ).toEqual(['supabase/migrations/0500_x.sql:anchors:ALTER TABLE']);
  });

  it('flags in-function DDL on audit_events (the exact BUG-019 statement pair)', () => {
    const v = scanFiles([
      file(
        'supabase/migrations/0500_x.sql',
        fnWith(
          '  DROP TRIGGER IF EXISTS reject_audit_delete ON audit_events;\n' +
            "  DELETE FROM audit_events WHERE created_at < now() - INTERVAL '2 years';\n" +
            '  CREATE TRIGGER reject_audit_delete BEFORE DELETE ON audit_events\n' +
            '    FOR EACH ROW EXECUTE FUNCTION reject_audit_modification();',
        ),
      ),
    ]);
    expect(v.map((x) => `${x.table}:${x.kind}`)).toEqual([
      'audit_events:DROP TRIGGER',
      'audit_events:CREATE TRIGGER',
    ]);
  });

  it('accepts that same pair once a bounded SET LOCAL precedes it in the body', () => {
    expect(
      violations([
        file(
          'supabase/migrations/0500_x.sql',
          fnWith(
            "  SET LOCAL lock_timeout = '5s';\n" +
              '  DROP TRIGGER IF EXISTS reject_audit_delete ON audit_events;\n' +
              '  CREATE TRIGGER reject_audit_delete BEFORE DELETE ON audit_events\n' +
              '    FOR EACH ROW EXECUTE FUNCTION reject_audit_modification();',
          ),
        ),
      ]),
    ).toEqual([]);
  });

  it('does NOT widen the top-level rule to audit_events', () => {
    // 0295 / 0309 / 0404 shapes stay green: one-shot, operator-supervised DDL.
    expect(
      violations([
        file('supabase/migrations/0500_x.sql', 'ALTER TABLE public.audit_events DROP CONSTRAINT c;\n'),
      ]),
    ).toEqual([]);
  });

  it('treats a DO block as immediate, so a file-level guard covers it', () => {
    expect(
      violations([
        file(
          'supabase/migrations/0500_x.sql',
          GUARD + 'DO $$\nBEGIN\n  ALTER TABLE anchors ADD COLUMN a text;\nEND;\n$$;\n',
        ),
      ]),
    ).toEqual([]);
  });

  it('still flags an unguarded DO block', () => {
    const v = scanFiles([
      file(
        'supabase/migrations/0500_x.sql',
        'DO $$\nBEGIN\n  ALTER TABLE anchors ADD COLUMN a text;\nEND;\n$$;\n',
      ),
    ]);
    expect(v.map((x) => `${x.table}:${x.context}`)).toEqual(['anchors:top-level']);
  });

  it('handles a tagged dollar quote ($fn$) and nested $$ inside it', () => {
    expect(
      violations([
        file(
          'supabase/migrations/0500_x.sql',
          'CREATE FUNCTION public.f() RETURNS void LANGUAGE plpgsql AS $fn$\n' +
            "BEGIN\n  EXECUTE 'SELECT 1';\n  ALTER TABLE profiles ADD COLUMN a text;\nEND;\n$fn$;\n",
        ),
      ]),
    ).toEqual(['supabase/migrations/0500_x.sql:profiles:ALTER TABLE']);
  });

  it('scopes the guard to one body — a guard in function A does not cover function B', () => {
    const a = `CREATE FUNCTION public.a() RETURNS void LANGUAGE plpgsql AS $$\nBEGIN\n  SET LOCAL lock_timeout = '5s';\n  ALTER TABLE anchors ADD COLUMN a text;\nEND;\n$$;\n`;
    const b = `CREATE FUNCTION public.b() RETURNS void LANGUAGE plpgsql AS $$\nBEGIN\n  ALTER TABLE profiles ADD COLUMN b text;\nEND;\n$$;\n`;
    expect(violations([file('supabase/migrations/0500_x.sql', a + b)])).toEqual([
      'supabase/migrations/0500_x.sql:profiles:ALTER TABLE',
    ]);
  });

  it('labels top-level violations with context "top-level"', () => {
    const [v] = scanFiles([
      file('supabase/migrations/0500_x.sql', 'ALTER TABLE anchors ADD COLUMN a text;\n'),
    ]);
    expect(v.context).toBe('top-level');
  });
});
