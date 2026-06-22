/**
 * PERF: org Compliance/CPE-CLE dashboard partial indexes (migration 0340).
 *
 * src/pages/ComplianceDashboardPage.tsx builds the org CPE/CLE reporting panels
 * with, per panel:
 *   WHERE org_id = $1 AND cpe_metadata IS NOT NULL ORDER BY issued_at DESC LIMIT 1000
 *   (and the analogous cle_metadata panel).
 * On prod, public.anchors is ~3M rows / 22 GB and the only org_id indexes are
 * created_at-ordered composites with no cpe_metadata/cle_metadata predicate — so
 * the planner does a full Parallel Seq Scan + Sort and the query exceeds the
 * statement timeout for large orgs (the primary org owns ~99% of rows). Migration
 * 0340 adds two PARTIAL (org_id, issued_at DESC) indexes — one WHERE cpe_metadata
 * IS NOT NULL, one WHERE cle_metadata IS NOT NULL — that store only the few
 * CPE/CLE rows and serve both the filter and the ordering.
 *
 * Because public.anchors is a multi-GB hot table and `supabase db push` wraps each
 * migration in one transaction, the indexes MUST be built CONCURRENTLY (no blocking
 * lock) and CONCURRENTLY cannot run inside a transaction. So — per the 0313 / 0330 /
 * 0335 convention — the migration body is a transactional marker (a DO/RAISE NOTICE
 * no-op) and the CREATE INDEX CONCURRENTLY statements are documented as
 * operator-applied, NON-TRANSACTIONAL, IF NOT EXISTS steps. These assertions read
 * migration 0340 directly (content-guard), mirroring the convention in
 * scrum-2236-dashboard-cache-budgets.test.ts and scrum-2203-unembedded-query-perf.test.ts.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MIGRATION_PATH = path.join(
  process.cwd(),
  'supabase/migrations/0340_cpe_cle_dashboard_partial_index.sql',
);

function migration(): string {
  return fs.readFileSync(MIGRATION_PATH, 'utf8');
}

/**
 * The EXECUTABLE statements of the migration — i.e. the file with every `--`
 * line comment removed. The CREATE INDEX CONCURRENTLY statements live ONLY
 * inside comments (operator-applied), so this is what `supabase db push` /
 * `db reset` actually runs in a transaction; it must contain no DDL that would
 * lock the table or abort the transaction.
 */
function executableSql(): string {
  return migration()
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

/**
 * The DOCUMENTED operator SQL: the same file with the leading `--` comment
 * markers stripped from each line (so the commented-out CREATE INDEX
 * CONCURRENTLY statements are reconstituted as plain SQL text we can match on),
 * with the executable body removed so prose mentions of "CREATE INDEX" in the
 * RAISE NOTICE literal cannot be confused for a documented statement.
 */
function documentedSql(): string {
  return migration()
    .split('\n')
    .map((line) => line.replace(/^\s*--\s?/, ''))
    .join('\n');
}

const COLUMNS = ['cpe_metadata', 'cle_metadata'] as const;
const INDEX_NAME: Record<(typeof COLUMNS)[number], string> = {
  cpe_metadata: 'idx_anchors_org_cpe_metadata_issued',
  cle_metadata: 'idx_anchors_org_cle_metadata_issued',
};

describe('PERF: org CPE/CLE dashboard partial indexes (migration 0340)', () => {
  it('migration file exists at the reserved 0340 prefix', () => {
    expect(fs.existsSync(MIGRATION_PATH)).toBe(true);
  });

  describe.each(COLUMNS)('%s panel index', (column) => {
    const name = INDEX_NAME[column];

    it(`defines ${name} ON public.anchors (org_id, issued_at DESC)`, () => {
      // Reconstitute the operator SQL (strip the leading `--` markers), then
      // match across the clause's wrapped lines.
      const sql = documentedSql();
      expect(sql).toMatch(
        new RegExp(
          `CREATE INDEX CONCURRENTLY IF NOT EXISTS\\s+${name}\\s+ON\\s+public\\.anchors\\s*\\(\\s*org_id\\s*,\\s*issued_at\\s+DESC\\s*\\)`,
          'i',
        ),
      );
    });

    it(`is PARTIAL on WHERE ${column} IS NOT NULL (stores only the CPE/CLE rows)`, () => {
      const sql = documentedSql();
      // The CREATE … <name> … statement must carry the partial predicate.
      const stmt = sql.slice(
        sql.indexOf(`IF NOT EXISTS ${name}`),
        sql.indexOf(';', sql.indexOf(`IF NOT EXISTS ${name}`)) + 1,
      );
      expect(stmt).toMatch(
        new RegExp(`WHERE\\s*\\(?\\s*${column}\\s+IS\\s+NOT\\s+NULL`, 'i'),
      );
    });

    it(`rollback drops ${name} with DROP INDEX CONCURRENTLY IF EXISTS`, () => {
      const sql = documentedSql();
      expect(sql).toMatch(
        new RegExp(
          `DROP INDEX CONCURRENTLY IF EXISTS\\s+public\\.${name}`,
          'i',
        ),
      );
    });
  });

  it('builds every index CONCURRENTLY (never a plain locking CREATE INDEX)', () => {
    // Match the real statement shape `CREATE INDEX … ON public.anchors (` — prose
    // like "a plain CREATE INDEX would be unsafe on prod" lacks the `ON public.…(`
    // signature and is correctly ignored. Every real statement must be CONCURRENTLY:
    // a plain CREATE INDEX on the 3M-row hot table takes a write-blocking lock for
    // the full build.
    const sql = documentedSql();
    const createIndexStmts =
      sql.match(/CREATE\s+INDEX[\s\S]*?ON\s+public\.\w+\s*\(/gi) ?? [];
    expect(createIndexStmts.length).toBeGreaterThanOrEqual(2);
    for (const stmt of createIndexStmts) {
      expect(stmt).toMatch(/CREATE\s+INDEX\s+CONCURRENTLY/i);
    }
  });

  it('keeps ALL index DDL out of the executable (transactional) body', () => {
    // CONCURRENTLY cannot run inside a transaction, and `supabase db push` wraps
    // the migration in one — so a live CREATE INDEX statement here would either
    // abort the migration (CONCURRENTLY, SQLSTATE 25001) or lock the table
    // (plain CREATE INDEX). The actual index DDL must live ONLY in comments.
    // Match the STATEMENT form (CREATE INDEX … ON public.<table> ( / DROP INDEX
    // CONCURRENTLY) so incidental prose in the RAISE NOTICE marker is ignored.
    const exec = executableSql();
    expect(exec).not.toMatch(/CREATE\s+INDEX[\s\S]*?ON\s+public\.\w+\s*\(/i);
    expect(exec).not.toMatch(/DROP\s+INDEX\s+CONCURRENTLY/i);
  });

  it('executable body is a safe transactional no-op (marker DO block only)', () => {
    const exec = executableSql();
    // The only executable statement is the DO/RAISE NOTICE marker (0313 pattern).
    expect(exec).toMatch(/DO \$\$/);
    expect(exec).toMatch(/RAISE NOTICE/i);
    // No table/row mutation sneaks into the transactional body.
    expect(exec).not.toMatch(/\b(ALTER\s+TABLE|UPDATE|DELETE\s+FROM|INSERT\s+INTO)\b/i);
  });

  it('documents the CONCURRENTLY-vs-transaction decision as NON-TRANSACTIONAL / operator-applied', () => {
    const sql = migration();
    expect(sql).toMatch(/NON-TRANSACTIONAL/i);
    expect(sql).toMatch(/CONCURRENTLY cannot run inside (a )?transaction/i);
    // And references the established repo convention.
    expect(sql).toMatch(/0313|0330|0335/);
  });

  it('explains that a partial index still scans the full table to build (lock-risk quantified)', () => {
    // The reviewer-critical nuance: partial != cheap-to-build. The header must
    // call out that Postgres scans the entire heap to evaluate the predicate.
    const sql = migration();
    expect(sql).toMatch(/partial index/i);
    expect(sql).toMatch(/scan|heap/i);
  });

  it('carries a -- ROLLBACK: block', () => {
    expect(migration()).toMatch(/--\s*ROLLBACK:/i);
  });

  it('does not execute a schema-cache reload (no NOTIFY pgrst — index-only)', () => {
    // Index DDL does not touch the PostgREST surface, so the migration should not
    // RUN an RPC/schema reload it does not need (keeps the change honestly scoped).
    // Asserted against the executable body — the header prose may legitimately
    // explain WHY no reload is needed.
    const exec = executableSql();
    expect(exec).not.toMatch(/NOTIFY pgrst/i);
  });
});
