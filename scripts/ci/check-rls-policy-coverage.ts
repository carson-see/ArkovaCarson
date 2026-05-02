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

import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { loadMigrations } from './lib/migration-lint';

const OVERRIDE_LABEL = 'rls-no-policy-intentional';
const REPO = process.env.RLS_POLICY_REPO_ROOT
  ?? process.env.RLS_POLICY_COVERAGE_REPO_ROOT
  ?? resolve(import.meta.dirname, '..', '..');
const MIGRATIONS_DIR = join(REPO, 'supabase', 'migrations');
const BASELINE_PATH = join(REPO, 'scripts', 'ci', 'snapshots', 'rls-policy-coverage-baseline.json');
const prLabels = (process.env.PR_LABELS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

interface Baseline {
  missing_in_prod?: string[];
  grandfathered?: string[];
}

interface Finding {
  table: string;
  enabledIn: string;
}

function normalizeIdent(raw: string): string {
  return raw
    .replace(/^"public"\./i, '')
    .replace(/^public\./i, '')
    .replace(/^"|"$/g, '')
    .toLowerCase();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tableRefPattern(table: string): string {
  const escaped = escapeRegex(table);
  return `(?:(?:"public"|public)\\.)?"?${escaped}"?\\b`;
}

function loadBaseline(): Set<string> {
  if (!existsSync(BASELINE_PATH)) return new Set();
  const raw = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline;
  return new Set([...(raw.missing_in_prod ?? []), ...(raw.grandfathered ?? [])].map((t) => t.toLowerCase()));
}

function tableHasPolicy(sql: string, table: string): boolean {
  const re = new RegExp(
    `CREATE\\s+POLICY\\s+(?:"[^"]+"|\\w+)\\s+ON\\s+${tableRefPattern(table)}`,
    'i',
  );
  return re.test(sql);
}

function tableHasDenyAllComment(sql: string, table: string): boolean {
  const re = new RegExp(
    `COMMENT\\s+ON\\s+TABLE\\s+${tableRefPattern(table)}\\s+IS\\s+'[^']*[Dd]eny-?all\\s+by\\s+design[^']*'`,
    'i',
  );
  return re.test(sql);
}

function main(): void {
  const baseline = loadBaseline();
  const migrations = loadMigrations(MIGRATIONS_DIR);
  const enabledByTable = new Map<string, string>();
  const enableOrForceRe =
    /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?((?:(?:"public"|public)\.)?(?:"[^"]+"|\w+))\s+(?:ENABLE|FORCE)\s+ROW\s+LEVEL\s+SECURITY/gi;

  for (const migration of migrations) {
    let match: RegExpExecArray | null;
    while ((match = enableOrForceRe.exec(migration.stripped)) !== null) {
      const table = normalizeIdent(match[1]);
      if (!enabledByTable.has(table)) {
        enabledByTable.set(table, migration.file);
      }
    }
  }

  const findings: Finding[] = [];
  for (const [table, enabledIn] of enabledByTable) {
    if (baseline.has(table)) continue;

    const hasPolicyOrComment = migrations.some((migration) => {
      return tableHasPolicy(migration.sql, table) || tableHasDenyAllComment(migration.sql, table);
    });

    if (!hasPolicyOrComment) {
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
