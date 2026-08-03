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

/**
 * Advance past a quoted region (single- or double-quoted SQL identifier/string).
 * Returns the index of the closing quote, or `line.length` if unterminated.
 */
function skipQuotedRegion(line: string, start: number, quoteChar: string): number {
  let i = start + 1;
  while (i < line.length) {
    if (line[i] === quoteChar) {
      // Doubled quote is an escape — skip past the pair.
      if (line[i + 1] === quoteChar) {
        i += 2;
      } else {
        return i;
      }
    } else {
      i += 1;
    }
  }
  return line.length;
}

/**
 * Drop a trailing `--` line comment, respecting quoted regions so a `--` inside
 * a string literal is not treated as a comment start. Exported because any
 * scanner that pattern-matches SQL DDL must strip comments first — otherwise a
 * migration that merely DOCUMENTS a statement in its header is indistinguishable
 * from one that executes it (see check-envelope-key-index-parity.ts).
 */
export function stripSqlLineComment(line: string): string {
  let index = 0;
  while (index < line.length) {
    const char = line[index];
    if (char === "'" || char === '"') {
      index = skipQuotedRegion(line, index, char) + 1;
      continue;
    }
    if (char === '-' && line[index + 1] === '-') {
      return line.slice(0, index).trimEnd();
    }
    index += 1;
  }

  return line;
}

const MARKER_RE = /^\s*--\s*anchor-index-justification:\s*(.+)$/i;

function markerHasReason(line: string): boolean {
  const match = MARKER_RE.exec(line);
  return match !== null && match[1].trim().length > 0;
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

/**
 * Extract the index name from a CREATE INDEX statement.
 *
 * Strategy: normalize whitespace, strip known SQL keywords that appear
 * between CREATE INDEX and the name, then match the identifier. Uses
 * individual keyword regexes to keep each under the SonarCloud S5843
 * complexity limit of 20.
 */
const STRIP_UNIQUE_RE = /\bUNIQUE\b/gi;
const STRIP_CONCURRENTLY_RE = /\bCONCURRENTLY\b/gi;
const STRIP_IF_NOT_EXISTS_RE = /\bIF NOT EXISTS\b/gi;
// Match a SQL identifier: either a quoted "name" or an unquoted name.
const SQL_IDENT_RE = /^(?:"([^"]+)"|([a-zA-Z_]\w*))/;
// Match an optional schema prefix (identifier followed by a dot).
const SCHEMA_PREFIX_RE = /^(?:"[^"]+"|[a-zA-Z_]\w*)\s*\.\s*/;

function stripIndexKeywords(sql: string): string {
  return sql
    .replace(STRIP_UNIQUE_RE, '')
    .replace(STRIP_CONCURRENTLY_RE, '')
    .replace(STRIP_IF_NOT_EXISTS_RE, '');
}

function extractIndexName(statement: string): string | null {
  // Normalize to single spaces and locate CREATE INDEX.
  const normalized = normalizeSql(statement);
  const createIdx = normalized.search(/\bCREATE\s+INDEX\b/i);
  if (createIdx === -1) return null;
  // Slice past "CREATE INDEX" then strip optional keywords.
  const afterCreate = normalized.slice(createIdx).replace(/^CREATE\s+INDEX\s+/i, '');
  let remainder = stripIndexKeywords(afterCreate).trimStart();
  // Strip optional schema prefix (e.g., "public".)
  const schemaMatch = SCHEMA_PREFIX_RE.exec(remainder);
  if (schemaMatch) {
    remainder = remainder.slice(schemaMatch[0].length);
  }
  // Match the index name identifier.
  const nameMatch = SQL_IDENT_RE.exec(remainder);
  return nameMatch?.[1] ?? nameMatch?.[2] ?? null;
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
