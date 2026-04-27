/**
 * SCRUM-1189 (AUDIT-08) — search_path = public coverage for 13 mutable-search-path functions.
 *
 * Supabase advisor `function_search_path_mutable` flags functions whose
 * search_path is not explicitly pinned. CLAUDE.md §1.4 requires
 * `SET search_path = public` on any SECURITY DEFINER function, and we
 * extend the same hygiene to trigger functions on the same advisor list
 * to remove the warning entirely.
 *
 * This test scans `supabase/migrations/*.sql` for each named function
 * and asserts at least ONE of:
 *   (a) The CREATE OR REPLACE FUNCTION block declares `SET search_path = public`
 *   (b) A later migration runs `ALTER FUNCTION <name>(<args>) SET search_path = public`
 *
 * Either makes the function safe per the advisor.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const FUNCTIONS = [
  { name: 'sanitize_metadata_for_public', args: 'jsonb' },
  { name: 'protect_privileged_profile_fields', args: '' },
  { name: 'reject_audit_modification', args: '' },
  { name: 'update_agents_updated_at', args: '' },
  { name: 'prevent_attestation_claim_modification', args: '' },
  { name: 'generate_anchor_public_id', args: 'text' },
  { name: 'update_attestation_updated_at', args: '' },
  { name: 'trigger_set_updated_at', args: '' },
  { name: 'check_role_immutability', args: '' },
  { name: 'enforce_lowercase_email', args: '' },
  { name: 'generate_public_id', args: '' },
  { name: 'auto_generate_public_id', args: '' },
  { name: 'update_review_queue_updated_at', args: '' },
] as const;

function readAllMigrations(): string {
  const dir = path.join(process.cwd(), 'supabase/migrations');
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
    .join('\n');
}

const SEARCH_PATH_RE = /SET\s+search_path\s*=\s*public/i;

function hasInlineSearchPath(allSql: string, fnName: string): boolean {
  const pattern = new RegExp(
    `CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+(?:public\\.)?${fnName}\\s*\\([^)]*\\)[\\s\\S]*?AS\\s*\\$`,
    'gi',
  );
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(allSql)) !== null) {
    if (SEARCH_PATH_RE.test(m[0])) return true;
  }
  return false;
}

function hasAlterSearchPath(allSql: string, fnName: string): boolean {
  const pattern = new RegExp(
    `ALTER\\s+FUNCTION\\s+(?:public\\.)?${fnName}\\s*\\([^)]*\\)[\\s\\S]*?SET\\s+search_path\\s*=\\s*public`,
    'i',
  );
  return pattern.test(allSql);
}

describe('SCRUM-1189 (AUDIT-08): mutable-search-path advisor coverage', () => {
  const allSql = readAllMigrations();

  for (const fn of FUNCTIONS) {
    it(`${fn.name}(${fn.args}) has SET search_path = public (inline or via ALTER)`, () => {
      const inline = hasInlineSearchPath(allSql, fn.name);
      const altered = hasAlterSearchPath(allSql, fn.name);
      expect(
        inline || altered,
        `${fn.name} is missing SET search_path = public — see CLAUDE.md §1.4 and Supabase advisor function_search_path_mutable`,
      ).toBe(true);
    });
  }
});
