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
import { scanFiles, HOT_TABLES } from './check-hot-table-ddl-lock-timeout';

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
