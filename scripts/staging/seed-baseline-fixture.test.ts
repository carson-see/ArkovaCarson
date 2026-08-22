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

  it('keeps the baseline SUBMITTED anchor on legal hold so mock confirmation cannot consume it', () => {
    const anchorInsert = sql.match(
      /insert\s+into\s+public\.anchors[\s\S]*?on\s+conflict\s*\(\s*id\s*\)\s*do\s+update\s+set\s+legal_hold\s*=\s*true/i,
    );
    expect(anchorInsert, 'public.anchors insert must set and preserve legal_hold=true').not.toBeNull();
    expect(anchorInsert?.[0]).toMatch(/\blegal_hold\b[\s\S]*\btrue\b/i);
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
    // Fixture UUIDs live in the obviously-synthetic 5eed0000- range, and carry
    // RFC 9562 version/variant nibbles (`4`/`8`) so strict `z.string().uuid()`
    // worker validators accept them — see tests/infra/seed-fixture-uuids.test.ts
    // and docs/staging/fullsoak-2026-08/deg5-org-queue-triage.md (DEG-5).
    expect(sql).toMatch(/5eed0000-0000-4000-8000-/i);
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

/**
 * FD-SEED-1 (docs/staging/findings/FD-SEED-1-baseline-fixture-self-reverts-in-7-minutes.md).
 *
 * A SUBMITTED anchor with `chain_tx_id IS NULL` is precisely the row
 * `public.recover_stuck_broadcasts()` (migration
 * `0379_f3_recover_submitted_null_txid.sql`) resets to PENDING once it is 5
 * minutes stale, and `routes/scheduled.ts` runs that reclaimer on a two-minute
 * in-process cron in EVERY environment. So the fixture this file seeds used to
 * evaporate ~7 minutes after provisioning, taking preflight Check 5 —
 * `submitted_anchors` — down with it and silently reclassifying the rig
 * `fixture_seeded`. Two exclusions are required, and they are not
 * interchangeable:
 *
 *   chain_tx_id NOT NULL  excludes recover_stuck_broadcasts (0379 deliberately
 *                         does NOT check legal_hold — see its header)
 *   legal_hold = true     excludes autoConfirmMockAnchors / monitorStuckTransactions
 *                         / rebroadcastDroppedTransactions, all of which filter
 *                         `.eq('legal_hold', false)`
 *
 * These tests pin both, plus the repair path for rigs seeded with the old file.
 */
describe('seed-baseline-fixture.sql — FD-SEED-1 durability', () => {
  /**
   * The `INSERT INTO public.anchors … ;` statement, isolated.
   *
   * Not a lazy `…;` match: semicolons appear both in the surrounding prose and
   * inside the anchor's own `description` literal, either of which truncates the
   * statement long before its ON CONFLICT tail. Anchor on the ON CONFLICT clause
   * explicitly and take the first `;` after it.
   */
  const anchorStatement = (() => {
    const start = sqlNoComments.search(/insert\s+into\s+public\.anchors/i);
    if (start < 0) return '';
    const conflict = sqlNoComments.slice(start).search(/on\s+conflict\s*\(\s*id\s*\)\s*do\s+update/i);
    if (conflict < 0) return '';
    const end = sqlNoComments.indexOf(';', start + conflict);
    if (end < 0) return '';
    return sqlNoComments.slice(start, end + 1);
  })();

  it('isolates the anchors INSERT for the assertions below', () => {
    expect(anchorStatement).not.toBe('');
  });

  it('writes chain_tx_id on the SUBMITTED fixture anchor', () => {
    // Column must be in the INSERT list — a NULL chain_tx_id is 0379's predicate.
    const columnList = anchorStatement.match(/insert\s+into\s+public\.anchors\s*\(([\s\S]*?)\)/i)?.[1] ?? '';
    expect(columnList).toMatch(/\bchain_tx_id\b/);
  });

  it('derives the txid as 64 hex characters from md5 halves, not a pasted literal', () => {
    // Two md5() calls concatenated = 64 hex chars, deterministic (so re-runs are
    // idempotent) and self-evidently synthetic in source. A pasted 64-hex literal
    // would read like a real on-chain txid.
    expect(anchorStatement).toMatch(/md5\(\s*'[^']+'\s*\)\s*\|\|\s*md5\(\s*'[^']+'\s*\)/i);
  });

  it('never inserts the SUBMITTED anchor with an explicit NULL chain_tx_id', () => {
    expect(anchorStatement).not.toMatch(/chain_tx_id\s*(=|,)?\s*NULL/i);
  });

  it('backfills chain_tx_id on re-run so an already-seeded rig is repaired', () => {
    // ON CONFLICT must not stop at legal_hold: a rig seeded with the pre-fix file
    // carries a NULL txid, and re-running the seed is the repair path.
    const doUpdate = anchorStatement.match(/on\s+conflict\s*\(\s*id\s*\)\s*do\s+update[\s\S]*$/i)?.[0] ?? '';
    expect(doUpdate).toMatch(/\blegal_hold\s*=\s*true/i);
    expect(doUpdate).toMatch(/\bchain_tx_id\s*=\s*COALESCE\(\s*anchors\.chain_tx_id\s*,\s*EXCLUDED\.chain_tx_id\s*\)/i);
  });

  it('restores a reclaimed PENDING fixture to SUBMITTED, and only when it carries our synthetic txid', () => {
    // Repairing the txid alone leaves an already-reclaimed row at PENDING, so
    // Check 5 would still read zero. But a row carrying a REAL txid must keep its
    // own status — we only reinstate rows that never actually broadcast anything.
    const doUpdate = anchorStatement.match(/on\s+conflict\s*\(\s*id\s*\)\s*do\s+update[\s\S]*$/i)?.[0] ?? '';
    expect(doUpdate).toMatch(/\bstatus\s*=\s*CASE\b/i);
    expect(doUpdate).toMatch(/anchors\.status\s*=\s*'PENDING'/i);
    expect(doUpdate).toMatch(/EXCLUDED\.chain_tx_id/);
    expect(doUpdate).toMatch(/'SUBMITTED'::public\.anchor_status/i);
    expect(doUpdate).toMatch(/ELSE\s+anchors\.status/i);
  });

  it('asserts its own post-conditions in-transaction and fails closed', () => {
    // The preflight reads Check 5 as a point-in-time count and cannot tell "no
    // fixture" from "fixture that evaporates in five minutes". The seed proves the
    // structural predicate instead — instantly, and without a timed re-check.
    // provision-isolated-rig.sh runs this under `set -euo pipefail` via run_cmd,
    // so a RAISE here aborts provisioning rather than admitting a doomed rig.
    const doBlock = sql.match(/DO\s+\$\$[\s\S]*?\$\$\s*;/i)?.[0] ?? '';
    expect(doBlock, 'a DO $$ … $$ post-condition block must be present').not.toBe('');
    expect(doBlock).toMatch(/RAISE\s+EXCEPTION/i);
    // Each of the three ways the fixture can be non-durable is named separately.
    expect(doBlock).toMatch(/chain_tx_id\s+IS\s+NULL/i);
    expect(doBlock).toMatch(/legal_hold/i);
    expect(doBlock).toMatch(/'SUBMITTED'/);
    // …and it must run before COMMIT, inside the seeding transaction.
    expect(sql.indexOf(doBlock)).toBeLessThan(sql.lastIndexOf('COMMIT'));
  });

  it('documents the reclaimer by name so the constraint is traceable from the file', () => {
    expect(sql).toMatch(/recover_stuck_broadcasts/);
    expect(sql).toMatch(/0379/);
    expect(sql).toMatch(/FD-SEED-1/);
  });

  it('points at a provisioning script that exists', () => {
    // The pre-fix header cited scripts/staging/soak-rig.sh, which is not in the repo.
    expect(sql).not.toMatch(/soak-rig\.sh/);
    expect(sql).toMatch(/scripts\/staging\/provision-isolated-rig\.sh/);
  });
});
