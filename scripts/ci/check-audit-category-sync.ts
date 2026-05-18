/**
 * CI check: audit_events event_category constraint ↔ codebase sync.
 *
 * Extracts the allowed categories from the latest migration that defines
 * audit_events_event_category_valid, then greps the codebase for all
 * event_category string literals used in inserts. Fails if any codebase
 * value is not in the constraint's allowed set.
 *
 * Prevents silent insert failures from fire-and-forget audit inserts that
 * hit an unknown CHECK category.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function getRoot(): string {
  try {
    return resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
  } catch {
    return process.cwd();
  }
}

const ROOT = getRoot();

export interface CategorySyncViolation {
  file: string;
  line: number;
  category: string;
}

/**
 * Parse the CHECK constraint from the latest migration that defines it.
 * Reads migrations in reverse order to find the most recent definition.
 */
export function extractConstraintCategories(): string[] {
  const migrationsDir = join(ROOT, 'supabase/migrations');
  const files = readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort()
    .reverse();

  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), 'utf-8');
    if (sql.includes('audit_events_event_category_valid')) {
      const allArrays = [...sql.matchAll(/ARRAY\[([^\]]+)\]/g)];
      const lastMatch = allArrays[allArrays.length - 1];
      if (!lastMatch) continue;
      const categories = [...lastMatch[1].matchAll(/'([A-Z_]+)'/g)].map(m => m[1]);
      if (categories.length > 0) return categories;
    }
  }

  throw new Error('Could not find audit_events_event_category_valid constraint in any migration');
}

function walkTs(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkTs(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.') && !entry.name.includes('.spec.')) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Find all event_category string literals used in audit_events inserts.
 * Searches worker and frontend source, excluding test files and node_modules.
 */
export function extractCodeCategories(): CategorySyncViolation[] {
  const results: CategorySyncViolation[] = [];
  const re = /event_category:\s*['"]([^'"]+)['"]/g;

  const dirs = [join(ROOT, 'services/worker/src'), join(ROOT, 'src')];
  for (const dir of dirs) {
    try { statSync(dir); } catch { continue; }
    for (const file of walkTs(dir)) {
      const content = readFileSync(file, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        let m: RegExpExecArray | null;
        re.lastIndex = 0;
        while ((m = re.exec(lines[i])) !== null) {
          const relPath = file.startsWith(ROOT) ? file.slice(ROOT.length + 1) : file;
          results.push({ file: relPath, line: i + 1, category: m[1] });
        }
      }
    }
  }

  return results;
}

export function check(): { pass: boolean; violations: CategorySyncViolation[] } {
  const allowed = new Set(extractConstraintCategories());
  const usages = extractCodeCategories();
  const violations = usages.filter(u => !allowed.has(u.category));
  return { pass: violations.length === 0, violations };
}

const isDirectRun = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  const { pass, violations } = check();
  if (!pass) {
    console.error('audit_events event_category constraint ↔ codebase MISMATCH:');
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line} — category '${v.category}' not in CHECK constraint`);
    }
    process.exit(1);
  }
  console.log('audit_events event_category constraint ↔ codebase: OK');
}
