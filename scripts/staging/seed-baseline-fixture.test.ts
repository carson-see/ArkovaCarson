import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Structural contract tests for the isolated soak-rig baseline fixture.
 *
 * The fixture is declarative SQL (no executable logic to unit-test), and CI has
 * no Postgres for this path, so these tests pin the invariants that make the
 * fixture (a) satisfy the staging-honesty preflight's Check 5 and (b) stay
 * compliant with CLAUDE.md §1.11A (data-only, idempotent, clearly synthetic).
 * The live before/after preflight flip was validated against rig
 * sveujcebzkqxbhimotbb during authoring.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SQL_PATH = resolve(here, 'seed-baseline-fixture.sql');
const PROVISIONER_PATH = resolve(here, 'provision-isolated-rig.sh');

const sql = readFileSync(SQL_PATH, 'utf8');
const provisioner = readFileSync(PROVISIONER_PATH, 'utf8');

/**
 * SQL with `-- line comments` stripped. The fixture's header documents the
 * §1.11A invariants in prose ("writes NOTHING to supabase_migrations…"), so the
 * ledger-write assertions must inspect executable SQL only, not the commentary.
 */
const sqlNoComments = sql
  .split('\n')
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n');

describe('seed-baseline-fixture.sql — preflight Check 5', () => {
  it('inserts at least one anchor with status SUBMITTED', () => {
    // The preflight counts: select count(*) from anchors where status='SUBMITTED'.
    expect(sql).toMatch(/insert\s+into\s+public\.anchors/i);
    expect(sql).toMatch(/'SUBMITTED'/);
  });

  it('satisfies the full FK chain (auth.users -> profiles -> anchors, plus org + identity)', () => {
    expect(sql).toMatch(/insert\s+into\s+auth\.users/i);
    expect(sql).toMatch(/insert\s+into\s+auth\.identities/i);
    expect(sql).toMatch(/insert\s+into\s+public\.organizations/i);
    expect(sql).toMatch(/insert\s+into\s+public\.profiles/i);
    expect(sql).toMatch(/insert\s+into\s+public\.anchors/i);
  });

  it('uses a 64-hex fingerprint (anchors_fingerprint_format CHECK)', () => {
    // Pull the fingerprint literal from the anchors VALUES list.
    const m = sql.match(/'([A-Fa-f0-9]{64})'/);
    expect(m, 'a 64-char hex fingerprint literal must be present').not.toBeNull();
  });
});

describe('seed-baseline-fixture.sql — §1.11A data-only + idempotent', () => {
  it('never writes to the migration ledger (executable SQL, comments excluded)', () => {
    expect(sqlNoComments).not.toMatch(/supabase_migrations/i);
    expect(sqlNoComments).not.toMatch(/schema_migrations/i);
    expect(sqlNoComments).not.toMatch(/migration\s+repair/i);
  });

  it('is idempotent — every INSERT is guarded against re-runs', () => {
    const inserts = sql.match(/insert\s+into/gi) ?? [];
    const onConflict = sql.match(/on\s+conflict/gi) ?? [];
    // Every INSERT must carry an ON CONFLICT DO NOTHING guard.
    expect(inserts.length).toBeGreaterThanOrEqual(5);
    expect(onConflict.length).toBeGreaterThanOrEqual(inserts.length);
    expect(sql).toMatch(/on\s+conflict\s*\(\s*id\s*\)\s*do\s+nothing/i);
  });

  it('uses clearly-synthetic fixture identifiers', () => {
    expect(sql).toMatch(/seed-fixture/i);
    // Fixture UUIDs live in the obviously-synthetic 5eed0000- range.
    expect(sql).toMatch(/5eed0000-0000-0000-0000-/i);
  });

  it('does not use a seed-prefixed org name (keeps org_topology PASS)', () => {
    // SEED_ORG_PREFIXES in the preflight: stg / staging_seed_ / test_org_.
    // The fixture org's display/legal name must NOT start with any of these,
    // or it counts as a bare seed org with no org-scoped fixtures (FAIL).
    expect(sql).not.toMatch(/'(stg|staging_seed_|test_org_)/i);
  });

  it('takes the service_role fast-path so the SUBMITTED insert is permitted', () => {
    // protect_anchor_status_transition() requires get_caller_role()='service_role'
    // to allow a non-PENDING anchor INSERT. The seed sets a transaction-local claim.
    expect(sql).toMatch(/set_config\(\s*'request\.jwt\.claims'/i);
    expect(sql).toMatch(/"role"\s*:\s*"service_role"/);
    // Must be wrapped in an explicit transaction so the local GUC applies.
    expect(sql).toMatch(/\bBEGIN\b/);
    expect(sql).toMatch(/\bCOMMIT\b/);
  });

  it('has no hardcoded credential literal for encrypted_password (S6418)', () => {
    // SonarCloud S6418 / CLAUDE.md §1.4 "never hardcode secrets": the fixture
    // user's encrypted_password must NOT be a pasted bcrypt literal NOR a string
    // literal passed to crypt(). It is derived at runtime from a random UUID via
    // pgcrypto, so source carries no secret-looking string. Guard the bcrypt prefix
    // AND any quoted string arg to crypt().
    expect(sql).not.toMatch(/\$2[aby]\$[0-9]{2}\$/);
    expect(sql).not.toMatch(/crypt\(\s*'[^']+'/i);
    // The runtime derivation must be present and schema-qualified (pgcrypto
    // lives in `extensions`), so the column stays a valid bcrypt value.
    expect(sql).toMatch(
      /encrypted_password/i,
    );
    expect(sql).toMatch(
      /extensions\.crypt\(\s*gen_random_uuid\(\)::text\s*,\s*extensions\.gen_salt\(\s*'bf'\s*\)\s*\)/i,
    );
  });
});

describe('provision-isolated-rig.sh — fixture wiring', () => {
  it('runs the baseline fixture seed via the CLI direct-DB path', () => {
    expect(provisioner).toMatch(
      /supabase\s+db\s+query\s+--linked\s+--file\s+scripts\/staging\/seed-baseline-fixture\.sql/,
    );
  });

  it('seeds AFTER the worker deploy and BEFORE the clean_mirror preflight', () => {
    // Key off the EXECUTED commands (run_cmd / gcloud run deploy / tsx preflight),
    // not header-comment mentions of the filename.
    const seedIdx = provisioner.search(/run_cmd\s+npx\s+supabase\s+db\s+query\s+--linked\s+--file/);
    const deployIdx = provisioner.search(/run_cmd\s+gcloud\s+run\s+deploy/);
    const preflightIdx = provisioner.search(/run_cmd\s+npx\s+tsx\s+scripts\/ci\/staging-honesty-preflight\.ts/);
    expect(seedIdx).toBeGreaterThan(-1);
    expect(deployIdx).toBeGreaterThan(-1);
    expect(preflightIdx).toBeGreaterThan(-1);
    // executed order: deploy -> seed -> preflight.
    expect(seedIdx).toBeGreaterThan(deployIdx);
    expect(preflightIdx).toBeGreaterThan(seedIdx);
  });
});
