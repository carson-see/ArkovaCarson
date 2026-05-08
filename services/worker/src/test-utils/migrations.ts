import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function repoRoot(): string {
  const cwd = process.cwd();
  return existsSync(resolve(cwd, 'supabase')) ? cwd : resolve(cwd, '../..');
}

export function migrationPath(name: string): string {
  const root = repoRoot();
  const livePath = resolve(root, 'supabase/migrations', name);
  if (existsSync(livePath)) return livePath;
  return resolve(root, 'docs/migrations-archive', name);
}

export function readMigration(name: string): string {
  return readFileSync(migrationPath(name), 'utf8');
}
