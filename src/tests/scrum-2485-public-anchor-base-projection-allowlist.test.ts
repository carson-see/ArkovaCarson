/**
 * SCRUM-2485 — get_public_anchor base metadata projection: denylist → allow-list.
 *
 * get_public_anchor is GRANTed to anon and called directly by the public verify
 * page. Its top-level keys are already an EXPLICIT jsonb_build_object allow-list,
 * and 0331 added an explicit allow-list for cpe_metadata/cle_metadata — BUT the
 * `'metadata'` sub-object was still built by sanitize_metadata_for_public(...),
 * a DENYLIST (named PII keys + `_`-prefixed internals stripped, EVERYTHING ELSE
 * passed through). That means ANY new top-level anchors.metadata key the
 * pipeline starts stamping (e.g. registry.ctid, competencyFrameworks) would
 * auto-project to anonymous callers with no code change — the exact
 * public-by-default leak class this ticket closes.
 *
 * Migration 0355 rebuilds the `'metadata'` sub-object from an EXPLICIT
 * jsonb_build_object + jsonb_strip_nulls allow-list of only the safe public
 * display keys (mirroring the proven 0331 CPE/CLE pattern), so a NEW unlisted key
 * can never project. sanitize_metadata_for_public stays wired as defense in depth
 * for the allow-listed free-form values.
 *
 * These assertions read migration 0355 directly (content-guard) — the same
 * no-live-DB convention as scrum-2248 / scrum-1847-1869. The EXACT allow-list key
 * set is snapshotted so any future edit that widens the projection (or drops the
 * allow-list back to a denylist) fails this test.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MIGRATION_PATH = path.join(
  process.cwd(),
  'supabase/migrations/0355_scrum2485_public_anchor_base_projection_allowlist.sql',
);

function migration(): string {
  return fs.readFileSync(MIGRATION_PATH, 'utf8');
}

/** The body of the CREATE OR REPLACE FUNCTION get_public_anchor def. */
function functionBlock(sql: string): string {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION');
  expect(start).toBeGreaterThan(-1);
  const end = sql.indexOf('$$;', start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

/**
 * The EXACT public allow-list for the `'metadata'` sub-object. Every one of
 * these keys MUST appear in the jsonb_build_object; NOTHING outside this set may
 * be free-passed. If a new public display key is genuinely needed, add it here
 * AND to the migration in the SAME change — that is the whole point of the
 * snapshot.
 */
const EXPECTED_METADATA_ALLOWLIST = [
  // Generic public display fields written by the issue-credential + anchoring UI.
  'title',
  'credential_title',
  'description',
  'category',
  'proof_url',
  'issuer',
  'jurisdiction',
  // Source-import evidence metadata (mirrors PublicCredentialEvidenceMetadataSchema
  // in services/worker/src/lib/credential-evidence.ts). The source_*/evidence_*
  // keys already promoted to dedicated top-level get_public_anchor keys are NOT
  // re-listed here (they are `-`'d off the input before this projection).
  'evidence_schema_version',
  'source_id',
  'source_payload_content_type',
  'source_payload_byte_length',
  'extraction_method',
  'extraction_manifest_hash',
  'extraction_confidence',
  'credential_id_hash',
].sort();

describe('SCRUM-2485: get_public_anchor base metadata projection is an explicit allow-list', () => {
  it('migration 0355 redefines get_public_anchor', () => {
    expect(migration()).toMatch(
      /CREATE OR REPLACE FUNCTION\s+(?:"?public"?\.)?"?get_public_anchor"?/,
    );
  });

  it('builds the metadata sub-object from an EXPLICIT jsonb_build_object allow-list', () => {
    const block = functionBlock(migration());
    // The base metadata sub-key must be an explicit build, wrapped in
    // jsonb_strip_nulls (mirroring the 0331 CPE/CLE allow-list pattern).
    expect(block).toMatch(/'metadata',\s*jsonb_strip_nulls\(\s*jsonb_build_object\(/);
  });

  it('does NOT free-pass the raw metadata blob through sanitize_metadata_for_public as the base projection', () => {
    const block = functionBlock(migration());
    // The denylist helper may still appear as a defense-in-depth wrap on the
    // ALLOW-LISTED free-form values, but the `'metadata'` KEY must not be
    // assigned the bare `sanitize_metadata_for_public(COALESCE(a.metadata,...))`
    // pass-through that projected everything unnamed.
    expect(block).not.toMatch(
      /'metadata',\s*sanitize_metadata_for_public\(\s*COALESCE\(a\.metadata/,
    );
  });

  /**
   * Extract the metadata sub-object build text: from the `'metadata',
   * jsonb_strip_nulls(jsonb_build_object(` opener up to the next TOP-LEVEL
   * get_public_anchor key (`'created_at',`). Robust to the nested
   * sanitize_metadata_for_public(...) parens inside the build.
   */
  function metadataBuildBlock(block: string): string {
    const metaStart = block.indexOf("'metadata', jsonb_strip_nulls(jsonb_build_object(");
    expect(metaStart).toBeGreaterThan(-1);
    const afterMeta = block.slice(metaStart);
    const nextTopKey = afterMeta.indexOf("'created_at',");
    expect(nextTopKey).toBeGreaterThan(-1);
    return afterMeta.slice(0, nextTopKey);
  }

  /** The allow-list keys are the pair-leading quoted literals that are followed
   *  by an `->>` / `->` / `a.metadata` / `sanitize_metadata_for_public` source
   *  (i.e. a build entry), excluding the outer `'metadata'` label. */
  function projectedKeys(metaBlock: string): string[] {
    return [...metaBlock.matchAll(/'([a-z0-9_]+)'\s*,\s*(?:\(?sanitize_metadata_for_public|a\.metadata)/gi)]
      .map((m) => m[1]);
  }

  it('projects EXACTLY the snapshotted public allow-list keys (no more, no less)', () => {
    const block = functionBlock(migration());
    const keys = projectedKeys(metadataBuildBlock(block));
    expect(keys.slice().sort()).toEqual(EXPECTED_METADATA_ALLOWLIST);
  });

  it('rejects any key NOT on the allow-list (registry.ctid / competencyFrameworks cannot project)', () => {
    const metaBlock = metadataBuildBlock(functionBlock(migration())).toLowerCase();
    // Guard the specific future keys the ticket calls out.
    expect(metaBlock).not.toContain('ctid');
    expect(metaBlock).not.toContain('competency');
  });

  // ── Migration hygiene gates (preserve the security envelope) ───────────────
  it('preserves SECURITY DEFINER + search_path hardening', () => {
    const block = functionBlock(migration());
    expect(block).toMatch(/SECURITY\s+DEFINER/i);
    expect(block).toMatch(/SET\s+search_path\s+TO\s+'public'/i);
  });

  it('preserves the status filter and deleted_at guard', () => {
    const block = functionBlock(migration());
    expect(block).toMatch(/a\.status\s+IN\s*\(/i);
    expect(block).toMatch(/a\.deleted_at\s+IS\s+NULL/i);
  });

  it('reloads the PostgREST schema cache', () => {
    expect(migration()).toContain("NOTIFY pgrst, 'reload schema'");
  });

  it('documents a ROLLBACK path restoring the prior definition', () => {
    expect(migration()).toMatch(/--\s*ROLLBACK:[\s\S]*get_public_anchor/i);
  });

  it('carries the SCRUM-2485 ticket reference', () => {
    expect(migration()).toContain('SCRUM-2485');
  });
});
