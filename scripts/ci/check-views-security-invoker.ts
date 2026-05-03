#!/usr/bin/env -S npx tsx
/**
 * SCRUM-1276 (R3-3) - block bare CREATE VIEW in migrations.
 *
 * Postgres views default to definer-rights behavior. A view without
 * `WITH (security_invoker = true)` can bypass caller RLS, which is a
 * tenant-isolation hazard.
 *
 * Allowed forms:
 *   1. CREATE VIEW ... WITH (security_invoker = true) ...
 *   2. CREATE VIEW ... followed by ALTER VIEW ... SET (security_invoker = true)
 *      in the same migration.
 *   3. A nearby `-- DELIBERATE: definer-rights view` comment with rationale.
 *
 * Override: PR labeled `view-security-definer-intentional`.
 */

import { resolve, join } from 'node:path';
import {
  loadBaseline,
  loadMigrations,
  normalizePublicIdent,
  publicSchemaRefPattern,
  stripSqlCommentsAndStringLiterals,
  stripSqlStringLiterals,
} from './lib/migration-lint';

const OVERRIDE_LABEL = 'view-security-definer-intentional';
const REPO = process.env.VIEWS_LINT_REPO_ROOT
  ?? process.env.VIEW_SECURITY_INVOKER_REPO_ROOT
  ?? resolve(import.meta.dirname, '..', '..');
const MIGRATIONS_DIR = join(REPO, 'supabase', 'migrations');
const BASELINE_PATH = join(REPO, 'scripts', 'ci', 'snapshots', 'views-security-invoker-baseline.json');
const prLabels = (process.env.PR_LABELS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

interface Finding {
  file: string;
  view: string;
  line: number;
}

function lineNumber(text: string, idx: number): number {
  return text.slice(0, idx).split('\n').length;
}

function hasDeliberateDefinerComment(sql: string): boolean {
  return stripSqlStringLiterals(sql)
    .split('\n')
    .some((line) => line.trimStart().toLowerCase().startsWith('-- deliberate: definer-rights view'));
}

function statementEnd(sql: string, offset: number): number {
  const semicolon = sql.indexOf(';', offset);
  return semicolon === -1 ? sql.length : semicolon + 1;
}

function alterSecurityInvokerRegex(view: string, cache: Map<string, RegExp>): RegExp {
  const cached = cache.get(view);
  if (cached) return cached;

  const re = new RegExp(
    String.raw`ALTER\s+VIEW\s+(?:IF\s+EXISTS\s+)?${publicSchemaRefPattern(view)}\s+SET\s*\(\s*security_invoker\s*=\s*(?:true|on)\s*\)`,
    'i',
  );
  cache.set(view, re);
  return re;
}

function findViolations(file: string, strippedSql: string): Finding[] {
  const findings: Finding[] = [];
  const sanitizedSql = stripSqlCommentsAndStringLiterals(strippedSql);
  const lines = strippedSql.split('\n');
  const alterReCache = new Map<string, RegExp>();
  const createViewRe =
    /CREATE\s+(?:OR\s+REPLACE\s+)?(?!MATERIALIZED\s+)VIEW\s+((?:(?:"public"|public)\.)?(?:"[^"]+"|\w+))/gi;

  let match: RegExpExecArray | null;
  while ((match = createViewRe.exec(sanitizedSql)) !== null) {
    const rawView = match[1];
    const view = normalizePublicIdent(rawView);
    const offset = match.index;
    const line = lineNumber(sanitizedSql, offset);

    const statementSql = sanitizedSql.slice(offset, statementEnd(sanitizedSql, offset));
    if (/WITH\s*\(\s*security_invoker\s*=\s*(?:true|on)\s*\)/i.test(statementSql)) {
      continue;
    }

    const followingSql = sanitizedSql.slice(offset);
    if (alterSecurityInvokerRegex(view, alterReCache).test(followingSql)) {
      continue;
    }

    const preceding = lines.slice(Math.max(0, line - 6), line - 1).join('\n');
    if (hasDeliberateDefinerComment(preceding)) {
      continue;
    }

    findings.push({ file, view, line });
  }

  return findings;
}

function main(): void {
  const baseline = loadBaseline(BASELINE_PATH);
  const findings = loadMigrations(MIGRATIONS_DIR)
    .flatMap((migration) => findViolations(migration.file, migration.stripped))
    .filter((finding) => !baseline.has(finding.view) && !baseline.has(finding.file));

  if (findings.length === 0) {
    console.log(`OK - no new bare CREATE VIEW statements (${baseline.size} baseline exemptions).`);
    return;
  }

  if (prLabels.includes(OVERRIDE_LABEL)) {
    console.log(`PR labeled ${OVERRIDE_LABEL}; allowing ${findings.length} bare view(s).`);
    for (const finding of findings) {
      console.log(`  ${finding.file}:${finding.line} CREATE VIEW ${finding.view}`);
    }
    return;
  }

  console.error(`::error::SCRUM-1276: ${findings.length} CREATE VIEW statement(s) without security_invoker:`);
  for (const finding of findings) {
    console.error(`  ${finding.file}:${finding.line} CREATE VIEW ${finding.view}`);
  }
  console.error('');
  console.error('Add WITH (security_invoker = true), add ALTER VIEW ... SET (security_invoker = true),');
  console.error(`or label the PR with ${OVERRIDE_LABEL} after review.`);
  process.exit(1);
}

main();
