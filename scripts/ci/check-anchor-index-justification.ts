#!/usr/bin/env -S npx tsx
/**
 * SCRUM-1286: any new index on public.anchors must explain why it exists.
 *
 * The anchors table is write-hot and already carries a large index footprint.
 * Future indexes are allowed, but the migration must carry an adjacent
 * `anchor-index-justification:` comment with a non-empty reason.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const JUSTIFICATION_MARKER = 'anchor-index-justification:';
const MIGRATIONS_DIR = join('supabase', 'migrations');

const GRANDFATHERED_MIGRATION_FILES = new Set([
  'supabase/migrations/00000000000000_baseline_at_main_HEAD.sql',
  'supabase/migrations/0310_idx_anchors_secured_chain_ts.sql',
]);

export interface Violation {
  file: string;
  line: number;
  indexName: string;
  text: string;
}

function comparePath(a: string, b: string): number {
  return a.localeCompare(b);
}

function normalizeRelPath(path: string): string {
  return path.split(sep).join('/');
}

export function collectMigrationFiles(repo: string): string[] {
  const absDir = join(repo, MIGRATIONS_DIR);
  if (!existsSync(absDir)) return [];

  return readdirSync(absDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => normalizeRelPath(relative(repo, join(absDir, entry.name))))
    .sort(comparePath);
}

function stripSqlLineComment(line: string): string {
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (inSingleQuote) {
      if (char === "'" && next === "'") {
        index += 1;
        continue;
      }
      if (char === "'") inSingleQuote = false;
      continue;
    }

    if (inDoubleQuote) {
      if (char === '"' && next === '"') {
        index += 1;
        continue;
      }
      if (char === '"') inDoubleQuote = false;
      continue;
    }

    if (char === "'") {
      inSingleQuote = true;
      continue;
    }
    if (char === '"') {
      inDoubleQuote = true;
      continue;
    }
    if (char === '-' && next === '-') {
      return line.slice(0, index).trimEnd();
    }
  }

  return line;
}

function markerHasReason(line: string): boolean {
  const markerAt = line.indexOf(JUSTIFICATION_MARKER);
  if (markerAt === -1) return false;
  return line.slice(markerAt + JUSTIFICATION_MARKER.length).trim().length > 0;
}

function hasNearbyJustification(lines: string[], createLineIndex: number): boolean {
  for (const nearby of [createLineIndex, createLineIndex - 1, createLineIndex - 2]) {
    if (nearby < 0) continue;
    if (markerHasReason(lines[nearby])) return true;
  }
  return false;
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function extractIndexName(statement: string): string | null {
  const match = statement.match(
    /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?:(?:"[^"]+"|[a-zA-Z_][\w$]*)\s*\.\s*)?(?:"([^"]+)"|([a-zA-Z_][\w$]*))/i,
  );
  return match?.[1] ?? match?.[2] ?? null;
}

function createsAnchorIndex(statement: string): boolean {
  return /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(statement)
    && /\bON\s+(?:(?:"public"|public)\s*\.\s*)?(?:"anchors"|anchors)\b/i.test(statement);
}

export function scanTextForUnjustifiedAnchorIndexes(file: string, text: string): Violation[] {
  if (GRANDFATHERED_MIGRATION_FILES.has(file)) return [];

  const lines = text.split(/\r?\n/);
  const violations: Violation[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const stripped = stripSqlLineComment(lines[index]);
    if (!/\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(stripped)) continue;

    const statementLines = [stripped];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const nextLine = stripSqlLineComment(lines[cursor]);
      statementLines.push(nextLine);
      if (nextLine.includes(';')) break;
    }

    const statement = normalizeSql(statementLines.join('\n'));
    if (!createsAnchorIndex(statement)) continue;

    const indexName = extractIndexName(statement) ?? '<unknown>';
    if (hasNearbyJustification(lines, index)) continue;

    violations.push({
      file,
      line: index + 1,
      indexName,
      text: lines[index].trim(),
    });
  }

  return violations;
}

function main(): void {
  const repo = resolve(import.meta.dirname, '..', '..');
  const files = collectMigrationFiles(repo);
  const violations = files.flatMap((file) =>
    scanTextForUnjustifiedAnchorIndexes(file, readFileSync(join(repo, file), 'utf8')),
  );

  if (violations.length === 0) {
    console.log(`anchors index justification policy passed (${files.length} migration file(s) scanned).`);
    return;
  }

  console.error(
    `::error::Found ${violations.length} new public.anchors index(es) without ` +
      `an adjacent ${JUSTIFICATION_MARKER} comment.`,
  );
  for (const violation of violations) {
    console.error(
      `${violation.file}:${violation.line} ${violation.indexName}: ${violation.text}`,
    );
  }
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
