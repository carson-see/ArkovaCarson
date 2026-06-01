/**
 * SCRUM-1847 (CPE-R1) + SCRUM-1869 (CLE-R1): get_public_anchor must surface
 * cpe_metadata and cle_metadata on the public verification payload.
 *
 * The public verify path (src/components/verification/PublicVerification.tsx
 * and src/components/embed/VerificationWidget.tsx) calls get_public_anchor
 * directly via the Supabase anon client and assigns the whole RPC result to
 * the public anchor object — a passthrough, not a worker-mediated allowlist.
 * The frontend (open draft PRs #1023/#1025) reads data.cpe_metadata /
 * data.cle_metadata and self-hides when absent, allowlisting display fields.
 *
 * Migration 0331 redefines get_public_anchor to ALSO return:
 *   - cpe_metadata: a.cpe_metadata with extraction_confidence/extraction_source
 *     stripped (NULL when the column is NULL)
 *   - cle_metadata: same strip
 * These are additive nullable fields (CLAUDE.md §1.8 — no API version bump).
 * The server-side strip is defense in depth, matching the frontend allowlist:
 * internal extraction signals must never reach the public payload even if a
 * client forgets to filter them.
 *
 * These assertions read migration 0331 directly (content-guard), mirroring
 * the convention in scrum-2189-rpc-reads-cache.test.ts and
 * scrum-1980-public-search-perf.test.ts.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MIGRATION_PATH = path.join(
  process.cwd(),
  'supabase/migrations/0331_scrum1847_1869_public_anchor_cpe_cle_metadata.sql',
);

function migration(): string {
  return fs.readFileSync(MIGRATION_PATH, 'utf8');
}

/** The body of the CREATE OR REPLACE FUNCTION get_public_anchor definition. */
function functionBlock(sql: string): string {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION');
  expect(start).toBeGreaterThan(-1);
  // Body runs to the closing $$; of the function definition.
  const end = sql.indexOf('$$;', start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

describe('SCRUM-1847/1869: get_public_anchor surfaces cpe/cle_metadata', () => {
  it('migration 0331 redefines get_public_anchor', () => {
    expect(migration()).toMatch(
      /CREATE OR REPLACE FUNCTION\s+public\.get_public_anchor/,
    );
  });

  it('returns cpe_metadata as a top-level key', () => {
    expect(functionBlock(migration())).toContain("'cpe_metadata'");
  });

  it('returns cle_metadata as a top-level key', () => {
    expect(functionBlock(migration())).toContain("'cle_metadata'");
  });

  it('strips extraction_confidence + extraction_source from cpe_metadata (two-key strip)', () => {
    const block = functionBlock(migration());
    // The exact server-side allowlist backstop: subtract both internal signals.
    expect(block).toMatch(
      /a\.cpe_metadata\s*-\s*'extraction_confidence'\s*-\s*'extraction_source'/,
    );
  });

  it('strips extraction_confidence + extraction_source from cle_metadata (two-key strip)', () => {
    const block = functionBlock(migration());
    expect(block).toMatch(
      /a\.cle_metadata\s*-\s*'extraction_confidence'\s*-\s*'extraction_source'/,
    );
  });

  it('returns NULL for cpe_metadata / cle_metadata when the column is NULL (nullable, §1.8)', () => {
    const block = functionBlock(migration());
    // CASE WHEN a.cpe_metadata IS NOT NULL THEN (...) ELSE NULL END
    expect(block).toMatch(
      /CASE\s+WHEN\s+a\.cpe_metadata\s+IS\s+NOT\s+NULL[\s\S]*?ELSE\s+NULL\s+END/i,
    );
    expect(block).toMatch(
      /CASE\s+WHEN\s+a\.cle_metadata\s+IS\s+NOT\s+NULL[\s\S]*?ELSE\s+NULL\s+END/i,
    );
  });

  it('never leaks the internal extraction signals into any other returned key', () => {
    const block = functionBlock(migration());
    // The only mentions of the internal signals must be inside the strip
    // subtraction. They must never appear as a ->>' accessor that would surface
    // them as their own output field.
    expect(block).not.toMatch(/->>\s*'extraction_confidence'/);
    expect(block).not.toMatch(/->>\s*'extraction_source'/);
  });

  it('preserves SECURITY DEFINER and search_path hardening', () => {
    const block = functionBlock(migration());
    expect(block).toMatch(/SECURITY DEFINER/);
    expect(block).toMatch(/SET search_path TO 'public'/);
  });

  it('preserves the public-status filter and soft-delete guard', () => {
    const block = functionBlock(migration());
    expect(block).toMatch(
      /a\.status IN \('SECURED', 'REVOKED', 'EXPIRED', 'SUPERSEDED', 'PENDING', 'SUBMITTED'\)/,
    );
    expect(block).toContain('a.deleted_at IS NULL');
  });

  it('preserves the recipient-identifier SHA-256 hashing logic', () => {
    const block = functionBlock(migration());
    expect(block).toContain("encode(extensions.digest(v_recipient_raw::bytea, 'sha256'), 'hex')");
    expect(block).toContain("'recipient_identifier'");
  });

  it('reloads the PostgREST schema cache', () => {
    expect(migration()).toContain("NOTIFY pgrst, 'reload schema'");
  });

  it('documents a ROLLBACK path', () => {
    expect(migration()).toMatch(/--\s*ROLLBACK:/i);
  });
});
