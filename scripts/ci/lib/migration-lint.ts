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
    return m.replaceAll(/[^\n]/g, ' ');
  });
}

export interface MigrationFile {
  file: string;
  /** Original SQL — use when policy/comment matches MUST see DO/EXECUTE bodies. */
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
  if (!existsSync(migrationsDir)) return [];
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql') && !f.startsWith('_'))
    .sort()
    .map((file) => {
      const sql = readFileSync(join(migrationsDir, file), 'utf8');
      return { file, sql, stripped: stripDollarQuoted(sql) };
    });
}
