/**
 * G4 (PI-0.5 24h slice) — ENABLE_ORG_CREDIT_ENFORCEMENT switchboard seed.
 *
 * Pairs with the merged #1570 credit gate (SCRUM-2970, stable reference_id on
 * org_credit_deductions). The flag row must exist in `switchboard_flags` so
 * operators have a single visible switchboard entry for the launch-gated
 * credit-enforcement rollout — and it must seed OFF, because enforcement may
 * not be flipped ON before HakiChain's balance is funded (G3, founder-owned).
 *
 * These tests pin the MIGRATION + SEED artifacts (content-level, no DB):
 *  - off-by-default: the row seeds `enabled = false`;
 *  - idempotent: `ON CONFLICT (flag_key) DO NOTHING` — re-applying the
 *    migration can never flip an operator-set value in either direction;
 *  - rollback comment present per CLAUDE.md §4.
 *
 * The worker-side fail-closed behavior for this flag is pinned in
 * `services/worker/src/utils/orgCreditEnforcementFlag.test.ts`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationsDir = path.resolve(process.cwd(), 'supabase/migrations');

function readFlagMigration(): string {
  const migration = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .find((file) => file.includes('0360') && file.includes('org_credit_enforcement'));

  if (!migration) {
    throw new Error('Missing 0360 ENABLE_ORG_CREDIT_ENFORCEMENT flag migration');
  }

  return fs.readFileSync(path.join(migrationsDir, migration), 'utf8');
}

/** Executable SQL only — strip `--` comment lines so prose in the header /
 *  ROLLBACK block can never satisfy or trip an assertion about the LIVE
 *  statements (same convention as the 0345 migration test). */
function executableSql(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
}

describe('0360 ENABLE_ORG_CREDIT_ENFORCEMENT switchboard seed (G4, off-by-default)', () => {
  it('seeds the flag row with enabled = false (must NOT be ON before HakiChain funding — G3)', () => {
    const exec = executableSql(readFlagMigration());

    // The INSERT must target switchboard_flags and carry the flag key with a
    // literal `false` for enabled in the same VALUES tuple.
    expect(exec).toMatch(/INSERT INTO\s+(public\.)?switchboard_flags/i);
    expect(exec).toMatch(/'ENABLE_ORG_CREDIT_ENFORCEMENT'\s*,\s*false\s*,/);
    // Guard against an accidental `true` anywhere in executable SQL.
    expect(exec).not.toMatch(/'ENABLE_ORG_CREDIT_ENFORCEMENT'\s*,\s*true/i);
  });

  it('is idempotent via ON CONFLICT (flag_key) DO NOTHING — re-apply never flips an operator-set value', () => {
    const exec = executableSql(readFlagMigration());

    // DO NOTHING (not DO UPDATE): if an operator has already created or —
    // post-G3 — enabled the row, re-running the migration must not stomp it.
    expect(exec).toMatch(/ON CONFLICT\s*\(\s*"?flag_key"?\s*\)\s*DO NOTHING/i);
    expect(exec).not.toMatch(/ON CONFLICT[^;]*DO UPDATE/i);
  });

  it('carries a -- ROLLBACK: comment per CLAUDE.md §4', () => {
    const sql = readFlagMigration();
    expect(sql).toMatch(/--\s*ROLLBACK:/);
  });

  it('seed.sql carries the flag with enabled = false so local resets stay non-enforcing', () => {
    const seed = fs.readFileSync(path.resolve(process.cwd(), 'supabase/seed.sql'), 'utf8');
    expect(seed).toMatch(/'ENABLE_ORG_CREDIT_ENFORCEMENT'\s*,\s*false\s*,/);
  });
});
