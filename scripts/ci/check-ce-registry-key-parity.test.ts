import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { collectMigrationFiles } from './check-anchor-index-justification.js';
import {
  CE_REGISTRY_WRITER_FILES,
  collectWorkerTsFiles,
  extractGetPublicAnchorBody,
  findRegisteredWritersMissingRegistryUrl,
  findUnregisteredWriters,
  hasCeProvenanceMarker,
  hasRegistryUrlKey,
  latestGetPublicAnchorMigration,
  projectionHasRegistryUrlKey,
  stripJsLineComment,
} from './check-ce-registry-key-parity.js';

const REPO = resolve(import.meta.dirname, '..', '..');

describe('stripJsLineComment', () => {
  it('drops everything after a real // comment', () => {
    expect(stripJsLineComment("  registry_url: x, // the CE link")).toBe('  registry_url: x,');
  });

  it('does not treat // inside a string literal as a comment', () => {
    expect(stripJsLineComment("const registry_url = 'https://credentialengineregistry.org';"))
      .toBe("const registry_url = 'https://credentialengineregistry.org';");
  });

  it('does not treat // inside a template literal as a comment', () => {
    expect(stripJsLineComment('const url = `https://example.com/${ctid}`;'))
      .toBe('const url = `https://example.com/${ctid}`;');
  });

  it('handles an escaped quote inside a string without ending the string early', () => {
    expect(stripJsLineComment(String.raw`const s = 'it\'s // not a comment'; // real comment`))
      .toBe(String.raw`const s = 'it\'s // not a comment';`);
  });
});

describe('hasCeProvenanceMarker / hasRegistryUrlKey', () => {
  it('detects a bare object key with a colon', () => {
    expect(hasCeProvenanceMarker('const m = { ce_envelope_sha256: hash };')).toBe(true);
    expect(hasRegistryUrlKey('const m = { registry_url: url };')).toBe(true);
  });

  it('detects a quoted object key with a colon', () => {
    expect(hasCeProvenanceMarker("const m = { 'ce_envelope_sha256': hash };")).toBe(true);
  });

  it('detects an interface/type property declaration', () => {
    expect(hasRegistryUrlKey('interface X { registry_url: string; }')).toBe(true);
  });

  // The exact false-pass class check-envelope-key-index-parity.ts self-review
  // caught for SQL comments — a prose mention with a trailing colon must NOT
  // count as the file actually stamping the key.
  it('does NOT count a key that only appears in a // comment', () => {
    expect(hasRegistryUrlKey('// stamps registry_url: the CE link, when detected'))
      .toBe(false);
  });

  it('does NOT count a property READ (no trailing colon)', () => {
    expect(hasRegistryUrlKey('const sha256 = metadata.ce_envelope_sha256;')).toBe(false);
    expect(hasCeProvenanceMarker('const { registry_url } = provenance;')).toBe(false);
  });

  it('does NOT false-match a similarly-prefixed key', () => {
    expect(hasRegistryUrlKey('const m = { ce_registry_url: url };')).toBe(false);
  });
});

describe('findRegisteredWritersMissingRegistryUrl — the drift this guard exists for', () => {
  it('passes when every registered writer stamps both keys', () => {
    const sourceByFile = new Map(
      CE_REGISTRY_WRITER_FILES.map((file) => [
        file,
        'const m = { ce_envelope_sha256: hash, registry_url: url };',
      ]),
    );
    expect(findRegisteredWritersMissingRegistryUrl(sourceByFile)).toEqual([]);
  });

  // DRIFT SIMULATION: reproduces the exact bug this PR follow-up fixes —
  // credentials-ctdl-registry-anchor.ts stamped ce_registry_url (prefixed)
  // and ce_envelope_sha256, but never the unprefixed registry_url the
  // projection actually reads.
  it('FAILS (flags the file) when a registered writer stamps the CE marker but never registry_url — reproduces the pre-fix bug', () => {
    const sourceByFile = new Map<string, string>([
      [CE_REGISTRY_WRITER_FILES[0], 'const m = { ce_registry_ctid: ctid, ce_registry_url: url, ce_envelope_sha256: hash };'],
      [CE_REGISTRY_WRITER_FILES[1], 'const m = { ce_envelope_sha256: hash, registry_url: url };'],
    ]);
    expect(findRegisteredWritersMissingRegistryUrl(sourceByFile)).toEqual([CE_REGISTRY_WRITER_FILES[0]]);
  });

  it('does not flag a registered file that never stamps the CE-provenance marker at all (not a provenance writer in this snapshot)', () => {
    const sourceByFile = new Map(CE_REGISTRY_WRITER_FILES.map((file) => [file, 'export const noop = 1;']));
    expect(findRegisteredWritersMissingRegistryUrl(sourceByFile)).toEqual([]);
  });

  it('fails closed when a registered writer file is missing from the input entirely (moved/renamed/deleted)', () => {
    const sourceByFile = new Map<string, string>();
    const missing = findRegisteredWritersMissingRegistryUrl(sourceByFile);
    expect(missing).toHaveLength(CE_REGISTRY_WRITER_FILES.length);
    expect(missing[0]).toMatch(/file not found/);
  });
});

describe('findUnregisteredWriters — a third writer must not go uncovered', () => {
  it('passes when only registered files stamp the CE-provenance marker', () => {
    const sourceByFile = new Map<string, string>([
      [CE_REGISTRY_WRITER_FILES[0], 'const m = { ce_envelope_sha256: hash, registry_url: url };'],
      ['services/worker/src/lib/unrelated.ts', 'export const noop = 1;'],
    ]);
    expect(findUnregisteredWriters(sourceByFile)).toEqual([]);
  });

  // DRIFT SIMULATION: a new, third writer is added somewhere in the worker
  // tree without being registered in CE_REGISTRY_WRITER_FILES — this guard
  // must not silently ignore it.
  it('FAILS (flags the file) when an unregistered file stamps the CE-provenance marker', () => {
    const sourceByFile = new Map<string, string>([
      ['services/worker/src/api/v1/a-third-ce-writer.ts', 'const m = { ce_envelope_sha256: hash };'],
    ]);
    expect(findUnregisteredWriters(sourceByFile)).toEqual(['services/worker/src/api/v1/a-third-ce-writer.ts']);
  });

  it('does not flag a registered file even though it obviously stamps the marker', () => {
    const sourceByFile = new Map(
      CE_REGISTRY_WRITER_FILES.map((file) => [file, 'const m = { ce_envelope_sha256: hash, registry_url: url };']),
    );
    expect(findUnregisteredWriters(sourceByFile)).toEqual([]);
  });
});

describe('latestGetPublicAnchorMigration', () => {
  it('picks the highest-numbered migration that redefines get_public_anchor, ignoring one that redefines a different function', () => {
    const sqlByFile = new Map([
      ['supabase/migrations/0311_x.sql', 'CREATE OR REPLACE FUNCTION public.get_public_anchor(p_public_id text) RETURNS jsonb AS $$ SELECT 1; $$;'],
      ['supabase/migrations/0339_y.sql', 'CREATE OR REPLACE FUNCTION public.get_public_anchor_by_fingerprint(p text) RETURNS jsonb AS $$ SELECT 2; $$;'],
      ['supabase/migrations/0385_z.sql', "CREATE OR REPLACE FUNCTION public.get_public_anchor(p_public_id text) RETURNS jsonb AS $$ SELECT jsonb_build_object('registry_url', metadata ->> 'registry_url'); $$;"],
    ]);
    const result = latestGetPublicAnchorMigration(sqlByFile);
    expect(result?.file).toBe('supabase/migrations/0385_z.sql');
  });

  // DRIFT SIMULATION: the function is renamed away entirely, or no migration
  // defines it under this exact marker — must fail closed (null), never
  // silently report "no issue".
  it('returns null when nothing defines get_public_anchor — the caller must treat this as a failure, not a skip', () => {
    const sqlByFile = new Map([
      ['supabase/migrations/0001_x.sql', 'CREATE TABLE anchors (id uuid);'],
    ]);
    expect(latestGetPublicAnchorMigration(sqlByFile)).toBeNull();
  });
});

describe('extractGetPublicAnchorBody', () => {
  it('isolates only the get_public_anchor body out of a file defining several functions', () => {
    const sql = [
      'CREATE OR REPLACE FUNCTION private.helper_one() RETURNS text AS $$ SELECT 1; $$;',
      "CREATE OR REPLACE FUNCTION public.get_public_anchor(p_public_id text) RETURNS jsonb AS $$ SELECT jsonb_build_object('registry_url', a.metadata ->> 'registry_url'); $$;",
      'CREATE OR REPLACE FUNCTION private.helper_two() RETURNS text AS $$ SELECT 2; $$;',
    ].join('\n');

    const body = extractGetPublicAnchorBody(sql);
    expect(body).toContain("metadata ->> 'registry_url'");
    expect(body).not.toContain('helper_one');
    expect(body).not.toContain('helper_two');
  });

  // Mirrors check-envelope-key-index-parity.test.ts's "does NOT count an
  // index that a comment merely DOCUMENTS but never creates" regression —
  // the same false-pass class, here for the function-body marker.
  it('does not pick up a get_public_anchor mention that lives only in a -- comment', () => {
    const sql = [
      '-- Historical note: CREATE OR REPLACE FUNCTION public.get_public_anchor(p text) RETURNS jsonb AS $$ SELECT 0; $$;',
      "CREATE OR REPLACE FUNCTION public.get_public_anchor(p_public_id text) RETURNS jsonb AS $$ SELECT jsonb_build_object('registry_url', a.metadata ->> 'registry_url'); $$;",
    ].join('\n');

    const body = extractGetPublicAnchorBody(sql);
    expect(body).toContain("metadata ->> 'registry_url'");
  });

  it('returns null when no CREATE OR REPLACE FUNCTION public.get_public_anchor( is present', () => {
    expect(extractGetPublicAnchorBody('SELECT 1;')).toBeNull();
  });

  it('returns null when the body is never closed with $$;', () => {
    expect(extractGetPublicAnchorBody('CREATE OR REPLACE FUNCTION public.get_public_anchor(p text) RETURNS jsonb AS $$ SELECT 1;')).toBeNull();
  });
});

describe('projectionHasRegistryUrlKey', () => {
  it('true when the allow-list projects metadata ->> \'registry_url\'', () => {
    expect(projectionHasRegistryUrlKey("jsonb_build_object('registry_url', private.public_url_or_null(a.metadata ->> 'registry_url'))")).toBe(true);
  });

  // DRIFT SIMULATION: someone edits the allow-list and drops registry_url
  // while other CE keys (e.g. ce_envelope_sha256) remain — must be caught.
  it('FALSE when registry_url has been dropped from the allow-list — reproduces the SQL-side half of the drift class', () => {
    expect(projectionHasRegistryUrlKey("jsonb_build_object('ce_envelope_sha256', private.public_free_text_or_null(a.metadata ->> 'ce_envelope_sha256'))")).toBe(false);
  });
});

describe('live repository state', () => {
  it('every registered CE-registry writer that stamps ce_envelope_sha256 also stamps registry_url', () => {
    const sourceByFile = new Map(
      CE_REGISTRY_WRITER_FILES.map((file) => [file, readFileSync(join(REPO, file), 'utf8')]),
    );
    expect(findRegisteredWritersMissingRegistryUrl(sourceByFile)).toEqual([]);
  });

  it('no unregistered file under services/worker/src stamps the CE-provenance marker', () => {
    const sourceByFile = new Map(
      collectWorkerTsFiles(REPO).map((file) => [file, readFileSync(join(REPO, file), 'utf8')]),
    );
    expect(findUnregisteredWriters(sourceByFile)).toEqual([]);
  });

  it('the live get_public_anchor projection still allow-lists registry_url', () => {
    const sqlByFile = new Map(
      collectMigrationFiles(REPO).map((file) => [file, readFileSync(join(REPO, file), 'utf8')]),
    );
    const projection = latestGetPublicAnchorMigration(sqlByFile);
    expect(projection).not.toBeNull();

    const body = extractGetPublicAnchorBody(projection!.sql);
    expect(body).not.toBeNull();
    expect(projectionHasRegistryUrlKey(body!)).toBe(true);
  });
});
