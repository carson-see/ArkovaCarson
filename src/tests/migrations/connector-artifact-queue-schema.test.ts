/**
 * QUEUE-02 / SCRUM-2348 — connector_artifact queue schema (migration 0343).
 *
 * Static structural assertions over the migration SQL. These run in the default
 * vitest suite (no live database / no Docker required) and give a runnable
 * Red→Green TDD signal for the migration's *shape*: the §1.6A "no raw bytes"
 * invariant, FORCE RLS, service-role-only writes, the connector dedupe key, the
 * SECURITY DEFINER + search_path RPC, and the "no credit debit at enqueue" rule.
 *
 * The behavioural / cross-tenant RLS + idempotency proof lives in
 * tests/rls/connector-artifact.test.ts and requires a live Supabase instance.
 *
 * Pattern mirrored from src/tests/security/rls-policy-audit.test.ts.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MIGRATION_FILE = path.join(
  process.cwd(),
  'supabase/migrations/0343_scrum2348_connector_artifact_queue_schema.sql',
);

function readMigration(): string {
  if (!fs.existsSync(MIGRATION_FILE)) {
    throw new Error(
      `Migration not found: ${MIGRATION_FILE}. ` +
        'QUEUE-02 expects 0343_scrum2348_connector_artifact_queue_schema.sql.',
    );
  }
  return fs.readFileSync(MIGRATION_FILE, 'utf8');
}

describe('SCRUM-2348 — connector_artifact queue migration (0343)', () => {
  it('migration file exists with the reserved 0343 numeric prefix', () => {
    expect(fs.existsSync(MIGRATION_FILE)).toBe(true);
  });

  describe('table: connector_artifact', () => {
    it('creates public.connector_artifact', () => {
      const sql = readMigration();
      expect(sql).toMatch(
        /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+public\.connector_artifact/i,
      );
    });

    it('has a uuid PK defaulting to gen_random_uuid()', () => {
      const sql = readMigration();
      expect(sql).toMatch(/id\s+uuid[^,]*PRIMARY\s+KEY/i);
      expect(sql).toMatch(/gen_random_uuid\(\)/i);
    });

    it('org_id is NOT NULL and references organizations(id) (tenant key)', () => {
      const sql = readMigration();
      expect(sql).toMatch(
        /org_id\s+uuid\s+NOT\s+NULL\s+REFERENCES\s+public\.organizations\(id\)/i,
      );
    });

    it('source has a CHECK restricting to the locked connector set', () => {
      const sql = readMigration();
      for (const src of [
        'google_drive',
        'docusign',
        'microsoft_365',
        'manual_upload',
        'batch_upload',
      ]) {
        expect(sql).toContain(`'${src}'`);
      }
      expect(sql).toMatch(/source\s+text\s+NOT\s+NULL/i);
      expect(sql).toMatch(/connector_artifact_source_check/i);
    });

    it('integration_id is a nullable uuid FK to org_integrations', () => {
      const sql = readMigration();
      // nullable: no NOT NULL on the column; FK to org_integrations.
      expect(sql).toMatch(/integration_id\s+uuid\b/i);
      expect(sql).toMatch(
        /integration_id[\s\S]*?REFERENCES\s+public\.org_integrations\(id\)/i,
      );
    });

    it('fingerprint_sha256 is NOT NULL and CHECK-constrained to a 64-hex string', () => {
      const sql = readMigration();
      expect(sql).toMatch(/fingerprint_sha256\s+text\s+NOT\s+NULL/i);
      expect(sql).toMatch(/\^\[a-f0-9\]\{64\}\$/);
    });

    it('NEVER declares a bytes / blob / bytea / content column (§1.6A)', () => {
      // Strip `--` line comments first: the §1.6A header *mentions* bytea/blob to
      // explain their deliberate absence; we assert on real DDL, not prose.
      const sql = readMigration()
        .split('\n')
        .map((line) => line.replace(/--.*$/, ''))
        .join('\n')
        .toLowerCase();
      // No column may carry raw document bytes server-side.
      expect(sql).not.toMatch(/\bbytea\b/);
      expect(sql).not.toMatch(/^\s*(raw_)?bytes\s+/m);
      expect(sql).not.toMatch(/^\s*blob\s+/m);
      expect(sql).not.toMatch(/^\s*content\s+/m);
      expect(sql).not.toMatch(/^\s*file_bytes\s+/m);
      expect(sql).not.toMatch(/^\s*document_bytes\s+/m);
    });

    it('status defaults to pending and is CHECK-constrained to the lifecycle set', () => {
      const sql = readMigration();
      expect(sql).toMatch(/status\s+text\s+NOT\s+NULL\s+DEFAULT\s+'pending'/i);
      for (const st of [
        'pending',
        'queued',
        'processing',
        'materialized',
        'anchored',
        'failed',
        'skipped',
      ]) {
        expect(sql).toContain(`'${st}'`);
      }
    });

    it('credit_deduction_id is a nullable FK to org_credit_deductions', () => {
      const sql = readMigration();
      expect(sql).toMatch(
        /credit_deduction_id[\s\S]*?REFERENCES\s+public\.org_credit_deductions\(id\)/i,
      );
    });

    it('anchor_id is a nullable FK to anchors', () => {
      const sql = readMigration();
      expect(sql).toMatch(
        /anchor_id[\s\S]*?REFERENCES\s+public\.anchors\(id\)/i,
      );
    });

    it('metadata is NOT NULL jsonb defaulting to {}', () => {
      const sql = readMigration();
      expect(sql).toMatch(/metadata\s+jsonb\s+NOT\s+NULL\s+DEFAULT\s+'\{\}'/i);
    });

    it('uses timestamptz for created_at / updated_at (UTC server time)', () => {
      const sql = readMigration();
      expect(sql).toMatch(/created_at\s+timestamptz\s+NOT\s+NULL\s+DEFAULT\s+now\(\)/i);
      expect(sql).toMatch(/updated_at\s+timestamptz\s+NOT\s+NULL\s+DEFAULT\s+now\(\)/i);
    });
  });

  describe('dedupe / idempotency key', () => {
    it('enforces uniqueness across (org_id, source, external_ref, external_revision)', () => {
      const sql = readMigration();
      // external_revision is nullable, so the dedupe must COALESCE NULLs to a
      // sentinel via a unique INDEX (a plain UNIQUE constraint would treat
      // NULL revisions as always-distinct and let redeliveries double-insert).
      expect(sql).toMatch(/CREATE\s+UNIQUE\s+INDEX/i);
      expect(sql).toMatch(/COALESCE\s*\(\s*external_revision\s*,\s*''\s*\)/i);
      expect(sql).toMatch(/org_id[\s\S]*?source[\s\S]*?external_ref/i);
    });
  });

  describe('RLS', () => {
    it('ENABLEs and FORCEs row level security on connector_artifact', () => {
      const sql = readMigration();
      expect(sql).toMatch(
        /ALTER\s+TABLE\s+public\.connector_artifact\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/i,
      );
      expect(sql).toMatch(
        /ALTER\s+TABLE\s+public\.connector_artifact\s+FORCE\s+ROW\s+LEVEL\s+SECURITY/i,
      );
    });

    it('grants service_role full access', () => {
      const sql = readMigration();
      expect(sql).toMatch(
        /CREATE\s+POLICY\s+\w+\s+ON\s+public\.connector_artifact\s+FOR\s+ALL\s+TO\s+service_role/i,
      );
    });

    it('grants org members SELECT only on their own org rows', () => {
      const sql = readMigration();
      expect(sql).toMatch(
        /CREATE\s+POLICY\s+\w+\s+ON\s+public\.connector_artifact\s+FOR\s+SELECT\s+TO\s+authenticated/i,
      );
      // tenant-scoped via org_members membership check
      expect(sql).toMatch(/org_members/i);
      expect(sql).toMatch(/auth\.uid\(\)/i);
    });

    it('does NOT grant INSERT/UPDATE/DELETE to authenticated (writes are service-role only)', () => {
      const sql = readMigration();
      // authenticated must only ever be granted SELECT on this table.
      expect(sql).not.toMatch(/GRANT[^;]*INSERT[^;]*\bON\b[^;]*connector_artifact[^;]*TO\s+authenticated/i);
      expect(sql).not.toMatch(/GRANT[^;]*UPDATE[^;]*\bON\b[^;]*connector_artifact[^;]*TO\s+authenticated/i);
      expect(sql).not.toMatch(/GRANT[^;]*DELETE[^;]*\bON\b[^;]*connector_artifact[^;]*TO\s+authenticated/i);
    });
  });

  describe('RPC: enqueue_connector_artifact', () => {
    it('is SECURITY DEFINER with SET search_path = public', () => {
      const sql = readMigration();
      expect(sql).toMatch(
        /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.enqueue_connector_artifact/i,
      );
      const fnStart = sql.search(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.enqueue_connector_artifact/i);
      const fnBlock = sql.slice(fnStart);
      expect(fnBlock).toMatch(/SECURITY\s+DEFINER/i);
      expect(fnBlock).toMatch(/SET\s+search_path\s*=\s*public/i);
    });

    it('is idempotent: ON CONFLICT ... DO NOTHING then returns the existing id', () => {
      const sql = readMigration();
      expect(sql).toMatch(/INSERT\s+INTO\s+public\.connector_artifact/i);
      expect(sql).toMatch(/ON\s+CONFLICT[\s\S]*?DO\s+NOTHING/i);
      // must resolve the existing row id on conflict, not return NULL
      expect(sql).toMatch(/RETURNING\s+id/i);
    });

    it('performs NO credit debit at enqueue (debit happens at SECURING via debit_and_enqueue_anchor)', () => {
      const sql = readMigration();
      const fnStart = sql.search(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.enqueue_connector_artifact/i);
      const fnBlock = sql.slice(fnStart);
      expect(fnBlock).not.toMatch(/deduct_org_credit/i);
      expect(fnBlock).not.toMatch(/debit_and_enqueue_anchor/i);
      expect(fnBlock).not.toMatch(/UPDATE\s+org_credits/i);
    });

    it('grants EXECUTE on the RPC to service_role only (never anon/authenticated)', () => {
      const sql = readMigration();
      expect(sql).toMatch(
        /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.enqueue_connector_artifact[\s\S]*?TO\s+service_role/i,
      );
      expect(sql).not.toMatch(
        /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.enqueue_connector_artifact[^;]*TO[^;]*\banon\b/i,
      );
      expect(sql).not.toMatch(
        /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.enqueue_connector_artifact[^;]*TO[^;]*\bauthenticated\b/i,
      );
    });
  });

  describe('migration boilerplate', () => {
    it('has a -- ROLLBACK: block dropping the function and table', () => {
      const sql = readMigration();
      expect(sql).toMatch(/--\s*ROLLBACK:/i);
      expect(sql).toMatch(/DROP\s+FUNCTION\s+IF\s+EXISTS\s+public\.enqueue_connector_artifact/i);
      expect(sql).toMatch(/DROP\s+TABLE\s+IF\s+EXISTS\s+public\.connector_artifact/i);
    });

    it('reloads the PostgREST schema cache after DDL', () => {
      const sql = readMigration();
      expect(sql).toMatch(/NOTIFY\s+pgrst,\s*'reload schema'/i);
    });

    it('references the story id in a header comment', () => {
      const sql = readMigration();
      expect(sql).toMatch(/SCRUM-2348/);
    });
  });
});
