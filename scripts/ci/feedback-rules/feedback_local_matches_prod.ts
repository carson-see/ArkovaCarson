#!/usr/bin/env -S npx tsx
/**
 * SCRUM-1306 (R0-7-FU1) rule: feedback_local_matches_prod.
 *
 * Compares the local migration ledger's resulting table set against a
 * cached snapshot of the prod schema (`scripts/ci/snapshots/prod-tables.json`).
 * Catches drift like "table only created locally" or "demo seed table never
 * promoted to prod" — the failure mode memory/feedback_local_matches_prod.md
 * was written for.
 *
 * Why a snapshot vs live MCP: live Supabase MCP isn't available in CI, and
 * a daily snapshot dump is good enough for catch-on-merge drift. Operator
 * refreshes the snapshot post-major-migration via Supabase MCP `list_tables`
 * (helper script deferred — for now the snapshot is hand-maintained).
 *
 * Warn-only when the snapshot is missing (bootstrap state). Override via
 * PR label `local-matches-prod-skip`.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { hasLabel, REPO } from '../lib/ciContext.js';

const MIGRATIONS_DIR = resolve(REPO, 'supabase/migrations');
const SNAPSHOT_FILE =
  process.env.PROD_TABLES_FILE ?? resolve(REPO, 'scripts/ci/snapshots/prod-tables.json');

function localTableSet(): Set<string> {
  const tables = new Set<string>();
  if (!existsSync(MIGRATIONS_DIR)) return tables;
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const f of files) {
    const raw = readFileSync(resolve(MIGRATIONS_DIR, f), 'utf8');
    // Strip line + block comments before scanning. Migration rollback hints
    // (`-- Rollback: DROP TABLE foo`) and helper SQL inside SECDEF function
    // bodies otherwise polluted the DROP detection. Trust CREATE TABLE
    // statements only — explicit drops on already-created tables are rare
    // enough that false positives are acceptable; we'd rather over-report
    // than silently miss a real prod-vs-local table.
    const sql = raw
      .split('\n')
      .filter((line) => !/^\s*--/.test(line))
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    for (const rawTarget of createTableTargets(sql)) {
      const { schema, table } = parseCreateTableTarget(rawTarget);
      if (schema !== 'public') continue;
      tables.add(table);
    }
  }
  return tables;
}

function createTableTargets(sql: string): string[] {
  const targets: string[] = [];
  let cursor = 0;

  while (cursor < sql.length) {
    const createAt = findKeyword(sql, 'create', cursor);
    if (createAt < 0) break;
    cursor = createAt + 'create'.length;

    if (!hasStatementBoundaryBefore(sql, createAt)) continue;

    let next = skipWhitespace(sql, cursor);
    if (!isKeywordAt(sql, next, 'table')) continue;
    next = skipWhitespace(sql, next + 'table'.length);
    next = skipOptionalIfNotExists(sql, next);

    const target = readCreateTableTarget(sql, next);
    if (target) targets.push(target);
    cursor = next + target.length;
  }

  return targets;
}

function findKeyword(sql: string, keyword: string, start: number): number {
  const lowerSql = sql.toLowerCase();
  let cursor = lowerSql.indexOf(keyword, start);
  while (cursor >= 0) {
    if (isKeywordAt(sql, cursor, keyword)) return cursor;
    cursor = lowerSql.indexOf(keyword, cursor + keyword.length);
  }
  return -1;
}

function hasStatementBoundaryBefore(sql: string, keywordAt: number): boolean {
  let cursor = keywordAt - 1;
  while (cursor >= 0 && isWhitespace(sql[cursor])) cursor -= 1;
  return cursor < 0 || sql[cursor] === ';';
}

function skipOptionalIfNotExists(sql: string, start: number): number {
  if (!isKeywordAt(sql, start, 'if')) return start;
  let cursor = skipWhitespace(sql, start + 'if'.length);
  if (!isKeywordAt(sql, cursor, 'not')) return start;
  cursor = skipWhitespace(sql, cursor + 'not'.length);
  if (!isKeywordAt(sql, cursor, 'exists')) return start;
  return skipWhitespace(sql, cursor + 'exists'.length);
}

function readCreateTableTarget(sql: string, start: number): string {
  let cursor = skipWhitespace(sql, start);
  const targetStart = cursor;
  let inQuotedIdentifier = false;

  while (cursor < sql.length) {
    const char = sql[cursor];
    if (char === '"') {
      if (inQuotedIdentifier && sql[cursor + 1] === '"') {
        cursor += 2;
        continue;
      }
      inQuotedIdentifier = !inQuotedIdentifier;
      cursor += 1;
      continue;
    }
    if (!inQuotedIdentifier && (char === '(' || isWhitespace(char))) break;
    cursor += 1;
  }

  return sql.slice(targetStart, cursor);
}

function skipWhitespace(sql: string, start: number): number {
  let cursor = start;
  while (cursor < sql.length && isWhitespace(sql[cursor])) cursor += 1;
  return cursor;
}

function isKeywordAt(sql: string, start: number, keyword: string): boolean {
  const end = start + keyword.length;
  if (start < 0 || end > sql.length) return false;
  if (sql.slice(start, end).toLowerCase() !== keyword) return false;
  return !isIdentifierChar(sql[start - 1]) && !isIdentifierChar(sql[end]);
}

function isWhitespace(char: string | undefined): boolean {
  return char === ' ' || char === '\n' || char === '\r' || char === '\t' || char === '\f';
}

function isIdentifierChar(char: string | undefined): boolean {
  if (!char) return false;
  const code = char.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    char === '_' ||
    char === '$'
  );
}

function parseCreateTableTarget(rawTarget: string): { schema: string; table: string } {
  const parts = rawTarget.split('.');
  const table = unquoteIdentifier(parts[parts.length - 1] ?? rawTarget);
  const schema = parts.length > 1 ? unquoteIdentifier(parts[parts.length - 2] ?? 'public') : 'public';
  return { schema, table };
}

function unquoteIdentifier(identifier: string): string {
  if (identifier.startsWith('"') && identifier.endsWith('"')) {
    return identifier.slice(1, -1).toLowerCase();
  }
  return identifier.toLowerCase();
}

interface SnapshotShape {
  tables: { name: string; schema?: string }[];
  _known_drift?: {
    in_migrations_only?: { name: string; reason: string }[];
    in_prod_only?: { name: string; reason: string }[];
  };
}

interface ParsedSnapshot {
  prod: Set<string>;
  drift: { migrationsOnly: Set<string>; prodOnly: Set<string> };
}

// Read + parse the snapshot file once and return both the prod-table set
// and the known-drift allow-lists. Returns null if the file is missing
// (bootstrapping case).
function loadSnapshot(): ParsedSnapshot | null {
  if (!existsSync(SNAPSHOT_FILE)) return null;
  const raw = JSON.parse(readFileSync(SNAPSHOT_FILE, 'utf8')) as
    | { name: string; schema?: string }[]
    | SnapshotShape;
  const arr = Array.isArray(raw) ? raw : raw.tables;
  const prod = new Set(
    arr
      .filter((t) => !t.schema || t.schema === 'public')
      .map((t) => t.name.toLowerCase()),
  );
  const driftSpec = Array.isArray(raw) ? undefined : raw._known_drift;
  return {
    prod,
    drift: {
      migrationsOnly: new Set(
        (driftSpec?.in_migrations_only ?? []).map((t) => t.name.toLowerCase()),
      ),
      prodOnly: new Set((driftSpec?.in_prod_only ?? []).map((t) => t.name.toLowerCase())),
    },
  };
}

export function run(): { ok: boolean; message: string } {
  if (hasLabel('local-matches-prod-skip')) {
    return {
      ok: true,
      message: '🏷️  feedback_local_matches_prod: skipped (PR label `local-matches-prod-skip`).',
    };
  }

  const local = localTableSet();
  const snapshot = loadSnapshot();

  if (!snapshot) {
    return {
      ok: true,
      message:
        `⏳ feedback_local_matches_prod: snapshot at ${SNAPSHOT_FILE} not found — bootstrapping run, skipping. ` +
        'Refresh snapshot after a known-good prod schema window (operator step).',
    };
  }

  const { prod, drift } = snapshot;
  const onlyLocal = [...local]
    .filter((t) => !prod.has(t) && !drift.migrationsOnly.has(t))
    .sort((a, b) => a.localeCompare(b));
  const onlyProd = [...prod]
    .filter((t) => !local.has(t) && !drift.prodOnly.has(t))
    .sort((a, b) => a.localeCompare(b));

  if (onlyLocal.length === 0 && onlyProd.length === 0) {
    const allowedSize = drift.migrationsOnly.size + drift.prodOnly.size;
    const note = allowedSize > 0 ? ` (${allowedSize} known-drift entries allowed)` : '';
    return {
      ok: true,
      message: `✅ feedback_local_matches_prod: clean (${local.size} tables in migrations, ${prod.size} in prod)${note}.`,
    };
  }

  const lines: string[] = [];
  if (onlyLocal.length > 0) {
    lines.push(
      `⚠️  ${onlyLocal.length} table(s) in migrations but NOT in prod snapshot — ${onlyLocal.join(', ')}`,
    );
  }
  if (onlyProd.length > 0) {
    lines.push(
      `⚠️  ${onlyProd.length} table(s) in prod snapshot but NOT in migrations — ${onlyProd.join(', ')}`,
    );
  }
  return { ok: false, message: `feedback_local_matches_prod:\n${lines.join('\n')}` };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = run();
  console.log(result.message);
  process.exit(result.ok ? 0 : 1);
}
