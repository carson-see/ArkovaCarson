/**
 * Migration 0405 — content-guard for the property that makes
 * `public.organization_field_policies` a CONTRACTUAL control rather than a
 * setting.
 *
 * DPA Schedule 1 / clause 4.6 obliges Arkova to reject prohibited fields
 * INDEPENDENTLY of the counterparty agreeing to stop sending them. That word
 * is the whole design: if the organisation subject to the restriction can
 * relax or delete its own policy row, the control is worth nothing, and the
 * failure would be invisible — a policy row quietly UPDATEd to `enabled=false`
 * looks exactly like an org that never had one.
 *
 * `public.organizations` shows why this is not paranoia. It carries the
 * baseline policy `organizations_update_admin`
 * (`FOR UPDATE TO authenticated USING public.is_org_admin_of(id)`) on top of
 * `GRANT ALL ON TABLE public.organizations TO authenticated`, and Postgres RLS
 * is ROW-level, not column-level — so an ORG_ADMIN can already PATCH any
 * column of their own org row. A `jsonb` policy column there would have been
 * self-administered by the regulated party.
 *
 * This file is the half that runs in ordinary CI with no database (same
 * two-layer convention as `sec-0388-sanitize-metadata-helper-revoke.test.ts`),
 * so a future PR that adds a write grant or a write policy goes red before it
 * can silently hand the control back.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MIGRATION_PATH = path.join(
  process.cwd(),
  'supabase/migrations/0405_org_field_policies_dpa_clause_4_6.sql',
);

const TABLE = 'public.organization_field_policies';

/** Strip SQL comment lines so the header prose and ROLLBACK block never match. */
function executableSql(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

let cache: string | null = null;
function sql(): string {
  if (cache === null) cache = executableSql(fs.readFileSync(MIGRATION_PATH, 'utf8'));
  return cache;
}

describe('0405: organization_field_policies is administered by Arkova, not by the org', () => {
  it('the migration exists', () => {
    expect(fs.existsSync(MIGRATION_PATH)).toBe(true);
  });

  it('creates the table', () => {
    expect(sql()).toMatch(
      new RegExp(`CREATE TABLE IF NOT EXISTS\\s+${TABLE.replace('.', '\\.')}`, 'i'),
    );
  });

  it('enables AND forces row level security', () => {
    expect(sql()).toMatch(/ENABLE ROW LEVEL SECURITY/i);
    // FORCE matters specifically: without it the table owner is exempt.
    expect(sql()).toMatch(/FORCE ROW LEVEL SECURITY/i);
  });

  it('revokes the default privileges the baseline auto-grants on every new public table', () => {
    // baseline:15104-15107 runs
    // `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon, authenticated`,
    // so a new public table is writable by authenticated the moment it exists.
    // Absent this REVOKE, the only thing standing between an org admin and
    // their own compliance control is the absence of a write POLICY.
    const revoke = sql().match(/REVOKE ALL ON TABLE[^;]+;/i);
    expect(revoke, 'migration must REVOKE ALL on the table').not.toBeNull();
    const stmt = (revoke as RegExpMatchArray)[0];
    expect(stmt).toContain('organization_field_policies');
    for (const role of ['PUBLIC', 'anon', 'authenticated']) {
      expect(stmt).toContain(role);
    }
  });

  it('grants authenticated read only — never INSERT, UPDATE or DELETE', () => {
    const grants = sql().match(/GRANT[^;]+TO\s+authenticated\s*;/gi) ?? [];
    expect(grants.length, 'expected exactly one grant to authenticated').toBe(1);
    expect(grants[0]).toMatch(/GRANT\s+SELECT\s+ON TABLE/i);
    for (const verb of ['INSERT', 'UPDATE', 'DELETE', 'ALL']) {
      expect(grants[0]).not.toMatch(new RegExp(`\\b${verb}\\b`, 'i'));
    }
  });

  it('defines NO write policy for authenticated (the second, independent lock)', () => {
    const policies = sql().match(/CREATE POLICY[\s\S]*?;/gi) ?? [];
    expect(policies.length).toBeGreaterThan(0);
    const authenticatedPolicies = policies.filter((p) => /TO\s+authenticated/i.test(p));
    expect(authenticatedPolicies.length).toBeGreaterThan(0);
    for (const policy of authenticatedPolicies) {
      expect(
        policy,
        'a write policy for `authenticated` would let the regulated org edit its own control',
      ).toMatch(/FOR\s+SELECT/i);
    }
  });

  it('keeps service_role as the only administrator', () => {
    expect(sql()).toMatch(/GRANT ALL ON TABLE[^;]+TO service_role\s*;/i);
    expect(sql()).toMatch(/CREATE POLICY\s+organization_field_policies_service_all/i);
  });

  it('inserts no policy row — applying it must change behaviour for zero organisations', () => {
    // Enforcement keys off the PRESENCE of a row. A seeded row here would turn
    // a schema migration into a live behaviour change for a real customer.
    expect(sql()).not.toMatch(/INSERT\s+INTO/i);
  });

  it('carries a ROLLBACK comment (§1.2)', () => {
    const raw = fs.readFileSync(MIGRATION_PATH, 'utf8');
    expect(raw).toMatch(/^--\s*ROLLBACK:/m);
  });

  it('reloads the PostgREST schema cache so the new table is visible', () => {
    expect(sql()).toMatch(/NOTIFY pgrst, 'reload schema'/i);
  });

  it('bounds every free-text and array column it adds', () => {
    // A policy row is operator-authored but still ends up in an API response
    // body (`policy_reason`), and `disallowed_fields` is turned into a set
    // tested against every request key.
    expect(sql()).toMatch(/CONSTRAINT org_field_policies_field_names_shape CHECK/i);
    expect(sql()).toMatch(/CONSTRAINT org_field_policies_field_count CHECK/i);
    expect(sql()).toMatch(/CONSTRAINT org_field_policies_reason_len CHECK/i);
  });
});
