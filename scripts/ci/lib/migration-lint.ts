/**
 * Shared helpers for migration-lint scripts (SCRUM-1275 / 1276).
 *
 * Both scripts walk supabase/migrations/, load a JSON baseline of
 * grandfathered entries, and need to skip dollar-quoted PL/pgSQL
 * blocks when scanning top-level statements. This module hosts the
 * three primitives so the lint scripts stay focused on their rule
 * logic.
 */

import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DOLLAR_QUOTED_BLOCK = /\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1\$/g;

interface Baseline {
  /** Entries (filenames or table names — interpretation is per-lint) exempt from the rule. */
  grandfathered?: string[];
  /** Historical production-ledger drift exemptions for RLS policy coverage. */
  missing_in_prod?: string[];
}

function blankPreservingNewlines(text: string): string {
  return text.replaceAll(/[^\n]/g, ' ');
}

function consumeSingleQuoted(sql: string, start: number): number {
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === "'" && sql[i + 1] === "'") {
      i += 2;
      continue;
    }
    if (sql[i] === "'") {
      return i + 1;
    }
    i += 1;
  }
  return i;
}

function consumeDoubleQuoted(sql: string, start: number): number {
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === '"' && sql[i + 1] === '"') {
      i += 2;
      continue;
    }
    if (sql[i] === '"') {
      return i + 1;
    }
    i += 1;
  }
  return i;
}

function consumeLineComment(sql: string, start: number): number {
  let i = start + 2;
  while (i < sql.length && sql[i] !== '\n') {
    i += 1;
  }
  return i;
}

function consumeBlockComment(sql: string, start: number): number {
  let i = start + 2;
  let depth = 1;
  while (i < sql.length && depth > 0) {
    if (sql[i] === '/' && sql[i + 1] === '*') {
      depth += 1;
      i += 2;
      continue;
    }
    if (sql[i] === '*' && sql[i + 1] === '/') {
      depth -= 1;
      i += 2;
      continue;
    }
    i += 1;
  }
  return i;
}

interface SqlToken {
  text: string;
  next: number;
}

function readQuotedToken(sql: string, start: number): SqlToken | null {
  if (sql[start] === "'") {
    const next = consumeSingleQuoted(sql, start);
    return { text: sql.slice(start, next), next };
  }
  if (sql[start] === '"') {
    const next = consumeDoubleQuoted(sql, start);
    return { text: sql.slice(start, next), next };
  }
  return null;
}

function readBlankedQuotedToken(sql: string, start: number): SqlToken | null {
  const token = readQuotedToken(sql, start);
  if (!token) return null;

  const quote = sql[start];
  const inner = sql.slice(start + 1, token.next - 1);
  const text = `${quote}${blankPreservingNewlines(inner)}${quote}`;
  return { text, next: token.next };
}

function readCommentToken(sql: string, start: number): SqlToken | null {
  if (sql[start] === '-' && sql[start + 1] === '-') {
    const next = consumeLineComment(sql, start);
    return { text: blankPreservingNewlines(sql.slice(start, next)), next };
  }
  if (sql[start] === '/' && sql[start + 1] === '*') {
    const next = consumeBlockComment(sql, start);
    return { text: blankPreservingNewlines(sql.slice(start, next)), next };
  }
  return null;
}

/**
 * Load a baseline JSON of grandfathered entries. Returns an empty Set
 * when the file is absent so first-time lints don't trip on missing
 * snapshots.
 */
export function loadBaseline(baselinePath: string): Set<string> {
  if (!existsSync(baselinePath)) return new Set();
  const raw = JSON.parse(readFileSync(baselinePath, 'utf8')) as Baseline;
  return new Set([...(raw.missing_in_prod ?? []), ...(raw.grandfathered ?? [])].map((entry) => entry.toLowerCase()));
}

/**
 * Normalize a public-schema SQL identifier to the unqualified lower-case name.
 */
export function normalizePublicIdent(raw: string): string {
  return raw
    .replaceAll(/^"public"\./gi, '')
    .replaceAll(/^public\./gi, '')
    .replaceAll(/^"|"$/g, '')
    .toLowerCase();
}

function escapeRegExpLiteral(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/**
 * Regex source for matching `foo`, `public.foo`, or `"public"."foo"`.
 */
export function publicSchemaRefPattern(identifier: string): string {
  return String.raw`(?:(?:"public"|public)\.)?"?${escapeRegExpLiteral(identifier)}"?\b`;
}

/**
 * Replace dollar-quoted blocks (`$$ ... $$` and `$tag$ ... $tag$`)
 * with whitespace, preserving newlines so subsequent line-counting
 * stays correct. The lints want this for top-level-statement scans
 * (CREATE VIEW, ALTER TABLE FORCE) where templates inside DO/EXECUTE
 * blocks must not match.
 */
export function stripDollarQuoted(sql: string): string {
  return sql.replaceAll(DOLLAR_QUOTED_BLOCK, (m) => {
    return blankPreservingNewlines(m);
  });
}

/**
 * Remove SQL comments while preserving quoted strings and newlines.
 *
 * Several migration lints use regexes as a lightweight parser. Blanking
 * comments first prevents commented-out SQL from satisfying those lints
 * without shifting line numbers in reported findings.
 */
export function stripSqlComments(sql: string): string {
  let output = '';
  let i = 0;

  while (i < sql.length) {
    const quoted = readQuotedToken(sql, i);
    if (quoted) {
      output += quoted.text;
      i = quoted.next;
      continue;
    }

    const comment = readCommentToken(sql, i);
    if (comment) {
      output += comment.text;
      i = comment.next;
      continue;
    }

    output += sql[i];
    i += 1;
  }

  return output;
}

/**
 * Blank quoted string contents. The quote delimiters stay in place so simple
 * statement regexes can still reason about SQL shape without being fooled by
 * SQL text embedded in literals.
 */
export function stripSqlStringLiterals(sql: string): string {
  let output = '';
  let i = 0;

  while (i < sql.length) {
    const quoted = readBlankedQuotedToken(sql, i);
    if (quoted) {
      output += quoted.text;
      i = quoted.next;
      continue;
    }

    output += sql[i];
    i += 1;
  }

  return output;
}

/**
 * Remove comments and then blank quoted string contents.
 */
export function stripSqlCommentsAndStringLiterals(sql: string): string {
  return stripSqlStringLiterals(stripSqlComments(sql));
}

export interface MigrationFile {
  file: string;
  /** Original SQL — use when a lint needs the full migration text. */
  sql: string;
  /** Dollar-quoted blocks blanked — use for top-level-statement scans. */
  stripped: string;
}

/**
 * Read every `*.sql` file in a migrations directory, sorted, with both
 * the original and stripped views ready to scan. Files starting with
 * `_` are skipped (Supabase scratchpad convention).
 */
export function loadMigrations(migrationsDir: string): MigrationFile[] {
  if (!existsSync(migrationsDir)) {
    throw new Error(
      `Migrations directory not found: ${migrationsDir}. Manual RLS/view scans must cover **/*.{ts,tsx,js,jsx,sql}.`,
    );
  }
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql') && !f.startsWith('_'))
    .sort()
    .map((file) => {
      const sql = readFileSync(join(migrationsDir, file), 'utf8');
      return { file, sql, stripped: stripDollarQuoted(sql) };
    });
}
