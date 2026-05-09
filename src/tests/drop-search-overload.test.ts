import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MIGRATION_PATH = path.join(
  process.cwd(),
  'supabase/migrations/0304_drop_broken_search_public_credentials_overload.sql',
);

const BASELINE_PATH = path.join(
  process.cwd(),
  'supabase/migrations/00000000000000_baseline_at_main_HEAD.sql',
);

describe('0304: drop broken search_public_credentials(text,int,int) overload', () => {
  it('migration file exists and drops the 3-arg overload', () => {
    const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
    expect(sql).toContain(
      'DROP FUNCTION IF EXISTS public.search_public_credentials(text, integer, integer)',
    );
  });

  it('migration does NOT drop the working 2-arg overload', () => {
    const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
    expect(sql).not.toMatch(
      /DROP\s+FUNCTION.*search_public_credentials\s*\(\s*text\s*,\s*integer\s*\)/,
    );
  });

  it('baseline only defines the 2-arg overload — no 3-arg with offset', () => {
    const sql = fs.readFileSync(BASELINE_PATH, 'utf8');
    const createMatches = [
      ...sql.matchAll(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+"public"\."search_public_credentials"\s*\(/g),
    ];
    expect(createMatches.length).toBe(1);
    const snippet = sql.slice(createMatches[0].index!, createMatches[0].index! + 300);
    expect(snippet).toContain('"p_query"');
    expect(snippet).toContain('"p_limit"');
    expect(snippet).not.toContain('p_offset');
  });

  it('no app code passes p_offset to search_public_credentials', () => {
    const dirs = ['src', 'services'];
    for (const dir of dirs) {
      const fullDir = path.join(process.cwd(), dir);
      const files = findTsFiles(fullDir);
      for (const file of files) {
        if (file.includes('drop-search-overload.test')) continue;
        if (file.includes('database.types')) continue;
        const content = fs.readFileSync(file, 'utf8');
        if (!content.includes('search_public_credentials')) continue;
        expect(content).not.toMatch(/p_offset/);
      }
    }
  });
});

function findTsFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules') {
      results.push(...findTsFiles(full));
    } else if (entry.isFile() && /\.[tj]sx?$/.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}
