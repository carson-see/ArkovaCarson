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
  grandfathered: string[];
}

function blankPreservingNewlines(text: string): string {
  return text.replaceAll(/[^\n]/g, ' ');
}

/**
 * Load a baseline JSON of grandfathered entries. Returns an empty Set
 * when the file is absent so first-time lints don't trip on missing
 * snapshots.
 */
export function loadBaseline(baselinePath: string): Set<string> {
  if (!existsSync(baselinePath)) return new Set();
  const raw = JSON.parse(readFileSync(baselinePath, 'utf8')) as Baseline;
  return new Set(raw.grandfathered);
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
    const current = sql[i];
    const next = sql[i + 1];

    if (current === "'") {
      const start = i;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i += 1;
          break;
        }
        i += 1;
      }
      output += sql.slice(start, i);
      continue;
    }

    if (current === '"') {
      const start = i;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          i += 2;
          continue;
        }
        if (sql[i] === '"') {
          i += 1;
          break;
        }
        i += 1;
      }
      output += sql.slice(start, i);
      continue;
    }

    if (current === '-' && next === '-') {
      const start = i;
      i += 2;
      while (i < sql.length && sql[i] !== '\n') {
        i += 1;
      }
      output += blankPreservingNewlines(sql.slice(start, i));
      continue;
    }

    if (current === '/' && next === '*') {
      const start = i;
      i += 2;
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
      output += blankPreservingNewlines(sql.slice(start, i));
      continue;
    }

    output += current;
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
    const current = sql[i];

    if (current === "'") {
      output += "'";
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          output += '  ';
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          output += "'";
          i += 1;
          break;
        }
        output += sql[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      continue;
    }

    if (current === '"') {
      output += '"';
      i += 1;
      while (i < sql.length) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          output += '  ';
          i += 2;
          continue;
        }
        if (sql[i] === '"') {
          output += '"';
          i += 1;
          break;
        }
        output += sql[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      continue;
    }

    output += current;
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
