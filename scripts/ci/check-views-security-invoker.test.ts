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

  it('treats a later ALTER VIEW SET (security_invoker = true) as resolving an earlier bare CREATE', () => {
    const { bareCreates, fixedAfter } = scanFiles([
      file('supabase/migrations/0100_create.sql', 'CREATE OR REPLACE VIEW payment_ledger AS SELECT 1;'),
      file(
        'supabase/migrations/0274_alter.sql',
        'ALTER VIEW public.payment_ledger SET (security_invoker = true);',
      ),
    ]);
    expect(bareCreates).toEqual([]);
    expect(fixedAfter.has('payment_ledger')).toBe(true);
  });

  it('accepts ALTER VIEW SET with security_invoker among other options', () => {
    const { bareCreates, fixedAfter } = scanFiles([
      file('supabase/migrations/0100_create.sql', 'CREATE OR REPLACE VIEW payment_ledger AS SELECT 1;'),
      file(
        'supabase/migrations/0274_alter.sql',
        'ALTER VIEW public.payment_ledger SET (check_option = local, security_invoker = true);',
      ),
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

  it('flags negative ALTER VIEW security_invoker changes after a fixed CREATE', () => {
    const { bareCreates } = scanFiles([
      file(
        'supabase/migrations/0100_fixed.sql',
        'CREATE OR REPLACE VIEW public.v WITH (security_invoker = true) AS SELECT 1;\n',
      ),
      file(
        'supabase/migrations/0500_unfix.sql',
        'ALTER VIEW public.v SET (security_invoker = false);\n',
      ),
    ]);

    expect(bareCreates.map((f) => f.view)).toEqual(['v']);
    expect(bareCreates[0].file).toBe('supabase/migrations/0500_unfix.sql');
  });

  it('flags ALTER VIEW RESET security_invoker after a fixed CREATE', () => {
    const { bareCreates } = scanFiles([
      file(
        'supabase/migrations/0100_fixed.sql',
        'CREATE OR REPLACE VIEW public.v WITH (security_invoker = true) AS SELECT 1;\n',
      ),
      file('supabase/migrations/0500_reset.sql', 'ALTER VIEW public.v RESET (security_invoker);\n'),
    ]);

    expect(bareCreates.map((f) => f.view)).toEqual(['v']);
  });

  it('flags multi-option ALTER VIEW RESET containing security_invoker', () => {
    const { bareCreates } = scanFiles([
      file(
        'supabase/migrations/0100_fixed.sql',
        'CREATE OR REPLACE VIEW public.v WITH (security_invoker = true) AS SELECT 1;\n',
      ),
      file(
        'supabase/migrations/0500_reset.sql',
        'ALTER VIEW public.v RESET (check_option, security_invoker);\n',
      ),
    ]);

    expect(bareCreates.map((f) => f.view)).toEqual(['v']);
  });

  it('does not let a later fixed CREATE satisfy an earlier bare CREATE in the same file', () => {
    const { bareCreates } = scanFiles([
      file(
        'supabase/migrations/0500_two_views.sql',
        'CREATE VIEW bare_v AS SELECT 1;\n' +
          'CREATE VIEW fixed_v WITH (security_invoker = true) AS SELECT 2;\n',
      ),
    ]);

    expect(bareCreates.map((f) => f.view)).toEqual(['bare_v']);
  });

  it('does not let security_invoker text in the SELECT body satisfy a bare CREATE', () => {
    const { bareCreates } = scanFiles([
      file(
        'supabase/migrations/0500_select_body.sql',
        "CREATE VIEW bare_v AS SELECT 'security_invoker = true' AS marker;\n",
      ),
    ]);

    expect(bareCreates.map((f) => f.view)).toEqual(['bare_v']);
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
});
