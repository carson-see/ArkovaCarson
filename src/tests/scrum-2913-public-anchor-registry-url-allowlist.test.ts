/**
 * SCRUM-2913 (Lane 2) — get_public_anchor base metadata allow-list: additive
 * widening to project `registry_url` + `ce_envelope_sha256`.
 *
 * Migration 0355 (SCRUM-2485) rebuilt the `'metadata'` sub-object of
 * get_public_anchor from a sanitize_metadata_for_public DENYLIST into an EXPLICIT
 * jsonb_build_object + jsonb_strip_nulls ALLOW-LIST, so a NEW anchors.metadata key
 * can never auto-project to anonymous callers. That was deliberate: adding a
 * public key now requires editing the allow-list AND its snapshot test in the same
 * change. 0356 (SCRUM-2484) preserved that allow-list verbatim while re-deriving
 * recipient_identifier as a keyed HMAC.
 *
 * The Lane 3 CTDL importer (#1603 / SCRUM-2913) explicitly DEFERS surfacing
 * `registry_url` publicly to a Lane 2 allow-list migration (this one) plus this
 * snapshot test — see #1603's note: "Surfacing registry_url PUBLICLY is out of
 * scope for this PR: it requires a deliberate S2/T3 allow-list migration (Lane 2)
 * + the SCRUM-2485 snapshot test." The importer maps registryUrl→registry_url and
 * ceEnvelopeSha256→ce_envelope_sha256 into anchors.metadata; migration 0362 only
 * WIDENS what get_public_anchor is ALLOWED to project — it does not set the values
 * and does not add storage.
 *
 * R-7 (§1.13 claims gate): `registry_url` is PROVENANCE ("this anchor's evidence
 * was sourced from this Credential Engine registry URL"), NOT a claim that Arkova
 * is listed/registered in the CE Registry. `ce_envelope_sha256` is an integrity
 * fingerprint (hex), consistent with the §1.5 public evidence model. Both are
 * public-safe (provenance/integrity, not PII). This migration ALLOWS the keys to
 * project; the value semantics are the importer's responsibility.
 *
 * These assertions read migration 0362 directly (content-guard) — the same
 * no-live-DB convention as scrum-2485 / scrum-2484 / scrum-1847-1869. The EXACT
 * widened allow-list is snapshotted so any future edit that widens the projection
 * beyond these two keys (or drops the allow-list back to a denylist) fails here.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MIGRATION_PATH = path.join(
  process.cwd(),
  'supabase/migrations/0362_scrum2913_public_anchor_registry_url_allowlist.sql',
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
 * The EXACT widened public allow-list for the `'metadata'` sub-object: the 15
 * SCRUM-2485 keys (0355/0356) PLUS the two SCRUM-2913 additions. Nothing outside
 * this set may be free-passed. This proves the widening is EXACTLY two keys — not
 * an opened projection.
 */
const EXPECTED_METADATA_ALLOWLIST = [
  // ── inherited SCRUM-2485 allow-list (0355/0356), verbatim ──
  'title',
  'credential_title',
  'description',
  'category',
  'proof_url',
  'issuer',
  'jurisdiction',
  'evidence_schema_version',
  'source_id',
  'source_payload_content_type',
  'source_payload_byte_length',
  'extraction_method',
  'extraction_manifest_hash',
  'extraction_confidence',
  'credential_id_hash',
  // ── SCRUM-2913 additive widening (this migration) ──
  'registry_url',
  'ce_envelope_sha256',
].sort();

/**
 * Extract the metadata sub-object build text: from the `'metadata',
 * jsonb_strip_nulls(jsonb_build_object(` opener up to the next TOP-LEVEL
 * get_public_anchor key (`'created_at',`).
 */
function metadataBuildBlock(block: string): string {
  const metaStart = block.indexOf("'metadata', jsonb_strip_nulls(jsonb_build_object(");
  expect(metaStart).toBeGreaterThan(-1);
  const afterMeta = block.slice(metaStart);
  const nextTopKey = afterMeta.indexOf("'created_at',");
  expect(nextTopKey).toBeGreaterThan(-1);
  return afterMeta.slice(0, nextTopKey);
}

/** The allow-list keys: the pair-leading quoted literals followed by a build
 *  source (`sanitize_metadata_for_public(...)` or `a.metadata`), excluding the
 *  outer `'metadata'` label. */
function projectedKeys(metaBlock: string): string[] {
  return [...metaBlock.matchAll(/'([a-z0-9_]+)'\s*,\s*(?:\(?sanitize_metadata_for_public|a\.metadata)/gi)]
    .map((m) => m[1]);
}

describe('SCRUM-2913: get_public_anchor allow-list widens by registry_url + ce_envelope_sha256', () => {
  it('migration 0362 redefines get_public_anchor via CREATE OR REPLACE', () => {
    expect(migration()).toMatch(
      /CREATE OR REPLACE FUNCTION\s+(?:"?public"?\.)?"?get_public_anchor"?/,
    );
  });

  it('keeps the metadata sub-object as an EXPLICIT jsonb_build_object allow-list (no denylist regression)', () => {
    const block = functionBlock(migration());
    expect(block).toMatch(/'metadata',\s*jsonb_strip_nulls\(\s*jsonb_build_object\(/);
    // Must NOT regress to the bare sanitize_metadata_for_public(COALESCE(a.metadata,...))
    // pass-through that projected everything unnamed.
    expect(block).not.toMatch(
      /'metadata',\s*sanitize_metadata_for_public\(\s*COALESCE\(a\.metadata/,
    );
  });

  it('projects the two NEW keys registry_url + ce_envelope_sha256', () => {
    const metaBlock = metadataBuildBlock(functionBlock(migration()));
    const keys = projectedKeys(metaBlock);
    expect(keys).toContain('registry_url');
    expect(keys).toContain('ce_envelope_sha256');
  });

  it('projects EXACTLY the widened allow-list (inherited 15 + exactly these 2; no more, no less)', () => {
    const keys = projectedKeys(metadataBuildBlock(functionBlock(migration())));
    expect(keys.slice().sort()).toEqual(EXPECTED_METADATA_ALLOWLIST);
  });

  it('uses the exact Lane-3-chosen key name ce_envelope_sha256 (not registry_envelope — claims-lint collision)', () => {
    const metaBlock = metadataBuildBlock(functionBlock(migration()));
    expect(metaBlock).toContain('ce_envelope_sha256');
    expect(metaBlock).not.toContain('registry_envelope');
  });

  it('still rejects any key NOT on the allow-list (registry.ctid / competencyFrameworks / recipient cannot project)', () => {
    const metaBlock = metadataBuildBlock(functionBlock(migration())).toLowerCase();
    expect(metaBlock).not.toContain('ctid');
    expect(metaBlock).not.toContain('competency');
    // A raw recipient/PII key must never enter the base allow-list.
    expect(metaBlock).not.toContain("'recipient'");
    expect(metaBlock).not.toContain("'ssn'");
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

  it('preserves the SCRUM-2484 keyed-HMAC recipient_identifier derivation (no regression to bare sha256)', () => {
    const block = functionBlock(migration());
    expect(block).toMatch(/extensions\.hmac\(/i);
    expect(block).not.toMatch(/recipient_identifier[\s\S]*extensions\.digest\(/i);
  });

  it('reloads the PostgREST schema cache', () => {
    expect(migration()).toContain("NOTIFY pgrst, 'reload schema'");
  });

  it('documents a ROLLBACK path restoring the prior (non-widened) definition', () => {
    expect(migration()).toMatch(/--\s*ROLLBACK:[\s\S]*get_public_anchor/i);
  });

  it('carries the SCRUM-2913 ticket reference and R-7 provenance note', () => {
    expect(migration()).toContain('SCRUM-2913');
    expect(migration()).toMatch(/R-7|provenance/i);
  });
});
