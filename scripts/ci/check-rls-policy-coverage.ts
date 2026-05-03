#!/usr/bin/env -S npx tsx
/**
 * SCRUM-1275 (R3-2) - block new ENABLE/FORCE RLS without a policy.
 *
 * Postgres tables with RLS enabled and no policy become silent deny-all
 * for non-bypass roles. `FORCE ROW LEVEL SECURITY` tightens that further.
 * This is sometimes intentional, but it should be explicit and reviewed.
 *
 * Allowed forms:
 *   1. A CREATE POLICY ... ON <table> exists in the same or another migration.
 *   2. A COMMENT ON TABLE <table> IS '...Deny-all by design...' documents
 *      deliberate quarantine/no-user-access behavior.
 *   3. The table is listed in the baseline as historically referenced but
 *      missing in production.
 *
 * Override: PR labeled `rls-no-policy-intentional`.
 */

import { resolve, join } from 'node:path';
import {
  loadBaseline,
  loadMigrations,
  normalizePublicIdent,
  publicSchemaRefPattern,
  stripSqlComments,
  stripSqlCommentsAndStringLiterals,
} from './lib/migration-lint';

const OVERRIDE_LABEL = 'rls-no-policy-intentional';
const REPO = process.env.RLS_POLICY_REPO_ROOT
  ?? process.env.RLS_POLICY_COVERAGE_REPO_ROOT
  ?? resolve(import.meta.dirname, '..', '..');
const MIGRATIONS_DIR = join(REPO, 'supabase', 'migrations');
const BASELINE_PATH = join(REPO, 'scripts', 'ci', 'snapshots', 'rls-policy-coverage-baseline.json');
const prLabels = (process.env.PR_LABELS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

interface Finding {
  table: string;
  enabledIn: string;
}

function tableHasPolicy(sql: string, table: string): boolean {
  const re = new RegExp(
    String.raw`CREATE\s+POLICY\s+(?:"[^"]+"|\w+)\s+ON\s+${publicSchemaRefPattern(table)}`,
    'i',
  );
  return re.test(sql);
}

function tableHasDenyAllComment(sql: string, table: string): boolean {
  const re = new RegExp(
    String.raw`COMMENT\s+ON\s+TABLE\s+${publicSchemaRefPattern(table)}\s+IS\s+'[^']*[Dd]eny-?all\s+by\s+design[^']*'`,
    'i',
  );
  return re.test(sql);
}

type PolicySource = {
  commentsVisible: string;
  literalsHidden: string;
};

const ALTER_TABLE_PREFIX_RE = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?/gi;
const PUBLIC_SCHEMA_QUALIFIER_RE = /(?:"public"|public)\./iy;
const SQL_IDENTIFIER_RE = /"[^"]+"|\w+/y;
const ENABLE_OR_FORCE_RLS_RE = /\s+(?:ENABLE|FORCE)\s+ROW\s+LEVEL\s+SECURITY\b/iy;

function buildPolicySources(migrations: ReturnType<typeof loadMigrations>): PolicySource[] {
  return migrations.map((migration) => ({
    commentsVisible: stripSqlComments(migration.stripped),
    literalsHidden: stripSqlCommentsAndStringLiterals(migration.stripped),
  }));
}

function execAt(re: RegExp, sql: string, index: number): RegExpExecArray | null {
  re.lastIndex = index;
  return re.exec(sql);
}

function readAlterTableTarget(sql: string, startIndex: number): { raw: string; end: number } | null {
  let cursor = startIndex;
  let raw = '';

  const schema = execAt(PUBLIC_SCHEMA_QUALIFIER_RE, sql, cursor);
  if (schema) {
    raw += schema[0];
    cursor = schema.index + schema[0].length;
  }

  const table = execAt(SQL_IDENTIFIER_RE, sql, cursor);
  if (!table) return null;

  raw += table[0];
  return { raw, end: table.index + table[0].length };
}

function collectEnabledTables(migrations: ReturnType<typeof loadMigrations>): Map<string, string> {
  const enabledByTable = new Map<string, string>();

  for (const migration of migrations) {
    while (ALTER_TABLE_PREFIX_RE.exec(migration.stripped) !== null) {
      const target = readAlterTableTarget(migration.stripped, ALTER_TABLE_PREFIX_RE.lastIndex);
      if (!target || !execAt(ENABLE_OR_FORCE_RLS_RE, migration.stripped, target.end)) {
        continue;
      }

      const table = normalizePublicIdent(target.raw);
      if (!enabledByTable.has(table)) {
        enabledByTable.set(table, migration.file);
      }
    }
  }
  return enabledByTable;
}

function hasPolicyOrDenyAllComment(sources: PolicySource[], table: string): boolean {
  return sources.some((migration) => {
    return (
      tableHasPolicy(migration.literalsHidden, table)
      || tableHasDenyAllComment(migration.commentsVisible, table)
    );
  });
}

function main(): void {
  const baseline = loadBaseline(BASELINE_PATH);
  const migrations = loadMigrations(MIGRATIONS_DIR);
  const migrationPolicySources = buildPolicySources(migrations);
  const enabledByTable = collectEnabledTables(migrations);

  const findings: Finding[] = [];
  for (const [table, enabledIn] of enabledByTable) {
    if (baseline.has(table)) continue;

    if (!hasPolicyOrDenyAllComment(migrationPolicySources, table)) {
      findings.push({ table, enabledIn });
    }
  }

  if (findings.length === 0) {
    console.log(`OK - every RLS-enabled table has a policy or deny-all comment (${baseline.size} baseline exemptions).`);
    return;
  }

  if (prLabels.includes(OVERRIDE_LABEL)) {
    console.log(`PR labeled ${OVERRIDE_LABEL}; allowing ${findings.length} RLS table(s) without policy.`);
    for (const finding of findings) {
      console.log(`  ${finding.table} (enabled in ${finding.enabledIn})`);
    }
    return;
  }

  console.error(`::error::SCRUM-1275: ${findings.length} table(s) with ENABLE/FORCE RLS but no policy:`);
  for (const finding of findings) {
    console.error(`  ${finding.table}  (first enabled in ${finding.enabledIn})`);
  }
  console.error('');
  console.error('Add CREATE POLICY ... ON <table> ..., add a documented deny-all comment,');
  console.error(`or label the PR with ${OVERRIDE_LABEL} after review.`);
  process.exit(1);
}

main();
