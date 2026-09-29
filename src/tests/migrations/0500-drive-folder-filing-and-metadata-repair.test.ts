import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0500_drive_connector_folder_filing_and_metadata_repair.sql'),
  'utf8',
);

/**
 * BUG-2026-09-29 — orchestrator review (2026-09-29T21:50Z) shrank this
 * migration after production read-only SQL refuted the original draft's
 * assumption that filing needed a SQL fix at all:
 *   - `resolve_connector_destination_folder` was ALREADY correct (reads
 *     metadata->>'integration_id', not the integration_id COLUMN) — dropped
 *     from this migration entirely.
 *   - `enqueue_connector_artifact` did not need a p_integration_id parameter
 *     — populating that column has no reader; dropped as pure hygiene, not
 *     shipped here.
 *   - Filing already works in prod for every anchor created today. The real
 *     per-anchor gap (a connection momentarily revoked at INSERT time) is
 *     fixed in worker code (connector-artifact-drain.ts's retry-routing
 *     sweep), not SQL.
 * What remains: `materialize_connector_artifact_anchor` (credential_type
 * OTHER + file_size — required, since the CURRENT 0462 body hardcodes
 * CONTRACT_POSTSIGNING and has no file_size column) plus a data-only
 * backfill for the 13 pre-existing anchors.
 */
describe('0500 drive connector folder filing and metadata repair (shrunk, BUG-2026-09-29 review)', () => {
  it('is a well-formed compensating migration', () => {
    expect(migration).toMatch(/^BEGIN;/m);
    expect(migration).toMatch(/SET LOCAL lock_timeout = '5s';/);
    expect(migration).toMatch(/NOTIFY pgrst, 'reload schema';/);
    expect(migration).toMatch(/^COMMIT;/m);
    expect(migration).toMatch(/--\s*ROLLBACK:/i);
  });

  it('does NOT touch enqueue_connector_artifact or resolve_connector_destination_folder', () => {
    // The orchestrator's explicit instruction: do not replace hot-path
    // functions to fix a problem that does not exist. Only the header prose
    // may mention these names (explaining why they were removed) — no
    // CREATE/DROP/REPLACE statement for either.
    expect(migration).not.toMatch(/DROP FUNCTION[^;]*enqueue_connector_artifact/);
    expect(migration).not.toMatch(/CREATE (?:OR REPLACE )?FUNCTION public\.enqueue_connector_artifact/);
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION public\.resolve_connector_destination_folder/);
  });

  it('touches exactly one function: materialize_connector_artifact_anchor', () => {
    const createFunctionMatches = [...migration.matchAll(/^CREATE (?:OR REPLACE )?FUNCTION public\.(\w+)/gm)];
    expect(createFunctionMatches.map((m) => m[1])).toEqual(['materialize_connector_artifact_anchor']);
  });

  describe('materialize_connector_artifact_anchor: credential_type OTHER + file_size', () => {
    it('keeps the exact 7-arg signature — a plain body-only CREATE OR REPLACE', () => {
      expect(migration).toMatch(
        /CREATE OR REPLACE FUNCTION public\.materialize_connector_artifact_anchor\(\s*p_artifact_id uuid,\s*p_org_id uuid,\s*p_expected_updated_at timestamptz,\s*p_expected_fingerprint text,\s*p_expected_metadata jsonb,\s*p_anchor_payload jsonb,\s*p_existing_anchor_id uuid DEFAULT NULL\s*\)/,
      );
    });

    function functionBody(): string {
      const fnStart = migration.indexOf('CREATE OR REPLACE FUNCTION public.materialize_connector_artifact_anchor');
      const fnEnd = migration.indexOf('$$;', fnStart);
      return migration.slice(fnStart, fnEnd);
    }

    it('validates credential_type is CONTRACT_POSTSIGNING or OTHER, never a bare literal check', () => {
      const body = functionBody();
      expect(body).toMatch(
        /p_anchor_payload->>'credential_type' IS DISTINCT FROM 'CONTRACT_POSTSIGNING'\s*\n?\s*AND p_anchor_payload->>'credential_type' IS DISTINCT FROM 'OTHER'/,
      );
      expect(body).not.toMatch(/credential_type' IS DISTINCT FROM 'CONTRACT_POSTSIGNING'\s*\n\s*OR p_anchor_payload->'metadata'/);
    });

    it('casts credential_type from the payload rather than hardcoding the literal in the INSERT', () => {
      expect(functionBody()).toMatch(/\(p_anchor_payload->>'credential_type'\)::credential_type/);
    });

    it('does NOT require file_size: the worker deployed at apply time sends the 0462 payload without it', () => {
      const flat = functionBody().replace(/\s+/g, ' ');
      expect(flat).not.toContain("OR NOT (p_anchor_payload ? 'file_size')");
      expect(flat).toContain(
        "OR (p_anchor_payload ? 'file_size' AND jsonb_typeof(p_anchor_payload->'file_size') NOT IN ('null','number'))",
      );
    });

    it('type-checks file_size when present, adds it to the INSERT, and extends the strict key allow-list', () => {
      const body = functionBody();
      expect(body).toMatch(/jsonb_typeof\(p_anchor_payload->'file_size'\) NOT IN \('null','number'\)/);
      expect(body).toMatch(/\(p_anchor_payload->>'file_size'\)::bigint/);
      expect(body).toMatch(/'credential_type','metadata','fingerprint_source','file_size'/);
    });
  });

  describe('backfill: historical Drive anchors (data-only, idempotent)', () => {
    it('impersonates service_role for the duration of the backfill (established repo pattern)', () => {
      expect(migration).toMatch(/set_config\('request\.jwt\.claim\.role', 'service_role', true\)/);
      expect(migration).toMatch(/set_config\('request\.jwt\.claims', '\{"role":"service_role"\}', true\)/);
    });

    it('Backfill 1 (folder_id): joins connector_artifact.anchor_id -> the mirrored ORG folder, only where folder_id is NULL — a clean no-op on zero matches', () => {
      const start = migration.indexOf('-- Backfill 1');
      expect(start).toBeGreaterThan(0);
      const section = migration.slice(start, migration.indexOf('-- Backfill 2'));
      expect(section).toMatch(/UPDATE public\.anchors a/);
      expect(section).toMatch(/ca\.anchor_id = a\.id/);
      expect(section).toMatch(/f\.owner_scope = 'ORG'/);
      expect(section).toMatch(/f\.connector_provider = 'google_drive'/);
      expect(section).toMatch(/f\.connector_source_id = ca\.metadata->>'_drive_folder_id'/);
      expect(section).toMatch(/a\.folder_id IS NULL/);
      expect(section).toMatch(/ca\.source = 'google_drive'/);
      // No RAISE / assertion that a match must exist anywhere in this backfill.
      expect(section).not.toMatch(/RAISE/);
    });

    it('Backfill 2 (filename): derives it from the last path segment of _drive_folder_path, gated on the synthetic name, not on folder_id or status', () => {
      const start = migration.indexOf('-- Backfill 2');
      expect(start).toBeGreaterThan(0);
      const section = migration.slice(start, migration.indexOf('-- Backfill 3'));
      expect(section).toMatch(/UPDATE public\.anchors a/);
      expect(section).toMatch(/a\.filename LIKE 'google_drive:%'/);
      expect(section).toMatch(/regexp_replace\(ca\.metadata->>'_drive_folder_path', '\^\.\*\/', ''\)/);
      expect(section).toMatch(/BETWEEN 1 AND 255/);
      expect(section).toMatch(/\[\\x00-\\x1F\\x7F\]/);
      expect(section).not.toMatch(/a\.status/);
      expect(section).not.toMatch(/a\.folder_id/);
    });

    it('Backfill 3 (file_size): from connector_artifact.byte_length, respecting the positive-size CHECK, regardless of status', () => {
      const start = migration.indexOf('-- Backfill 3');
      expect(start).toBeGreaterThan(0);
      const section = migration.slice(start, migration.indexOf('-- Backfill 4'));
      expect(section).toMatch(/UPDATE public\.anchors a/);
      expect(section).toMatch(/SET file_size = ca\.byte_length/);
      expect(section).toMatch(/a\.file_size IS NULL/);
      expect(section).toMatch(/ca\.byte_length > 0/);
      expect(section).not.toMatch(/a\.status/);
    });

    it('Backfill 4 (credential_type): to OTHER, gated to status=PENDING only — never forced on a SECURED row', () => {
      const start = migration.indexOf('-- Backfill 4');
      expect(start).toBeGreaterThan(0);
      const section = migration.slice(start);
      expect(section).toMatch(/UPDATE public\.anchors a/);
      expect(section).toMatch(/SET credential_type = 'OTHER'/);
      // Index-driven through connector_artifact, never a scan of anchors by an
      // unindexed metadata key (prod EXPLAIN planned that as a full seq scan).
      expect(section).toMatch(/FROM public\.connector_artifact ca/);
      expect(section).toMatch(/ca\.anchor_id = a\.id/);
      expect(section).toMatch(/ca\.source = 'google_drive'/);
      expect(section).not.toMatch(/WHERE a\.metadata->>'connector_source'/);
      expect(section).toMatch(/a\.credential_type = 'CONTRACT_POSTSIGNING'/);
      expect(section).toMatch(/a\.status = 'PENDING'/);
    });

    it('the four backfill statements touch exactly folder_id, filename, file_size, credential_type — in that order', () => {
      const setClauses = [...migration.matchAll(/UPDATE public\.anchors a\s*\n\s*SET (\w+)/g)].map((m) => m[1]);
      expect(setClauses).toEqual(['folder_id', 'filename', 'file_size', 'credential_type']);
    });
  });
});
