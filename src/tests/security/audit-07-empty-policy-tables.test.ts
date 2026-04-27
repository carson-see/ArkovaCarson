/**
 * SCRUM-1188 (AUDIT-07) — RLS policies on 7 service-role-only tables.
 *
 * The Supabase advisor `rls_enabled_no_policy` flagged tables with RLS
 * enabled but missing the explicit "service-role-only" policy hint.
 * With RLS+FORCE and no policies, queries from non-service roles are
 * silently denied — which is the intent — but the implicit deny is
 * easy to invert by accident in a future migration.
 *
 * The fix is to ATTACH an explicit deny-all-for-users policy to each
 * table so the intent is documented in code (and the advisor clears).
 *
 * For the two switchboard tables that already carry SELECT policies,
 * a deny-write policy is added — DML stays service-role-only.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SERVICE_ROLE_ONLY_TABLES = [
  'anchor_chain_index',
  'anchoring_jobs',
  'audit_events_archive',
  'job_queue',
  'rule_embeddings',
] as const;

const SWITCHBOARD_TABLES = ['switchboard_flags', 'switchboard_flag_history'] as const;

function readAllSql(): string {
  const dir = path.join(process.cwd(), 'supabase/migrations');
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
    .join('\n');
}

describe('SCRUM-1188 (AUDIT-07): explicit service-role-only RLS policies', () => {
  const allSql = readAllSql();

  for (const tbl of SERVICE_ROLE_ONLY_TABLES) {
    it(`${tbl} has an explicit deny-all-users policy`, () => {
      // Find a CREATE POLICY on this table that targets authenticated/anon
      // and uses USING (false) — the documented "service-role-only" pattern
      // (matches the cloud_logging_queue policy from migration 0235).
      const re = new RegExp(
        `CREATE\\s+POLICY\\s+\\w+\\s+ON\\s+(?:public\\.)?${tbl}\\s+FOR\\s+ALL\\s+TO\\s+(?:authenticated\\s*,\\s*anon|anon\\s*,\\s*authenticated)\\s+USING\\s*\\(\\s*false\\s*\\)\\s+WITH\\s+CHECK\\s*\\(\\s*false\\s*\\)`,
        'i',
      );
      expect(re.test(allSql), `${tbl} is missing the explicit deny-all policy`).toBe(true);
    });
  }

  for (const tbl of SWITCHBOARD_TABLES) {
    it(`${tbl} has an explicit deny-write policy for non-service-role`, () => {
      // Switchboard tables already have a SELECT policy. The deny-write
      // policy locks INSERT/UPDATE/DELETE to service_role; without it the
      // advisor rls_enabled_no_policy fires for the missing DML coverage.
      const re = new RegExp(
        `CREATE\\s+POLICY\\s+\\w+\\s+ON\\s+(?:public\\.)?${tbl}\\s+FOR\\s+(?:INSERT|UPDATE|DELETE|ALL)\\s+TO\\s+(?:authenticated\\s*,\\s*anon|anon\\s*,\\s*authenticated|authenticated|anon)[\\s\\S]*?WITH\\s+CHECK\\s*\\(\\s*false\\s*\\)`,
        'i',
      );
      expect(re.test(allSql), `${tbl} is missing the deny-write policy`).toBe(true);
    });
  }
});
