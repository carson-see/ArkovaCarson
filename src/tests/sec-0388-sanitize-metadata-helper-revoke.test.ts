/**
 * SEC-RECON / migration 0388 — content-guard for the revoke of
 * `public.sanitize_metadata_for_public(jsonb)`.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE LIVE SUITE:
 *   `tests/rls/**` is excluded from the default vitest run (vitest.config.ts)
 *   because it needs a live seeded database. The live proof lives in
 *   tests/rls/sanitize-metadata-helper-revoke.test.ts and runs under
 *   `npm run test:rls`. This file is the half that runs in ordinary CI, so a
 *   PR that quietly drops or weakens the revoke goes red without a DB.
 *   Same two-layer convention as src/tests/scrum-2905-security-advisor-revokes.test.ts.
 *
 * WHAT IT PINS:
 *   1. the exact REVOKE / GRANT pair, in the 0377/0378 form;
 *   2. that no statement re-grants anon or authenticated (asserted
 *      non-vacuously — see the grant-count check);
 *   3. that the migration does NOT revoke anything on the deliberately-public
 *      verification RPCs, which is the regression this change must not cause;
 *   4. that the helper's SOLE caller is still SECURITY DEFINER — the entire
 *      safety argument for the revoke. If a future migration flips
 *      get_public_anchor to SECURITY INVOKER, the revoke starts breaking the
 *      anon verification page and this test fires first.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MIGRATIONS_DIR = path.join(process.cwd(), 'supabase/migrations');
const MIGRATION_PATH = path.join(
  MIGRATIONS_DIR,
  '0388_sec_revoke_sanitize_metadata_helper_grants.sql',
);

const TARGET = 'public.sanitize_metadata_for_public(jsonb)';

function read(p: string): string {
  return fs.readFileSync(p, 'utf8');
}

/** Strip SQL comment lines so header prose and the ROLLBACK block never match. */
function executableSql(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

let cache: string | null = null;
function migration(): string {
  if (cache === null) cache = read(MIGRATION_PATH);
  return cache;
}

describe('0388: revokes anon/authenticated EXECUTE on the redaction helper', () => {
  it('migration 0388 exists', () => {
    expect(fs.existsSync(MIGRATION_PATH)).toBe(true);
  });

  it('is transactional and reloads the PostgREST schema cache', () => {
    const sql = executableSql(migration());
    expect(sql).toContain('BEGIN;');
    expect(sql).toContain('COMMIT;');
    expect(sql).toContain("NOTIFY pgrst, 'reload schema';");
  });

  it('REVOKEs from PUBLIC, anon, authenticated', () => {
    expect(executableSql(migration())).toContain(
      `REVOKE ALL ON FUNCTION ${TARGET} FROM PUBLIC, anon, authenticated;`,
    );
  });

  it('retains EXECUTE for service_role', () => {
    expect(executableSql(migration())).toContain(
      `GRANT EXECUTE ON FUNCTION ${TARGET} TO service_role;`,
    );
  });

  it('does NOT re-grant EXECUTE to anon or authenticated', () => {
    // Non-vacuous by construction: assert the expected number of grants exists
    // BEFORE inspecting what they say, so an empty match set cannot pass. Match
    // GRANT ALL as well as GRANT EXECUTE — the baseline itself uses GRANT ALL,
    // which is exactly how this hole was opened.
    const normalized = executableSql(migration()).replace(/\s+/g, ' ');
    const grants = [
      ...normalized.matchAll(
        /GRANT (?:EXECUTE|ALL) ON FUNCTION public\.sanitize_metadata_for_public\(jsonb\) TO ([^;]+);/g,
      ),
    ].map((m) => m[1]);

    expect(grants).toHaveLength(1);
    expect(grants[0]).toContain('service_role');
    expect(grants[0]).not.toMatch(/\banon\b/);
    expect(grants[0]).not.toMatch(/\bauthenticated\b/);
  });

  it('carries a ROLLBACK comment that restores the prior grants', () => {
    const sql = migration();
    expect(sql).toContain('-- ROLLBACK:');
    expect(sql).toContain(
      `GRANT EXECUTE ON FUNCTION ${TARGET} TO anon, authenticated;`,
    );
  });

  it('does NOT revoke anything on the deliberately-public verification RPCs', () => {
    const sql = executableSql(migration());
    for (const fn of [
      'get_public_anchor',
      'get_public_anchor_by_fingerprint',
      'search_public_credentials',
      'get_public_records_page',
    ]) {
      expect(sql).not.toMatch(new RegExp(`REVOKE[^\\n]*\\b${fn}\\b`));
    }
  });

  it('changes only grants — no body, signature, or schema change', () => {
    const sql = executableSql(migration());
    expect(sql).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i);
    expect(sql).not.toMatch(/DROP\s+FUNCTION/i);
    expect(sql).not.toMatch(/ALTER\s+FUNCTION[^\n]*SET\s+SCHEMA/i);
  });
});

/**
 * The safety argument, pinned. The revoke is safe ONLY because the helper's
 * sole caller runs as its owner. This asserts that property against the tree
 * rather than trusting the prose in the migration header.
 */
describe('0388: the sole caller stays SECURITY DEFINER', () => {
  /** Every migration that defines or redefines get_public_anchor. */
  function callerDefiningMigrations(): string[] {
    return fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .filter((f) =>
        /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+"?public"?\.\s*"?get_public_anchor"?\s*\(/i.test(
          executableSql(read(path.join(MIGRATIONS_DIR, f))),
        ),
      )
      .sort();
  }

  it('finds the caller definitions at all (guards against a vacuous pass)', () => {
    // If a rename or reformat makes the regex stop matching, this fires instead
    // of the suite silently going green over zero files.
    expect(callerDefiningMigrations().length).toBeGreaterThanOrEqual(5);
  });

  it.each(callerDefiningMigrations())(
    '%s defines get_public_anchor as SECURITY DEFINER',
    (file) => {
      const sql = executableSql(read(path.join(MIGRATIONS_DIR, file)));
      const defs = [
        ...sql.matchAll(
          /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+"?public"?\.\s*"?get_public_anchor"?\s*\([\s\S]{0,4000}?AS\s+\$/gi,
        ),
      ];
      expect(defs.length).toBeGreaterThan(0);
      for (const [block] of defs) {
        expect(block).toMatch(/SECURITY\s+DEFINER/i);
        expect(block).not.toMatch(/SECURITY\s+INVOKER/i);
      }
    },
  );

  it('no worker, edge, or frontend source calls the helper directly', () => {
    // A runtime call site outside a SECURITY DEFINER body would break on the
    // revoke. There are none today; this keeps it that way.
    const roots = ['src', 'services'].filter((d) => fs.existsSync(d));
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist') continue;
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        // The generated types legitimately describe every function in the
        // schema; tests legitimately regex the migration SQL as text.
        if (entry.name === 'database.types.ts') continue;
        if (/\.test\.tsx?$/.test(entry.name)) continue;

        const body = fs.readFileSync(full, 'utf8');
        if (/\.rpc\(\s*['"`]sanitize_metadata_for_public['"`]/.test(body)) {
          offenders.push(full);
        }
      }
    };

    for (const root of roots) walk(root);
    expect(offenders).toEqual([]);
  });
});
