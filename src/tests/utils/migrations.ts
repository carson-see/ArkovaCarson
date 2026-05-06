import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function migrationPath(name: string): string {
  const livePath = join(process.cwd(), 'supabase/migrations', name);
  if (existsSync(livePath)) return livePath;
  return join(process.cwd(), 'docs/migrations-archive', name);
}

export function readMigration(name: string): string {
  return readFileSync(migrationPath(name), 'utf8');
}
