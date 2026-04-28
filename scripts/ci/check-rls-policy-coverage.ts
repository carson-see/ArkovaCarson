#!/usr/bin/env -S npx tsx
/**
 * SCRUM-1275 (R3-2) — block tables with FORCE RLS but no policy.
 *
 * `ENABLE + FORCE ROW LEVEL SECURITY` on a table with NO policy silently
 * denies all queries — including from `service_role`, which is otherwise
 * RLS-bypassed. The 24-table audit in SCRUM-1275 found this pattern
 * silently locking out worker code in several places.
 *
 * Allowed forms (none of these triggers a violation):
 *
 *   1. The same migration adds a CREATE POLICY ... ON <table>.
 *   2. A later migration adds CREATE POLICY ... ON <table>.
 *   3. The migration carries a `Deny-all by design` comment on the table:
 *        COMMENT ON TABLE <table> IS '...Deny-all by design...';
 *
 * Override label (when the rule misfires): `rls-policy-coverage-approved`
 * on the PR. Override is enforced at the workflow level, not here.
 */

import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const REPO = process.env.RLS_POLICY_COVERAGE_REPO_ROOT
  ?? resolve(import.meta.dirname, '..', '..');
const MIGRATIONS_DIR = join(REPO, 'supabase', 'migrations');
const BASELINE_PATH = join(REPO, 'scripts', 'ci', 'snapshots', 'rls-policy-coverage-baseline.json');

interface Baseline {
  /** Table names exempt from the policy-coverage requirement. */
  grandfathered: string[];
}

function loadBaseline(): Set<string> {
  if (!existsSync(BASELINE_PATH)) return new Set();
  const raw = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline;
  return new Set(raw.grandfathered);
}

function stripDollarQuoted(sql: string): string {
  return sql.replace(/\$([a-zA-Z_][a-zA-Z0-9_]*)?\$[\s\S]*?\$\1\$/g, (m) => {
    return m.replace(/[^\n]/g, ' ');
  });
}

function unquoteIdent(s: string): string {
  return s.replace(/^"|"$/g, '');
}

function bareName(qualified: string): string {
  // Strip optional `public.` schema prefix and surrounding quotes.
  const noSchema = qualified.replace(/^public\./i, '').replace(/^"public"\./i, '');
  return unquoteIdent(noSchema);
}

interface MigrationView {
  file: string;
  sql: string;
  /**
   * `sql` with dollar-quoted blocks blanked. Used only for FORCE RLS
   * detection — ALTER TABLE … FORCE inside a DO/EXECUTE block is
   * vanishingly rare and the strip helps avoid quoted ALTERs in
   * comment headers from being matched. CREATE POLICY detection runs
   * against the ORIGINAL `sql` because policies inside DO/EXECUTE
   * blocks (e.g. 0275's anchoring_jobs IF EXISTS guard) are real
   * runtime CREATE POLICY statements that must count.
   */
  stripped: string;
}

function loadMigrations(): MigrationView[] {
  if (!existsSync(MIGRATIONS_DIR)) return [];
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && !f.startsWith('_'))
    .sort()
    .map((file) => {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      return { file, sql, stripped: stripDollarQuoted(sql) };
    });
}

function tableHasForceRls(stripped: string, table: string): boolean {
  const re = new RegExp(
    `ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:public\\.)?\"?${table}\"?\\s+FORCE\\s+ROW\\s+LEVEL\\s+SECURITY`,
    'i',
  );
  return re.test(stripped);
}

function tableHasPolicy(stripped: string, table: string): boolean {
  // Policy name can be a bare identifier (\w+) or a quoted identifier
  // ("Org members can read..."). The ON clause can be schema-qualified
  // and the table name itself may be quoted.
  const re = new RegExp(
    `CREATE\\s+POLICY\\s+(?:\\w+|"[^"]+")\\s+ON\\s+(?:public\\.)?\"?${table}\"?\\b`,
    'i',
  );
  return re.test(stripped);
}

function tableHasDenyAllComment(stripped: string, table: string): boolean {
  const re = new RegExp(
    `COMMENT\\s+ON\\s+TABLE\\s+(?:public\\.)?\"?${table}\"?\\s+IS\\s+'[^']*Deny-all by design[^']*'`,
    'i',
  );
  return re.test(stripped);
}

function main(): void {
  const grandfathered = loadBaseline();
  const migrations = loadMigrations();
  if (migrations.length === 0) {
    console.log(`No migrations directory; skipping.`);
    return;
  }

  // Pass 1: collect every table that ever sets FORCE ROW LEVEL SECURITY.
  // Track the first migration where it happens so error output is helpful.
  const forceRlsByTable = new Map<string, string>();
  for (const mig of migrations) {
    const re =
      /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?((?:public\.)?"?\w+"?)\s+FORCE\s+ROW\s+LEVEL\s+SECURITY/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(mig.stripped)) !== null) {
      const tbl = bareName(m[1]);
      if (!forceRlsByTable.has(tbl)) {
        forceRlsByTable.set(tbl, mig.file);
      }
    }
  }

  // Pass 2: for each table with FORCE RLS, check across all migrations
  // for a CREATE POLICY ... ON <table> or a deny-all comment. Scan the
  // ORIGINAL SQL (not stripped) so policies inside DO/EXECUTE blocks
  // (e.g. 0275's anchoring_jobs IF EXISTS guard) are counted.
  const violations: Array<{ table: string; firstMigration: string }> = [];
  for (const [table, firstMigration] of forceRlsByTable) {
    if (grandfathered.has(table)) continue;
    let hasPolicy = false;
    let hasDenyAllComment = false;
    for (const mig of migrations) {
      if (tableHasPolicy(mig.sql, table)) hasPolicy = true;
      if (tableHasDenyAllComment(mig.sql, table)) hasDenyAllComment = true;
    }
    if (!hasPolicy && !hasDenyAllComment) {
      violations.push({ table, firstMigration });
    }
  }

  if (violations.length === 0) {
    console.log(
      `OK — No tables with bare ENABLE+FORCE ROW LEVEL SECURITY ` +
        `(${grandfathered.size} grandfathered).`,
    );
    return;
  }

  console.error(
    `::error::SCRUM-1275: ${violations.length} table(s) with FORCE RLS but no policy:`,
  );
  for (const v of violations) {
    console.error(`  ${v.table}  (FORCE RLS first set in ${v.firstMigration})`);
  }
  console.error('');
  console.error('Add CREATE POLICY ... ON <table> ... in the same or a later migration,');
  console.error('OR add a COMMENT ON TABLE <table> IS \'...Deny-all by design...\' to');
  console.error('document the deliberate deny-all intent.');
  process.exit(1);
}

main();
