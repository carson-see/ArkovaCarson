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

import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { loadMigrations, stripSqlComments } from './lib/migration-lint';

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

function viewRefPattern(view: string): string {
  const escaped = escapeRegex(view);
  return `(?:(?:"public"|public)\\.)?"?${escaped}"?\\b`;
}

function lineNumber(text: string, idx: number): number {
  return text.slice(0, idx).split('\n').length;
}

function statementEnd(sql: string, offset: number): number {
  const semicolon = sql.indexOf(';', offset);
  return semicolon === -1 ? sql.length : semicolon + 1;
}

function alterSecurityInvokerRegex(view: string, cache: Map<string, RegExp>): RegExp {
  const cached = cache.get(view);
  if (cached) return cached;

  const re = new RegExp(
    `ALTER\\s+VIEW\\s+(?:IF\\s+EXISTS\\s+)?${viewRefPattern(view)}\\s+SET\\s*\\(\\s*security_invoker\\s*=\\s*(?:true|on)\\s*\\)`,
    'i',
  );
  cache.set(view, re);
  return re;
}

function loadBaseline(): Set<string> {
  if (!existsSync(BASELINE_PATH)) return new Set();
  const raw = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as { grandfathered?: string[] };
  return new Set((raw.grandfathered ?? []).map((entry) => entry.toLowerCase()));
}

function findViolations(file: string, strippedSql: string): Finding[] {
  const findings: Finding[] = [];
  const lines = strippedSql.split('\n');
  const alterReCache = new Map<string, RegExp>();
  const createViewRe =
    /CREATE\s+(?:OR\s+REPLACE\s+)?(?!MATERIALIZED\s+)VIEW\s+((?:(?:"public"|public)\.)?(?:"[^"]+"|\w+))/gi;

  let match: RegExpExecArray | null;
  while ((match = createViewRe.exec(strippedSql)) !== null) {
    const rawView = match[1];
    const view = normalizeIdent(rawView);
    const offset = match.index;
    const line = lineNumber(strippedSql, offset);

    const statementSql = strippedSql.slice(offset, statementEnd(strippedSql, offset));
    const statementWithoutComments = stripSqlComments(statementSql);
    if (/WITH\s*\(\s*security_invoker\s*=\s*(?:true|on)\s*\)/i.test(statementWithoutComments)) {
      continue;
    }

    if (alterSecurityInvokerRegex(view, alterReCache).test(stripSqlComments(strippedSql.slice(offset)))) {
      continue;
    }

    const preceding = lines.slice(Math.max(0, line - 6), line - 1).join('\n');
    if (/--\s*DELIBERATE:\s*definer-rights view/i.test(preceding)) {
      continue;
    }

    findings.push({ file, view, line });
  }

  return findings;
}

function main(): void {
  const baseline = loadBaseline();
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
