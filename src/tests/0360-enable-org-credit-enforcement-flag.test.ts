/**
 * G4 (PI-0.5 24h slice) — ENABLE_ORG_CREDIT_ENFORCEMENT switchboard seed.
 *
 * Pairs with the merged #1570 credit gate (SCRUM-2970, stable reference_id on
 * org_credit_deductions). The row is an AUDIT MIRROR ONLY: the worker never
 * reads it (runtime gate = the env-backed `config.enableOrgCreditEnforcement`
 * from deploy-worker.yml, classified under ENV_FLAG_GETTERS — not DB_FLAGS —
 * in flagRegistry.ts), and it is not rendered by PlatformControlsPage.tsx /
 * src/lib/switchboard.ts. It must seed OFF and its description must say it is
 * a mirror, because enforcement may not go ON before HakiChain's balance is
 * funded (G3, founder-owned) — the enforced coupling lives in the R-5
 * config-drift manifest pin, not in this row.
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

  it('row descriptions state AUDIT MIRROR ONLY (worker never reads this row; env var is the gate)', () => {
    // Review fix (a): a description implying the row is the control would let
    // an operator "enable" enforcement with zero runtime effect while the
    // audit trigger logs that it was enabled — silent free anchoring post-G3.
    const migration = readFlagMigration();
    const seed = fs.readFileSync(path.resolve(process.cwd(), 'supabase/seed.sql'), 'utf8');
    for (const source of [migration, seed]) {
      expect(source).toMatch(/AUDIT MIRROR ONLY[^']*does NOT gate enforcement/);
      expect(source).toMatch(/env var in deploy-worker\.yml/);
    }
  });

  it('flag_key literal matches the env key read by config.ts and registered in flagRegistry.ts ENV_FLAG_GETTERS', () => {
    // Cross-pin: a rename on either side must fail this test, or the audit
    // mirror silently drifts from the real (env-backed) runtime gate.
    const KEY = 'ENABLE_ORG_CREDIT_ENFORCEMENT';
    const migration = readFlagMigration();
    expect(migration).toContain(`'${KEY}'`);

    const configTs = fs.readFileSync(
      path.resolve(process.cwd(), 'services/worker/src/config.ts'),
      'utf8',
    );
    expect(configTs).toContain(`process.env.${KEY}`);

    const flagRegistryTs = fs.readFileSync(
      path.resolve(process.cwd(), 'services/worker/src/middleware/flagRegistry.ts'),
      'utf8',
    );
    // Must be an ENV-backed registry entry (the audit-mirror premise), i.e.
    // `KEY: () => config....` inside ENV_FLAG_GETTERS — not a DB_FLAGS string.
    expect(flagRegistryTs).toMatch(
      new RegExp(`${KEY}:\\s*\\(\\)\\s*=>\\s*config\\.enableOrgCreditEnforcement`),
    );
    const dbFlagsBlock = /const\s+DB_FLAGS\s*=\s*\[([\s\S]*?)\]\s*as\s+const\s*;/.exec(
      flagRegistryTs,
    );
    expect(dbFlagsBlock).not.toBeNull();
    expect(dbFlagsBlock?.[1]).not.toContain(KEY);
  });
});
