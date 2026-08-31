/**
 * SCRUM-3817/3818 (docusign-bilateral-2026-08) — migration 0424's `-- ROLLBACK:`
 * block must be genuinely executable, not just present.
 *
 * Found by the `mig-docusign-trust` T3 soak rehearsal (PR #2513,
 * docs/staging/mig-docusign-trust/STANDUP.md, rig `yfqgxycaiwgvvvbzhkma`):
 * the original block re-added the pre-0424 global
 * `UNIQUE (envelope_id, event_id, generated_at)` constraint immediately after
 * dropping the tenant-scoped one, with no step to resolve rows that only the
 * tenant-scoped key can tell apart. Once two different DocuSign accounts have
 * legitimately shared an (envelope_id, event_id, generated_at) tuple — the
 * exact case 0424 exists to permit — that ADD CONSTRAINT fails with a
 * unique-violation and the whole rollback transaction aborts.
 *
 * These are static structural assertions over the migration SQL (no live
 * database / no Docker required), pinned so the corrected rollback cannot
 * silently regress back to the non-executable form. Pattern mirrored from
 * src/tests/migrations/connector-artifact-queue-schema.test.ts.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MIGRATION_FILE = path.join(
  process.cwd(),
  'supabase/migrations/0424_docusign_webhook_nonces_tenant_scope.sql',
);

function readMigration(): string {
  if (!fs.existsSync(MIGRATION_FILE)) {
    throw new Error(
      `Migration not found: ${MIGRATION_FILE}. ` +
        'Expected 0424_docusign_webhook_nonces_tenant_scope.sql.',
    );
  }
  return fs.readFileSync(MIGRATION_FILE, 'utf8');
}

/** The `-- ROLLBACK:` comment block only (from the marker to the first blank line). */
function rollbackBlock(sql: string): string {
  const start = sql.search(/^--\s*ROLLBACK:/im);
  expect(start, '`-- ROLLBACK:` marker not found').toBeGreaterThanOrEqual(0);
  const rest = sql.slice(start);
  // The comment block ends at the first line that is blank (not `--`-prefixed).
  const end = rest.search(/\n(?!--)/);
  return end === -1 ? rest : rest.slice(0, end);
}

describe('0424 docusign_webhook_nonces tenant-scope migration — ROLLBACK executability', () => {
  it('migration file exists with the reserved 0424 numeric prefix', () => {
    expect(fs.existsSync(MIGRATION_FILE)).toBe(true);
  });

  it('the executed BEGIN...COMMIT block is unchanged (rollback fix is comment-only)', () => {
    const sql = readMigration();
    // The two ALTER TABLE statements that add account_id and the tenant-scoped
    // constraint must still be the only executed DDL — the finding and its fix
    // are entirely inside the `--`-prefixed rollback comment.
    const executedLines = sql
      .split('\n')
      .filter((line) => !/^\s*--/.test(line));
    const executedSql = executedLines.join('\n');
    expect(executedSql).toMatch(
      /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+account_id\s+text/i,
    );
    expect(executedSql).toMatch(
      /ADD\s+CONSTRAINT\s+docusign_webhook_nonces_account_envelope_event_gen_key/i,
    );
    expect(executedSql).toMatch(
      /UNIQUE\s*\(\s*account_id\s*,\s*envelope_id\s*,\s*event_id\s*,\s*generated_at\s*\)/i,
    );
    // The rollback fix must NOT introduce a live executed DELETE anywhere in
    // the file — the dedup only ever runs as operator-invoked rollback SQL.
    expect(executedSql).not.toMatch(/DELETE\s+FROM/i);
  });

  describe('-- ROLLBACK: block', () => {
    it('drops the tenant-scoped constraint before re-adding the global one', () => {
      const block = rollbackBlock(readMigration());
      const dropIdx = block.search(
        /DROP\s+CONSTRAINT\s+IF\s+EXISTS\s+docusign_webhook_nonces_account_envelope_event_gen_key/i,
      );
      const addIdx = block.search(
        /ADD\s+CONSTRAINT\s+docusign_webhook_nonces_envelope_id_event_id_generated_at_key/i,
      );
      expect(dropIdx).toBeGreaterThanOrEqual(0);
      expect(addIdx).toBeGreaterThan(dropIdx);
    });

    it('includes a DEDUP step (DELETE) between the DROP and the re-ADD of the global constraint', () => {
      const block = rollbackBlock(readMigration());
      const dropIdx = block.search(
        /DROP\s+CONSTRAINT\s+IF\s+EXISTS\s+docusign_webhook_nonces_account_envelope_event_gen_key/i,
      );
      const deleteIdx = block.search(/DELETE\s+FROM\s+public\.docusign_webhook_nonces/i);
      const addIdx = block.search(
        /ADD\s+CONSTRAINT\s+docusign_webhook_nonces_envelope_id_event_id_generated_at_key/i,
      );
      expect(deleteIdx, 'ROLLBACK block has no DEDUP (DELETE) step').toBeGreaterThan(dropIdx);
      expect(addIdx).toBeGreaterThan(deleteIdx);
    });

    it('dedup partitions on the OLD 3-column key, not the new tenant-scoped one', () => {
      const block = rollbackBlock(readMigration());
      expect(block).toMatch(
        /PARTITION\s+BY\s+envelope_id\s*,\s*event_id\s*,\s*generated_at/i,
      );
      // Must NOT partition by account_id — that key is exactly what allowed
      // the duplicate to exist legitimately in the first place.
      expect(block).not.toMatch(/PARTITION\s+BY\s+account_id/i);
    });

    it('dedup keeps a deterministic single survivor per tuple (earliest received_at, id tiebreak)', () => {
      const block = rollbackBlock(readMigration());
      expect(block).toMatch(/ORDER\s+BY\s+received_at\s+ASC\s*,\s*id\s+ASC/i);
      expect(block).toMatch(/ROW_NUMBER\s*\(\s*\)/i);
      expect(block).toMatch(/rn\s*>\s*1/i);
    });

    it('re-adds the exact original global UNIQUE(envelope_id, event_id, generated_at) constraint', () => {
      const block = rollbackBlock(readMigration());
      expect(block).toMatch(
        /ADD\s+CONSTRAINT\s+docusign_webhook_nonces_envelope_id_event_id_generated_at_key\s*\n--\s*UNIQUE\s*\(\s*envelope_id\s*,\s*event_id\s*,\s*generated_at\s*\)/i,
      );
    });

    it('drops the account_id column last', () => {
      const block = rollbackBlock(readMigration());
      const addConstraintIdx = block.search(
        /ADD\s+CONSTRAINT\s+docusign_webhook_nonces_envelope_id_event_id_generated_at_key/i,
      );
      const dropColumnIdx = block.search(/DROP\s+COLUMN\s+IF\s+EXISTS\s+account_id/i);
      expect(dropColumnIdx).toBeGreaterThan(addConstraintIdx);
    });

    it('is wrapped in BEGIN/COMMIT with SET LOCAL lock_timeout', () => {
      const block = rollbackBlock(readMigration());
      expect(block).toMatch(/BEGIN;/);
      expect(block).toMatch(/SET\s+LOCAL\s+lock_timeout\s*=\s*'5s'/i);
      expect(block).toMatch(/COMMIT;/);
    });

    it('explicitly documents the rollback as LOSSY once the tenant key has been exercised', () => {
      const block = rollbackBlock(readMigration());
      expect(block).toMatch(/LOSSY/);
    });

    it('credits the mig-docusign-trust soak rehearsal finding', () => {
      const block = rollbackBlock(readMigration());
      expect(block).toMatch(/mig-docusign-trust/i);
    });
  });
});
