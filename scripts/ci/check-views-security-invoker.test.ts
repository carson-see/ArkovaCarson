/**
 * SCRUM-1276 (R3-3) — coverage for the views-security-invoker linter.
 *
 * The linter must:
 *   - flag a bare `CREATE VIEW`
 *   - accept `CREATE OR REPLACE VIEW ... WITH (security_invoker = true)`
 *   - accept a later `ALTER VIEW <name> SET (security_invoker = true)`
 *     as resolving an earlier bare CREATE
 *   - process migrations in sorted order (so a later migration overrides
 *     an earlier one for the same view name)
 *   - skip MATERIALIZED VIEW (different semantics, tracked separately)
 *   - tolerate the `IF EXISTS` and `public.` qualifiers in ALTER VIEW
 */

import { describe, it, expect } from 'vitest';
import { scanFiles } from './check-views-security-invoker';

function file(name: string, body: string) {
  return { name, body };
}

function fixedPublicView(name = 'v') {
  return file(
    'supabase/migrations/0100_fixed.sql',
    `CREATE OR REPLACE VIEW public.${name} WITH (security_invoker = true) AS SELECT 1;\n`,
  );
}

function bareViewNames(files: ReturnType<typeof file>[]) {
  return scanFiles(files).bareCreates.map((f) => f.view);
}

describe('check-views-security-invoker scanFiles', () => {
  it('flags a bare CREATE VIEW with no follow-up fix', () => {
    const { bareCreates } = scanFiles([
      file('supabase/migrations/0100_x.sql', 'CREATE VIEW payment_ledger AS SELECT 1;'),
    ]);
    expect(bareCreates.map((f) => f.view)).toEqual(['payment_ledger']);
  });

  it('accepts CREATE OR REPLACE VIEW ... WITH (security_invoker = true) inline', () => {
    const { bareCreates, fixedAfter } = scanFiles([
      file(
        'supabase/migrations/0281_x.sql',
        'CREATE OR REPLACE VIEW public_org_profiles\nWITH (security_invoker = true) AS\nSELECT id FROM organizations;',
      ),
    ]);
    expect(bareCreates).toEqual([]);
    expect(fixedAfter.has('public_org_profiles')).toBe(true);
  });

  it('accepts pg_dump reloptions spelling for inline security_invoker', () => {
    const { bareCreates, fixedAfter } = scanFiles([
      file(
        'supabase/migrations/00000000000000_baseline.sql',
        'CREATE OR REPLACE VIEW "public"."payment_ledger" WITH ("security_invoker"=\'true\') AS SELECT 1;',
      ),
    ]);
    expect(bareCreates).toEqual([]);
    expect(fixedAfter.has('payment_ledger')).toBe(true);
  });

  it.each([
    ['single security_invoker option', 'ALTER VIEW public.payment_ledger SET (security_invoker = true);'],
    ['security_invoker = on', 'ALTER VIEW public.payment_ledger SET (security_invoker = on);'],
    [
      'security_invoker among other options',
      'ALTER VIEW public.payment_ledger SET (check_option = local, security_invoker = true);',
    ],
    [
      'pg_dump quoted reloption spelling',
      'ALTER VIEW public.payment_ledger SET ("security_invoker" = \'true\');',
    ],
  ])('treats a later ALTER VIEW SET as resolving an earlier bare CREATE: %s', (_caseName, alterSql) => {
    const { bareCreates, fixedAfter } = scanFiles([
      file('supabase/migrations/0100_create.sql', 'CREATE OR REPLACE VIEW payment_ledger AS SELECT 1;'),
      file('supabase/migrations/0274_alter.sql', alterSql),
    ]);
    expect(bareCreates).toEqual([]);
    expect(fixedAfter.has('payment_ledger')).toBe(true);
  });

  it('respects sorted migration order regardless of input order', () => {
    const { bareCreates } = scanFiles([
      file(
        'supabase/migrations/0274_alter.sql',
        'ALTER VIEW payment_ledger SET (security_invoker = true);',
      ),
      file('supabase/migrations/0100_create.sql', 'CREATE OR REPLACE VIEW payment_ledger AS SELECT 1;'),
    ]);
    expect(bareCreates).toEqual([]);
  });

  it('flags a bare CREATE OR REPLACE that lands AFTER a fix (regression)', () => {
    const { bareCreates } = scanFiles([
      file(
        'supabase/migrations/0100_a.sql',
        'CREATE OR REPLACE VIEW v WITH (security_invoker = true) AS SELECT 1;',
      ),
      file('supabase/migrations/0500_b.sql', 'CREATE OR REPLACE VIEW v AS SELECT 1;'),
    ]);
    expect(bareCreates.map((f) => f.view)).toEqual(['v']);
    expect(bareCreates[0].file).toBe('supabase/migrations/0500_b.sql');
  });

  it('preserves statement order inside one migration file', () => {
    const { bareCreates } = scanFiles([
      file(
        'supabase/migrations/0500_mixed.sql',
        'ALTER VIEW public.v SET (security_invoker = true);\n' +
          'CREATE OR REPLACE VIEW public.v AS SELECT 1;\n',
      ),
    ]);

    expect(bareCreates.map((f) => f.view)).toEqual(['v']);
    expect(bareCreates[0].line).toBe(2);
  });

  it.each([
    [
      'SET false',
      file('supabase/migrations/0500_unfix.sql', 'ALTER VIEW public.v SET (security_invoker = false);\n'),
    ],
    ['RESET single option', file('supabase/migrations/0500_reset.sql', 'ALTER VIEW public.v RESET (security_invoker);\n')],
    [
      'RESET among other options',
      file('supabase/migrations/0500_reset.sql', 'ALTER VIEW public.v RESET (check_option, security_invoker);\n'),
    ],
  ])('flags ALTER VIEW security_invoker regressions after a fixed CREATE: %s', (_caseName, alterMigration) => {
    const { bareCreates } = scanFiles([
      fixedPublicView(),
      alterMigration,
    ]);

    expect(bareCreates.map((f) => f.view)).toEqual(['v']);
  });

  it('treats a later fixed CREATE for the same view as the latest state', () => {
    expect(bareViewNames([
      file(
        'supabase/migrations/0500_same_view.sql',
        'CREATE VIEW v AS SELECT 1;\n' +
          'CREATE VIEW v WITH (security_invoker = true) AS SELECT 2;\n',
      ),
    ])).toEqual([]);
  });

  it('does not let a fixed CREATE for another view satisfy an earlier bare CREATE', () => {
    expect(bareViewNames([
      file(
        'supabase/migrations/0500_two_views.sql',
        'CREATE VIEW bare_v AS SELECT 1;\n' +
          'CREATE VIEW fixed_v WITH (security_invoker = true) AS SELECT 2;\n',
      ),
    ])).toEqual(['bare_v']);
  });

  it('does not let security_invoker text in the SELECT body satisfy a bare CREATE', () => {
    expect(bareViewNames([
      file(
        'supabase/migrations/0500_select_body.sql',
        "CREATE VIEW bare_v AS SELECT 'security_invoker = true' AS marker;\n",
      ),
    ])).toEqual(['bare_v']);
  });

  it('skips CREATE MATERIALIZED VIEW (out of scope)', () => {
    const { bareCreates } = scanFiles([
      file('supabase/migrations/0123_x.sql', 'CREATE MATERIALIZED VIEW mv_x AS SELECT 1;'),
    ]);
    expect(bareCreates).toEqual([]);
  });

  it('accepts ALTER VIEW IF EXISTS schema-qualified', () => {
    const { bareCreates } = scanFiles([
      file('supabase/migrations/0100_a.sql', 'CREATE OR REPLACE VIEW q AS SELECT 1;'),
      file(
        'supabase/migrations/0274_b.sql',
        'ALTER VIEW IF EXISTS public.q SET (security_invoker = true);',
      ),
    ]);
    expect(bareCreates).toEqual([]);
  });

  it('accepts security_invoker = on as well as = true', () => {
    const { bareCreates } = scanFiles([
      file(
        'supabase/migrations/0100_a.sql',
        'CREATE OR REPLACE VIEW v WITH (security_invoker = on) AS SELECT 1;',
      ),
    ]);
    expect(bareCreates).toEqual([]);
  });

  it('reports the latest bare CREATE finding with file + line', () => {
    const body =
      'BEGIN;\n' +
      '\n' +
      'CREATE OR REPLACE VIEW some_view AS\n' +
      '  SELECT 1 AS x;\n' +
      '\n' +
      'COMMIT;\n';
    const { bareCreates } = scanFiles([file('supabase/migrations/0900_z.sql', body)]);
    expect(bareCreates).toHaveLength(1);
    expect(bareCreates[0].file).toBe('supabase/migrations/0900_z.sql');
    expect(bareCreates[0].line).toBe(3);
  });

  it('handles multiple distinct views in one migration', () => {
    const { bareCreates, fixedAfter } = scanFiles([
      file(
        'supabase/migrations/0100_x.sql',
        'CREATE OR REPLACE VIEW good_v WITH (security_invoker = true) AS SELECT 1;\n' +
          'CREATE OR REPLACE VIEW bad_v AS SELECT 1;\n',
      ),
    ]);
    expect(bareCreates.map((f) => f.view)).toEqual(['bad_v']);
    expect(fixedAfter.has('good_v')).toBe(true);
    expect(fixedAfter.has('bad_v')).toBe(false);
  });

  it('flags a bare CREATE VIEW with a double-quoted identifier', () => {
    expect(bareViewNames([
      file(
        'supabase/migrations/0100_quoted.sql',
        'CREATE VIEW "MyView" AS SELECT 1;',
      ),
    ])).toEqual(['MyView']);
  });

  it('accepts a fixed CREATE VIEW with a double-quoted identifier', () => {
    const { bareCreates, fixedAfter } = scanFiles([
      file(
        'supabase/migrations/0100_quoted.sql',
        'CREATE OR REPLACE VIEW "MyView" WITH (security_invoker = true) AS SELECT 1;',
      ),
    ]);
    expect(bareCreates).toEqual([]);
    expect(fixedAfter.has('MyView')).toBe(true);
  });

  it('treats an ALTER on a quoted identifier as resolving the same bare view', () => {
    const { bareCreates, fixedAfter } = scanFiles([
      file('supabase/migrations/0100_create.sql', 'CREATE VIEW my_view AS SELECT 1;'),
      file(
        'supabase/migrations/0274_alter.sql',
        'ALTER VIEW "my_view" SET (security_invoker = true);',
      ),
    ]);
    expect(bareCreates).toEqual([]);
    expect(fixedAfter.has('my_view')).toBe(true);
  });

  it('handles a fully quoted schema-qualified view name', () => {
    const { bareCreates, fixedAfter } = scanFiles([
      file(
        'supabase/migrations/0100_quoted.sql',
        'CREATE OR REPLACE VIEW "public"."My_View" WITH (security_invoker = true) AS SELECT 1;',
      ),
    ]);
    expect(bareCreates).toEqual([]);
    expect(fixedAfter.has('My_View')).toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────────
  // Comment-bypass regressions: SQL comments must never spoof or hide the
  // lint state. A `--` line comment or `/* ... */` block comment that
  // looks like a CREATE/ALTER statement is not executable SQL and must
  // not flip the latestState/latestFinding maps.
  // ───────────────────────────────────────────────────────────────────────
  it('does not let a commented-out CREATE VIEW count as a real declaration', () => {
    const { bareCreates, fixedAfter } = scanFiles([
      file(
        'supabase/migrations/0100_only_comments.sql',
        '-- CREATE VIEW commented_v AS SELECT 1;\n' +
          '/* CREATE VIEW block_commented_v AS SELECT 2; */\n',
      ),
    ]);
    expect(bareCreates).toEqual([]);
    expect(fixedAfter.has('commented_v')).toBe(false);
    expect(fixedAfter.has('block_commented_v')).toBe(false);
  });

  it('does not let a commented-out ALTER VIEW SET satisfy an earlier bare CREATE', () => {
    const { bareCreates } = scanFiles([
      file('supabase/migrations/0100_create.sql', 'CREATE VIEW v AS SELECT 1;'),
      file(
        'supabase/migrations/0274_fake_fix.sql',
        '-- ALTER VIEW v SET (security_invoker = true);\n' +
          '/* ALTER VIEW v SET (security_invoker = true); */\n',
      ),
    ]);
    expect(bareCreates.map((f) => f.view)).toEqual(['v']);
  });

  it('does not let a commented-out ALTER VIEW RESET regress an earlier fix', () => {
    const { bareCreates, fixedAfter } = scanFiles([
      file(
        'supabase/migrations/0100_fixed.sql',
        'CREATE OR REPLACE VIEW v WITH (security_invoker = true) AS SELECT 1;',
      ),
      file(
        'supabase/migrations/0500_fake_unfix.sql',
        '-- ALTER VIEW v RESET (security_invoker);\n' +
          '/* ALTER VIEW v SET (security_invoker = false); */\n',
      ),
    ]);
    expect(bareCreates).toEqual([]);
    expect(fixedAfter.has('v')).toBe(true);
  });

  it('preserves line numbers when stripping comments (lineNumber() stays aligned)', () => {
    const body =
      '-- header comment line 1\n' +
      '/* multi-line block\n' +
      '   line 3\n' +
      '   line 4 */\n' +
      'CREATE VIEW bare_v AS SELECT 1;\n';
    const { bareCreates } = scanFiles([file('supabase/migrations/0900_z.sql', body)]);
    expect(bareCreates).toHaveLength(1);
    expect(bareCreates[0].view).toBe('bare_v');
    expect(bareCreates[0].line).toBe(5);
  });

  it('keeps text inside string literals (does not treat -- inside a quoted string as a comment)', () => {
    const { bareCreates } = scanFiles([
      file(
        'supabase/migrations/0100_str.sql',
        "CREATE VIEW bare_v AS SELECT '-- this is data, not a comment' AS marker;\n",
      ),
    ]);
    expect(bareCreates.map((f) => f.view)).toEqual(['bare_v']);
  });
});
